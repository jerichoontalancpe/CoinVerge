/*
 * ============================================================================
 *  COINVERGE — ESP32 Coin Exchange / Money Changer Firmware
 *  Reconstructed from: coinverge_backup.bin
 * ============================================================================
 *
 *  Build environment (confirmed from binary):
 *    Board   : ESP32 Dev Module
 *    Core    : Arduino ESP32 v2.0.15
 *    IDF     : v4.4.7 (compiled Mar 5 2024)
 *
 *  ALL hardware confirmed from probe testing (2026-07-23/24):
 *    GPIO5  → ₱1  hopper
 *    GPIO18 → ₱5  hopper
 *    GPIO19 → ₱10 hopper
 *    GPIO17 → ₱20 hopper
 *    GPIO32 → Bill acceptor signal (pulse-type, open-collector, INPUT_PULLUP)
 *
 *  Architecture:
 *    - ESP32 handles hardware (bill detection, hopper control)
 *    - Raspberry Pi handles UI (touchscreen, denomination selection)
 *    - Communication via Serial (USB or UART, 115200 baud)
 *    - ESP32 does NOT auto-exchange — waits for DISPENSE command from RPi
 *
 *  Protocol (see config.h for full documentation):
 *    ESP32 → RPi:  READY, BILL:<amt>, DISPENSED:OK, DISPENSED:ERROR:<reason>, STOCK:...
 *    RPi → ESP32:  DISPENSE:<denom>x<qty>,...  STOCK?  RESET
 *
 *  Debug commands (DEBUG_MODE 1 only):
 *    BILL <amount>   simulate bill insert (sends BILL:<amt> event)
 *    DISPENSE:...    same as RPi command
 *    STOCK?          request stock
 *    RESET           clear balance
 *    STATUS          show internal state
 *    REFILL          refill coin stock
 *    HELP            list all commands
 * ============================================================================
 */

#include <Arduino.h>
#include "config.h"

// ============================================================================
//  GLOBAL STATE
// ============================================================================

static volatile int  g_totalMoney   = 0;     // accumulated bill value, waiting for dispense
static int           g_coinStock[DENOM_COUNT];
static String        g_serialBuf    = "";     // incoming Serial command buffer

// ── Coin Counting State ─────────────────────────────────────────────────────
static bool          g_countActive  = false;  // true while counting is in progress
static bool          g_countAbort   = false;  // set true by COUNT_STOP command
static int           g_countIndex   = -1;     // hopper index being counted

// ============================================================================
//  FORWARD DECLARATIONS
// ============================================================================

void openhop(int denomIndex);
void closehop(int denomIndex);
void closeAllHoppers();
void exchangeTerminate();
void sendStockReport();
void processCommand(String cmd);
bool executeDispense(String args);
void executeCount(int hopperIndex);
int  lookupBillPulses(int pulses);

// ============================================================================
//  setup()
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(200);

    Serial.println();
    Serial.println("SYSTEM START");
    Serial.println("Coinverge v1.0 | Build: Mar  5 2024 | IDF: v4.4.7");
    Serial.println("Hoppers: GPIO5=P1  GPIO18=P5  GPIO19=P10  GPIO17=P20");
    Serial.println("Bill acceptor: GPIO32 (pulse-type)");

#if DEBUG_MODE
    Serial.println("[DEBUG MODE] No GPIO. Use Serial commands. Type HELP.");
