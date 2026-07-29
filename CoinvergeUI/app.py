"""
CoinVerge — Flask Backend
Full kiosk system: bill exchange UI, admin panel, transaction logging, stock management.

Run:
    python3 app.py --simulate         (no hardware, test on laptop)
    python3 app.py --port /dev/ttyUSB0  (real ESP32 connected)
    python3 app.py --kiosk            (fullscreen on RPi)
"""

import argparse
import json
import random
import threading
import time
import sys
from datetime import datetime, timedelta
from flask import Flask, render_template, jsonify, request, session, Response
from database import (
    init_db, log_transaction, get_transactions, get_transactions_by_date,
    get_transaction_count, get_summary, get_stock, update_stock, deduct_stock,
    refill_stock, refill_all, is_any_stock_available, verify_pin, get_setting,
    set_setting, get_maintenance_mode, set_maintenance_mode,
    get_low_stock_denominations, get_fee, get_fee_tiers, set_fee_tiers,
    log_stock_count, get_stock_counts, get_stock_counts_by_date,
    log_stock_event, get_stock_events, get_stock_events_by_date,
    REFILL_THRESHOLD
)

# ── ESP32 Serial Connection ──────────────────────────────────────────────────

# Hopper index to denomination mapping (matches ESP32 HOPPER_MAP)
HOPPER_INDEX_MAP = {0: 1, 1: 5, 2: 10, 3: 20}
DENOM_TO_INDEX = {1: 0, 5: 1, 10: 2, 20: 3}

# Coin counting state (admin feature)
counting_state = {"active": False, "denomination": 0, "count": 0}


