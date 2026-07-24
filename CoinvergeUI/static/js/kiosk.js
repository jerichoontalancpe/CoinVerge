/* ═══════════════════════════════════════════════════════════════════════════
   CoinVerge — Kiosk Frontend Logic
   ═══════════════════════════════════════════════════════════════════════════ */

const DENOMS = [1, 5, 10, 20];
const TIMEOUT_MS = 60000; // 60 seconds inactivity timeout on picker

const state = {
    screen: "idle",
    balance: 0,
    simulate: false,
    stock: { 1: 200, 5: 200, 10: 200, 20: 200 },
    selection: { 1: 0, 5: 0, 10: 0, 20: 0 },
    lastEventTime: 0,
    adminTaps: 0,
    adminTimer: null,
    inactivityTimer: null,
    lastDispense: null, // stores what was dispensed for Done screen
};

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
    await fetchStatus();
    setInterval(pollEvents, 600);
});

async function fetchStatus() {
    try {
        const res = await fetch("/api/status");
        const data = await res.json();
        state.simulate = data.simulate;
        state.balance = data.balance;
        state.stock = {};
        for (const [k, v] of Object.entries(data.stock)) {
            state.stock[parseInt(k)] = v;
        }

        if (state.simulate) {
            document.getElementById("sim-controls").classList.remove("hidden");
        }

        if (!data.any_stock) {
            showScreen("empty");
        } else if (state.balance > 0) {
            showPicker();
        }
    } catch (e) { /* retry on next poll */ }
}

async function refreshStock() {
    try {
        const res = await fetch("/api/status");
        const data = await res.json();
        state.stock = {};
        for (const [k, v] of Object.entries(data.stock)) {
            state.stock[parseInt(k)] = v;
        }
    } catch (e) { /* use cached */ }
}

// ── Event Polling ───────────────────────────────────────────────────────────

async function pollEvents() {
    try {
        const res = await fetch(`/api/events?since=${state.lastEventTime}`);
        const events = await res.json();
        for (const ev of events) {
            state.lastEventTime = ev.time;
            handleEvent(ev);
        }
    } catch (e) { /* silent */ }
}

function handleEvent(ev) {
    switch (ev.type) {
        case "bill":
            state.balance = ev.data.balance;
            if (state.screen === "idle" || state.screen === "empty") {
                showPicker();
            } else if (state.screen === "picker") {
                // Another bill inserted — reset selection since balance changed
                resetSelection();
                updateBalanceDisplay();
                updateStockDisplay();
                updateRemaining();
                updateConfirm();
                resetInactivityTimer();
            }
            break;
        case "dispensed":
            if (ev.data.status === "ok") {
                showDone();
            } else {
                toast("Dispense error: " + (ev.data.reason || "Unknown"));
                showPicker();
            }
            break;
        case "reset":
            state.balance = 0;
            showScreen("idle");
            break;
    }
}

// ── Screen Management ───────────────────────────────────────────────────────

function showScreen(name) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(`screen-${name}`).classList.add("active");
    state.screen = name;

    // Clear inactivity timer when leaving picker
    if (name !== "picker") {
        clearTimeout(state.inactivityTimer);
    }
}

async function showPicker() {
    await refreshStock();
    resetSelection();
    updateBalanceDisplay();
    updateStockDisplay();
    updateRemaining();
    updateConfirm();
    showScreen("picker");
    resetInactivityTimer();
}

function showDone() {
    showScreen("done");

    // Show dispense summary
    const summaryEl = document.getElementById("done-summary");
    if (state.lastDispense && summaryEl) {
        const parts = [];
        for (const d of DENOMS) {
            const qty = state.lastDispense[d];
            if (qty && qty > 0) parts.push(`${qty} × ₱${d}`);
        }
        summaryEl.textContent = parts.join(", ");
    }

    let sec = 5;
    const el = document.getElementById("done-countdown");
    el.textContent = sec;
    const timer = setInterval(() => {
        sec--;
        el.textContent = sec;
        if (sec <= 0) {
            clearInterval(timer);
            state.balance = 0;
            state.lastDispense = null;
            fetchStatus();
            showScreen("idle");
        }
    }, 1000);
}

