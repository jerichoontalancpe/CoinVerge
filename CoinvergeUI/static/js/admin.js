/* ═══════════════════════════════════════════════════════════════════════════
   CoinVerge — Admin Panel Logic
   ═══════════════════════════════════════════════════════════════════════════ */

let pinBuffer = "";
let currentPage = 1;
let currentPeriod = "today";

// ── PIN Login ───────────────────────────────────────────────────────────────

function pinPress(digit) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digit;
    updatePinDots();
    if (pinBuffer.length === 4) {
        setTimeout(pinSubmit, 200);
    }
}

function pinClear() {
    pinBuffer = "";
    updatePinDots();
    document.getElementById("login-error").classList.add("hidden");
}

function updatePinDots() {
    for (let i = 0; i < 4; i++) {
        const dot = document.getElementById(`dot-${i}`);
        dot.classList.toggle("filled", i < pinBuffer.length);
    }
}

async function pinSubmit() {
    if (pinBuffer.length !== 4) return;

    try {
        const res = await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: pinBuffer }),
        });

        if (res.ok) {
            showAdminDashboard();
        } else {
            document.getElementById("login-error").classList.remove("hidden");
            pinBuffer = "";
            updatePinDots();
        }
    } catch (e) {
        document.getElementById("login-error").textContent = "Connection error";
        document.getElementById("login-error").classList.remove("hidden");
        pinBuffer = "";
        updatePinDots();
    }
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function showAdminDashboard() {
    document.getElementById("admin-login").classList.remove("active");
    document.getElementById("admin-dashboard").classList.add("active");
    loadStock();
    switchTab("stock");
}

function showTab(tab, evt) {
    // Called from onclick — evt is the click event
    switchTab(tab);
}

function switchTab(tab) {
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.getElementById(`tab-${tab}`).classList.add("active");

    // Highlight the correct tab button
    document.querySelectorAll(".tab-btn").forEach(b => {
        if (b.textContent.toLowerCase().includes(tab)) b.classList.add("active");
    });

    if (tab === "stock") loadStock();
    else if (tab === "history") loadHistory();
    else if (tab === "reports") loadReport(currentPeriod);
    else if (tab === "settings") { /* static content */ }
}

async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location = "/";
}

// ── Stock Tab ───────────────────────────────────────────────────────────────

async function loadStock() {
    try {
        const res = await fetch("/api/admin/stock");
        if (!res.ok) return;
        const stock = await res.json();

        for (const [denom, info] of Object.entries(stock)) {
            const pct = info.max > 0 ? (info.current / info.max * 100) : 0;
            const fill = document.getElementById(`sfill-${denom}`);
            if (!fill) continue;
            fill.style.width = `${pct}%`;
            fill.className = "scard-fill" +
                (pct < 10 ? " critical" : pct < 30 ? " low" : "");

            document.getElementById(`scount-${denom}`).textContent = info.current;
            document.getElementById(`smax-${denom}`).textContent = info.max;
        }

        // Machine status
        const mRes = await fetch("/api/admin/machine");
        if (mRes.ok) {
            const machine = await mRes.json();
            document.getElementById("machine-status").innerHTML =
                `<strong>${machine.machine_name}</strong> | ` +
                `ESP32: ${machine.esp32_connected ? "✅ Connected" : "❌ Disconnected"} | ` +
                `Mode: ${machine.simulate_mode ? "Simulation" : "Hardware"}`;
        }
    } catch (e) { /* silent */ }
}

async function refillDenom(denom) {
    await fetch("/api/admin/refill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ denomination: String(denom) }),
    });
    loadStock();
}

async function refillAll() {
    await fetch("/api/admin/refill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ denomination: "all" }),
    });
    loadStock();
}

async function setStockManual(denom) {
    const current = document.getElementById(`scount-${denom}`).textContent;
    const input = prompt(`Set ₱${denom} coin count (current: ${current}):`, current);
    if (input === null) return;
    const count = parseInt(input);
    if (isNaN(count) || count < 0) { alert("Invalid number"); return; }

    await fetch("/api/admin/set_stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ denomination: denom, count: count }),
    });
    loadStock();
}

// ── History Tab ─────────────────────────────────────────────────────────────

async function loadHistory() {
    try {
        const res = await fetch(`/api/admin/transactions?page=${currentPage}&per_page=15`);
        if (!res.ok) return;
        const data = await res.json();

        const tbody = document.getElementById("history-body");
        tbody.innerHTML = "";

        if (data.transactions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-dim)">No transactions yet</td></tr>';
        } else {
            for (const tx of data.transactions) {
                const row = document.createElement("tr");
                row.innerHTML = `
                    <td>${formatDate(tx.timestamp)}</td>
                    <td>₱${tx.bill_value}</td>
                    <td>${tx.coins_dispensed}</td>
                    <td>${tx.total_coins} pcs</td>
                `;
                tbody.appendChild(row);
            }
        }

        document.getElementById("page-info").textContent =
            `Page ${data.page} of ${data.total_pages || 1}`;
        document.getElementById("prev-btn").disabled = data.page <= 1;
        document.getElementById("next-btn").disabled = data.page >= data.total_pages;
    } catch (e) { /* silent */ }
}

function prevPage() { if (currentPage > 1) { currentPage--; loadHistory(); } }
function nextPage() { currentPage++; loadHistory(); }

function formatDate(ts) {
    if (!ts) return "—";
    const d = new Date(ts.replace(" ", "T"));
    if (isNaN(d)) return ts;
    return d.toLocaleDateString("en-PH", { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
}

async function exportCSV() {
    try {
        const res = await fetch("/api/admin/export_csv");
        if (!res.ok) { alert("Export failed"); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `coinverge_transactions_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) { alert("Export error: " + e.message); }
}

// ── Reports Tab ─────────────────────────────────────────────────────────────

async function loadReport(period) {
    currentPeriod = period;

    // Update button styles
    document.querySelectorAll(".rpt-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".rpt-btn").forEach(b => {
        if (b.getAttribute("data-period") === period) b.classList.add("active");
    });

    try {
        const res = await fetch(`/api/admin/summary?period=${period}`);
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById("rpt-transactions").textContent = data.total_transactions;
        document.getElementById("rpt-bills").textContent = `₱${data.total_bill_value.toLocaleString()}`;
        document.getElementById("rpt-coins").textContent = data.total_coins_dispensed.toLocaleString();

        const grid = document.getElementById("breakdown-grid");
        grid.innerHTML = "";
        for (const [denom, count] of Object.entries(data.by_denomination)) {
            grid.innerHTML += `
                <div class="bd-item">
                    <div class="bd-denom">₱${denom}</div>
                    <div class="bd-count">${count.toLocaleString()} pcs</div>
                </div>
            `;
        }
    } catch (e) { /* silent */ }
}

// ── Settings Tab ────────────────────────────────────────────────────────────

async function changePin() {
    const newPin = prompt("Enter new 4-digit PIN:");
    if (!newPin || newPin.length !== 4 || isNaN(newPin)) {
        alert("PIN must be exactly 4 digits");
        return;
    }
    const confirm = prompt("Confirm new PIN:");
    if (newPin !== confirm) {
        alert("PINs don't match");
        return;
    }

    const res = await fetch("/api/admin/change_pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_pin: newPin }),
    });
    if (res.ok) {
        alert("PIN changed successfully");
    } else {
        alert("Failed to change PIN");
    }
}
