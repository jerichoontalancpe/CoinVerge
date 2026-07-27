/* ═══════════════════════════════════════════════════════════════════════════
   CoinVerge — Admin Panel Logic
   v1.2 — Hopper frame design, improved exports
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
    loadMaintenanceStatus();
    switchTab("stock");
}

function switchTab(tab) {
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.getElementById(`tab-${tab}`).classList.add("active");

    document.querySelectorAll(".tab-btn").forEach(b => {
        if (b.textContent.toLowerCase().includes(tab)) b.classList.add("active");
    });

    if (tab === "stock") loadStock();
    else if (tab === "history") loadHistory();
    else if (tab === "reports") loadReport(currentPeriod);
    else if (tab === "settings") { loadFeeTiers(); loadServoPositions(); }
}

async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location = "/";
}

// ══════════════════════════════════════════════════════════════════════════════
// STOCK TAB — Hopper Frame Cards
// ══════════════════════════════════════════════════════════════════════════════

async function loadStock() {
    try {
        const res = await fetch("/api/admin/stock");
        if (!res.ok) return;
        const stock = await res.json();

        for (const [denom, info] of Object.entries(stock)) {
            const pct = info.max > 0 ? (info.current / info.max * 100) : 0;
            const frame = document.getElementById(`hopper-${denom}`);
            if (!frame) continue;

            // Determine status
            let status;
            if (pct >= 95) status = "full";
            else if (pct >= 30) status = "ok";
            else if (pct >= 10) status = "low";
            else if (pct > 0) status = "critical";
            else status = "empty";

            frame.setAttribute("data-status", status);

            // Update badge
            const badge = document.getElementById(`badge-${denom}`);
            if (badge) {
                badge.textContent = status.toUpperCase();
                badge.className = `hopper-badge ${status}`;
            }

            // Update tank fill
            const tankFill = document.getElementById(`tank-fill-${denom}`);
            if (tankFill) {
                tankFill.style.height = `${pct}%`;
            }

            // Update tank level text
            const tankLevel = document.getElementById(`tank-level-${denom}`);
            if (tankLevel) {
                tankLevel.textContent = `${Math.round(pct)}%`;
            }

            // Update count
            document.getElementById(`scount-${denom}`).textContent = info.current.toLocaleString();
            document.getElementById(`smax-${denom}`).textContent = info.max.toLocaleString();

            // Update peso value
            const valueEl = document.getElementById(`svalue-${denom}`);
            if (valueEl) {
                valueEl.textContent = `₱${(info.current * parseInt(denom)).toLocaleString()}`;
            }
        }

        // Machine status
        const mRes = await fetch("/api/admin/machine");
        if (mRes.ok) {
            const machine = await mRes.json();
            const statusEl = document.getElementById("machine-status");
            if (statusEl) {
                statusEl.innerHTML =
                    `<strong>${machine.machine_name}</strong> | ` +
                    `ESP32: ${machine.esp32_connected ? "OK" : "OFF"} | ` +
                    `Mode: ${machine.simulate_mode ? "Sim" : "HW"}`;
            }
        }

        // Load maintenance status
        const statusRes = await fetch("/api/status");
        if (statusRes.ok) {
            const statusData = await statusRes.json();
            updateMaintenanceUI(statusData.maintenance_mode || false);
        }
    } catch (e) { /* silent */ }
}


