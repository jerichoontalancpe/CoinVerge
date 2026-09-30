# CoinVerge — Status at Handover Guide (2026-09-30)

Kumpletong estado ng project at ang natitirang gagawin. Basahin ito bago
mag-presentation.

═══════════════════════════════════════════════════════════════════════
## PART A — ANG STATUS NG LAHAT
═══════════════════════════════════════════════════════════════════════

### ✅ VERIFIED na gumagana (na-test sa aktwal na app / database)

**Software / UI (RPi side) — TESTED end-to-end:**
- App bumu-boot nang malinis (kiosk, admin, phone — lahat HTTP 200)
- RPi ↔ ESP32 connection (na-confirm dati: `Connected to /dev/ttyUSB0`, HARDWARE mode)
- Low-stock detection (2-level: LOW dilaw, CRITICAL pula)
- Admin login (PIN 1234), threshold GET/SET via API
- Privacy: walang exact coin count sa kiosk (Available/Limited/Unavailable)
- Kiosk critical warning: "Do not insert your cash — this machine needs refill for: PX"
- Invalid threshold input (low < critical) tama na tinatanggihan

**Firmware (ESP32) — syntax-verified (clang++, 0 errors):**
- Interrupt-driven coin pulses + non-blocking servo
- 2-stage servo routing (Servo A: P20/pass/P1 ; Servo B: P5/P10)
- Coin pulse mapping 1/2/3/4 (P1/P5/P10/P20)
- Coin pin polarity FIX: FALLING edge, idle HIGH (Rejinald's finding)

### ⚠️ HINDI pa na-verify sa aktwal na hardware (kailangan pa ninyong i-test)
- Phantom/ghost coin — may software fix na (polarity + pulldown + sampling),
  PERO kailangan i-flash sa ESP32 at i-test kung tuluyang nawala.
- Servo speed — mabagal ang kasalukuyang motor (hardware). Optional palitan.
- Bill acceptor pulse table — HINDI pa na-verify (may TODO sa config.h).
- Hopper dispensing (actual coin-out) — hindi pa na-test end-to-end.

═══════════════════════════════════════════════════════════════════════
## PART B — ANG NATITIRANG GAGAWIN (in order)
═══════════════════════════════════════════════════════════════════════

### 1. HARDWARE — Ayusin ang PCB short (PINAKA-URGENT, safety)
Sinabi ng team: "shorted", "voltage leak", "magkakapatong na wire",
at may laptop na namatay habang naka-connect.
- Gumamit ng MULTIMETER (continuity mode) para hanapin ang short:
  - Coin signal pin (GPIO27) vs katabing pins — dapat WALANG beep
  - Power (5V/12V) vs signal/ground — dapat WALANG beep
- Ayusin: ihiwalay ang magkakadikit na wire, i-desolder ang solder bridges.
- Ihiwalay ang coin signal wire sa power wires (noise source).
- ⚠️ HUWAG i-connect ang ESP32 sa laptop habang may short (baka masira ulit).
  I-flash ang ESP32 nang NAKAHIWALAY sa problematic na PCB kung kaya.

### 2. (Optional pero recommended) Optocoupler sa coin signal
- PC817 — nag-i-isolate sa coin acceptor at ESP32 (sinisira ang ground loop).
- KUNG maglagay nito, SABIHIN sa susunod na makakatulong: kailangang baguhin
  ang firmware: FALLING (ganito na ngayon) at i-check ang polarity ng output.

### 3. I-FLASH ang pinakabagong firmware sa ESP32
- Sa Arduino IDE computer (Windows ni Kylee):
  `git pull origin main`  (dapat pinakabago ang commit)
  Buksan `Coinverge/Coinverge.ino` → Upload
- Sa boot log dapat: `[COIN] Acceptor pin GPIO27 ready (interrupt FALLING, ext pull-up, idle HIGH)`
- Test: walang barya → dapat WALA nang ghost pulse.

### 4. I-UPDATE ang RPi (para sa UI features — HINDI kailangang i-flash)
- Sa RPi: `cd ~/CoinVerge && git pull origin main`
- `sudo systemctl restart coinverge.service`
- Ang coinverge.service ay dapat naka-set sa `--port /dev/ttyUSB0` (HARDWARE),
  hindi `--simulate`. Check: `grep ExecStart /etc/systemd/system/coinverge.service`

### 5. TESTS bago mag-demo
- Mag-drop ng P1, P5, P10, P20 → tama ba ang pagbasa (COIN:1/5/10/20)?
- Tama ba ang routing sa hopper?
- Mag-exchange → tama ba ang dispense ng sukli?
- Admin → Stock tab → i-adjust ang threshold → Save → gumana ba ang alert?
- Kiosk → kapag critical ang hopper → lumalabas ba ang "Do not insert cash"?

═══════════════════════════════════════════════════════════════════════
## PART C — PAANO I-TEST SA LAPTOP (walang device kailangan)
═══════════════════════════════════════════════════════════════════════

    cd CoinvergeUI
    pip3 install flask
    python3 app.py --simulate

Buksan sa browser:
- Kiosk: http://localhost:8080
- Admin: http://localhost:8080/admin   (PIN: 1234)
- Phone: http://localhost:8080/phone

Sa admin → Stock tab makikita ang threshold editor at refill alerts.

═══════════════════════════════════════════════════════════════════════
## PART D — REFILL THRESHOLDS (default; editable sa admin)
═══════════════════════════════════════════════════════════════════════

    Hopper | LOW (dilaw) | CRITICAL (pula)
    P1     | 160         | 60
    P5     | 130         | 50
    P10    | 110         | 40
    P20    | 90          | 35

Editable sa Admin → Stock tab → "Refill Alert Thresholds" → Save.
Naka-store sa database (settings), natatandaan kahit i-restart.

═══════════════════════════════════════════════════════════════════════
## PART E — SECURITY (importante, gawin kapag may oras)
═══════════════════════════════════════════════════════════════════════
- Ang GitHub Personal Access Token ay nakalantad sa git remote URL.
  I-revoke ito sa GitHub → Settings → Developer settings → Personal access
  tokens, gumawa ng bago, at i-set ang remote nang WALANG token sa URL.

═══════════════════════════════════════════════════════════════════════
## SUMMARY
═══════════════════════════════════════════════════════════════════════
Ang SOFTWARE ay tapos, verified, at naka-push sa GitHub (branch: main).
Ang natitira ay HARDWARE (PCB short) at PISIKAL na testing (flash + demo).
Ang ghost-coin ay may software fix na PERO kailangang i-flash + i-test;
kung may PCB short pa, ayusin muna 'yun (hindi kayang ayusin ng code ang short).