#else
    // ── Hopper pins ──────────────────────────────────────────
    for (int i = 0; i < DENOM_COUNT; i++) {
        int pin = HOPPER_MAP[i][1];
        pinMode(pin, OUTPUT);
        digitalWrite(pin, !HOP_ACTIVE);    // OFF at boot

        // Sensor pins (input-only GPIOs, use INPUT)
        int sensorPin = HOPPER_MAP[i][2];
        if (sensorPin >= 0) {
            pinMode(sensorPin, INPUT_PULLUP);
        }
    }
    closeAllHoppers();

    // ── Hopper opto-sensor (legacy single pin — no longer used) ─

    // ── Bill acceptor pulse pin ──────────────────────────────
    pinMode(BILL_PIN, INPUT_PULLUP);       // GPIO32 — open-collector: pull-up, idles HIGH, pulses LOW
    Serial.printf("[BILL] Acceptor pin GPIO%d ready (idle=%s)\n",
                  BILL_PIN, BILL_IDLE_STATE == LOW ? "LOW" : "HIGH");
    Serial.printf("[BILL] GPIO%d current state at boot: %s\n",
                  BILL_PIN, digitalRead(BILL_PIN) == LOW ? "LOW" : "HIGH");

    // ── Bill acceptor inhibit pin ────────────────────────────
    if (BILL_INHIBIT_PIN >= 0) {
        pinMode(BILL_INHIBIT_PIN, OUTPUT);
        digitalWrite(BILL_INHIBIT_PIN, !BILL_INHIBIT_ACTIVE);  // Enable acceptor at boot
        Serial.printf("[BILL] Inhibit pin GPIO%d ready (enabled)\n", BILL_INHIBIT_PIN);
    }

    // ── Coin acceptor pulse pin ──────────────────────────────
    if (COIN_PIN >= 0) {
        pinMode(COIN_PIN, INPUT_PULLUP);
    }
#endif

    // Init coin stock
    for (int i = 0; i < DENOM_COUNT; i++) {
        g_coinStock[i] = MAX_COINS_PER_HOPPER;
    }

    Serial.printf("Total Money: %d\n", g_totalMoney);
    Serial.println("READY");
}

// ============================================================================
//  loop()
// ============================================================================

void loop() {
    // ── Read Serial commands (from RPi or Serial Monitor) ────
    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\n' || c == '\r') {
            g_serialBuf.trim();
            if (g_serialBuf.length() > 0) {
                processCommand(g_serialBuf);
            }
            g_serialBuf = "";
        } else {
            g_serialBuf += c;
        }
    }

#if !DEBUG_MODE
    // ── Poll bill acceptor (GPIO32, pulse-type) ──────────────
    {
        static unsigned long lastBillPulseMs = 0;
        static unsigned int  billPulseCount  = 0;
        static bool          billInWindow    = false;
        static bool          lastBillState   = (bool)digitalRead(BILL_PIN);

        bool currentState = (bool)digitalRead(BILL_PIN);

        // Detect falling edge (HIGH → LOW = active pulse for open-collector)
        bool activeState = !BILL_IDLE_STATE;
        if (currentState == activeState && lastBillState == (bool)BILL_IDLE_STATE) {
            unsigned long now = millis();
            if (now - lastBillPulseMs > BILL_DEBOUNCE_MS) {
                billPulseCount++;
                lastBillPulseMs = now;
                billInWindow    = true;
                Serial.printf("[BILL] Pulse %u detected on GPIO%d\n",
                              billPulseCount, BILL_PIN);
            }
        }
        lastBillState = currentState;

        // Window expired — decode bill denomination
        if (billInWindow && (millis() - lastBillPulseMs > BILL_WINDOW_MS)) {
            billInWindow = false;
            Serial.printf("Count %u\n", billPulseCount);

            int value = lookupBillPulses(billPulseCount);
            billPulseCount = 0;

            if (value > 0 && value >= MIN_BILL_VALUE && value <= MAX_BILL_VALUE) {
                // Reject if adding this bill would exceed max allowed balance
                if (g_totalMoney + value > MAX_BILL_VALUE) {
                    Serial.printf("[BILL] REJECTED P%d (balance would exceed P%d)\n",
                                  value, MAX_BILL_VALUE);
                    // NOTE: bill is physically inside — acceptor should be inhibited
                    // after first bill. For now just don't credit it.
                } else {
                    g_totalMoney += value;
                    Serial.printf("BILL:%d\n", value);   // ← RPi reads this
                    Serial.printf("Total Money: %d\n", g_totalMoney);

                    // Disable bill acceptor if balance reached max
                    if (BILL_INHIBIT_PIN >= 0 && g_totalMoney >= MAX_BILL_VALUE) {
                        digitalWrite(BILL_INHIBIT_PIN, BILL_INHIBIT_ACTIVE);
                        Serial.println("[BILL] Acceptor DISABLED (max balance reached)");
                    }
                }
            } else if (value > MAX_BILL_VALUE) {
                // Bill accepted by hardware but exceeds our software limit
                // (Should not happen if DIP switches are set correctly)
                Serial.printf("[BILL] REJECTED P%d (exceeds max P%d)\n",
                              value, MAX_BILL_VALUE);
            } else {
                Serial.println("[BILL] Unknown pulse count — update BILL_PULSE_TABLE");
            }
        }
    }

    // ── Poll coin acceptor ───────────────────────────────────
    if (COIN_PIN >= 0) {
        static unsigned long lastCoinPulseMs = 0;
        static unsigned int  coinPulseCount  = 0;
        static bool          coinInWindow    = false;

        if (digitalRead(COIN_PIN) == LOW) {
            unsigned long now = millis();
            if (now - lastCoinPulseMs > COIN_DEBOUNCE_MS) {
                coinPulseCount++;
                lastCoinPulseMs = now;
                coinInWindow    = true;
            }
        }

        if (coinInWindow && (millis() - lastCoinPulseMs > COIN_WINDOW_MS)) {
            coinInWindow = false;
            int value = 0;
            for (int i = 0; i < COIN_PULSE_TABLE_SIZE; i++) {
                if (COIN_PULSE_TABLE[i][0] == (int)coinPulseCount) {
                    value = COIN_PULSE_TABLE[i][1];
                    break;
                }
            }
            coinPulseCount = 0;
            if (value > 0) {
                g_totalMoney += value;
                Serial.printf("BILL:%d\n", value);  // reuse same event format for RPi
                Serial.printf("Total Money: %d\n", g_totalMoney);
            }
        }
    }
