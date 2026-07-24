/*
 * ============================================================================
 *  COINVERGE — Hardware Probe Utility
 *  Flash this FIRST to identify unknown GPIO pins on the board.
 *  This is a SEPARATE sketch — open this folder in Arduino IDE, not Coinverge/
 * ============================================================================
 *
 *  PURPOSE:
 *    The original firmware GPIO pin numbers are not stored as readable strings
 *    in the binary — they're compiled into machine code. This utility helps
 *    your students find the correct pins by:
 *      1. Scanning all GPIOs for the hopper relay
 *      2. Watching all GPIOs for coin acceptor pulses
 *      3. Sniffing UART on all common pin pairs for bill acceptor data
 *
 *  HOW TO USE:
 *    1. Flash this sketch to the ESP32
 *    2. Open Serial Monitor at 115200 baud
 *    3. Follow the on-screen menu
 *
 *  STUDENT TASK:
 *    Record what you find and update config.h in the main Coinverge sketch.
 * ============================================================================
 */

#include <Arduino.h>

// ESP32 GPIO pins available for testing (skip reserved/input-only pins)
const int TEST_GPIOS[] = {
    2, 4, 5, 12, 13, 14, 15,
    16, 17, 18, 19, 21, 22, 23,
    25, 26, 27, 32, 33, 34, 35
};
const int NUM_TEST_GPIOS = sizeof(TEST_GPIOS) / sizeof(TEST_GPIOS[0]);

// Input-only GPIOs (cannot drive output)
const int INPUT_ONLY_GPIOS[] = { 34, 35, 36, 39 };

bool isInputOnly(int pin) {
    for (int p : INPUT_ONLY_GPIOS) if (p == pin) return true;
    return false;
}

// ── State ────────────────────────────────────────────────────
static int  currentMode  = 0;    // 0=menu, 1=hop scan, 2=coin watch, 3=uart sniff
static int  hopScanIndex = 0;
static bool hopScanActive = false;

// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(300);
    printMenu();
}

void loop() {
    if (Serial.available()) {
        String input = Serial.readStringUntil('\n');
        input.trim();
        handleInput(input);
    }

    if (currentMode == 2) coinWatchTick();
    if (currentMode == 3) uartSniffTick();
}

// ============================================================================
//  MENU
// ============================================================================

void printMenu() {
    Serial.println();
    Serial.println("========================================");
    Serial.println("  Coinverge Hardware Probe Utility");
    Serial.println("========================================");
    Serial.println("1  Scan for HOPPER relay pin");
    Serial.println("   (pulses each GPIO HIGH for 1 sec)");
    Serial.println("2  Watch for COIN ACCEPTOR pulses");
    Serial.println("   (shows which GPIO goes LOW on coin)");
    Serial.println("3  Sniff BILL ACCEPTOR UART");
    Serial.println("   (tries all common baud rates + pins)");
    Serial.println("4  Manual GPIO toggle");
    Serial.println("   (type: HIGH <pin> or LOW <pin>)");
    Serial.println("0  Show this menu again");
    Serial.println("========================================");
    Serial.print("> ");
}

void handleInput(String s) {
    s.toUpperCase();

    if (s == "0") {
        currentMode = 0;
        stopAllModes();
        printMenu();

    } else if (s == "1") {
        startHopperScan();

    } else if (s == "2") {
        startCoinWatch();

    } else if (s == "3") {
        startUartSniff();

    } else if (s == "4") {
        currentMode = 4;
        Serial.println("Manual GPIO mode. Commands:");
        Serial.println("  HIGH <pin>   Drive pin HIGH");
        Serial.println("  LOW <pin>    Drive pin LOW");
        Serial.println("  READ <pin>   Read pin state");
        Serial.println("  0            Back to menu");

    } else if (s.startsWith("HIGH ") || s.startsWith("LOW ") || s.startsWith("READ ")) {
        handleManualGpio(s);

    } else if (s == "NEXT" && currentMode == 1) {
        hopScanNext();

    } else if (s == "STOP") {
        stopAllModes();
        currentMode = 0;
        printMenu();
    }
}

