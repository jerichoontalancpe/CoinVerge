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

// Hopper sensor pins — one per hopper (counts coins as they drop)
// Confirmed from wire tracing 2026-07-24:
#define HOP_SENSOR_PIN_1      39      // ₱1  sensor — GPIO39 (VN), blue wire
#define HOP_SENSOR_PIN_5      34      // ₱5  sensor — GPIO34, white wire
#define HOP_SENSOR_PIN_10     35      // ₱10 sensor — GPIO35, yellow wire
#define HOP_SENSOR_PIN_20     36      // ₱20 sensor — GPIO36 (VP), green wire

// -----------------------------------------------------------------------------
//  COIN DENOMINATIONS
//  { coin value in pesos, hopper GPIO pin, sensor GPIO pin }
// -----------------------------------------------------------------------------
#define DENOM_COUNT  4

const int HOPPER_MAP[DENOM_COUNT][3] = {
    {  1,  HOP_PIN_1,  HOP_SENSOR_PIN_1  },    // ₱1  → motor GPIO5,  sensor GPIO39
    {  5,  HOP_PIN_5,  HOP_SENSOR_PIN_5  },    // ₱5  → motor GPIO18, sensor GPIO34
    { 10,  HOP_PIN_10, HOP_SENSOR_PIN_10 },    // ₱10 → motor GPIO19, sensor GPIO35
    { 20,  HOP_PIN_20, HOP_SENSOR_PIN_20 },    // ₱20 → motor GPIO17, sensor GPIO36
};

// Maximum coins per hopper (0 = disable stock tracking)
#define MAX_COINS_PER_HOPPER  1000

// ms per coin for timed dispensing (used as timeout fallback)
#define HOP_MS_PER_COIN       1500

// Timeout waiting for one coin from sensor (ms)
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
#define BILL_PIN            32      // confirmed GPIO32
#define BILL_IDLE_STATE     HIGH    // INPUT_PULLUP: pin idles HIGH, pulses go LOW (open-collector)
#define BILL_INHIBIT_PIN    33      // GPIO33 — confirmed wired (Yellow=INHIBIT+, Green=GND)
#define BILL_INHIBIT_ACTIVE HIGH    // HIGH = acceptor disabled (rejects/spits back bills)
#define BILL_DEBOUNCE_MS    20      // ignore transitions shorter than this (pulses are ~25-50ms)
#define BILL_WINDOW_MS      800     // wait this long after last pulse to decode (needs headroom for ₱500/₱1000)

// Pulse count → bill value (pesos)
// CONFIRMED: 1 pulse = ₱10 (tested ₱50=5 pulses, ₱100=10 pulses on 2026-07-24)
#define BILL_PULSE_TABLE_SIZE  6
const int BILL_PULSE_TABLE[BILL_PULSE_TABLE_SIZE][2] = {
    // { pulse_count, peso_value }
    {   2,   20  },  // P20  = 2 pulses  (1 pulse per P10)
    {   5,   50  },  // P50  = 5 pulses  (confirmed)
    {  10,  100  },  // P100 = 10 pulses (confirmed)
    {  20,  200  },  // P200 = 20 pulses (predicted)
    {  50,  500  },  // P500 = 50 pulses (predicted)
    { 100, 1000  },  // P1000 = 100 pulses (predicted)
};

// -----------------------------------------------------------------------------
//  COIN ACCEPTOR — Allan 1299 Pro Max Universal
//  Signal: Normally Open (idles HIGH with INPUT_PULLUP, pulses LOW)
//  Pulse speed: configurable via DIP switch (Fast=25ms, Med=45ms, Slow=65ms)
// -----------------------------------------------------------------------------
#define COIN_PIN            27      // Coin acceptor signal wire (GPIO27)
#define COIN_ACCEPT_PIN     27      // Alias for clarity
#define COIN_INHIBIT_PIN    26      // GPIO26 — relay cuts 12V power to coin acceptor
#define COIN_INHIBIT_ACTIVE HIGH    // HIGH = relay ON = coin acceptor powered (accepting)
                                    // LOW = relay OFF = coin acceptor off (rejecting)
#define COIN_DEBOUNCE_MS    20      // Debounce between pulses
#define COIN_WINDOW_MS      500     // Wait after last pulse to decode (needs time for 20 pulses)

// Pulse count → coin value table (configure to match DIP switch settings)
#define COIN_ACCEPT_TABLE_SIZE  4
const int COIN_ACCEPT_TABLE[][2] = {
    { 1,   1 },    // 1 pulse  = P1
    { 5,   5 },    // 5 pulses = P5
    { 10,  10 },   // 10 pulses = P10
    { 20,  20 },   // 20 pulses = P20
};

// Legacy alias for backward compatibility
#define COIN_PULSE_TABLE_SIZE  COIN_ACCEPT_TABLE_SIZE
#define COIN_PULSE_TABLE       COIN_ACCEPT_TABLE

// -----------------------------------------------------------------------------
//  SERVO MOTORS — Route coins to correct hopper
//  Servo A: routes ₱1 and ₱5 coins
//  Servo B: routes ₱10 and ₱20 coins
// -----------------------------------------------------------------------------
#define SERVO_A_PIN         13      // Servo A PWM pin (₱1/₱5 routing)
#define SERVO_B_PIN         14      // Servo B PWM pin (₱10/₱20 routing)

// Default servo positions (degrees) — calibrate via admin panel
#define SERVO_A_POS_1       45      // Servo A position for ₱1 hopper
#define SERVO_A_POS_5       135     // Servo A position for ₱5 hopper
#define SERVO_B_POS_10      45      // Servo B position for ₱10 hopper
#define SERVO_B_POS_20      135     // Servo B position for ₱20 hopper

// Neutral (center) servo position
#define SERVO_NEUTRAL       90

// Time to hold servo in position (ms) — ensures coin drops through
#define SERVO_HOLD_MS       500

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