#endif

    delay(5);
}

// ============================================================================
//  processCommand() — handle commands from RPi or Serial Monitor
// ============================================================================

void processCommand(String cmd) {
    // Preserve original for parsing, uppercase copy for matching
    String upper = cmd;
    upper.toUpperCase();

    // ── DISPENSE:<denom>x<qty>,... ───────────────────────────
    if (upper.startsWith("DISPENSE:")) {
        String args = cmd.substring(9);  // keep original case
        executeDispense(args);

    // ── STOCK? ───────────────────────────────────────────────
    } else if (upper == "STOCK?") {
        sendStockReport();

    // ── RESET ────────────────────────────────────────────────
    } else if (upper == "RESET") {
        g_totalMoney = 0;
        // Re-enable bill acceptor
        if (BILL_INHIBIT_PIN >= 0) {
            digitalWrite(BILL_INHIBIT_PIN, !BILL_INHIBIT_ACTIVE);
        }
        Serial.println("RESET:OK");
        Serial.printf("Total Money: %d\n", g_totalMoney);

    // ── CREDIT:<amount> — set balance from RPi (for e-payment) ──
    } else if (upper.startsWith("CREDIT:")) {
        int amount = upper.substring(7).toInt();
        if (amount > 0 && amount <= MAX_BILL_VALUE) {
            g_totalMoney = amount;
            Serial.printf("CREDIT:OK:%d\n", amount);
            Serial.printf("Total Money: %d\n", g_totalMoney);
            // Disable bill acceptor since balance is set
            if (BILL_INHIBIT_PIN >= 0) {
                digitalWrite(BILL_INHIBIT_PIN, BILL_INHIBIT_ACTIVE);
            }
        } else {
            Serial.printf("CREDIT:ERROR:INVALID_AMOUNT:%d\n", amount);
        }

    // ── COUNT:<hopper_index> — count all coins in a hopper ──
    } else if (upper.startsWith("COUNT:")) {
        int idx = upper.substring(6).toInt();
        if (idx < 0 || idx >= DENOM_COUNT) {
            Serial.printf("COUNT:ERROR:INVALID_INDEX:%d\n", idx);
        } else if (g_countActive) {
            Serial.println("COUNT:ERROR:ALREADY_COUNTING");
        } else {
            executeCount(idx);
        }

    // ── COUNT_STOP — abort an active coin count ─────────────
    } else if (upper == "COUNT_STOP") {
        if (g_countActive) {
            g_countAbort = true;
            Serial.println("COUNT_STOP:OK");
        } else {
            Serial.println("COUNT_STOP:ERROR:NOT_COUNTING");
        }

#if DEBUG_MODE
    // ── DEBUG-ONLY COMMANDS ──────────────────────────────────
    } else if (upper.startsWith("BILL ")) {
        int value = upper.substring(5).toInt();
        if (value >= MIN_BILL_VALUE && value <= MAX_BILL_VALUE) {
            g_totalMoney += value;
            Serial.printf("BILL:%d\n", value);
            Serial.printf("Total Money: %d\n", g_totalMoney);
        } else {
            Serial.printf("[DEBUG] P%d rejected (range P%d-P%d)\n",
                          value, MIN_BILL_VALUE, MAX_BILL_VALUE);
        }

    } else if (upper == "STATUS") {
        Serial.println("--- STATUS ---");
        Serial.printf("Total Money : P%d\n", g_totalMoney);
        Serial.println("Coin stock  :");
        for (int i = 0; i < DENOM_COUNT; i++) {
            Serial.printf("  P%2d  GPIO%d  x%d\n",
                          HOPPER_MAP[i][0], HOPPER_MAP[i][1], g_coinStock[i]);
        }
        Serial.println("--------------");

    } else if (upper == "REFILL") {
        for (int i = 0; i < DENOM_COUNT; i++) g_coinStock[i] = MAX_COINS_PER_HOPPER;
        Serial.println("[DEBUG] Stock refilled.");

    } else if (upper == "HELP") {
        Serial.println("Commands:");
        Serial.println("  BILL <amount>            simulate bill (e.g., BILL 100)");
        Serial.println("  DISPENSE:<d>x<q>,...     dispense coins (e.g., DISPENSE:20x5)");
        Serial.println("  STOCK?                   report coin stock");
        Serial.println("  RESET                    clear balance");
        Serial.println("  STATUS                   show internal state");
        Serial.println("  REFILL                   refill all hoppers");
#endif

    } else {
        Serial.printf("[CMD] Unknown: %s\n", cmd.c_str());
    }
}