void stopAllModes() {
    // Release all test pins
    for (int i = 0; i < NUM_TEST_GPIOS; i++) {
        if (!isInputOnly(TEST_GPIOS[i])) {
            digitalWrite(TEST_GPIOS[i], LOW);
            pinMode(TEST_GPIOS[i], INPUT);
        }
    }
}

// ============================================================================
//  MODE 1: HOPPER RELAY SCAN
//  Drives each GPIO HIGH one at a time and asks if the hopper ran.
// ============================================================================

void startHopperScan() {
    currentMode  = 1;
    hopScanIndex = 0;
    Serial.println();
    Serial.println("── HOPPER SCAN ─────────────────────────");
    Serial.println("Watch the hopper motor. When it spins,");
    Serial.println("that's the relay pin.");
    Serial.println("Press ENTER to advance, or type STOP.");
    Serial.println("─────────────────────────────────────────");
    hopScanNext();
}

void hopScanNext() {
    // Release previous pin
    if (hopScanIndex > 0) {
        int prevPin = TEST_GPIOS[hopScanIndex - 1];
        if (!isInputOnly(prevPin)) {
            digitalWrite(prevPin, LOW);
            pinMode(prevPin, INPUT);
        }
    }

    if (hopScanIndex >= NUM_TEST_GPIOS) {
        Serial.println("All GPIOs tested.");
        Serial.println("If nothing happened, try reversing relay polarity:");
        Serial.println("  Change HOP_ACTIVE to LOW in config.h");
        currentMode = 0;
        printMenu();
        return;
    }

    int pin = TEST_GPIOS[hopScanIndex];
    hopScanIndex++;

    if (isInputOnly(pin)) {
        Serial.printf("GPIO%d : input-only, skipping\n", pin);
        hopScanNext();
        return;
    }

    Serial.printf("\nTesting GPIO%d — driving HIGH for 2 seconds...\n", pin);
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);

    delay(2000);

    digitalWrite(pin, LOW);
    pinMode(pin, INPUT);

    Serial.printf("Did the hopper spin? (Yes → set HOP_PIN %d in config.h)\n", pin);
    Serial.println("Press ENTER for next pin, or type STOP.");
}

// ============================================================================
//  MODE 2: COIN ACCEPTOR PULSE WATCH
//  Monitors all GPIOs simultaneously and reports which one goes LOW.
// ============================================================================

static unsigned long coinWatchLastReport = 0;

void startCoinWatch() {
    currentMode = 2;
    Serial.println();
    Serial.println("── COIN ACCEPTOR WATCH ──────────────────");
    Serial.println("Insert a coin. The GPIO that goes LOW");
    Serial.println("is your COIN_PIN.");
    Serial.println("Type STOP to exit.");
    Serial.println("─────────────────────────────────────────");

    for (int i = 0; i < NUM_TEST_GPIOS; i++) {
        pinMode(TEST_GPIOS[i], INPUT_PULLUP);
    }
    coinWatchLastReport = millis();
}

void coinWatchTick() {
    for (int i = 0; i < NUM_TEST_GPIOS; i++) {
        int pin = TEST_GPIOS[i];
        if (digitalRead(pin) == LOW) {
            Serial.printf("[COIN PULSE] GPIO%d went LOW!\n", pin);
            Serial.printf("  → Set COIN_PIN %d in config.h\n", pin);
            delay(100);  // simple debounce display
        }
    }
    // Heartbeat every 5 seconds so students know it's running
    if (millis() - coinWatchLastReport > 5000) {
        Serial.println("[watching... insert a coin]");
        coinWatchLastReport = millis();
    }
}

// ============================================================================
//  MODE 3: UART SNIFFER
//  Tries common UART pin pairs at common baud rates.
//  Students insert a bill while each combo is active.
// ============================================================================