class ESP32Connection:
    """Manages serial communication with the ESP32."""

    def __init__(self, port=None, simulate=False):
        self.simulate = simulate
        self.serial_port = None
        self.lock = threading.Lock()
        self.balance = 0
        self.connected = False
        self._listeners = []
        self.payment_method = "cash"  # Track current payment method
        self.payment_source = "none"  # Track payment source: "bill", "coin", "epay", "mixed"
        self.servo_positions = {"A": 90, "B": 90, "A1": 45, "A5": 135, "B10": 45, "B20": 135}

        if simulate:
            self.connected = True
            print("[SIM] Running in SIMULATION mode (no hardware)")
        else:
            self._connect(port)

    def _connect(self, port=None):
        try:
            import serial
            import serial.tools.list_ports

            if port is None:
                ports = serial.tools.list_ports.comports()
                for p in ports:
                    desc = (p.description or "").lower()
                    if "cp210" in desc or "ch340" in desc or "usb" in desc:
                        port = p.device
                        break
                if port is None and ports:
                    port = ports[0].device

            if port is None:
                print("[SERIAL] No serial ports found. Use --simulate for testing.")
                return

            print(f"[SERIAL] Connecting to {port} at 115200...")
            self.serial_port = serial.Serial(port, 115200, timeout=0.1)
            self.connected = True
            print(f"[SERIAL] Connected to {port}")

            reader = threading.Thread(target=self._reader_loop, daemon=True)
            reader.start()

        except ImportError:
            print("[ERROR] pyserial not installed. Run: pip install pyserial")
            print("[ERROR] Falling back to simulation mode.")
            self.simulate = True
            self.connected = True

        except Exception as e:
            print(f"[SERIAL] Connection failed: {e}")

    def _reader_loop(self):
        while self.connected and self.serial_port:
            try:
                if self.serial_port.in_waiting:
                    line = self.serial_port.readline().decode('utf-8', errors='ignore').strip()
                    if line:
                        self._process_line(line)
            except Exception as e:
                print(f"[SERIAL] Read error: {e}")
                time.sleep(0.5)

    def _process_line(self, line):
        global counting_state
        print(f"[ESP32] {line}")

        if line.startswith("BILL:"):
            try:
                amount = int(line.split(":")[1])
                # Ignore bills during maintenance mode
                if get_maintenance_mode():
                    print(f"[ESP32] Bill ignored (maintenance mode)")
                    return
                self.balance += amount
                self.payment_method = "cash"
                # Track source: if coins were already inserted, it's mixed
                if self.payment_source == "coin":
                    self.payment_source = "mixed"
                elif self.payment_source == "none":
                    self.payment_source = "bill"
                # else: already "bill" or "mixed", keep as is
                self._notify("bill", {"amount": amount, "balance": self.balance})
            except ValueError:
                pass
        elif line.startswith("COIN:"):
            try:
                amount = int(line.split(":")[1])
                # Ignore coins during maintenance mode
                if get_maintenance_mode():
                    print(f"[ESP32] Coin ignored (maintenance mode)")
                    return
                self.balance += amount
                self.payment_method = "coin"
                # Track source: if bills were already inserted, it's mixed
                if self.payment_source == "bill":
                    self.payment_source = "mixed"
                elif self.payment_source == "none":
                    self.payment_source = "coin"
                # else: already "coin" or "mixed", keep as is
                # Increment stock in database (coin goes INTO the hopper)
                from database import get_stock, update_stock as db_update_stock
                stock = get_stock()
                denom_stock = stock.get(amount, {})
                current = denom_stock.get("current", 0)
                max_cap = denom_stock.get("max", 1000)
                new_count = min(current + 1, max_cap)
                db_update_stock(amount, new_count)
                print(f"[COIN] ₱{amount} deposited → stock {current} → {new_count}")
                self._notify("coin", {"amount": amount, "balance": self.balance})
            except ValueError:
                pass
        elif line.startswith("SERVO_POS:"):
            try:
                # FORMAT: SERVO_POS:A=90,B=90,A1=45,A5=135,B10=45,B20=135
                parts = line.split(":")[1].split(",")
                for part in parts:
                    key, val = part.split("=")
                    self.servo_positions[key] = int(val)
                print(f"[SERVO] Positions: {self.servo_positions}")
            except (ValueError, IndexError):
                pass
        elif line == "DISPENSED:OK":
            self._notify("dispensed", {"status": "ok"})
        elif line.startswith("DISPENSED:ERROR"):
            reason = line.split(":", 2)[2] if line.count(":") >= 2 else "unknown"
            self._notify("dispensed", {"status": "error", "reason": reason})
        elif line.startswith("COUNT_PROGRESS:"):
            # FORMAT: COUNT_PROGRESS:<index>:<count>
            try:
                parts = line.split(":")
                idx = int(parts[1])
                count = int(parts[2])
                denom = HOPPER_INDEX_MAP.get(idx, 0)
                counting_state["active"] = True
                counting_state["denomination"] = denom
                counting_state["count"] = count
                self._notify("count_progress", {"denomination": denom, "count": count})
            except (ValueError, IndexError):
                pass
        elif line.startswith("COUNT_DONE:"):
            # FORMAT: COUNT_DONE:<index>:<total>
            try:
                parts = line.split(":")
                idx = int(parts[1])
                total = int(parts[2])
                denom = HOPPER_INDEX_MAP.get(idx, 0)
                counting_state["active"] = False
                counting_state["denomination"] = denom
                counting_state["count"] = total
                # Auto-update stock in database
                if denom > 0:
                    update_stock(denom, total)
                    log_stock_count(denom, total)
                    log_stock_event(denom, "count", total, total)
                    print(f"[COUNT] Stock updated: ₱{denom} = {total} coins")
                self._notify("count_done", {"denomination": denom, "total": total})
            except (ValueError, IndexError):
                pass
        elif line == "READY":
            self._notify("ready", {})

    def _notify(self, event_type, data):
        for listener in self._listeners:
            listener(event_type, data)

    def add_listener(self, callback):
        self._listeners.append(callback)

    def send_command(self, cmd):
        with self.lock:
            if self.simulate:
                return self._simulate_command(cmd)
            elif self.serial_port and self.connected:
                self.serial_port.write((cmd + "\n").encode())
                return True
            return False

    def _simulate_command(self, cmd):
        global counting_state
        cmd_upper = cmd.upper()
        if cmd_upper.startswith("DISPENSE:"):
            # Simulate 2-second dispensing delay
            threading.Timer(2.0, lambda: self._notify("dispensed", {"status": "ok"})).start()
            return True
        elif cmd_upper == "RESET":
            self.balance = 0
            self.payment_source = "none"
            return True
        elif cmd_upper.startswith("SERVO:") and not cmd_upper.startswith("SERVO_"):
            # Simulate servo movement: SERVO:A:90
            parts = cmd.split(":")
            if len(parts) == 3:
                servo_id = parts[1].upper()
                try:
                    angle = int(parts[2])
                    angle = max(0, min(180, angle))
                    if servo_id == "A":
                        self.servo_positions["A"] = angle
                        print(f"[SIM][SERVO] A → {angle}°")
                    elif servo_id == "B":
                        self.servo_positions["B"] = angle
                        print(f"[SIM][SERVO] B → {angle}°")
                    return True
                except ValueError:
                    pass
            return False
        elif cmd_upper == "SERVO_POS":
            # Simulate servo position report
            print(f"[SIM][SERVO] Positions: {self.servo_positions}")
            return True
        elif cmd_upper.startswith("COUNT:"):
            # Simulate coin counting
            try:
                idx = int(cmd_upper.split(":")[1])
                denom = HOPPER_INDEX_MAP.get(idx, 0)
                if denom == 0:
                    return False
                counting_state["active"] = True
                counting_state["denomination"] = denom
                counting_state["count"] = 0

                def simulate_counting():
                    global counting_state
                    target = random.randint(50, 200)
                    count = 0
                    while count < target and counting_state["active"]:
                        time.sleep(0.2)
                        if not counting_state["active"]:
                            break  # Aborted
                        count += 1
                        counting_state["count"] = count
                        if count % 10 == 0:
                            self._process_line(f"COUNT_PROGRESS:{idx}:{count}")
                    # Fire COUNT_DONE
                    self._process_line(f"COUNT_DONE:{idx}:{count}")

                threading.Thread(target=simulate_counting, daemon=True).start()
            except (ValueError, IndexError):
                return False
            return True
        elif cmd_upper == "COUNT_STOP":
            if counting_state["active"]:
                counting_state["active"] = False
            return True
        return False

    def simulate_bill(self, amount):
        if amount > 0:
            self.balance += amount
            self.payment_method = "cash"
            if self.payment_source == "coin":
                self.payment_source = "mixed"
            elif self.payment_source in ("none", "bill"):
                self.payment_source = "bill"
            self._notify("bill", {"amount": amount, "balance": self.balance})
            return True
        return False

    def simulate_coin(self, amount):
        """Simulate a coin insertion (used in simulation mode)."""
        if amount > 0:
            self.balance += amount
            self.payment_method = "coin"
            if self.payment_source == "bill":
                self.payment_source = "mixed"
            elif self.payment_source in ("none", "coin"):
                self.payment_source = "coin"
            # Increment stock in database (coin goes INTO the hopper)
            stock = get_stock()
            denom_stock = stock.get(amount, {})
            current = denom_stock.get("current", 0)
            max_cap = denom_stock.get("max", 1000)
            new_count = min(current + 1, max_cap)
            update_stock(amount, new_count)
            print(f"[SIM][COIN] ₱{amount} deposited → stock {current} → {new_count}")
            self._notify("coin", {"amount": amount, "balance": self.balance})
            return True
        return False


# ── Flask App ────────────────────────────────────────────────────────────────

app = Flask(__name__)

# Generate a random secret key on first run, persist it across restarts
import os as _os
SECRET_KEY_FILE = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '.secret_key')
if _os.path.exists(SECRET_KEY_FILE):
    with open(SECRET_KEY_FILE, 'r') as _f:
        app.secret_key = _f.read().strip()
else:
    app.secret_key = _os.urandom(24).hex()
    with open(SECRET_KEY_FILE, 'w') as _f:
        _f.write(app.secret_key)

esp32 = None
event_queue = []
event_lock = threading.Lock()
pending_epay = None  # Tracks pending e-payment: {reference_number, timestamp}


def on_esp32_event(event_type, data):
    with event_lock:
        event_queue.append({"type": event_type, "data": data, "time": time.time()})
        if len(event_queue) > 100:
            event_queue.pop(0)


# ── Page Routes ──────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Main kiosk UI (user-facing)."""
    return render_template("index.html")


@app.route("/admin")
def admin_page():
    """Admin panel."""
    return render_template("admin.html")


