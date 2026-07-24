# Coinverge — ESP32 Money Changer Firmware
### Reconstructed from `coinverge_backup.bin`

---

## What This Is

The original Coinverge firmware was extracted from a physical coin exchange machine.
The binary was analyzed to recover function names, logic flow, debug strings, and the
flash partition layout. This repository contains a full reconstruction.

**Confirmed from binary analysis:**

| Item | Value |
|---|---|
| Board | ESP32 |
| Framework | Arduino + ESP-IDF v4.4.7 |
| Build date | Mar 5 2024 |
| Active partition | app0 / ota_0 at flash 0x010000 |
| OTA update image | app1 / ota_1 at flash 0x150000 |
| Crash log present | Yes — coredump at 0x3F0000 |
| Tasks in binary | loopTask, uart_event_task, IDLE0, IDLE1, ipc0, ipc1, esp_timer |

**Function names extracted directly from binary:**

```
openhop          closehop         exchangeMoney    exchangeTerminate
uart_event_task  loopTask
```

---

## Project Files

```
Coinverge/
├── README.md                      ← This file
├── Coinverge/
│   ├── Coinverge.ino              ← Main firmware (flash this to run the machine)
│   └── config.h                   ← ALL student-editable settings (pins, protocol, etc.)
└── CoinvergeProbe/
    └── CoinvergeProbe.ino         ← Hardware probe tool (flash this FIRST)
```

---

## Student Instructions

### Step 0 — Setup Arduino IDE

1. Install **Arduino IDE 2.x** from https://www.arduino.cc/en/software
2. Add ESP32 board support:
   - File → Preferences → Additional Board Manager URLs:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - Tools → Board → Board Manager → search `esp32` → install **esp32 by Espressif Systems v2.0.15**
3. Select board: **Tools → Board → ESP32 Arduino → ESP32 Dev Module**
4. Install CP210x USB driver (the `.zip` file in your Downloads folder)

---

### Step 1 — Test in Debug Mode (no hardware needed)

The firmware has a built-in debug mode. You can run it without the actual coin machine.

