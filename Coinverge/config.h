#pragma once

// =============================================================================
//  COINVERGE — Hardware Configuration
//
//  ALL GPIO pins CONFIRMED from hardware probe testing (2026-07-23):
//    GPIO5  → ₱1  hopper
//    GPIO18 → ₱5  hopper
//    GPIO19 → ₱10 hopper
//    GPIO17 → ₱20 hopper
//    GPIO32 → Bill acceptor signal (pulse-type, confirmed soldered)
// =============================================================================

// -----------------------------------------------------------------------------
//  DEBUG MODE
//  1 = Serial-only testing (no GPIO, use Serial Monitor commands)
//  0 = Real hardware mode  ← set this to 0 for real machine testing
// -----------------------------------------------------------------------------
#define DEBUG_MODE  0

// -----------------------------------------------------------------------------
//  HOPPER PINS — one pin per coin denomination
//  Confirmed from probe test on actual hardware 2026-07-23.
//  HIGH = relay ON = hopper runs.
// -----------------------------------------------------------------------------
#define HOP_ACTIVE      HIGH    // HIGH turns the hopper ON
                                // Change to LOW if relay is active-low

#define HOP_PIN_1       5       // ₱1  hopper — confirmed GPIO5
#define HOP_PIN_5       18      // ₱5  hopper — confirmed GPIO18
#define HOP_PIN_10      19      // ₱10 hopper — confirmed GPIO19
#define HOP_PIN_20      17      // ₱20 hopper — confirmed GPIO17

// -----------------------------------------------------------------------------
//  COIN DENOMINATIONS
//  { coin value in pesos, hopper GPIO pin }
// -----------------------------------------------------------------------------
#define DENOM_COUNT  4

const int HOPPER_MAP[DENOM_COUNT][2] = {
    {  1,  HOP_PIN_1  },    // ₱1  → GPIO5
    {  5,  HOP_PIN_5  },    // ₱5  → GPIO18
    { 10,  HOP_PIN_10 },    // ₱10 → GPIO19
    { 20,  HOP_PIN_20 },    // ₱20 → GPIO17
};

// Maximum coins per hopper (0 = disable stock tracking)
#define MAX_COINS_PER_HOPPER  200

// ms per coin for timed dispensing (tune to your hopper speed)
// If dispensing fewer coins than expected, INCREASE this value.
// 700ms tested — adjust up/down based on actual hopper speed.
#define HOP_MS_PER_COIN       700

// Hopper opto-sensor pin (-1 = not connected)
#define HOP_SENSOR_PIN        -1

// Timeout waiting for one coin from opto-sensor (ms)
#define HOP_COIN_TIMEOUT_MS   800

// -----------------------------------------------------------------------------
//  BILL ACCEPTOR — PULSE TYPE
//  Confirmed: GPIO32, soldered directly to bill acceptor signal wire.
//  The bill acceptor outputs pulses on this pin when a bill is accepted.
//
//  HOW IT WORKS (open-collector signal):
//    - GPIO32 is set to INPUT_PULLUP → idles HIGH (pulled up internally)
//    - Bill acceptor pulls the line LOW for each pulse
//    - Number of LOW pulses = denomination code
//    - BILL_IDLE_STATE = HIGH, active pulse = LOW
//
//  PULSE COUNT → BILL VALUE TABLE:
//    TODO: confirm exact pulse counts by testing each bill denomination.
//    Insert each bill and count how many pulses appear on GPIO32.
//    Update the table below with your findings.
// -----------------------------------------------------------------------------
#define BILL_PIN            32      // ✅ confirmed GPIO32
#define BILL_IDLE_STATE     HIGH    // INPUT_PULLUP: pin idles HIGH, pulses go LOW (open-collector)
#define BILL_INHIBIT_PIN    -1      // DISABLED — set to GPIO pin once inhibit wire is confirmed
#define BILL_INHIBIT_ACTIVE HIGH    // HIGH = acceptor disabled (rejects/spits back bills)
#define BILL_DEBOUNCE_MS    20      // ignore transitions shorter than this (pulses are ~25-50ms)
#define BILL_WINDOW_MS      800     // wait this long after last pulse to decode (needs headroom for ₱500/₱1000)

// Pulse count → bill value (pesos)
// CONFIRMED: 1 pulse = ₱10 (tested ₱50=5 pulses, ₱100=10 pulses on 2026-07-24)
#define BILL_PULSE_TABLE_SIZE  6
const int BILL_PULSE_TABLE[BILL_PULSE_TABLE_SIZE][2] = {
    // { pulse_count, peso_value }
    {   2,   20  },  // ✅ ₱20  = 2 pulses  (1 pulse per ₱10)
    {   5,   50  },  // ✅ ₱50  = 5 pulses  (confirmed)
    {  10,  100  },  // ✅ ₱100 = 10 pulses (confirmed)
    {  20,  200  },  // ₱200 = 20 pulses (predicted)
    {  50,  500  },  // ₱500 = 50 pulses (predicted)
    { 100, 1000  },  // ₱1000 = 100 pulses (predicted)
};

// -----------------------------------------------------------------------------
//  COIN ACCEPTOR — PULSE TYPE
//  TODO: find the coin acceptor signal pin using CoinvergeProbe option 2.
//  Set COIN_PIN to the confirmed GPIO once found.
// -----------------------------------------------------------------------------
#define COIN_PIN            -1      // TODO: find with probe option 2
#define COIN_DEBOUNCE_MS    50
#define COIN_WINDOW_MS      400

// Pulse count → coin value (pesos)
// TODO: verify pulse counts with actual coin acceptor
#define COIN_PULSE_TABLE_SIZE  4
const int COIN_PULSE_TABLE[COIN_PULSE_TABLE_SIZE][2] = {
    { 1,   1 },
    { 2,   5 },
    { 3,  10 },
    { 4,  20 },
};

// -----------------------------------------------------------------------------
//  ACCEPTED BILL RANGE
//  Only ₱20, ₱50, ₱100 accepted. Higher bills rejected by DIP switches 6-8=OFF
//  on the TOP/ICT TB74 validator head. MAX_BILL_VALUE is a software safety net.
// -----------------------------------------------------------------------------
#define MIN_BILL_VALUE    20
#define MAX_BILL_VALUE   100

// -----------------------------------------------------------------------------
//  SERIAL PROTOCOL — ESP32 ↔ Raspberry Pi Communication
//  The ESP32 sends events and receives commands over Serial (USB or UART).
//  Baud rate is set by Serial.begin() in setup() — 115200.
//
//  ESP32 → RPi (events):
//    READY                           — boot complete, waiting for commands
//    BILL:<amount>                   — bill accepted (e.g., BILL:100)
//    DISPENSED:OK                    — dispense completed
//    DISPENSED:ERROR:<reason>        — dispense failed
//    STOCK:1=n,5=n,10=n,20=n        — current coin stock per hopper
//
//  RPi → ESP32 (commands):
//    DISPENSE:<denom>x<qty>,...      — e.g., DISPENSE:1x10,5x4,10x2,20x1
//    STOCK?                          — request stock report
//    RESET                           — clear any pending balance
// -----------------------------------------------------------------------------