@app.route("/phone")
def phone_page():
    """Phone mockup page — simulates GCash/Maya payment app."""
    return render_template("phone.html")


# ── User API ─────────────────────────────────────────────────────────────────

@app.route("/api/status")
def api_status():
    stock = get_stock()
    low_stock = get_low_stock_denominations()
    maintenance = get_maintenance_mode()
    balance = esp32.balance
    payment_source = esp32.payment_source

    # Fee logic: pure coin-only = free (unless coin_fee_enabled), all others = tiered fee
    if payment_source == "coin":
        coin_fee_enabled = get_setting('coin_fee_enabled')
        if coin_fee_enabled == '1':
            fee = get_fee(balance) if balance > 0 else 0
        else:
            fee = 0
    else:
        # bill, epay, mixed, none — all get tiered fee
        fee = get_fee(balance) if balance > 0 else 0

    # Timeout settings
    timeout_seconds = int(get_setting("timeout_seconds") or 60)
    timeout_action = get_setting("timeout_action") or "largest"

    return jsonify({
        "connected": esp32.connected,
        "simulate": esp32.simulate,
        "balance": balance,
        "fee": fee,
        "available": balance - fee if balance > 0 else 0,
        "stock": {str(d): s["current"] for d, s in stock.items()},
        "any_stock": is_any_stock_available(),
        "maintenance_mode": maintenance,
        "low_stock": low_stock,
        "refill_threshold": REFILL_THRESHOLD,
        "payment_source": payment_source,
        "timeout_seconds": timeout_seconds,
        "timeout_action": timeout_action,
    })


@app.route("/api/events")
def api_events():
    since = float(request.args.get("since", 0))
    with event_lock:
        new_events = [e for e in event_queue if e["time"] > since]
    return jsonify(new_events)


@app.route("/api/dispense", methods=["POST"])
def api_dispense():
    if get_maintenance_mode():
        return jsonify({"error": "Machine is under maintenance"}), 503

    data = request.get_json()
    if not data or "combination" not in data:
        return jsonify({"error": "Missing combination"}), 400

    combo = data["combination"]  # {"1": 10, "5": 4, "10": 2, "20": 1}

    # Validate total (must equal balance - fee)
    total = 0
    int_combo = {}
    for denom, qty in combo.items():
        d, q = int(denom), int(qty)
        if q > 0:
            total += d * q
            int_combo[d] = q

    # Fee depends on payment source (coins = free unless coin_fee_enabled)
    if esp32.payment_source == "coin":
        coin_fee_enabled = get_setting('coin_fee_enabled')
        if coin_fee_enabled == '1':
            fee = get_fee(esp32.balance)
        else:
            fee = 0
    else:
        fee = get_fee(esp32.balance)
    available = esp32.balance - fee

    if total != available:
        return jsonify({"error": f"Total ₱{total} doesn't match available ₱{available} (balance ₱{esp32.balance} - fee ₱{fee})"}), 400

    if not int_combo:
        return jsonify({"error": "No coins selected"}), 400

    # Check stock
    stock = get_stock()
    for denom, qty in int_combo.items():
        avail_stock = stock.get(denom, {}).get("current", 0)
        if qty > avail_stock:
            return jsonify({"error": f"Not enough ₱{denom} coins (need {qty}, have {avail_stock})"}), 400

    # Build and send command
    parts = [f"{d}x{q}" for d, q in sorted(int_combo.items())]
    cmd = "DISPENSE:" + ",".join(parts)
    print(f"[CMD] {cmd}")

    bill_value = esp32.balance
    payment_method = esp32.payment_method

    # Sync ESP32 balance before dispensing (needed for e-payment where no physical bill)
    # Send the post-fee total so ESP32's g_totalMoney matches the DISPENSE total
    esp32.send_command(f"CREDIT:{total}")
    import time as _time
    _time.sleep(0.1)  # give ESP32 a moment to process CREDIT

    esp32.send_command(cmd)
    esp32.balance = 0
    esp32.payment_source = "none"

    # Optimistic deduction: stock is deducted immediately as coins are physically
    # dispensed. If ESP32 reports an error (jam/timeout), admin should use the
    # "Count" feature to re-verify actual hopper contents.
    deduct_stock(int_combo)
    log_transaction(bill_value, int_combo, sum(int_combo.values()), fee=fee, payment_method=payment_method)

    return jsonify({"status": "sent", "command": cmd})


@app.route("/api/simulate_bill", methods=["POST"])
def api_simulate_bill():
    if not esp32.simulate:
        return jsonify({"error": "Only available in simulation mode"}), 403

    if get_maintenance_mode():
        return jsonify({"error": "Machine is under maintenance"}), 503

    data = request.get_json()
    amount = data.get("amount", 0)
    if amount not in [20, 50, 100]:
        return jsonify({"error": "Invalid amount. Use 20, 50, or 100"}), 400

    # Reject if would exceed max balance
    if esp32.balance + amount > 100:
        return jsonify({"error": f"Cannot exceed ₱100 balance (current: ₱{esp32.balance})"}), 400

    esp32.simulate_bill(amount)
    return jsonify({"status": "ok", "balance": esp32.balance})


@app.route("/api/simulate_coin", methods=["POST"])
def api_simulate_coin():
    """Simulate coin insertion (simulation mode only)."""
    if not esp32.simulate:
        return jsonify({"error": "Only available in simulation mode"}), 403

    if get_maintenance_mode():
        return jsonify({"error": "Machine is under maintenance"}), 503

    data = request.get_json()
    amount = data.get("amount", 0)
    if amount not in [1, 5, 10, 20]:
        return jsonify({"error": "Invalid coin. Use 1, 5, 10, or 20"}), 400

    # Reject if would exceed max balance
    if esp32.balance + amount > 100:
        return jsonify({"error": f"Cannot exceed ₱100 balance (current: ₱{esp32.balance})"}), 400

    esp32.simulate_coin(amount)
    return jsonify({"status": "ok", "balance": esp32.balance})