1. Open `Coinverge/Coinverge.ino` in Arduino IDE
2. In `config.h`, confirm `DEBUG_MODE  1` (it's already set)
3. Upload to the ESP32
4. Open **Tools → Serial Monitor** at **115200 baud**
5. You should see:
   ```
   SYSTEM START
   Coinverge v1.0 | Build: Mar  5 2024 | IDF: v4.4.7
   [DEBUG MODE] Hardware GPIO disabled. Use Serial commands.
   Total Money: 0
   Ready.
   ```
6. Type these commands in the Serial Monitor input box:

| Command | What it does |
|---|---|
| `BILL 100` | Simulate inserting a ₱100 bill |
| `COIN 25` | Simulate inserting a ₱25 coin |
| `EXCHANGE` | Manually trigger the exchange |
| `STATUS` | Show current totals and coin stock |
| `RESET` | Clear totals |
| `REFILL` | Refill simulated coin stock |
| `HELP` | Show all commands |

**Expected output for `BILL 100` then `EXCHANGE`:**
```
[DEBUG] Bill ₱100 inserted
Total Money: 100
exchangeMoney: 100
Split 100 > FData : 4x25
D[0] :
 L:0
D[1] :
 L:0
D[2] :
 L:0
D[3] :
 L:4
openhop
[DEBUG] Dispensing 4 coins (simulated 1400 ms)
closehop
exchangeTerminate
Total Money: 0
```

> ✅ If you see this output, the core logic is working correctly.

---

### Step 2 — Find the Real Hardware Pins

The GPIO pin numbers are NOT stored as text in the firmware binary — they're
compiled into machine code. Use the probe tool to find them.

1. Open `CoinvergeProbe/CoinvergeProbe.ino` in Arduino IDE
2. Upload it to the ESP32 **while it's connected to the coin machine**
3. Open Serial Monitor at **115200 baud**
4. Follow the menu:

#### 2a. Find the Hopper Relay Pin

```
Select option 1
```
The tool will drive each GPIO HIGH for 2 seconds. **Watch the hopper motor.**
When it spins (or the relay clicks), that's your `HOP_PIN`.

**Record it:** GPIO ___

> ⚠️ If the hopper spins on LOW instead of HIGH, set `HOP_ACTIVE LOW` in config.h

#### 2b. Find the Coin Acceptor Pin

```
Select option 2
```
The tool watches all GPIOs simultaneously. **Insert a coin.**
The GPIO that flashes LOW is your `COIN_PIN`.

**Record it:** GPIO ___

#### 2c. Find the Bill Acceptor UART Pin + Baud Rate

```
Select option 3
```
The tool cycles through every combination of RX pin and baud rate.
**Insert a bill** after each "Trying..." message.
When bytes appear on screen, you have the right combination.

**Record:** RX Pin = GPIO ___ , Baud = ___

**Also record the bytes** that appeared and which bill denomination you inserted.
Example:
```
₱20  bill → 0x01
₱50  bill → 0x02
₱100 bill → 0x03
```
You'll enter these in `BILL_BYTE_TABLE` in config.h.

---

### Step 3 — Update config.h

Open `Coinverge/config.h` and fill in everything you found:

```cpp
#define DEBUG_MODE      0       // ← Change to 0

#define HOP_PIN         18      // ← Replace with your result from Step 2a
#define HOP_ACTIVE      HIGH    // ← Change to LOW if needed

#define COIN_PIN        19      // ← Replace with your result from Step 2b

#define BILL_UART_RX_PIN    16  // ← Replace with your result from Step 2c
#define BILL_UART_BAUD      9600 // ← Replace with your result from Step 2c
```

Also update the bill byte table with your recorded values:
```cpp
const int BILL_BYTE_TABLE[BILL_TABLE_SIZE][2] = {
    { 0x01,   20  },   // ← Use your actual sniffed bytes
    { 0x02,   50  },
    { 0x03,  100  },
    ...
};
```

---

### Step 4 — Flash and Test on Real Hardware

1. Open `Coinverge/Coinverge.ino`
2. Confirm `DEBUG_MODE 0` in config.h
3. Upload to the ESP32
4. Open Serial Monitor at 115200 baud
5. Insert a bill — you should see:
   ```
   SYSTEM START
   Total Money: 0
   Ready.
   [UART] Bytes: 0x03
   [BILL] Accepted ₱100
   Total Money: 100
   exchangeMoney: 100
   Split 100 > FData : 4x25
   ...
   openhop
   closehop
   exchangeTerminate
   Total Money: 0
   ```

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| Hopper doesn't spin | Wrong `HOP_PIN`, or relay is active-LOW (try `HOP_ACTIVE LOW`) |
| Hopper spins and won't stop | Logic inverted — swap `HOP_ACTIVE` |
| No UART data from bill acceptor | Wrong RX pin or baud rate — re-run probe step 3 |
| `ERROR: NO EXCHANGE` | `totalMoney` is 0, or coin stock is empty (check STATUS) |
| `Cannot make exact change` | Denominations in config don't match loaded coins |
| Parity/frame errors in Serial | Wrong baud rate on bill acceptor UART |
| Coins counted wrong | Pulse table in config.h wrong — count pulses manually with probe mode 2 |

---

## What's Still Unknown (fill in from hardware)

| Unknown | How to find it |
|---|---|
| `HOP_PIN` | Probe mode 1 |
| `HOP_ACTIVE` (HIGH or LOW) | Probe mode 1 — try both |
| `HOP_SENSOR_PIN` | Probe mode 2 while hopper is running |
| `COIN_PIN` | Probe mode 2 |
| `COIN_PULSE_TABLE` | Probe mode 2 — count pulses per denomination |
| `BILL_UART_RX_PIN` | Probe mode 3 |
| `BILL_UART_BAUD` | Probe mode 3 |
| `BILL_BYTE_TABLE` | Probe mode 3 — record bytes per bill |
