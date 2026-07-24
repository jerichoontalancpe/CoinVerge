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
    maintenanceMode: false,
    lowStock: [],
    epayMethod: null,
    epayAmount: null,
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
        state.maintenanceMode = data.maintenance_mode || false;
        state.lowStock = data.low_stock || [];
        state.stock = {};
        for (const [k, v] of Object.entries(data.stock)) {
            state.stock[parseInt(k)] = v;
        }

        if (state.simulate) {
            document.getElementById("sim-controls").classList.remove("hidden");
        }

        // Show unavailable screen if no stock or maintenance mode
        if (!data.any_stock || data.maintenance_mode) {
            showUnavailable(data.maintenance_mode, !data.any_stock);
        } else if (state.balance > 0) {
            showPicker();
        } else {
            // Update low stock banner on idle
            updateLowStockBanner();
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
        state.maintenanceMode = data.maintenance_mode || false;
        state.lowStock = data.low_stock || [];
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
            // Ignore bills during maintenance mode
            if (state.maintenanceMode) {
                toast("Machine under maintenance");
                break;
            }
            // Cap balance at ₱100 on UI side (ESP32 also enforces this)
            if (ev.data.balance > 100) {
                toast("Maximum ₱100 reached");
                break;
            }
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

function quickSelect(denom) {
    resetInactivityTimer();
    resetSelection();

    // Fill as many of this denomination as possible
    const maxByBalance = Math.floor(state.balance / denom);
    const maxByStock = state.stock[denom] || 0;
    const qty = Math.min(maxByBalance, maxByStock);

    if (qty === 0) {
        toast(`No ₱${denom} coins available`);
        return;
    }

    state.selection[denom] = qty;

    // If there's remainder, leave it for user to fill manually
    for (const d of DENOMS) updateCoinCard(d);
    updateRemaining();
    updateConfirm();
}

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

// ── Unavailable Screen (out of stock / maintenance) ─────────────────────────

function showUnavailable(isMaintenance, isNoStock) {
    const icon = document.getElementById("empty-icon");
    const title = document.getElementById("empty-title");
    const msg = document.getElementById("empty-message");
    const sub = document.getElementById("empty-sub");

    if (isMaintenance) {
        icon.textContent = "🔧";
        title.textContent = "Under Maintenance";
        msg.textContent = "Pakibalik mamaya";
        sub.textContent = "The machine is temporarily unavailable.";
    } else if (isNoStock) {
        icon.textContent = "🚫";
        title.textContent = "Walang Barya";
        msg.textContent = "Out of coins — please try again later.";
        sub.textContent = "Pakitawagan ang operator para sa refill.";
    }
    showScreen("empty");
}

// ── Low Stock Banner ────────────────────────────────────────────────────────

function updateLowStockBanner() {
    const banner = document.getElementById("low-stock-banner");
    if (!banner) return;
    if (state.lowStock && state.lowStock.length > 0) {
        banner.classList.remove("hidden");
    } else {
        banner.classList.add("hidden");
    }
}

// ── E-Payment Flow ──────────────────────────────────────────────────────────

function showEpay() {
    state.epayMethod = null;
    state.epayAmount = null;
    // Reset steps visibility
    document.getElementById("epay-step-method").classList.remove("hidden");
    document.getElementById("epay-step-amount").classList.add("hidden");
    document.getElementById("epay-step-qr").classList.add("hidden");
    showScreen("epay");
}

function cancelEpay() {
    showScreen("idle");
}

function selectEpayMethod(method) {
    state.epayMethod = method;
    document.getElementById("epay-method-label").textContent = method === "gcash" ? "GCash" : "Maya";
    document.getElementById("epay-step-method").classList.add("hidden");
    document.getElementById("epay-step-amount").classList.remove("hidden");
}

function epayBackToMethod() {
    document.getElementById("epay-step-amount").classList.add("hidden");
    document.getElementById("epay-step-method").classList.remove("hidden");
}

function selectEpayAmount(amount) {
    state.epayAmount = amount;
    // Generate fake reference number
    const refNum = "CVG-" + String(Date.now()).slice(-6);
    document.getElementById("epay-ref-num").textContent = refNum;
    document.getElementById("epay-processing-msg").textContent = "Waiting for payment...";

    document.getElementById("epay-step-amount").classList.add("hidden");
    document.getElementById("epay-step-qr").classList.remove("hidden");

    // Simulate payment received after 3 seconds
    setTimeout(async () => {
        document.getElementById("epay-processing-msg").textContent = "✅ Payment received!";
        try {
            const res = await fetch("/api/epay", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ method: state.epayMethod, amount: state.epayAmount }),
            });
            const data = await res.json();
            if (res.ok) {
                state.balance = data.balance;
                setTimeout(() => showPicker(), 800);
            } else {
                toast(data.error || "Payment failed");
                setTimeout(() => showScreen("idle"), 1500);
            }
        } catch (e) {
            toast("Connection error");
            setTimeout(() => showScreen("idle"), 1500);
        }
    }, 3000);
}