// ============================================================================
//  executeDispense() — parse and run a DISPENSE command
//  Format: "1x10,5x4,10x2,20x1"  means 10x₱1, 4x₱5, 2x₱10, 1x₱20
// ============================================================================

bool executeDispense(String args) {
    // Parse the dispense request into counts per denomination
    int requestCounts[DENOM_COUNT] = {0};
    int requestTotal = 0;

    // Parse comma-separated pairs: "<denom>x<qty>"
    int startIdx = 0;
    while (startIdx < (int)args.length()) {
        int commaIdx = args.indexOf(',', startIdx);
        if (commaIdx < 0) commaIdx = args.length();

        String pair = args.substring(startIdx, commaIdx);
        pair.trim();

        int xIdx = pair.indexOf('x');
        if (xIdx < 0) {
            Serial.printf("DISPENSED:ERROR:PARSE_FAIL:%s\n", pair.c_str());
            return false;
        }

        int denom = pair.substring(0, xIdx).toInt();
        int qty   = pair.substring(xIdx + 1).toInt();

        if (qty < 0) {
            Serial.printf("DISPENSED:ERROR:NEGATIVE_QTY:%s\n", pair.c_str());
            return false;
        }

        // Find which hopper index this denomination belongs to
        bool found = false;
        for (int i = 0; i < DENOM_COUNT; i++) {
            if (HOPPER_MAP[i][0] == denom) {
                requestCounts[i] += qty;
                requestTotal += denom * qty;
                found = true;
                break;
            }
        }
        if (!found) {
            Serial.printf("DISPENSED:ERROR:UNKNOWN_DENOM:%d\n", denom);
            return false;
        }

        startIdx = commaIdx + 1;
    }

    // ── Validation ───────────────────────────────────────────

    // Check total matches balance
    if (requestTotal != g_totalMoney) {
        Serial.printf("DISPENSED:ERROR:TOTAL_MISMATCH:requested=%d,balance=%d\n",
                      requestTotal, g_totalMoney);
        return false;
    }

    // Check stock availability
    for (int i = 0; i < DENOM_COUNT; i++) {
        if (requestCounts[i] > g_coinStock[i]) {
            Serial.printf("DISPENSED:ERROR:LOW_STOCK:P%d:need=%d,have=%d\n",
                          HOPPER_MAP[i][0], requestCounts[i], g_coinStock[i]);
            return false;
        }
    }

    // ── Execute dispensing ───────────────────────────────────
    Serial.printf("exchangeMoney: %d\n", requestTotal);

    for (int i = DENOM_COUNT - 1; i >= 0; i--) {
        int need  = requestCounts[i];
        int denom = HOPPER_MAP[i][0];
        if (need == 0) continue;

        Serial.printf("[HOP] Dispensing %d x P%d\n", need, denom);

#if DEBUG_MODE
        openhop(i);
        int ms = need * HOP_MS_PER_COIN;
        Serial.printf("[DEBUG] Simulating %d coins (%d ms)\n", need, ms);
        delay(min(ms, 3000));
        g_coinStock[i] -= need;
        closehop(i);

#else
        // Sensor-counted dispensing — count clicks until we reach 'need' coins
        int sensorPin = HOPPER_MAP[i][2];
        openhop(i);

        int coined = 0;
        bool lastSensorState = digitalRead(sensorPin);
        unsigned long timeout = millis() + (unsigned long)need * HOP_MS_PER_COIN * 2;  // generous timeout

        while (coined < need) {
            bool currentState = digitalRead(sensorPin);

            // Detect edge transition = coin passed sensor
            // ₱1 hopper is NC (idle=LOW, coin=HIGH → detect LOW→HIGH rising edge)
            // ₱5,₱10,₱20 hoppers are NO (idle=HIGH, coin=LOW → detect HIGH→LOW falling edge)
            bool coinDetected = false;
            if (i == 0) {
                // ₱1: Normally Closed — detect rising edge (LOW → HIGH)
                coinDetected = (lastSensorState == LOW && currentState == HIGH);
            } else {
                // ₱5,₱10,₱20: Normally Open — detect falling edge (HIGH → LOW)
                coinDetected = (lastSensorState == HIGH && currentState == LOW);
            }

            if (coinDetected) {
                coined++;
                g_coinStock[i]--;
                Serial.printf("[HOP] Coin %d/%d (P%d)\n", coined, need, denom);
                delay(30);  // debounce
            }
            lastSensorState = currentState;

            // Timeout protection
            if (millis() > timeout) {
                Serial.printf("[HOP] TIMEOUT: got %d/%d coins (P%d)\n", coined, need, denom);
                break;
            }

            delay(2);  // fast polling
        }

        closehop(i);
#endif
    }

    // ── Done ─────────────────────────────────────────────────
    g_totalMoney = 0;
    Serial.println("DISPENSED:OK");
    Serial.printf("Total Money: %d\n", g_totalMoney);

    // Re-enable bill acceptor for next customer
    if (BILL_INHIBIT_PIN >= 0) {
        digitalWrite(BILL_INHIBIT_PIN, !BILL_INHIBIT_ACTIVE);
        Serial.println("[BILL] Acceptor RE-ENABLED");
    }

    return true;
}