@app.route("/api/epay", methods=["POST"])
def api_epay():
    """E-Payment mockup — simulates GCash/Maya payment received (legacy endpoint)."""
    if get_maintenance_mode():
        return jsonify({"error": "Machine is under maintenance"}), 503

    data = request.get_json()
    method = data.get("method", "")
    amount = data.get("amount", 0)

    if method not in ["gcash", "maya"]:
        return jsonify({"error": "Invalid payment method. Use gcash or maya"}), 400
    if amount not in [20, 50, 100]:
        return jsonify({"error": "Invalid amount. Use 20, 50, or 100"}), 400

    # Reject if would exceed max balance
    if esp32.balance + amount > 100:
        return jsonify({"error": f"Cannot exceed ₱100 balance (current: ₱{esp32.balance})"}), 400

    # Credit the balance same as bill insertion
    esp32.balance += amount
    esp32.payment_method = method
    esp32.payment_source = "epay"
    on_esp32_event("bill", {"amount": amount, "balance": esp32.balance})

    return jsonify({"status": "ok", "balance": esp32.balance, "method": method})


@app.route("/api/epay/initiate", methods=["POST"])
def api_epay_initiate():
    """Initiate a pending e-payment — kiosk shows QR and waits for phone to confirm."""
    global pending_epay

    if get_maintenance_mode():
        return jsonify({"error": "Machine is under maintenance"}), 503

    # No longer requires method/amount — just generates reference
    # Reject if there's already a balance
    if esp32.balance > 0:
        return jsonify({"error": f"Balance already exists (₱{esp32.balance})"}), 400

    # Generate random 12-digit reference number
    ref_number = ''.join([str(random.randint(0, 9)) for _ in range(12)])

    pending_epay = {
        "reference_number": ref_number,
        "timestamp": time.time()
    }

    return jsonify({
        "status": "ok",
        "reference_number": ref_number,
    })


@app.route("/api/epay/pending", methods=["GET"])
def api_epay_pending():
    """Returns current pending e-payment info, or null if none."""
    if pending_epay is None:
        return jsonify(None)
    return jsonify(pending_epay)


@app.route("/api/epay/confirm", methods=["POST"])
def api_epay_confirm():
    """Confirms the pending e-payment — credits balance and notifies kiosk via event.
    Now accepts {method, amount} from the phone side."""
    global pending_epay

    if pending_epay is None:
        return jsonify({"error": "No pending payment"}), 400

    if get_maintenance_mode():
        return jsonify({"error": "Machine is under maintenance"}), 503

    data = request.get_json() or {}
    method = data.get("method", "gcash")
    amount = data.get("amount", 0)

    if method not in ["gcash", "maya"]:
        return jsonify({"error": "Invalid payment method"}), 400
    if amount not in [20, 50, 100]:
        return jsonify({"error": "Invalid amount. Use 20, 50, or 100"}), 400

    # Reject if would exceed max balance
    if esp32.balance + amount > 100:
        pending_epay = None
        return jsonify({"error": f"Cannot exceed ₱100 balance (current: ₱{esp32.balance})"}), 400

    # Credit the balance same as bill insertion
    esp32.balance += amount
    esp32.payment_method = method
    esp32.payment_source = "epay"
    on_esp32_event("bill", {"amount": amount, "balance": esp32.balance})

    # Also fire a specific epay_confirmed event so kiosk JS can react
    on_esp32_event("epay_confirmed", {"method": method, "amount": amount, "balance": esp32.balance})

    # Clear the pending payment
    pending_epay = None

    return jsonify({"status": "ok", "balance": esp32.balance, "method": method, "amount": amount})


@app.route("/api/epay/cancel", methods=["POST"])
def api_epay_cancel():
    """Cancel the pending e-payment."""
    global pending_epay
    pending_epay = None
    return jsonify({"status": "ok"})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    esp32.send_command("RESET")
    esp32.balance = 0
    esp32.payment_method = "cash"
    esp32.payment_source = "none"
    return jsonify({"status": "ok"})


# ── Admin API ────────────────────────────────────────────────────────────────

@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    data = request.get_json()
    pin = data.get("pin", "")
    if verify_pin(pin):
        session["admin"] = True
        return jsonify({"status": "ok"})
    return jsonify({"error": "Invalid PIN"}), 401


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    session.pop("admin", None)
    return jsonify({"status": "ok"})


def require_admin():
    """Check if admin session is active."""
    return session.get("admin", False)


@app.route("/api/admin/stock")
def api_admin_stock():
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    stock = get_stock()
    return jsonify(stock)


@app.route("/api/admin/refill", methods=["POST"])
def api_admin_refill():
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    denom = data.get("denomination")

    if denom == "all":
        refill_all()
    else:
        refill_stock(int(denom))

    return jsonify({"status": "ok", "stock": get_stock()})


@app.route("/api/admin/transactions")
def api_admin_transactions():
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    page = int(request.args.get("page", 1))
    per_page = int(request.args.get("per_page", 20))
    offset = (page - 1) * per_page

    transactions = get_transactions(limit=per_page, offset=offset)
    total = get_transaction_count()

    return jsonify({
        "transactions": transactions,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": (total + per_page - 1) // per_page,
    })


@app.route("/api/admin/summary")
def api_admin_summary():
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    period = request.args.get("period", "week")
    summary = get_summary(period)
    return jsonify(summary)


@app.route("/api/admin/machine")
def api_admin_machine():
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    return jsonify({
        "machine_name": get_setting("machine_name"),
        "esp32_connected": esp32.connected,
        "simulate_mode": esp32.simulate,
        "stock": get_stock(),
        "any_stock": is_any_stock_available(),
    })


@app.route("/api/admin/set_stock", methods=["POST"])
def api_admin_set_stock():
    """Manually set stock count for a denomination (backward compatibility)."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    denom = int(data.get("denomination", 0))
    count = int(data.get("count", 0))

    if denom not in [1, 5, 10, 20]:
        return jsonify({"error": "Invalid denomination"}), 400
    if count < 0:
        return jsonify({"error": "Count cannot be negative"}), 400

    update_stock(denom, count)
    return jsonify({"status": "ok", "stock": get_stock()})


@app.route("/api/admin/add_stock", methods=["POST"])
def api_admin_add_stock():
    """Add coins to a hopper (adds to current count, capped at 1000)."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    denom = int(data.get("denomination", 0))
    amount = int(data.get("amount", 0))

    if denom not in [1, 5, 10, 20]:
        return jsonify({"error": "Invalid denomination"}), 400
    if amount <= 0:
        return jsonify({"error": "Amount must be positive"}), 400

    stock = get_stock()
    current = stock.get(denom, {}).get("current", 0)
    max_capacity = 1000
    new_total = min(current + amount, max_capacity)
    actually_added = new_total - current

    update_stock(denom, new_total)
    log_stock_event(denom, "add", actually_added, new_total)

    return jsonify({
        "status": "ok",
        "previous": current,
        "added": actually_added,
        "new_total": new_total
    })


