"""
CoinVerge — Database Models (SQLite)
Tracks transactions, coin stock, and admin settings.
"""

import sqlite3
import os
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coinverge.db")

# Refill threshold — denominations below this count trigger warnings
REFILL_THRESHOLD = 20


def get_db():
    """Get a database connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """Create tables if they don't exist."""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            bill_value INTEGER NOT NULL,
            coins_dispensed TEXT NOT NULL,
            total_coins INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed'
        );

        CREATE TABLE IF NOT EXISTS stock (
            denomination INTEGER PRIMARY KEY,
            current_count INTEGER NOT NULL DEFAULT 0,
            max_capacity INTEGER NOT NULL DEFAULT 200
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_timestamp
            ON transactions(timestamp);
    """)

    # Initialize stock if empty
    cursor = conn.execute("SELECT COUNT(*) FROM stock")
    if cursor.fetchone()[0] == 0:
        conn.executemany("INSERT INTO stock (denomination, current_count, max_capacity) VALUES (?, ?, ?)", [
            (1, 200, 200),
            (5, 200, 200),
            (10, 200, 200),
            (20, 200, 200),
        ])

    # Initialize settings if empty
    cursor = conn.execute("SELECT COUNT(*) FROM settings")
    if cursor.fetchone()[0] == 0:
        conn.executemany("INSERT INTO settings (key, value) VALUES (?, ?)", [
            ("admin_pin", "1234"),
            ("machine_name", "CoinVerge Unit 1"),
            ("maintenance_mode", "0"),
        ])
    else:
        # Ensure maintenance_mode exists (for upgrades)
        row = conn.execute("SELECT value FROM settings WHERE key = 'maintenance_mode'").fetchone()
        if row is None:
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", ("maintenance_mode", "0"))

    conn.commit()
    conn.close()


# ── Transaction Functions ────────────────────────────────────────────────────

def log_transaction(bill_value, coins_dispensed, total_coins):
    """
    Log a completed transaction.
    coins_dispensed: dict like {1: 10, 5: 4, 10: 2, 20: 1}
    """
    conn = get_db()
    coins_str = ",".join(f"{d}x{q}" for d, q in sorted(coins_dispensed.items()) if q > 0)
    conn.execute(
        "INSERT INTO transactions (bill_value, coins_dispensed, total_coins, status) VALUES (?, ?, ?, ?)",
        (bill_value, coins_str, total_coins, "completed")
    )
    conn.commit()
    conn.close()


def get_transactions(limit=50, offset=0):
    """Get recent transactions."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        (limit, offset)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_transaction_count():
    """Get total number of transactions."""
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    conn.close()
    return count


def get_summary(period="week"):
    """
    Get transaction summary for a period.
    period: 'week', 'month', 'today'
    Returns: {total_transactions, total_bill_value, total_coins_dispensed, by_denomination}
    """
    conn = get_db()

    if period == "today":
        start = datetime.now().strftime("%Y-%m-%d 00:00:00")
    elif period == "week":
        start = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    elif period == "month":
        start = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
    else:
        start = "2000-01-01 00:00:00"

    rows = conn.execute(
        "SELECT * FROM transactions WHERE timestamp >= ? AND status = 'completed'",
        (start,)
    ).fetchall()
    conn.close()

    total_transactions = len(rows)
    total_bill_value = sum(r["bill_value"] for r in rows)
    total_coins = sum(r["total_coins"] for r in rows)

    # Count by denomination
    by_denom = {1: 0, 5: 0, 10: 0, 20: 0}
    for r in rows:
        parts = r["coins_dispensed"].split(",")
        for part in parts:
            if "x" in part:
                d, q = part.split("x")
                d, q = int(d), int(q)
                if d in by_denom:
                    by_denom[d] += q

    return {
        "period": period,
        "total_transactions": total_transactions,
        "total_bill_value": total_bill_value,
        "total_coins_dispensed": total_coins,
        "by_denomination": by_denom,
    }


# ── Stock Functions ──────────────────────────────────────────────────────────

def get_stock():
    """Get current coin stock levels."""
    conn = get_db()
    rows = conn.execute("SELECT * FROM stock ORDER BY denomination").fetchall()
    conn.close()
    return {r["denomination"]: {"current": r["current_count"], "max": r["max_capacity"]} for r in rows}


def update_stock(denomination, count):
    """Set stock for a denomination."""
    conn = get_db()
    conn.execute(
        "UPDATE stock SET current_count = ? WHERE denomination = ?",
        (count, denomination)
    )
    conn.commit()
    conn.close()


def deduct_stock(coins_dispensed):
    """Deduct dispensed coins from stock. coins_dispensed: dict {denom: qty}"""
    conn = get_db()
    for denom, qty in coins_dispensed.items():
        if qty > 0:
            conn.execute(
                "UPDATE stock SET current_count = MAX(0, current_count - ?) WHERE denomination = ?",
                (qty, denom)
            )
    conn.commit()
    conn.close()


def refill_stock(denomination, amount=None):
    """Refill a hopper. If amount is None, refill to max."""
    conn = get_db()
    if amount is None:
        conn.execute(
            "UPDATE stock SET current_count = max_capacity WHERE denomination = ?",
            (denomination,)
        )
    else:
        conn.execute(
            "UPDATE stock SET current_count = MIN(max_capacity, current_count + ?) WHERE denomination = ?",
            (amount, denomination)
        )
    conn.commit()
    conn.close()


def refill_all():
    """Refill all hoppers to max."""
    conn = get_db()
    conn.execute("UPDATE stock SET current_count = max_capacity")
    conn.commit()
    conn.close()


def is_any_stock_available():
    """Check if at least one denomination has stock."""
    conn = get_db()
    count = conn.execute("SELECT SUM(current_count) FROM stock").fetchone()[0]
    conn.close()
    return (count or 0) > 0


# ── Settings Functions ───────────────────────────────────────────────────────

def get_setting(key):
    """Get a setting value."""
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else None


def set_setting(key, value):
    """Update a setting."""
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        (key, value)
    )
    conn.commit()
    conn.close()


def verify_pin(pin):
    """Verify admin PIN."""
    stored_pin = get_setting("admin_pin")
    return pin == stored_pin


# ── Maintenance Mode Functions ───────────────────────────────────────────────

def get_maintenance_mode():
    """Get maintenance mode status. Returns True if maintenance is active."""
    val = get_setting("maintenance_mode")
    return val == "1"


def set_maintenance_mode(active):
    """Set maintenance mode on or off. active: bool."""
    set_setting("maintenance_mode", "1" if active else "0")


# ── Low Stock Functions ──────────────────────────────────────────────────────

def get_low_stock_denominations():
    """Return list of denominations below REFILL_THRESHOLD."""
    stock = get_stock()
    low = []
    for denom, info in stock.items():
        if info["current"] < REFILL_THRESHOLD:
            low.append(denom)
    return low
