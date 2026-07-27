/* ═══════════════════════════════════════════════════════════════════════════
   CoinVerge — Kiosk Frontend Logic
   ═══════════════════════════════════════════════════════════════════════════ */

const DENOMS = [1, 5, 10, 20];
const TIMEOUT_MS = 60000; // 60 seconds inactivity timeout on picker

const state = {
    screen: "idle",
    balance: 0,
    fee: 0,
    available: 0, // balance - fee (what user actually gets in coins)
    simulate: false,
    stock: { 1: 200, 5: 200, 10: 200, 20: 200 },
    selection: { 1: 0, 5: 0, 10: 0, 20: 0 },
    lastEventTime: 0,
    adminTaps: 0,
    adminTimer: null,
    inactivityTimer: null,
    lastDispense: null,
    maintenanceMode: false,
    lowStock: [],
    paymentSource: "bill",  // "bill", "coin", or "epay"
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
        state.fee = data.fee || 0;
        state.available = data.available || 0;
        state.maintenanceMode = data.maintenance_mode || false;
        state.lowStock = data.low_stock || [];
        state.paymentSource = data.payment_source || "bill";
        state.stock = {};
        for (const [k, v] of Object.entries(data.stock)) {
            state.stock[parseInt(k)] = v;
        }

        // Show unavailable screen if no stock or maintenance mode
        if (!data.any_stock || data.maintenance_mode) {
            showUnavailable(data.maintenance_mode, !data.any_stock);
        } else if (state.balance > 0) {
            showFeeScreen();
        } else {
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
        state.fee = data.fee || 0;
        state.available = data.available || 0;
        state.maintenanceMode = data.maintenance_mode || false;
        state.lowStock = data.low_stock || [];
        state.paymentSource = data.payment_source || "bill";
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
            if (state.maintenanceMode) {
                toast("Machine under maintenance");
                break;
            }
            if (ev.data.balance > 100) {
                toast("Maximum ₱100 reached");
                break;
            }
            state.balance = ev.data.balance;
            state.paymentSource = "bill";
            // After bill detected, show fee screen first (not picker directly)
            if (state.screen === "idle" || state.screen === "empty") {
                showFeeScreen();
            } else if (state.screen === "fee") {
                // Another bill inserted while on fee screen — update it
                updateFeeScreen();
            } else if (state.screen === "picker") {
                // Another bill inserted — show fee screen again
                showFeeScreen();
            }
            break;
        case "coin":
            if (state.maintenanceMode) {
                toast("Machine under maintenance");
                break;
            }
            if (ev.data.balance > 100) {
                toast("Maximum ₱100 reached");
                break;
            }
            state.balance = ev.data.balance;
            state.paymentSource = "coin";
            // After coin detected, show fee screen (which shows FREE for coins)
            if (state.screen === "idle" || state.screen === "empty") {
                showFeeScreen();
            } else if (state.screen === "fee") {
                updateFeeScreen();
            } else if (state.screen === "picker") {
                showFeeScreen();
            }
            break;
        case "epay_confirmed":
            state.balance = ev.data.balance;
            if (state.screen === "epay") {
                if (epayPollTimer) {
                    clearInterval(epayPollTimer);
                    epayPollTimer = null;
                }
                // Show confirmed transition screen
                document.getElementById("epay-step-qr").classList.add("hidden");
                document.getElementById("epay-step-confirmed").classList.remove("hidden");
                setTimeout(() => {
                    document.getElementById("epay-step-confirmed").classList.add("hidden");
                    document.getElementById("epay-step-qr").classList.remove("hidden");
                    showFeeScreen();
                }, 2000);
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
            state.fee = 0;
            state.available = 0;
            showScreen("idle");
            break;
    }
}

// ── Screen Management ───────────────────────────────────────────────────────

function showScreen(name) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(`screen-${name}`).classList.add("active");
    state.screen = name;

    if (name !== "picker") {
        clearTimeout(state.inactivityTimer);
    }
}

// ── Fee Screen ──────────────────────────────────────────────────────────────

async function showFeeScreen() {
    await refreshStock();
    updateFeeScreen();
    showScreen("fee");
}