@app.route("/api/admin/count_coins", methods=["POST"])
def api_admin_count_coins():
    """Start counting coins in a hopper. Sends COUNT:<index> to ESP32."""
    global counting_state
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    denom = int(data.get("denomination", 0))

    if denom not in [1, 5, 10, 20]:
        return jsonify({"error": "Invalid denomination"}), 400

    if counting_state["active"]:
        return jsonify({"error": "Counting already in progress"}), 400

    idx = DENOM_TO_INDEX[denom]
    counting_state = {"active": True, "denomination": denom, "count": 0}

    cmd = f"COUNT:{idx}"
    print(f"[CMD] {cmd}")
    esp32.send_command(cmd)

    return jsonify({"status": "ok", "denomination": denom, "index": idx})


@app.route("/api/admin/count_status")
def api_admin_count_status():
    """Get current counting state."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify(counting_state)


@app.route("/api/admin/count_stop", methods=["POST"])
def api_admin_count_stop():
    """Stop an active coin count."""
    global counting_state
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    if not counting_state["active"]:
        return jsonify({"error": "No active counting"}), 400

    esp32.send_command("COUNT_STOP")
    counting_state["active"] = False
    return jsonify({"status": "ok", "final_count": counting_state["count"]})


@app.route("/api/admin/servo_calibrate", methods=["POST"])
def api_admin_servo_calibrate():
    """Move a servo to a specific angle for calibration. Sends SERVO:<A|B>:<angle> to ESP32."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    servo = data.get("servo", "").upper()
    angle = int(data.get("angle", 90))

    if servo not in ["A", "B"]:
        return jsonify({"error": "Invalid servo. Use A or B"}), 400
    if angle < 0 or angle > 180:
        return jsonify({"error": "Angle must be 0-180"}), 400

    cmd = f"SERVO:{servo}:{angle}"
    print(f"[CMD] {cmd}")
    esp32.send_command(cmd)

    # Update local tracking
    esp32.servo_positions[servo] = angle

    return jsonify({"status": "ok", "servo": servo, "angle": angle})


@app.route("/api/admin/servo_positions")
def api_admin_servo_positions():
    """Get current servo positions and saved calibration values."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    # Request fresh positions from ESP32
    esp32.send_command("SERVO_POS")

    # Load saved positions from database settings
    saved = {
        "A1": int(get_setting("servo_a_pos_1") or 45),
        "A5": int(get_setting("servo_a_pos_5") or 135),
        "B10": int(get_setting("servo_b_pos_10") or 45),
        "B20": int(get_setting("servo_b_pos_20") or 135),
    }

    return jsonify({
        "current": esp32.servo_positions,
        "saved": saved,
    })


@app.route("/api/admin/servo_save_position", methods=["POST"])
def api_admin_servo_save_position():
    """Save a servo position for a specific denomination."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    position_key = data.get("key", "")  # e.g., "A1", "A5", "B10", "B20"
    angle = int(data.get("angle", 90))

    valid_keys = {"A1": "servo_a_pos_1", "A5": "servo_a_pos_5",
                  "B10": "servo_b_pos_10", "B20": "servo_b_pos_20"}

    if position_key not in valid_keys:
        return jsonify({"error": "Invalid position key. Use A1, A5, B10, or B20"}), 400
    if angle < 0 or angle > 180:
        return jsonify({"error": "Angle must be 0-180"}), 400

    set_setting(valid_keys[position_key], str(angle))
    esp32.servo_positions[position_key] = angle
    print(f"[SERVO] Saved {position_key} = {angle}°")

    return jsonify({"status": "ok", "key": position_key, "angle": angle})


@app.route("/api/admin/maintenance", methods=["POST"])
def api_admin_maintenance():
    """Toggle maintenance mode on/off."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    active = data.get("active", None)

    if active is None:
        # Toggle current state
        current = get_maintenance_mode()
        active = not current

    set_maintenance_mode(active)
    return jsonify({"status": "ok", "maintenance_mode": get_maintenance_mode()})


@app.route("/api/admin/coin_fee_toggle", methods=["POST"])
def api_admin_coin_fee_toggle():
    """Toggle coin exchange fee on/off. When off, coin-to-coin exchange is free."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    current = get_setting('coin_fee_enabled')
    new_value = '0' if current == '1' else '1'
    set_setting('coin_fee_enabled', new_value)
    return jsonify({"status": "ok", "coin_fee_enabled": new_value == '1'})


@app.route("/api/admin/coin_fee_status")
def api_admin_coin_fee_status():
    """Get current coin fee enabled status."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    current = get_setting('coin_fee_enabled')
    return jsonify({"coin_fee_enabled": current == '1'})


@app.route("/api/settings/timeout")
def api_settings_timeout():
    """Get timeout settings (public endpoint for kiosk)."""
    timeout_seconds = int(get_setting("timeout_seconds") or 60)
    timeout_action = get_setting("timeout_action") or "largest"
    return jsonify({
        "timeout_seconds": timeout_seconds,
        "timeout_action": timeout_action,
    })


@app.route("/api/admin/timeout_settings", methods=["POST"])
def api_admin_timeout_settings():
    """Save timeout settings (requires admin)."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    timeout_seconds = data.get("timeout_seconds")
    timeout_action = data.get("timeout_action")

    if timeout_seconds is not None:
        timeout_seconds = int(timeout_seconds)
        if timeout_seconds < 30 or timeout_seconds > 300:
            return jsonify({"error": "Timeout must be between 30 and 300 seconds"}), 400
        set_setting("timeout_seconds", str(timeout_seconds))

    if timeout_action is not None:
        if timeout_action not in ("largest", "smallest", "cancel"):
            return jsonify({"error": "Invalid timeout action. Use largest, smallest, or cancel"}), 400
        set_setting("timeout_action", timeout_action)

    return jsonify({
        "status": "ok",
        "timeout_seconds": int(get_setting("timeout_seconds") or 60),
        "timeout_action": get_setting("timeout_action") or "largest",
    })


