/* ═══════════════════════════════════════════════════════════════════════════
   CoinVerge — Kiosk Frontend Logic (UX Overhaul)
   ═══════════════════════════════════════════════════════════════════════════ */

const DENOMS = [1, 5, 10, 20];

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
    warningTimer: null,
    countdownTimer: null,
    lastDispense: null,
    maintenanceMode: false,
    lowStock: [],
    paymentSource: "none",  // "none", "bill", "coin", "epay", "mixed"
    timeoutSeconds: 60,
    timeoutAction: "largest",
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
        state.paymentSource = data.payment_source || "none";
        state.timeoutSeconds = data.timeout_seconds || 60;
        state.timeoutAction = data.timeout_action || "largest";
        state.stock = {};
        for (const [k, v] of Object.entries(data.stock)) {
            state.stock[parseInt(k)] = v;
        }

        // Show unavailable screen if no stock or maintenance mode
        if (!data.any_stock || data.maintenance_mode) {
            showUnavailable(data.maintenance_mode, !data.any_stock);
        } else if (state.balance > 0) {
            showPicker();
        } else {
            updateLowStockBanner();
        }
    } catch (e) { /* retry on next poll */ }
}

async function refreshStock() {
    try {
        const res = await fetch("/api/status");
        const data = await res.json();
        state.balance = data.balance;
        state.stock = {};
        for (const [k, v] of Object.entries(data.stock)) {
            state.stock[parseInt(k)] = v;
        }
        state.fee = data.fee || 0;
        state.available = data.available || 0;
        state.maintenanceMode = data.maintenance_mode || false;
        state.lowStock = data.low_stock || [];
        state.paymentSource = data.payment_source || "none";
        state.timeoutSeconds = data.timeout_seconds || 60;
        state.timeoutAction = data.timeout_action || "largest";
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
    console.log("[EVENT]", ev.type, ev.data);
    switch (ev.type) {
        case "bill":
            if (state.maintenanceMode) {
                toast("Machine under maintenance");
                break;
            }
            if (ev.data.balance > 100) {
                toast("Maximum \u20B1100 reached");
                break;
            }
            state.balance = ev.data.balance;
            state.paymentSource = "bill";
            if (state.screen === "idle" || state.screen === "empty") {
                showPicker();
            } else if (state.screen === "picker") {
                // Additional bill while on picker — refresh display
                refreshStock().then(() => {
                    updateBalanceDisplay();
                    updateStockDisplay();
                    updateRemaining();
                    updateConfirm();
                });
            }
            break;
        case "coin":
            if (state.maintenanceMode) {
                toast("Machine under maintenance");
                break;
            }
            if (ev.data.balance > 100) {
                toast("Maximum \u20B1100 reached");
                break;
            }
            state.balance = ev.data.balance;
            state.paymentSource = "coin";
            if (state.screen === "idle" || state.screen === "empty") {
                showPicker();
            } else if (state.screen === "picker") {
                // Coin arrived during picker — update balance in-place
                refreshStock().then(() => {
                    updateBalanceDisplay();
                    updateRemaining();
                    updateConfirm();
                    updateQuickCounts();
                    resetInactivityTimer();
                });
            }
            break;
        case "epay_confirmed":
            state.balance = ev.data.balance;
            if (state.screen === "epay") {
                if (epayPollTimer) {
                    clearInterval(epayPollTimer);
                    epayPollTimer = null;
                }
                document.getElementById("epay-step-qr").classList.add("hidden");
                document.getElementById("epay-step-confirmed").classList.remove("hidden");
                setTimeout(() => {
                    document.getElementById("epay-step-confirmed").classList.add("hidden");
                    document.getElementById("epay-step-qr").classList.remove("hidden");
                    showPicker();
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
        clearTimeout(state.warningTimer);
        clearInterval(state.countdownTimer);
        hideCountdown();
    }
}

// ── Fee Screen ──────────────────────────────────────────────────────────────

async function showFeeScreen() {
    showScreen("fee");        // Set screen immediately (prevents re-entry)
    // Compute fee locally first for instant display
    const b = state.balance;
    if (state.paymentSource === "coin") {
        state.fee = 0;
    } else if (b >= 100) {
        state.fee = 5;
    } else if (b >= 50) {
        state.fee = 3;
    } else if (b >= 20) {
        state.fee = 2;
    } else {
        state.fee = 0;
    }
    state.available = b - state.fee;
    updateFeeScreen();        // Show immediately with local data
    await refreshStock();     // Then fetch latest (updates stock display)
    updateFeeScreen();        // Update again with server data (if balance unchanged)
}

function updateFeeScreen() {
    const balance = state.balance;
    // Compute fee locally based on balance (same tiers as server)
    let fee = state.fee;
    let receive = state.available;
    
    // If fee/available seem stale (0 when balance > 0), compute locally
    if (balance > 0 && receive === 0) {
        if (state.paymentSource === "coin") {
            fee = 0;
        } else if (balance >= 100) {
            fee = 5;
        } else if (balance >= 50) {
            fee = 3;
        } else if (balance >= 20) {
            fee = 2;
        } else {
            fee = 0;
        }
        receive = balance - fee;
    }

    const feeAmountFil = document.getElementById("fee-amount-fil");
    const feeAmountEn = document.getElementById("fee-amount-en");
    const feeMessageFil = document.getElementById("fee-message-fil");
    const feeMessageEn = document.getElementById("fee-message-en");
    const feeBadgeArea = document.getElementById("fee-badge-area");

    if (state.paymentSource === "coin") {
        // Coin exchange — no fee!
        feeAmountFil.textContent = "\u20B10";
        feeAmountEn.textContent = "\u20B10";
        if (feeMessageFil) feeMessageFil.innerHTML = 'You inserted: <span class="fee-highlight">\u20B1' + balance + '</span> in coins';
        if (feeMessageEn) feeMessageEn.innerHTML = 'No service fee \u2014 free exchange!';
        if (feeBadgeArea) feeBadgeArea.innerHTML = '<span class="fee-badge">FREE EXCHANGE</span>';
    } else {
        // bill, epay, mixed — show fee
        if (feeBadgeArea) feeBadgeArea.innerHTML = '';
        feeAmountFil.textContent = `\u20B1${fee}`;
        feeAmountEn.textContent = `\u20B1${fee}`;
        if (feeMessageFil) feeMessageFil.innerHTML = `Service Fee: <span class="fee-highlight">\u20B1${fee}</span>`;
        if (feeMessageEn) feeMessageEn.innerHTML = `May bayad na \u20B1${fee} bawat palitan`;
    }

    document.getElementById("fee-inserted").textContent = `\u20B1${balance}`;
    document.getElementById("fee-charge").textContent = `\u2212\u20B1${fee}`;
    document.getElementById("fee-receive").textContent = `\u20B1${receive}`;
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
    updateQuickCounts();

    // Show cancel button only for e-payment and coin (no physical bill trapped)
    const cancelBtn = document.getElementById("picker-cancel");
    if (cancelBtn) {
        if (state.paymentSource === "epay" || state.paymentSource === "coin") {
            cancelBtn.classList.remove("hidden");
        } else {
            cancelBtn.classList.add("hidden");
        }
    }

    showScreen("picker");
    resetInactivityTimer();
}

function updateQuickCounts() {
    for (const d of DENOMS) {
        const maxByBalance = Math.floor(state.available / d);
        const maxByStock = state.stock[d] || 0;
        const qty = Math.min(maxByBalance, maxByStock);
        const el = document.getElementById(`quick-count-${d}`);
        if (el) {
            el.textContent = qty > 0 ? `${qty} coins` : "unavailable";
        }
    }
}

function showDone() {
    showScreen("done");

    const summaryEl = document.getElementById("done-summary");
    if (state.lastDispense && summaryEl) {
        const parts = [];
        for (const d of DENOMS) {
            const qty = state.lastDispense[d];
            if (qty && qty > 0) parts.push(`${qty} \u00D7 \u20B1${d}`);
        }
        summaryEl.textContent = "You received: " + parts.join(", ");
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
            state.paymentSource = "none";
            fetchStatus();
            showScreen("idle");
        }
    }, 1000);
}

// ── Inactivity Timeout ──────────────────────────────────────────────────────

function resetInactivityTimer() {
    clearTimeout(state.inactivityTimer);
    clearTimeout(state.warningTimer);
    clearInterval(state.countdownTimer);
    hideCountdown();

    const timeoutMs = state.timeoutSeconds * 1000;
    const warningMs = timeoutMs - 10000; // 10 seconds before timeout

    // Warning toast 10 seconds before timeout
    if (warningMs > 0) {
        state.warningTimer = setTimeout(() => {
            if (state.screen === "picker") {
                toast("Session expiring in 10 seconds...");
            }
        }, warningMs);
    }

    // Countdown display when < 15 seconds remaining
    const countdownStartMs = timeoutMs - 15000;
    if (countdownStartMs > 0) {
        setTimeout(() => {
            if (state.screen === "picker") {
                startCountdown(15);
            }
        }, countdownStartMs);
    } else {
        // If timeout is <= 15 seconds, start countdown immediately
        startCountdown(Math.floor(state.timeoutSeconds));
    }

    // Main timeout action
    state.inactivityTimer = setTimeout(() => {
        if (state.screen === "picker") {
            handleTimeout();
        }
    }, timeoutMs);
}

function startCountdown(seconds) {
    clearInterval(state.countdownTimer);
    let remaining = seconds;
    showCountdown(remaining);
    state.countdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0 || state.screen !== "picker") {
            clearInterval(state.countdownTimer);
            hideCountdown();
        } else {
            showCountdown(remaining);
        }
    }, 1000);
}