// ============================================================================
//  sendStockReport() — responds with STOCK:1=n,5=n,10=n,20=n
// ============================================================================

void sendStockReport() {
    Serial.print("STOCK:");
    for (int i = 0; i < DENOM_COUNT; i++) {
        if (i > 0) Serial.print(",");
        Serial.printf("%d=%d", HOPPER_MAP[i][0], g_coinStock[i]);
    }
    Serial.println();
}

// ============================================================================
//  openhop / closehop / closeAllHoppers
// ============================================================================

void openhop(int denomIndex) {
    int pin   = HOPPER_MAP[denomIndex][1];
    int denom = HOPPER_MAP[denomIndex][0];
    Serial.printf("openhop [P%d → GPIO%d]\n", denom, pin);
#if !DEBUG_MODE
    digitalWrite(pin, HOP_ACTIVE);
#endif
}

void closehop(int denomIndex) {
    int pin   = HOPPER_MAP[denomIndex][1];
    int denom = HOPPER_MAP[denomIndex][0];
    Serial.printf("closehop [P%d → GPIO%d]\n", denom, pin);
#if !DEBUG_MODE
    digitalWrite(pin, !HOP_ACTIVE);
#endif
}

void closeAllHoppers() {
    for (int i = 0; i < DENOM_COUNT; i++) {
#if !DEBUG_MODE
        digitalWrite(HOPPER_MAP[i][1], !HOP_ACTIVE);
#endif
    }
}

// ============================================================================
//  exchangeTerminate() — legacy name kept for reference
// ============================================================================