@app.route("/api/admin/sync_stock", methods=["POST"])
def api_admin_sync_stock():
    """
    Manually sync stock counts — admin enters physical count for each denomination.
    Accepts: {"stock": {"1": 150, "5": 80, "10": 120, "20": 95}}
    """
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    stock_counts = data.get("stock", {})

    if not stock_counts:
        return jsonify({"error": "No stock data provided"}), 400

    for denom_str, count in stock_counts.items():
        denom = int(denom_str)
        count = int(count)
        if denom not in [1, 5, 10, 20]:
            return jsonify({"error": f"Invalid denomination: {denom}"}), 400
        if count < 0:
            return jsonify({"error": f"Count cannot be negative for ₱{denom}"}), 400
        update_stock(denom, count)

    return jsonify({"status": "ok", "stock": get_stock()})


@app.route("/api/admin/change_pin", methods=["POST"])
def api_admin_change_pin():
    """Change the admin PIN."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    new_pin = data.get("new_pin", "")

    if len(new_pin) != 4 or not new_pin.isdigit():
        return jsonify({"error": "PIN must be exactly 4 digits"}), 400

    set_setting("admin_pin", new_pin)
    return jsonify({"status": "ok"})


@app.route("/api/admin/fee_tiers")
def api_admin_fee_tiers():
    """Get current fee tiers."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    tiers = get_fee_tiers()
    return jsonify(tiers)


