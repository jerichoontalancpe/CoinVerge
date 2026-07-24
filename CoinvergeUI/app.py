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
import threading
import time
import sys
from flask import Flask, render_template, jsonify, request, session
from database import (
    init_db, log_transaction, get_transactions, get_transaction_count,
    get_summary, get_stock, update_stock, deduct_stock, refill_stock,
    refill_all, is_any_stock_available, verify_pin, get_setting, set_setting,
    get_maintenance_mode, set_maintenance_mode, get_low_stock_denominations,
    REFILL_THRESHOLD
)

# ── ESP32 Serial Connection ──────────────────────────────────────────────────

class ESP32Connection:
    """Manages serial communication with the ESP32."""

    def __init__(self, port=None, simulate=False):
        self.simulate = simulate
        self.serial_port = None
        self.lock = threading.Lock()
        self.balance = 0
        self.connected = False
        self._listeners = []

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
        print(f"[ESP32] {line}")

        if line.startswith("BILL:"):
            try:
                amount = int(line.split(":")[1])
                self.balance += amount
                self._notify("bill", {"amount": amount, "balance": self.balance})
            except ValueError:
                pass
        elif line == "DISPENSED:OK":
            self._notify("dispensed", {"status": "ok"})
        elif line.startswith("DISPENSED:ERROR"):
            reason = line.split(":", 2)[2] if line.count(":") >= 2 else "unknown"
            self._notify("dispensed", {"status": "error", "reason": reason})
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
        cmd_upper = cmd.upper()
        if cmd_upper.startswith("DISPENSE:"):
            # Simulate 2-second dispensing delay
            threading.Timer(2.0, lambda: self._notify("dispensed", {"status": "ok"})).start()
            return True
        elif cmd_upper == "RESET":
            self.balance = 0
            return True
        return False

    def simulate_bill(self, amount):
        if amount > 0:
            self.balance += amount
            self._notify("bill", {"amount": amount, "balance": self.balance})
            return True
        return False


# ── Flask App ────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.secret_key = "coinverge-secret-key-change-in-production"

esp32 = None
event_queue = []
event_lock = threading.Lock()


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


# ── User API ─────────────────────────────────────────────────────────────────

@app.route("/api/status")
def api_status():
    stock = get_stock()
    low_stock = get_low_stock_denominations()
    maintenance = get_maintenance_mode()
    return jsonify({
        "connected": esp32.connected,
        "simulate": esp32.simulate,
        "balance": esp32.balance,
        "stock": {str(d): s["current"] for d, s in stock.items()},
        "any_stock": is_any_stock_available(),
        "maintenance_mode": maintenance,
        "low_stock": low_stock,
        "refill_threshold": REFILL_THRESHOLD,
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

    # Validate total
    total = 0
    int_combo = {}
    for denom, qty in combo.items():
        d, q = int(denom), int(qty)
        if q > 0:
            total += d * q
            int_combo[d] = q

    if total != esp32.balance:
        return jsonify({"error": f"Total ₱{total} doesn't match balance ₱{esp32.balance}"}), 400

    if not int_combo:
        return jsonify({"error": "No coins selected"}), 400

    # Check stock
    stock = get_stock()
    for denom, qty in int_combo.items():
        available = stock.get(denom, {}).get("current", 0)
        if qty > available:
            return jsonify({"error": f"Not enough ₱{denom} coins (need {qty}, have {available})"}), 400

    # Build and send command
    parts = [f"{d}x{q}" for d, q in sorted(int_combo.items())]
    cmd = "DISPENSE:" + ",".join(parts)
    print(f"[CMD] {cmd}")

    bill_value = esp32.balance

    # Store pending transaction (will be committed when ESP32 confirms)
    esp32.pending_dispense = {
        "bill_value": bill_value,
        "combo": int_combo,
        "total_coins": sum(int_combo.values()),
    }

    esp32.send_command(cmd)
    esp32.balance = 0

    # Deduct stock immediately (optimistic — coins are physically leaving)
    # If ESP32 reports error, admin can manually adjust stock
    deduct_stock(int_combo)
    log_transaction(bill_value, int_combo, sum(int_combo.values()))

    return jsonify({"status": "sent", "command": cmd})


@app.route("/api/simulate_bill", methods=["POST"])
def api_simulate_bill():
    if not esp32.simulate:
        return jsonify({"error": "Only available in simulation mode"}), 403

    data = request.get_json()
    amount = data.get("amount", 0)
    if amount not in [20, 50, 100]:
        return jsonify({"error": "Invalid amount. Use 20, 50, or 100"}), 400

    # Reject if would exceed max balance
    if esp32.balance + amount > 100:
        return jsonify({"error": f"Cannot exceed ₱100 balance (current: ₱{esp32.balance})"}), 400

    esp32.simulate_bill(amount)
    return jsonify({"status": "ok", "balance": esp32.balance})


@app.route("/api/epay", methods=["POST"])
def api_epay():
    """E-Payment mockup — simulates GCash/Maya payment received."""
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
    on_esp32_event("bill", {"amount": amount, "balance": esp32.balance})

    return jsonify({"status": "ok", "balance": esp32.balance, "method": method})


@app.route("/api/reset", methods=["POST"])
def api_reset():
    esp32.send_command("RESET")
    esp32.balance = 0
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
    """Manually set stock count for a denomination."""
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


@app.route("/api/admin/export_csv")
def api_admin_export_csv():
    """Export all transactions as CSV download."""
    if not require_admin():
        return jsonify({"error": "Unauthorized"}), 401

    from flask import Response
    import io

    transactions = get_transactions(limit=10000, offset=0)

    output = io.StringIO()
    output.write("ID,Timestamp,Bill Value (PHP),Coins Dispensed,Total Coins,Status\n")
    for tx in transactions:
        output.write(f"{tx['id']},{tx['timestamp']},{tx['bill_value']},\"{tx['coins_dispensed']}\",{tx['total_coins']},{tx['status']}\n")

    csv_data = output.getvalue()
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=coinverge_transactions.csv"}
    )


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