const int UART_RX_CANDIDATES[] = { 16, 17, 21, 22, 25, 26 };
const int NUM_UART_RX = sizeof(UART_RX_CANDIDATES) / sizeof(UART_RX_CANDIDATES[0]);
const int UART_BAUDS[] = { 9600, 4800, 19200, 115200 };
const int NUM_BAUDS = sizeof(UART_BAUDS) / sizeof(UART_BAUDS[0]);

static int sniffRxIdx   = 0;
static int sniffBaudIdx = 0;
static unsigned long sniffLastMsg = 0;

void startUartSniff() {
    currentMode  = 3;
    sniffRxIdx   = 0;
    sniffBaudIdx = 0;
    Serial.println();
    Serial.println("── BILL ACCEPTOR UART SNIFF ─────────────");
    Serial.println("Insert a bill after each 'Trying...' line.");
    Serial.println("When bytes appear, record RX pin + baud.");
    Serial.println("Type STOP to exit.");
    Serial.println("─────────────────────────────────────────");
    uartSniffNext();
}

void uartSniffNext() {
    if (sniffRxIdx >= NUM_UART_RX) {
        if (++sniffBaudIdx >= NUM_BAUDS) {
            Serial.println("All combinations tried.");
            Serial.println("If no bytes appeared, check bill acceptor power.");
            currentMode = 0;
            printMenu();
            return;
        }
        sniffRxIdx = 0;
    }

    int rxPin  = UART_RX_CANDIDATES[sniffRxIdx++];
    int baud   = UART_BAUDS[sniffBaudIdx];

    // Re-init Serial2 with new params
    Serial2.end();
    delay(50);
    Serial2.begin(baud, SERIAL_8N1, rxPin, -1);  // RX only

    Serial.printf("\nTrying RX=GPIO%d @ %d baud — insert a bill now...\n",
                  rxPin, baud);
    sniffLastMsg = millis();
}

void uartSniffTick() {
    if (Serial2.available()) {
        Serial.print("[UART DATA] Bytes: ");
        while (Serial2.available()) {
            uint8_t b = Serial2.read();
            Serial.printf("0x%02X ", b);
        }
        Serial.println();
        Serial.printf("→ Set BILL_UART_RX_PIN to current GPIO, BILL_UART_BAUD to current rate\n");
        Serial.println("→ Update BILL_BYTE_TABLE in config.h with these bytes + their bill values");
    }

    // Rotate to next combo every 6 seconds
    if (millis() - sniffLastMsg > 6000) {
        uartSniffNext();
    }
}

// ============================================================================
//  MODE 4: MANUAL GPIO
// ============================================================================

void handleManualGpio(String cmd) {
    int spaceIdx = cmd.indexOf(' ');
    if (spaceIdx < 0) { Serial.println("Usage: HIGH <pin>  LOW <pin>  READ <pin>"); return; }

    String action = cmd.substring(0, spaceIdx);
    int    pin    = cmd.substring(spaceIdx + 1).toInt();

    if (pin < 0 || pin > 39) {
        Serial.printf("Invalid GPIO %d\n", pin);
        return;
    }

    if (action == "HIGH") {
        if (isInputOnly(pin)) { Serial.printf("GPIO%d is input-only\n", pin); return; }
        pinMode(pin, OUTPUT);
        digitalWrite(pin, HIGH);
        Serial.printf("GPIO%d → HIGH\n", pin);

    } else if (action == "LOW") {
        if (isInputOnly(pin)) { Serial.printf("GPIO%d is input-only\n", pin); return; }
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
        Serial.printf("GPIO%d → LOW\n", pin);

    } else if (action == "READ") {
        pinMode(pin, INPUT_PULLUP);
        int val = digitalRead(pin);
        Serial.printf("GPIO%d = %s\n", pin, val ? "HIGH" : "LOW");
    }
}