function showCountdown(seconds) {
    let el = document.getElementById("timeout-countdown");
    if (!el) {
        el = document.createElement("div");
        el.id = "timeout-countdown";
        el.className = "timeout-countdown";
        const pickerScreen = document.getElementById("screen-picker");
        if (pickerScreen) pickerScreen.appendChild(el);
    }
    el.textContent = seconds + "s";
    el.classList.remove("hidden");
}

function hideCountdown() {
    const el = document.getElementById("timeout-countdown");
    if (el) el.classList.add("hidden");
}

function handleTimeout() {
    clearTimeout(state.warningTimer);
    clearInterval(state.countdownTimer);
    hideCountdown();

    const action = state.timeoutAction;
    if (action === "cancel") {
        toast("Session timed out");
        cancelTransaction();
    } else {
        // Auto-dispense with largest or smallest strategy
        autoDispense(action);
    }
}

function autoDispense(strategy) {
    // strategy: "largest" or "smallest"
    const available = state.available;
    const combo = {};
    let remaining = available;

    const order = strategy === "largest" ? [20, 10, 5, 1] : [1, 5, 10, 20];

    for (const d of order) {
        const stockAvail = state.stock[d] || 0;
        const maxCoins = Math.floor(remaining / d);
        const coins = Math.min(maxCoins, stockAvail);
        if (coins > 0) {
            combo[d] = coins;
            remaining -= coins * d;
        }
    }

    if (Object.keys(combo).length > 0 && remaining === 0) {
        // Submit dispense
        state.selection = { 1: combo[1] || 0, 5: combo[5] || 0, 10: combo[10] || 0, 20: combo[20] || 0 };
        toast("Auto-dispensing due to timeout");
        confirmDispense();
    } else {
        // Cannot dispense exact amount -- just cancel
        toast("Session timed out");
        cancelTransaction();
    }
}