async function addStock(denom) {
    const current = parseInt(document.getElementById(`scount-${denom}`).textContent.replace(/,/g, ''));
    const maxCapacity = 1000;
    const input = prompt(`How many coins are you adding to ₱${denom} hopper? (Current: ${current})`);
    if (input === null) return;
    const amount = parseInt(input);
    if (isNaN(amount) || amount <= 0) { alert("Please enter a positive number"); return; }

    const newCount = current + amount;
    if (newCount > maxCapacity) {
        const actualAdd = maxCapacity - current;
        if (actualAdd <= 0) {
            alert(`Hopper is already at max capacity (${maxCapacity}).`);
            return;
        }
        const proceed = confirm(`Would exceed max capacity (${maxCapacity}). Adding only ${actualAdd} to reach max.`);
        if (!proceed) return;
    }

    try {
        const res = await fetch("/api/admin/add_stock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ denomination: denom, amount: amount }),
        });
        const data = await res.json();
        if (res.ok) {
            alert(`Added ${data.added} coins to ₱${denom} hopper.\nPrevious: ${data.previous} → New: ${data.new_total}`);
            loadStock();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) {
        alert("Connection error: " + e.message);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// HISTORY TAB
// ══════════════════════════════════════════════════════════════════════════════

async function loadHistory() {
    try {
        const res = await fetch(`/api/admin/transactions?page=${currentPage}&per_page=15`);
        if (!res.ok) return;
        const data = await res.json();

        const tbody = document.getElementById("history-body");
        tbody.innerHTML = "";

        if (data.transactions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No transactions yet</td></tr>';
        } else {
            for (const tx of data.transactions) {
                const row = document.createElement("tr");
                const fee = tx.fee || 0;
                const method = tx.payment_method || "cash";
                row.innerHTML = `
                    <td>${formatDate(tx.timestamp)}</td>
                    <td>₱${tx.bill_value}</td>
                    <td>₱${fee}</td>
                    <td>${tx.coins_dispensed}</td>
                    <td>${tx.total_coins} pcs</td>
                    <td>${method.charAt(0).toUpperCase() + method.slice(1)}</td>
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

// ══════════════════════════════════════════════════════════════════════════════
// CSV & HTML REPORT EXPORT
// ══════════════════════════════════════════════════════════════════════════════

// Show/hide custom date inputs
document.addEventListener("DOMContentLoaded", () => {
    const presetEl = document.getElementById("export-preset");
    if (presetEl) {
        presetEl.addEventListener("change", () => {
            const isCustom = presetEl.value === "custom";
            document.getElementById("export-start").classList.toggle("hidden", !isCustom);
            document.getElementById("export-end").classList.toggle("hidden", !isCustom);
        });
    }
});

function getExportUrl(base) {
    const preset = document.getElementById("export-preset").value;
    let url = base + "?";

    if (preset === "custom") {
        const start = document.getElementById("export-start").value;
        const end = document.getElementById("export-end").value;
        if (!start || !end) {
            alert("Please select both start and end dates");
            return null;
        }
        url += `start_date=${start}&end_date=${end}`;
    } else {
        url += `preset=${preset}`;
    }
    return url;
}

async function exportCSV() {
    const url = getExportUrl("/api/admin/export_csv");
    if (!url) return;

    try {
        const res = await fetch(url);
        if (!res.ok) { alert("Export failed"); return; }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = `coinverge_report_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(blobUrl);
    } catch (e) { alert("Export error: " + e.message); }
}

function exportHTMLReport() {
    const url = getExportUrl("/api/admin/export_html");
    if (!url) return;
    window.open(url, "_blank");
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORTS TAB
// ══════════════════════════════════════════════════════════════════════════════

async function loadReport(period) {
    currentPeriod = period;

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
        document.getElementById("rpt-fees").textContent = `₱${(data.total_fees || 0).toLocaleString()}`;
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

    // Load stock counts
    loadStockCounts();
    // Load inventory activity
    loadInventoryActivity();
}

async function loadStockCounts() {
    try {
        const res = await fetch("/api/admin/stock_counts?limit=10");
        if (!res.ok) return;
        const counts = await res.json();

        const container = document.getElementById("stock-counts-list");
        if (counts.length === 0) {
            container.innerHTML = '<p class="no-data">No stock counts recorded yet</p>';
            return;
        }

        let html = "";
        for (const sc of counts) {
            html += `
                <div class="stock-count-entry">
                    <span class="sc-time">${formatDate(sc.timestamp)}</span>
                    <span class="sc-denom">₱${sc.denomination}</span>
                    <span class="sc-result">${sc.count_result.toLocaleString()} coins (₱${(sc.count_result * sc.denomination).toLocaleString()})</span>
                </div>
            `;
        }
        container.innerHTML = html;
    } catch (e) { /* silent */ }
}

async function loadInventoryActivity() {
    try {
        const res = await fetch("/api/admin/stock_events?limit=20");
        if (!res.ok) return;
        const events = await res.json();

        const container = document.getElementById("inventory-activity-list");
        if (!container) return;

        if (events.length === 0) {
            container.innerHTML = '<p class="no-data">No inventory activity recorded yet</p>';
            return;
        }

        let html = "";
        for (const ev of events) {
            const timeStr = formatDate(ev.timestamp);
            if (ev.type === "add") {
                html += `
                    <div class="stock-count-entry">
                        <span class="sc-time">${timeStr}</span>
                        <span class="sc-denom">₱${ev.denomination}</span>
                        <span class="sc-result">restocked: +${ev.amount} coins (total: ${ev.new_total})</span>
                    </div>
                `;
            } else {
                html += `
                    <div class="stock-count-entry">
                        <span class="sc-time">${timeStr}</span>
                        <span class="sc-denom">₱${ev.denomination}</span>
                        <span class="sc-result">counted: ${ev.amount} coins</span>
                    </div>
                `;
            }
        }
        container.innerHTML = html;
    } catch (e) { /* silent */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// FEE CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

async function loadFeeTiers() {
    try {
        const res = await fetch("/api/admin/fee_tiers");
        if (!res.ok) return;
        const tiers = await res.json();

        const container = document.getElementById("fee-tiers-container");
        container.innerHTML = "";

        tiers.forEach((tier, i) => {
            container.innerHTML += `
                <div class="fee-tier-row" id="fee-tier-${i}">
                    <span class="fee-tier-label">₱</span>
                    <input type="number" class="fee-input" id="fee-min-${i}" value="${tier.min_amount}" min="0" placeholder="Min">
                    <span class="fee-tier-label">— ₱</span>
                    <input type="number" class="fee-input" id="fee-max-${i}" value="${tier.max_amount}" min="0" placeholder="Max">
                    <span class="fee-tier-label">→ Fee: ₱</span>
                    <input type="number" class="fee-input" id="fee-val-${i}" value="${tier.fee}" min="0" placeholder="Fee">
                    <button class="fee-remove-btn" onclick="removeFeeRow(${i})">✕</button>
                </div>
            `;
        });

        container.innerHTML += `
            <button class="fee-add-btn" onclick="addFeeRow()">+ Add Tier</button>
        `;
    } catch (e) { /* silent */ }
}

function addFeeRow() {
    const container = document.getElementById("fee-tiers-container");
    const rows = container.querySelectorAll(".fee-tier-row");
    const i = rows.length;

    const addBtn = container.querySelector(".fee-add-btn");
    if (addBtn) addBtn.remove();

    const div = document.createElement("div");
    div.className = "fee-tier-row";
    div.id = `fee-tier-${i}`;
    div.innerHTML = `
        <span class="fee-tier-label">₱</span>
        <input type="number" class="fee-input" id="fee-min-${i}" value="0" min="0" placeholder="Min">
        <span class="fee-tier-label">— ₱</span>
        <input type="number" class="fee-input" id="fee-max-${i}" value="0" min="0" placeholder="Max">
        <span class="fee-tier-label">→ Fee: ₱</span>
        <input type="number" class="fee-input" id="fee-val-${i}" value="0" min="0" placeholder="Fee">
        <button class="fee-remove-btn" onclick="removeFeeRow(${i})">✕</button>
    `;
    container.appendChild(div);

    const btn = document.createElement("button");
    btn.className = "fee-add-btn";
    btn.onclick = addFeeRow;
    btn.textContent = "+ Add Tier";
    container.appendChild(btn);
}

function removeFeeRow(index) {
    const row = document.getElementById(`fee-tier-${index}`);
    if (row) row.remove();
}

async function saveFeeTiers() {
    const container = document.getElementById("fee-tiers-container");
    const rows = container.querySelectorAll(".fee-tier-row");
    const tiers = [];

    rows.forEach((row, i) => {
        const minEl = row.querySelector(`[id^="fee-min-"]`);
        const maxEl = row.querySelector(`[id^="fee-max-"]`);
        const valEl = row.querySelector(`[id^="fee-val-"]`);
        if (minEl && maxEl && valEl) {
            tiers.push({
                min_amount: parseInt(minEl.value) || 0,
                max_amount: parseInt(maxEl.value) || 0,
                fee: parseInt(valEl.value) || 0,
            });
        }
    });

    if (tiers.length === 0) {
        alert("At least one fee tier is required");
        return;
    }

    try {
        const res = await fetch("/api/admin/fee_tiers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tiers }),
        });
        if (res.ok) {
            alert("Fee tiers saved!");
            loadFeeTiers();
        } else {
            const data = await res.json();
            alert("Error: " + (data.error || "Failed to save"));
        }
    } catch (e) {
        alert("Connection error");
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ══════════════════════════════════════════════════════════════════════════════

async function changePin() {
    const newPin = prompt("Enter new 4-digit PIN:");
    if (!newPin || newPin.length !== 4 || isNaN(newPin)) {
        alert("PIN must be exactly 4 digits");
        return;
    }
    const confirmPin = prompt("Confirm new PIN:");
    if (newPin !== confirmPin) {
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

// ── Maintenance Mode ────────────────────────────────────────────────────────

async function toggleMaintenance() {
    try {
        const res = await fetch("/api/admin/maintenance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        if (res.ok) {
            const data = await res.json();
            updateMaintenanceUI(data.maintenance_mode);
        } else {
            alert("Failed to toggle maintenance mode");
        }
    } catch (e) {
        alert("Connection error");
    }
}

function updateMaintenanceUI(active) {
    const statusEl = document.getElementById("maintenance-status");
    const toggleBtn = document.getElementById("maintenance-toggle");
    if (statusEl) {
        statusEl.textContent = active ? "ON" : "OFF";
    }
    if (toggleBtn) {
        toggleBtn.classList.toggle("maintenance-active", active);
    }
}

async function loadMaintenanceStatus() {
    try {
        const res = await fetch("/api/status");
        if (res.ok) {
            const data = await res.json();
            updateMaintenanceUI(data.maintenance_mode || false);
        }
    } catch (e) { /* silent */ }
}

// ── Sync Stock ──────────────────────────────────────────────────────────────

async function syncStock() {
    const stock = {};
    const denoms = [1, 5, 10, 20];
    for (const d of denoms) {
        const currentEl = document.getElementById(`scount-${d}`);
        const current = currentEl ? currentEl.textContent.replace(/,/g, '') : "0";
        const input = prompt(`Physical count for ₱${d} coins (current in system: ${current}):`, current);
        if (input === null) return;
        const count = parseInt(input);
        if (isNaN(count) || count < 0) {
            alert(`Invalid number for ₱${d}`);
            return;
        }
        stock[String(d)] = count;
    }

    try {
        const res = await fetch("/api/admin/sync_stock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stock: stock }),
        });
        if (res.ok) {
            alert("Stock synced successfully!");
            loadStock();
        } else {
            const data = await res.json();
            alert("Sync failed: " + (data.error || "Unknown error"));
        }
    } catch (e) {
        alert("Connection error");
    }
}

// ── Test Bill (Simulation) ──────────────────────────────────────────────────

async function testBill(amount) {
    try {
        const res = await fetch("/api/simulate_bill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount }),
        });
        const data = await res.json();
        if (res.ok) {
            alert(`Simulated ₱${amount} bill inserted. Check kiosk screen.`);
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) { alert("Error: " + e.message); }
}

// ── Test Coin (Simulation) ──────────────────────────────────────────────────

async function testCoin(amount) {
    try {
        const res = await fetch("/api/simulate_coin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount }),
        });
        const data = await res.json();
        if (res.ok) {
            alert(`Simulated ₱${amount} coin inserted. Stock +1, fee = FREE. Check kiosk screen.`);
            loadStock();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) { alert("Error: " + e.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVO CALIBRATION
// ══════════════════════════════════════════════════════════════════════════════

async function moveServo(servoId) {
    const sliderId = servoId === "A" ? "servo-a-slider" : "servo-b-slider";
    const angle = parseInt(document.getElementById(sliderId).value);

    try {
        const res = await fetch("/api/admin/servo_calibrate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ servo: servoId, angle: angle }),
        });
        const data = await res.json();
        if (res.ok) {
            console.log(`[SERVO] ${servoId} moved to ${angle}°`);
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) { alert("Error: " + e.message); }
}

async function saveServoPos(posKey) {
    // posKey: "A1", "A5", "B10", "B20"
    const servoId = posKey.startsWith("A") ? "A" : "B";
    const sliderId = servoId === "A" ? "servo-a-slider" : "servo-b-slider";
    const angle = parseInt(document.getElementById(sliderId).value);

    const denomMap = {"A1": "₱1", "A5": "₱5", "B10": "₱10", "B20": "₱20"};
    const denomLabel = denomMap[posKey] || posKey;

    try {
        const res = await fetch("/api/admin/servo_save_position", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: posKey, angle: angle }),
        });
        const data = await res.json();
        if (res.ok) {
            alert(`Saved Servo ${servoId} position for ${denomLabel} = ${angle}°`);
            loadServoPositions();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (e) { alert("Error: " + e.message); }
}

async function loadServoPositions() {
    try {
        const res = await fetch("/api/admin/servo_positions");
        if (!res.ok) return;
        const data = await res.json();

        const display = document.getElementById("servo-positions-display");
        if (display) {
            display.innerHTML = `
                <p class="settings-info">
                    <strong>Saved:</strong>
                    ₱1=${data.saved.A1}° | ₱5=${data.saved.A5}° |
                    ₱10=${data.saved.B10}° | ₱20=${data.saved.B20}°
                </p>
            `;
        }
    } catch (e) { /* silent */ }
}

// ── Coin Exchange Fee Toggle ────────────────────────────────────────────────

async function toggleCoinFee() {
    // This is a placeholder — coin fee is always disabled by default (free)
    // Toggle would store a setting to enable/disable fee for coin exchange
    const statusEl = document.getElementById("coin-fee-status");
    const current = statusEl.textContent.includes("Disabled");
    const newState = current ? "Enabled" : "Disabled (Free)";
    statusEl.textContent = newState;
    alert(current
        ? "Coin exchange fee ENABLED — coins will now incur service fee."
        : "Coin exchange fee DISABLED — coin exchange is free!");
}

// ══════════════════════════════════════════════════════════════════════════════
// COIN COUNTING (Hopper Self-Count)
// ══════════════════════════════════════════════════════════════════════════════

let countPollingInterval = null;
let countingDenom = 0;

async function startCount(denom) {
    const confirmed = confirm(
        `Place a container below the ₱${denom} hopper.\n\n` +
        `All coins will be dispensed and counted.\n` +
        `After counting, put coins back into the hopper.\n\n` +
        `Continue?`
    );
    if (!confirmed) return;

    countingDenom = denom;

    try {
        const res = await fetch("/api/admin/count_coins", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ denomination: denom }),
        });
        const data = await res.json();

        if (!res.ok) {
            alert(`Error: ${data.error}`);
            return;
        }

        showCountModal(denom);
        countPollingInterval = setInterval(pollCountStatus, 500);
    } catch (e) {
        alert("Connection error: " + e.message);
    }
}

function showCountModal(denom) {
    const modal = document.getElementById("count-modal");
    modal.classList.remove("hidden");

    document.getElementById("count-modal-title").textContent = `Counting ₱${denom} coins...`;
    document.getElementById("count-modal-counter").textContent = "0";
    document.getElementById("count-modal-value").textContent = "₱0";
    document.getElementById("count-modal-status").textContent = "Dispensing and counting...";
    document.getElementById("count-modal-bar").className = "count-modal-bar";
    document.getElementById("count-modal-bar").style.width = "50%";
    document.getElementById("count-stop-btn").classList.remove("hidden");
    document.getElementById("count-ok-btn").classList.add("hidden");
}

async function pollCountStatus() {
    try {
        const res = await fetch("/api/admin/count_status");
        if (!res.ok) return;
        const state = await res.json();

        const counter = document.getElementById("count-modal-counter");
        const value = document.getElementById("count-modal-value");

        counter.textContent = state.count.toLocaleString();
        value.textContent = `₱${(state.count * state.denomination).toLocaleString()}`;

        if (!state.active) {
            clearInterval(countPollingInterval);
            countPollingInterval = null;
            showCountComplete(state.denomination, state.count);
        }
    } catch (e) { /* silent */ }
}

let countAutoCloseTimer = null;

function showCountComplete(denom, total) {
    const totalValue = total * denom;
    document.getElementById("count-modal-icon").textContent = "OK";
    document.getElementById("count-modal-title").textContent = "Count Complete!";
    document.getElementById("count-modal-counter").textContent = total.toLocaleString();
    document.getElementById("count-modal-value").textContent = `₱${totalValue.toLocaleString()}`;
    document.getElementById("count-modal-status").textContent =
        `Put coins back into the ₱${denom} hopper and press Done.\nStock has been updated automatically.`;
    document.getElementById("count-modal-bar").className = "count-modal-bar done";
    document.getElementById("count-modal-bar").style.width = "100%";
    document.getElementById("count-stop-btn").classList.add("hidden");

    const okBtn = document.getElementById("count-ok-btn");
    okBtn.textContent = "Done";
    okBtn.classList.remove("hidden");

    // Auto-close after 3 seconds
    countAutoCloseTimer = setTimeout(() => {
        closeCountModal();
    }, 3000);
}

async function stopCount() {
    try {
        await fetch("/api/admin/count_stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
    } catch (e) { /* silent */ }

    if (countPollingInterval) {
        clearInterval(countPollingInterval);
        countPollingInterval = null;
    }

    setTimeout(async () => {
        try {
            const res = await fetch("/api/admin/count_status");
            if (res.ok) {
                const state = await res.json();
                document.getElementById("count-modal-icon").textContent = "||";
                document.getElementById("count-modal-title").textContent = "Counting Stopped";
                document.getElementById("count-modal-counter").textContent = state.count.toLocaleString();
                document.getElementById("count-modal-value").textContent =
                    `₱${(state.count * (state.denomination || countingDenom)).toLocaleString()}`;
                document.getElementById("count-modal-status").textContent =
                    "Counting was stopped early. Stock was NOT updated.";
                document.getElementById("count-modal-bar").style.width = "0%";
                document.getElementById("count-stop-btn").classList.add("hidden");
                document.getElementById("count-ok-btn").classList.remove("hidden");
            }
        } catch (e) { /* silent */ }
    }, 600);
}

function closeCountModal() {
    // Clear auto-close timer if user clicks Done manually
    if (countAutoCloseTimer) {
        clearTimeout(countAutoCloseTimer);
        countAutoCloseTimer = null;
    }
    document.getElementById("count-modal").classList.add("hidden");
    document.getElementById("count-modal-icon").textContent = "#";
    document.getElementById("count-ok-btn").textContent = "OK";
    loadStock();
}