function updateFeeScreen() {
    const balance = state.balance;
    const fee = state.fee;
    const receive = state.available;

    const feeAmountFil = document.getElementById("fee-amount-fil");
    const feeAmountEn = document.getElementById("fee-amount-en");
    const feeMessageFil = document.getElementById("fee-message-fil");
    const feeMessageEn = document.getElementById("fee-message-en");

    if (state.paymentSource === "coin") {
        // Coin exchange — no fee!
        feeAmountFil.textContent = "₱0";
        feeAmountEn.textContent = "₱0";
        if (feeMessageFil) feeMessageFil.innerHTML = 'Coin Exchange — <span class="fee-highlight fee-free">Walang Service Fee!</span>';
        if (feeMessageEn) feeMessageEn.innerHTML = 'Free Coin Redistribution — <span class="fee-highlight fee-free">No charge!</span>';
    } else {
        feeAmountFil.textContent = `₱${fee}`;
        feeAmountEn.textContent = `₱${fee}`;
        if (feeMessageFil) feeMessageFil.innerHTML = `May service charge na <span class="fee-highlight">₱${fee}</span> ang makinang ito.`;
        if (feeMessageEn) feeMessageEn.innerHTML = `This machine will charge you <span class="fee-highlight">₱${fee}</span> as a service fee.`;
    }

    document.getElementById("fee-inserted").textContent = `₱${balance}`;
    document.getElementById("fee-charge").textContent = `−₱${fee}`;
    document.getElementById("fee-receive").textContent = `₱${receive}`;
}

function proceedFromFee() {
    showPicker();
}

// ── Picker ──────────────────────────────────────────────────────────────────

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
            state.fee = 0;
            state.available = 0;
            state.lastDispense = null;
            state.paymentSource = "bill";
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
        // Use available amount (balance - fee) as the cap
        if (total + denom > state.available) return;
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
    document.getElementById("picker-fee-amount").textContent = `₱${state.fee}`;
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
    // Remaining counts down from available (balance - fee)
    const rem = state.available - getTotal();
    const el = document.getElementById("rem-amount");
    el.textContent = `₱${rem}`;
    el.className = "rem-value " + (rem === 0 ? "zero" : "nonzero");
}

function updateConfirm() {
    const btn = document.getElementById("btn-confirm");
    const rem = state.available - getTotal();
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

    // Fill as many of this denomination as possible using available amount
    const maxByBalance = Math.floor(state.available / denom);
    const maxByStock = state.stock[denom] || 0;
    const qty = Math.min(maxByBalance, maxByStock);

    if (qty === 0) {
        toast(`No ₱${denom} coins available`);
        return;
    }

    state.selection[denom] = qty;

    for (const d of DENOMS) updateCoinCard(d);
    updateRemaining();
    updateConfirm();
}

async function confirmDispense() {
    if (state.available - getTotal() !== 0) return;
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
    state.fee = 0;
    state.available = 0;
    state.paymentSource = "bill";
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
            showFeeScreen();
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

// ── Unavailable Screen ──────────────────────────────────────────────────────

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

// ── E-Payment Flow (Redesigned: kiosk shows QR, phone selects amount) ───────

let epayPollTimer = null;

async function showEpay() {
    // Initiate a payment — just get a reference number
    try {
        const res = await fetch("/api/epay/initiate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        const data = await res.json();
        if (!res.ok) {
            toast(data.error || "Failed to start e-payment");
            return;
        }

        // Show QR screen with reference
        document.getElementById("epay-ref-num").textContent = data.reference_number;
        document.getElementById("epay-processing-msg").textContent = "⏳ Waiting for payment...";
        document.getElementById("epay-step-qr").classList.remove("hidden");
        document.getElementById("epay-step-confirmed").classList.add("hidden");

        showScreen("epay");
        startEpayPolling();
    } catch (e) {
        toast("Connection error");
    }
}

function cancelEpay() {
    fetch("/api/epay/cancel", { method: "POST" }).catch(() => {});
    if (epayPollTimer) {
        clearInterval(epayPollTimer);
        epayPollTimer = null;
    }
    showScreen("idle");
}

function startEpayPolling() {
    if (epayPollTimer) clearInterval(epayPollTimer);
    epayPollTimer = setInterval(async () => {
        try {
            const res = await fetch("/api/epay/pending");
            const data = await res.json();
            // If pending is null and we're on the epay screen, payment was confirmed
            if (data === null && state.screen === "epay") {
                clearInterval(epayPollTimer);
                epayPollTimer = null;
                // The epay_confirmed event handler will show the confirmed screen
                // and then navigate to fee screen
            }
        } catch (e) { /* silent */ }
    }, 1500);
}