// ── Picker Logic ────────────────────────────────────────────────────────────

function adjust(denom, delta) {
    resetInactivityTimer();

    const newVal = state.selection[denom] + delta;
    if (newVal < 0) return;
    if (newVal > state.stock[denom]) return;

    if (delta > 0) {
        const total = getTotal();
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
    document.getElementById(`sub-${d}`).textContent = `\u20B1${d * state.selection[d]}`;
    const card = document.getElementById(`card-${d}`);
    card.classList.toggle("active", state.selection[d] > 0);
}

function updateBalanceDisplay() {
    document.getElementById("bal-amount").textContent = `\u20B1${state.balance}`;
    document.getElementById("picker-fee-amount").textContent = `\u20B1${state.fee}`;
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
    const rem = state.available - getTotal();
    const el = document.getElementById("rem-amount");
    el.textContent = `\u20B1${rem}`;
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

    const maxByBalance = Math.floor(state.available / denom);
    const maxByStock = state.stock[denom] || 0;
    const qty = Math.min(maxByBalance, maxByStock);

    if (qty === 0) {
        toast(`No \u20B1${denom} coins available`);
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

    // Update dispensing screen with details
    updateDispensingScreen();

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
        startDispenseProgress();
        setTimeout(() => {
            if (state.screen === "dispensing") showDone();
        }, 5000);
    } catch (e) {
        toast("Connection error");
        showPicker();
    }
}

function updateDispensingScreen() {
    const detailEl = document.getElementById("disp-detail");
    if (detailEl && state.lastDispense) {
        const parts = [];
        for (const d of DENOMS) {
            const qty = state.lastDispense[d];
            if (qty && qty > 0) parts.push(`${qty} \u00D7 \u20B1${d}`);
        }
        detailEl.textContent = "Dispensing " + parts.join(", ");
    }
}

function startDispenseProgress() {
    const progressText = document.getElementById("disp-progress-text");
    if (!progressText || !state.lastDispense) return;

    let totalCoins = 0;
    for (const d of DENOMS) {
        totalCoins += state.lastDispense[d] || 0;
    }

    let dispensed = 0;
    const interval = Math.max(100, 4000 / totalCoins);

    const timer = setInterval(() => {
        if (state.screen !== "dispensing") {
            clearInterval(timer);
            return;
        }
        dispensed++;
        if (dispensed >= totalCoins) {
            progressText.textContent = `${totalCoins} of ${totalCoins} dispensed`;
            clearInterval(timer);
        } else {
            progressText.textContent = `${dispensed} of ${totalCoins} dispensed...`;
        }
    }, interval);
}

async function cancelTransaction() {
    clearTimeout(state.inactivityTimer);
    clearTimeout(state.warningTimer);
    clearInterval(state.countdownTimer);
    hideCountdown();
    await fetch("/api/reset", { method: "POST" });
    state.balance = 0;
    state.fee = 0;
    state.available = 0;
    state.paymentSource = "bill";
    resetSelection();
    showScreen("idle");
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
        icon.textContent = "M";
        title.textContent = "Under Maintenance";
        msg.textContent = "The machine is temporarily unavailable.";
        sub.textContent = "Pakibalik mamaya";
    } else if (isNoStock) {
        icon.textContent = "X";
        title.textContent = "Out of Coins";
        msg.textContent = "Please try again later.";
        sub.textContent = "Walang barya — pakitawagan ang operator para sa refill.";
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

let epayPollTimer = null;

async function showEpay() {
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

        document.getElementById("epay-ref-num").textContent = data.reference_number;
        document.getElementById("epay-processing-msg").textContent = "Waiting for payment";
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
            if (data === null && state.screen === "epay") {
                clearInterval(epayPollTimer);
                epayPollTimer = null;
            }
        } catch (e) { /* silent */ }
    }, 1500);
}