@app.route("/api/admin/fee_tiers", methods=["POST"])
def api_admin_set_fee_tiers():
    """Update fee tiers."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    tiers = data.get("tiers", [])

    if not tiers:
        return jsonify({"error": "No tiers provided"}), 400

    # Validate tiers
    for t in tiers:
        if "min_amount" not in t or "max_amount" not in t or "fee" not in t:
            return jsonify({"error": "Each tier must have min_amount, max_amount, and fee"}), 400
        if int(t["min_amount"]) > int(t["max_amount"]):
            return jsonify({"error": "min_amount cannot be greater than max_amount"}), 400
        if int(t["fee"]) < 0:
            return jsonify({"error": "Fee cannot be negative"}), 400

    set_fee_tiers(tiers)
    return jsonify({"status": "ok", "tiers": get_fee_tiers()})


@app.route("/api/admin/export_csv")
def api_admin_export_csv():
    """Export transactions as CSV with date range and proper formatting."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    import io

    # Parse date range parameters
    start_date = request.args.get("start_date", None)
    end_date = request.args.get("end_date", None)
    preset = request.args.get("preset", None)

    if preset == "today":
        start_date = datetime.now().strftime("%Y-%m-%d")
        end_date = datetime.now().strftime("%Y-%m-%d")
    elif preset == "week":
        start_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        end_date = datetime.now().strftime("%Y-%m-%d")
    elif preset == "month":
        start_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        end_date = datetime.now().strftime("%Y-%m-%d")

    transactions = get_transactions_by_date(start_date, end_date)
    stock_count_records = get_stock_counts_by_date(start_date, end_date)
    stock_event_records = get_stock_events_by_date(start_date, end_date)

    # Format period string
    if start_date and end_date:
        try:
            s = datetime.strptime(start_date, "%Y-%m-%d")
            e = datetime.strptime(end_date, "%Y-%m-%d")
            period_str = f"{s.strftime('%B %d')}-{e.strftime('%d, %Y')}"
        except ValueError:
            period_str = f"{start_date} to {end_date}"
    else:
        period_str = "All Time"

    generated_str = datetime.now().strftime("%B %d, %Y %I:%M %p")

    output = io.StringIO()
    output.write("CoinVerge Transaction Report\n")
    output.write(f"Period: {period_str}\n")
    output.write(f"Generated: {generated_str}\n")
    output.write("\n")
    output.write("No.,Date/Time,Bill Value,Fee,Coins Dispensed,Total Coins,Payment Method\n")

    total_bills = 0
    total_fees = 0
    total_coins_value = 0
    by_denom = {1: 0, 5: 0, 10: 0, 20: 0}

    for i, tx in enumerate(transactions, 1):
        bill_value = tx['bill_value']
        fee = tx.get('fee', 0)
        coins = tx['coins_dispensed']
        total_c = tx['total_coins']
        method = tx.get('payment_method', 'cash')

        total_bills += bill_value
        total_fees += fee

        # Parse coins_dispensed for denomination breakdown
        parts = coins.split(",")
        for part in parts:
            if "x" in part:
                d, q = part.split("x")
                d, q = int(d), int(q)
                if d in by_denom:
                    by_denom[d] += q
                total_coins_value += d * q

        output.write(f"{i},{tx['timestamp']},₱{bill_value},₱{fee},\"{coins}\",{total_c},{method.capitalize()}\n")

    output.write("\n")
    output.write("SUMMARY\n")
    output.write(f"Total Transactions: {len(transactions)}\n")
    output.write(f"Total Bills Received: ₱{total_bills:,}\n")
    output.write(f"Total Fees Collected: ₱{total_fees:,}\n")
    output.write(f"Total Coins Dispensed: ₱{total_coins_value:,}\n")
    output.write("\n")
    output.write("Breakdown by Denomination:\n")
    for denom in [1, 5, 10, 20]:
        output.write(f"₱{denom}: {by_denom[denom]} coins\n")

    # Stock Counts section
    if stock_count_records:
        output.write("\n")
        output.write("STOCK COUNTS\n")
        output.write("Date/Time,Denomination,Count Result\n")
        for sc in stock_count_records:
            output.write(f"{sc['timestamp']},₱{sc['denomination']},{sc['count_result']} coins\n")

    # Inventory Activity section
    if stock_event_records:
        output.write("\n")
        output.write("INVENTORY ACTIVITY\n")
        output.write("Date/Time,Denomination,Type,Amount,New Total\n")
        for ev in stock_event_records:
            ev_type = ev['type'].capitalize()
            if ev['type'] == 'add':
                output.write(f"{ev['timestamp']},₱{ev['denomination']},Restocked,+{ev['amount']},{ev['new_total']} coins\n")
            else:
                output.write(f"{ev['timestamp']},₱{ev['denomination']},Counted,{ev['amount']},{ev['new_total']} coins\n")

    csv_data = output.getvalue()
    filename = f"coinverge_report_{start_date or 'all'}_{end_date or 'all'}.csv"
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@app.route("/api/admin/export_html")
def api_admin_export_html():
    """Export transactions as a styled HTML report for printing."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    # Parse date range parameters
    start_date = request.args.get("start_date", None)
    end_date = request.args.get("end_date", None)
    preset = request.args.get("preset", None)

    if preset == "today":
        start_date = datetime.now().strftime("%Y-%m-%d")
        end_date = datetime.now().strftime("%Y-%m-%d")
    elif preset == "week":
        start_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        end_date = datetime.now().strftime("%Y-%m-%d")
    elif preset == "month":
        start_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        end_date = datetime.now().strftime("%Y-%m-%d")

    transactions = get_transactions_by_date(start_date, end_date)
    stock_count_records = get_stock_counts_by_date(start_date, end_date)
    stock_event_records = get_stock_events_by_date(start_date, end_date)

    # Format period string
    if start_date and end_date:
        try:
            s = datetime.strptime(start_date, "%Y-%m-%d")
            e = datetime.strptime(end_date, "%Y-%m-%d")
            period_str = f"{s.strftime('%B %d')} – {e.strftime('%B %d, %Y')}"
        except ValueError:
            period_str = f"{start_date} to {end_date}"
    else:
        period_str = "All Time"

    generated_str = datetime.now().strftime("%B %d, %Y %I:%M %p")

    # Calculate totals
    total_bills = 0
    total_fees = 0
    total_coins_value = 0
    by_denom = {1: 0, 5: 0, 10: 0, 20: 0}

    for tx in transactions:
        total_bills += tx['bill_value']
        total_fees += tx.get('fee', 0)
        parts = tx['coins_dispensed'].split(",")
        for part in parts:
            if "x" in part:
                d, q = part.split("x")
                d, q = int(d), int(q)
                if d in by_denom:
                    by_denom[d] += q
                total_coins_value += d * q

    # Build transaction rows
    tx_rows = ""
    for i, tx in enumerate(transactions, 1):
        fee = tx.get('fee', 0)
        method = tx.get('payment_method', 'cash').capitalize()
        row_class = "even" if i % 2 == 0 else "odd"
        tx_rows += f"""<tr class="{row_class}">
            <td>{i}</td>
            <td>{tx['timestamp']}</td>
            <td>₱{tx['bill_value']}</td>
            <td>₱{fee}</td>
            <td>{tx['coins_dispensed']}</td>
            <td>{tx['total_coins']}</td>
            <td>{method}</td>
        </tr>"""

    # Build stock counts rows
    sc_rows = ""
    if stock_count_records:
        for sc in stock_count_records:
            sc_rows += f"""<tr>
                <td>{sc['timestamp']}</td>
                <td>₱{sc['denomination']}</td>
                <td>{sc['count_result']:,} coins</td>
                <td>₱{sc['denomination'] * sc['count_result']:,}</td>
            </tr>"""

    stock_counts_section = ""
    if stock_count_records:
        stock_counts_section = f"""
        <div class="section">
            <h2>Stock Counts</h2>
            <table>
                <thead>
                    <tr><th>Date/Time</th><th>Denomination</th><th>Count</th><th>Value</th></tr>
                </thead>
                <tbody>{sc_rows}</tbody>
            </table>
        </div>
        """

    # Build inventory activity rows
    inv_rows = ""
    if stock_event_records:
        for ev in stock_event_records:
            if ev['type'] == 'add':
                desc = f"+{ev['amount']} coins (total: {ev['new_total']})"
                ev_label = "Restocked"
            else:
                desc = f"{ev['amount']} coins"
                ev_label = "Counted"
            inv_rows += f"""<tr>
                <td>{ev['timestamp']}</td>
                <td>₱{ev['denomination']}</td>
                <td>{ev_label}</td>
                <td>{desc}</td>
            </tr>"""

    inventory_section = ""
    if stock_event_records:
        inventory_section = f"""
        <div class="section">
            <h2>Inventory Activity</h2>
            <table>
                <thead>
                    <tr><th>Date/Time</th><th>Denomination</th><th>Type</th><th>Details</th></tr>
                </thead>
                <tbody>{inv_rows}</tbody>
            </table>
        </div>
        """

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>CoinVerge Report — {period_str}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            color: #1a1a2e; background: #fff; padding: 24px;
            font-size: 11px;
        }}
        .header {{
            background: linear-gradient(135deg, #0038a8 0%, #002060 100%);
            color: #fff; padding: 20px 24px; border-radius: 8px;
            margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;
        }}
        .header h1 {{ font-size: 20px; }}
        .header .subtitle {{ color: #fcd116; font-size: 12px; margin-top: 4px; }}
        .header .logo {{
            width: 48px; height: 48px; border-radius: 50%;
            background: #fcd116; color: #002060;
            display: flex; align-items: center; justify-content: center;
            font-size: 24px; font-weight: 900;
        }}
        .meta {{ color: #555; font-size: 10px; margin-bottom: 16px; text-align: right; }}
        .summary-cards {{
            display: grid; grid-template-columns: repeat(4, 1fr);
            gap: 12px; margin-bottom: 20px;
        }}
        .summary-card {{
            background: #f0f4ff; border: 1px solid #d0d8f0;
            border-radius: 8px; padding: 12px; text-align: center;
        }}
        .summary-card .value {{ font-size: 18px; font-weight: 800; color: #0038a8; }}
        .summary-card .label {{ font-size: 10px; color: #555; margin-top: 4px; }}
        .summary-card.gold {{ background: #fffbea; border-color: #fcd116; }}
        .summary-card.gold .value {{ color: #b8960a; }}
        .denom-grid {{
            display: grid; grid-template-columns: repeat(4, 1fr);
            gap: 8px; margin-bottom: 20px;
        }}
        .denom-item {{
            background: #f8f9ff; border: 1px solid #e0e4f0; border-radius: 6px;
            padding: 10px; text-align: center;
        }}
        .denom-item .denom {{ font-size: 16px; font-weight: 800; color: #0038a8; }}
        .denom-item .count {{ font-size: 11px; color: #555; }}
        .denom-item .bar {{
            height: 4px; background: #e0e4f0; border-radius: 2px; margin-top: 6px; overflow: hidden;
        }}
        .denom-item .bar-fill {{ height: 100%; background: #fcd116; border-radius: 2px; }}
        .section {{ margin-bottom: 20px; }}
        .section h2 {{
            font-size: 13px; color: #0038a8; border-bottom: 2px solid #fcd116;
            padding-bottom: 4px; margin-bottom: 10px;
        }}
        table {{ width: 100%; border-collapse: collapse; font-size: 10px; }}
        th {{
            background: #0038a8; color: #fff; padding: 6px 8px;
            text-align: left; font-weight: 600;
        }}
        td {{ padding: 5px 8px; border-bottom: 1px solid #e8ecf0; }}
        tr.even {{ background: #f8f9ff; }}
        tr.odd {{ background: #fff; }}
        .footer {{
            margin-top: 24px; padding-top: 12px; border-top: 1px solid #e0e4f0;
            text-align: center; color: #888; font-size: 9px;
        }}
        @media print {{
            body {{ padding: 12px; }}
            .header {{ page-break-after: avoid; }}
            table {{ page-break-inside: auto; }}
            tr {{ page-break-inside: avoid; }}
        }}
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>CoinVerge</h1>
            <div class="subtitle">Transaction Report — {period_str}</div>
        </div>
        <div class="logo">₱</div>
    </div>
    <div class="meta">Generated: {generated_str}</div>

    <div class="summary-cards">
        <div class="summary-card">
            <div class="value">{len(transactions)}</div>
            <div class="label">Transactions</div>
        </div>
        <div class="summary-card">
            <div class="value">₱{total_bills:,}</div>
            <div class="label">Bills Received</div>
        </div>
        <div class="summary-card gold">
            <div class="value">₱{total_fees:,}</div>
            <div class="label">Fees Collected</div>
        </div>
        <div class="summary-card">
            <div class="value">₱{total_coins_value:,}</div>
            <div class="label">Coins Dispensed</div>
        </div>
    </div>

    <div class="section">
        <h2>Denomination Breakdown</h2>
        <div class="denom-grid">
            <div class="denom-item">
                <div class="denom">₱1</div>
                <div class="count">{by_denom[1]:,} coins</div>
                <div class="bar"><div class="bar-fill" style="width:{min(100, (by_denom[1] / max(1, max(by_denom.values()))) * 100):.0f}%"></div></div>
            </div>
            <div class="denom-item">
                <div class="denom">₱5</div>
                <div class="count">{by_denom[5]:,} coins</div>
                <div class="bar"><div class="bar-fill" style="width:{min(100, (by_denom[5] / max(1, max(by_denom.values()))) * 100):.0f}%"></div></div>
            </div>
            <div class="denom-item">
                <div class="denom">₱10</div>
                <div class="count">{by_denom[10]:,} coins</div>
                <div class="bar"><div class="bar-fill" style="width:{min(100, (by_denom[10] / max(1, max(by_denom.values()))) * 100):.0f}%"></div></div>
            </div>
            <div class="denom-item">
                <div class="denom">₱20</div>
                <div class="count">{by_denom[20]:,} coins</div>
                <div class="bar"><div class="bar-fill" style="width:{min(100, (by_denom[20] / max(1, max(by_denom.values()))) * 100):.0f}%"></div></div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Transaction Details</h2>
        <table>
            <thead>
                <tr><th>#</th><th>Date/Time</th><th>Bill</th><th>Fee</th><th>Coins</th><th>Total</th><th>Method</th></tr>
            </thead>
            <tbody>{tx_rows if tx_rows else '<tr><td colspan="7" style="text-align:center;color:#888">No transactions in this period</td></tr>'}</tbody>
        </table>
    </div>

    {stock_counts_section}

    {inventory_section}

    <div class="footer">
        CoinVerge Coin Exchange Kiosk System • Report generated {generated_str}
    </div>
</body>
</html>"""

    return Response(html, mimetype="text/html")