void exchangeTerminate() {
    closeAllHoppers();
    g_totalMoney = 0;
}

// ============================================================================
//  executeCount() — count all coins in a hopper (admin coin counting)
//  Turns on motor, counts sensor pulses until 3-second timeout with no coins.
//  Sends progress every 10 coins and final count when done.
// ============================================================================

void executeCount(int hopperIndex) {
    g_countActive = true;
    g_countAbort  = false;
    g_countIndex  = hopperIndex;

    int denom     = HOPPER_MAP[hopperIndex][0];
    int sensorPin = HOPPER_MAP[hopperIndex][2];
    int total     = 0;

    Serial.printf("[COUNT] Starting count for P%d (hopper %d)\n", denom, hopperIndex);

#if DEBUG_MODE
    // In debug mode, simulate counting with a simple loop
    openhop(hopperIndex);
    int simTotal = random(50, 201);  // simulate 50-200 coins
    for (int i = 1; i <= simTotal; i++) {
        if (g_countAbort) break;
        total = i;
        if (total % 10 == 0) {
            Serial.printf("COUNT_PROGRESS:%d:%d\n", hopperIndex, total);
        }
        delay(50);  // simulate counting speed

        // Check for COUNT_STOP command during simulation
        while (Serial.available()) {
            char c = Serial.read();
            if (c == '\n' || c == '\r') {
                g_serialBuf.trim();
                String bufUpper = g_serialBuf;
                bufUpper.toUpperCase();
                if (bufUpper == "COUNT_STOP") {
                    g_countAbort = true;
                    Serial.println("COUNT_STOP:OK");
                }
                g_serialBuf = "";
            } else {
                g_serialBuf += c;
            }
        }
    }
    closehop(hopperIndex);

#else
    // Real hardware: turn on motor, count sensor edges, timeout after 3s of no coins
    openhop(hopperIndex);

    bool lastSensorState = digitalRead(sensorPin);
    unsigned long lastCoinTime = millis();  // time of last detected coin
    const unsigned long COUNT_TIMEOUT_MS = 3000;  // 3 seconds no coin = done

    while (!g_countAbort) {
        bool currentState = digitalRead(sensorPin);

        // Detect edge transition (same logic as dispensing)
        bool coinDetected = false;
        if (hopperIndex == 0) {
            // ₱1: Normally Closed — detect rising edge (LOW → HIGH)
            coinDetected = (lastSensorState == LOW && currentState == HIGH);
        } else {
            // ₱5,₱10,₱20: Normally Open — detect falling edge (HIGH → LOW)
            coinDetected = (lastSensorState == HIGH && currentState == LOW);
        }

        if (coinDetected) {
            total++;
            lastCoinTime = millis();
            if (total % 10 == 0) {
                Serial.printf("COUNT_PROGRESS:%d:%d\n", hopperIndex, total);
            }
            delay(30);  // debounce
        }
        lastSensorState = currentState;

        // Timeout: no coin for 3 seconds → done
        if (millis() - lastCoinTime > COUNT_TIMEOUT_MS) {
            break;
        }

        // Check for COUNT_STOP command mid-count
        while (Serial.available()) {
            char c = Serial.read();
            if (c == '\n' || c == '\r') {
                g_serialBuf.trim();
                String bufUpper = g_serialBuf;
                bufUpper.toUpperCase();
                if (bufUpper == "COUNT_STOP") {
                    g_countAbort = true;
                    Serial.println("COUNT_STOP:OK");
                }
                g_serialBuf = "";
            } else {
                g_serialBuf += c;
            }
        }

        delay(2);  // fast polling
    }

    closehop(hopperIndex);
#endif

    // Send final result
    Serial.printf("COUNT_DONE:%d:%d\n", hopperIndex, total);
    Serial.printf("[COUNT] Finished: %d coins (P%d)\n", total, denom);

    g_countActive = false;
    g_countAbort  = false;
    g_countIndex  = -1;
}

// ============================================================================
//  lookupBillPulses() — map pulse count to bill peso value
// ============================================================================

int lookupBillPulses(int pulses) {
    for (int i = 0; i < BILL_PULSE_TABLE_SIZE; i++) {
        if (BILL_PULSE_TABLE[i][0] == pulses) return BILL_PULSE_TABLE[i][1];
    }
    return 0;
}