// ── Inactivity Timeout ──────────────────────────────────────────────────────

function resetInactivityTimer() {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = setTimeout(() => {
        if (state.screen === "picker") {
            // Auto-cancel after 60s of no interaction
            toast("Session timed out");
            cancelTransaction();
        }
    }, TIMEOUT_MS);
}

// ── Picker Logic ────────────────────────────────────────────────────────────

function adjust(denom, delta) {
    resetInactivityTimer();

    const newVal = state.selection[denom] + delta;
    if (newVal < 0) return;
    if (newVal > state.stock[denom]) return;

    if (delta > 0) {
        const total = getTotal();
        if (total + denom > state.balance) return;
    }

    state.selection[denom] = newVal;
    updateCoinCard(denom);
    updateRemaining();
    updateConfirm();
}

function getTotal() {
    let t = 0;
    for (const d of DENOMS) t += d * state.selection[d];
    return t;
}

function updateCoinCard(d) {
    document.getElementById(`count-${d}`).textContent = state.selection[d];
    document.getElementById(`sub-${d}`).textContent = `₱${d * state.selection[d]}`;
    const card = document.getElementById(`card-${d}`);
    card.classList.toggle("active", state.selection[d] > 0);
}

function updateBalanceDisplay() {
    document.getElementById("bal-amount").textContent = `₱${state.balance}`;
}

function updateStockDisplay() {
    for (const d of DENOMS) {
        const count = state.stock[d] || 0;
        document.getElementById(`stock-${d}`).textContent = `${count} pcs`;
        const card = document.getElementById(`card-${d}`);
        card.classList.toggle("disabled", count === 0);
    }
}

function updateRemaining() {
    const rem = state.balance - getTotal();
    const el = document.getElementById("rem-amount");
    el.textContent = `₱${rem}`;
    el.className = "rem-value " + (rem === 0 ? "zero" : "nonzero");
}

function updateConfirm() {
    const btn = document.getElementById("btn-confirm");
    const rem = state.balance - getTotal();
    btn.classList.toggle("disabled", rem !== 0 || getTotal() === 0);
}

function resetSelection() {
    for (const d of DENOMS) {
        state.selection[d] = 0;
        updateCoinCard(d);
    }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function confirmDispense() {
    if (state.balance - getTotal() !== 0) return;
    if (getTotal() === 0) return;

    resetInactivityTimer();

    const combo = {};
    for (const d of DENOMS) {
        if (state.selection[d] > 0) combo[d] = state.selection[d];
    }

    // Save for Done screen summary
    state.lastDispense = { ...state.selection };

    showScreen("dispensing");

    try {
        const res = await fetch("/api/dispense", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ combination: combo }),
        });
        const data = await res.json();
        if (!res.ok) {
            toast(data.error || "Dispense failed");
            showPicker();
            return;
        }
        // Wait for DISPENSED:OK event from polling or fallback timeout
        setTimeout(() => {
            if (state.screen === "dispensing") showDone();
        }, 5000);
    } catch (e) {
        toast("Connection error");
        showPicker();
    }
}

async function cancelTransaction() {
    clearTimeout(state.inactivityTimer);
    await fetch("/api/reset", { method: "POST" });
    state.balance = 0;
    resetSelection();
    showScreen("idle");
}

// ── Simulation ──────────────────────────────────────────────────────────────

async function simulateBill(amount) {
    try {
        const res = await fetch("/api/simulate_bill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount }),
        });
        const data = await res.json();
        if (res.ok) {
            state.balance = data.balance;
            showPicker();
        }
    } catch (e) { toast("Simulation error"); }
}

// ── Admin Tap (5 taps on top-right corner) ──────────────────────────────────

function adminTap() {
    state.adminTaps++;
    clearTimeout(state.adminTimer);
    state.adminTimer = setTimeout(() => { state.adminTaps = 0; }, 2000);
    if (state.adminTaps >= 5) {
        state.adminTaps = 0;
        window.location = "/admin";
    }
}

// ── Toast ───────────────────────────────────────────────────────────────────

function toast(msg) {
    const el = document.getElementById("toast");
    document.getElementById("toast-msg").textContent = msg;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 3000);
}