@app.route("/api/admin/stock_counts")
def api_admin_stock_counts():
    """Get recent stock count records."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    limit = int(request.args.get("limit", 20))
    counts = get_stock_counts(limit)
    return jsonify(counts)


@app.route("/api/admin/stock_events")
def api_admin_stock_events():
    """Get recent stock events (add and count)."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401
    limit = int(request.args.get("limit", 20))
    events = get_stock_events(limit)
    return jsonify(events)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    global esp32

    parser = argparse.ArgumentParser(description="CoinVerge Kiosk System")
    parser.add_argument("--simulate", action="store_true", help="Run without hardware")
    parser.add_argument("--port", type=str, default=None, help="Serial port")
    parser.add_argument("--kiosk", action="store_true", help="Launch Chromium kiosk")
    parser.add_argument("--host", type=str, default="0.0.0.0")
    parser.add_argument("--web-port", type=int, default=8080)
    args = parser.parse_args()

    # Initialize database
    init_db()

    # Initialize ESP32 connection
    esp32 = ESP32Connection(port=args.port, simulate=args.simulate)
    esp32.add_listener(on_esp32_event)

    print(f"\n{'='*50}")
    print(f"  CoinVerge Kiosk System")
    print(f"  User UI:  http://localhost:{args.web_port}")
    print(f"  Admin:    http://localhost:{args.web_port}/admin")
    print(f"  Phone:    http://localhost:{args.web_port}/phone")
    print(f"  Mode:     {'SIMULATION' if args.simulate else 'HARDWARE'}")
    print(f"  Admin PIN: {get_setting('admin_pin')}")
    print(f"{'='*50}\n")

    if args.kiosk:
        import subprocess
        url = f"http://localhost:{args.web_port}"
        subprocess.Popen([
            "chromium-browser", "--kiosk", "--noerrdialogs",
            "--disable-infobars", "--no-first-run", url
        ])

    app.run(host=args.host, port=args.web_port, debug=False)


if __name__ == "__main__":
    main()
