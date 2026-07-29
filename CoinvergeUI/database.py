"""
CoinVerge — Database Models (SQLite)
Tracks transactions, coin stock, fee tiers, and admin settings.
"""

import sqlite3
import os
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coinverge.db")

# Refill threshold — denominations below this count trigger warnings
REFILL_THRESHOLD = 20

# Default fee tiers: (min_amount, max_amount, fee)
DEFAULT_FEE_TIERS = [
    (20, 49, 2),
    (50, 99, 3),
    (100, 100, 5),
]


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
            fee INTEGER NOT NULL DEFAULT 0,
            coins_dispensed TEXT NOT NULL,
            total_coins INTEGER NOT NULL,
            payment_method TEXT NOT NULL DEFAULT 'cash',
            status TEXT NOT NULL DEFAULT 'completed'
        );

        CREATE TABLE IF NOT EXISTS stock (
            denomination INTEGER PRIMARY KEY,
            current_count INTEGER NOT NULL DEFAULT 0,
            max_capacity INTEGER NOT NULL DEFAULT 1000
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS fee_tiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            min_amount INTEGER NOT NULL,
            max_amount INTEGER NOT NULL,
            fee INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stock_counts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            denomination INTEGER NOT NULL,
            count_result INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stock_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            denomination INTEGER NOT NULL,
            type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            new_total INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_timestamp
            ON transactions(timestamp);
        CREATE INDEX IF NOT EXISTS idx_stock_counts_timestamp
            ON stock_counts(timestamp);
        CREATE INDEX IF NOT EXISTS idx_stock_events_timestamp
            ON stock_events(timestamp);
    """)

    # Add fee column if upgrading from old schema
    try:
        conn.execute("SELECT fee FROM transactions LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE transactions ADD COLUMN fee INTEGER NOT NULL DEFAULT 0")

    # Add payment_method column if upgrading from old schema
    try:
        conn.execute("SELECT payment_method FROM transactions LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE transactions ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'")

    # Initialize stock if empty
    cursor = conn.execute("SELECT COUNT(*) FROM stock")
    if cursor.fetchone()[0] == 0:
        conn.executemany("INSERT INTO stock (denomination, current_count, max_capacity) VALUES (?, ?, ?)", [
            (1, 1000, 1000),
            (5, 1000, 1000),
            (10, 1000, 1000),
            (20, 1000, 1000),
        ])
    else:
        # Update max_capacity to 1000 for existing databases
        conn.execute("UPDATE stock SET max_capacity = 1000")
        # Cap current_count at max_capacity
        conn.execute("UPDATE stock SET current_count = 1000 WHERE current_count > 1000")

    # Initialize fee tiers if empty
    cursor = conn.execute("SELECT COUNT(*) FROM fee_tiers")
    if cursor.fetchone()[0] == 0:
        conn.executemany("INSERT INTO fee_tiers (min_amount, max_amount, fee) VALUES (?, ?, ?)",
                         DEFAULT_FEE_TIERS)

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


# ── Fee Tier Functions ───────────────────────────────────────────────────────

def get_fee(amount):
    """Get the fee for a given amount based on fee tiers."""
    conn = get_db()
    row = conn.execute(
        "SELECT fee FROM fee_tiers WHERE ? >= min_amount AND ? <= max_amount ORDER BY min_amount LIMIT 1",
        (amount, amount)
    ).fetchone()
    conn.close()
    if row:
        return row["fee"]
    return 0


def get_fee_tiers():
    """Get all fee tiers."""
    conn = get_db()
    rows = conn.execute("SELECT * FROM fee_tiers ORDER BY min_amount").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_fee_tiers(tiers):
    """
    Replace all fee tiers with new ones.
    tiers: list of dicts [{"min_amount": 20, "max_amount": 49, "fee": 2}, ...]
    """
    conn = get_db()
    conn.execute("DELETE FROM fee_tiers")
    for t in tiers:
        conn.execute(
            "INSERT INTO fee_tiers (min_amount, max_amount, fee) VALUES (?, ?, ?)",
            (t["min_amount"], t["max_amount"], t["fee"])
        )
    conn.commit()
    conn.close()


# ── Transaction Functions ────────────────────────────────────────────────────

def log_transaction(bill_value, coins_dispensed, total_coins, fee=0, payment_method="cash"):
    """
    Log a completed transaction.
    coins_dispensed: dict like {1: 10, 5: 4, 10: 2, 20: 1}
    """
    conn = get_db()
    coins_str = ",".join(f"{d}x{q}" for d, q in sorted(coins_dispensed.items()) if q > 0)
    conn.execute(
        "INSERT INTO transactions (bill_value, fee, coins_dispensed, total_coins, payment_method, status) VALUES (?, ?, ?, ?, ?, ?)",
        (bill_value, fee, coins_str, total_coins, payment_method, "completed")
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


def get_transactions_by_date(start_date=None, end_date=None, limit=10000):
    """Get transactions within a date range."""
    conn = get_db()
    if start_date and end_date:
        rows = conn.execute(
            "SELECT * FROM transactions WHERE timestamp >= ? AND timestamp <= ? AND status = 'completed' ORDER BY timestamp DESC LIMIT ?",
            (start_date, end_date + " 23:59:59", limit)
        ).fetchall()
    elif start_date:
        rows = conn.execute(
            "SELECT * FROM transactions WHERE timestamp >= ? AND status = 'completed' ORDER BY timestamp DESC LIMIT ?",
            (start_date, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM transactions WHERE status = 'completed' ORDER BY timestamp DESC LIMIT ?",
            (limit,)
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
    Returns: {total_transactions, total_bill_value, total_coins_dispensed, total_fees, by_denomination}
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
    total_fees = sum(r["fee"] for r in rows)

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
        "total_fees": total_fees,
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


# ── Stock Count Functions ────────────────────────────────────────────────────

def log_stock_count(denomination, count_result):
    """Log a stock count operation."""
    conn = get_db()
    conn.execute(
        "INSERT INTO stock_counts (denomination, count_result) VALUES (?, ?)",
        (denomination, count_result)
    )
    conn.commit()
    conn.close()


def get_stock_counts(limit=20):
    """Get recent stock count records."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM stock_counts ORDER BY timestamp DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_stock_counts_by_date(start_date=None, end_date=None):
    """Get stock counts within a date range."""
    conn = get_db()
    if start_date and end_date:
        rows = conn.execute(
            "SELECT * FROM stock_counts WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
            (start_date, end_date + " 23:59:59")
        ).fetchall()
    elif start_date:
        rows = conn.execute(
            "SELECT * FROM stock_counts WHERE timestamp >= ? ORDER BY timestamp DESC",
            (start_date,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM stock_counts ORDER BY timestamp DESC"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Stock Event Functions ────────────────────────────────────────────────────

def log_stock_event(denomination, event_type, amount, new_total):
    """Log a stock event (add or count)."""
    conn = get_db()
    conn.execute(
        "INSERT INTO stock_events (denomination, type, amount, new_total) VALUES (?, ?, ?, ?)",
        (denomination, event_type, amount, new_total)
    )
    conn.commit()
    conn.close()


def get_stock_events(limit=20):
    """Get recent stock events."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM stock_events ORDER BY timestamp DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_stock_events_by_date(start_date=None, end_date=None):
    """Get stock events within a date range."""
    conn = get_db()
    if start_date and end_date:
        rows = conn.execute(
            "SELECT * FROM stock_events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
            (start_date, end_date + " 23:59:59")
        ).fetchall()
    elif start_date:
        rows = conn.execute(
            "SELECT * FROM stock_events WHERE timestamp >= ? ORDER BY timestamp DESC",
            (start_date,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM stock_events ORDER BY timestamp DESC"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
