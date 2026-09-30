# CoinVerge — Exact Flashing Steps for Kylee

## Bakit ito kailangan
Ang machine ay running pa rin ng LUMANG firmware (`Build: Mar 5 2024`).
Hindi pumasok ang servo fixes. Kailangan i-pull ang bagong code
(commit `8d3e01e`) at i-flash nang tama sa ESP32.

Ang PATUNAY na tama nang naka-flash: sa Serial Monitor pagka-boot, dapat
lumabas ang linyang:

    [COIN] Acceptor pin GPIO27 ready (interrupt on RISING)

Kung `(idle=LOW, pulses HIGH)` pa rin ang lumalabas, HINDI pumasok ang
bagong code — ulitin ang steps.

---

## STEP 1 — Buksan ang terminal sa TAMANG repo folder

Gamitin ang Git Bash (o Command Prompt / PowerShell) sa Windows.

Punta sa folder ng repo (palitan ang path kung saan mo naka-clone ang CoinVerge):

    cd path/to/CoinVerge

Halimbawa kung nasa Documents:

    cd %USERPROFILE%\Documents\CoinVerge

I-verify na tama ang folder — dapat may makita kang `Coinverge` folder na may `.ino`:

    dir Coinverge

Dapat may makita kang `Coinverge.ino` at `config.h`.

---

## STEP 2 — Kunin ang pinakabagong code mula GitHub

I-type ito nang isa-isa:

    git fetch origin
    git checkout main
    git pull origin main

I-verify na nasa TAMANG commit ka na. I-type:

    git log --oneline -3

Dapat ang PINAKATAAS na linya ay:

    8d3e01e Debug: add servo latency timing logs (measure 1st-pulse to servo command)

Kung HINDI `8d3e01e` ang nasa taas, hindi ka naka-pull ng tama — ulitin ang
`git pull origin main` at tingnan kung may error.

> Kung may sasabing "local changes would be overwritten": i-type muna
>     git stash
> tapos ulitin ang
>     git pull origin main

---

## STEP 3 — Siguraduhing TAMANG file ang bubuksan sa Arduino IDE

MAHALAGA: HUWAG buksan ang mga ito (lumang kopya sila):
  - `Coinverge_BACKUP_2026-07-27/` folder
  - anumang galing sa `Coinverge.zip`
  - anumang lumang clone sa ibang folder

Buksan LANG ang file na ito mula sa pinull mong repo:

    CoinVerge/Coinverge/Coinverge.ino

Sa Arduino IDE: File > Open... > pumunta sa repo > Coinverge folder >
piliin ang `Coinverge.ino`.

Kumpirmahin sa loob ng IDE: dapat may tab na `config.h` at kapag hinanap mo
ang salitang `attachInterrupt`, may makikita ka (Ctrl+F sa IDE o tingnan
ang linya ~154). Kung wala, mali ang binuksang file.

---

## STEP 4 — Library check (isang beses lang)

Kailangan ng `ESP32Servo` library. Sa Arduino IDE:
  Sketch > Include Library > Manage Libraries...
  Hanapin: "ESP32Servo"  → Install (kung wala pa).

---

## STEP 5 — Piliin ang tamang Board at Port

Tools > Board > ESP32 Arduino > (ang board na ginagamit, hal. "ESP32 Dev Module")
Tools > Port > piliin ang COM port ng naka-connect na ESP32
  (hal. COM3, COM4 — kung hindi sigurado, tanggalin ang USB, tingnan alin
   ang nawala sa list, isaksak ulit, 'yun ang tama).

Baud rate sa Serial Monitor: 115200

---

## STEP 6 — Upload (Flash)

Pindutin ang Upload button (ang → arrow icon), o Sketch > Upload.

HINTAYIN ang mensaheng:

    Done uploading.

Kung may error (hal. "Failed to connect", "A fatal error occurred"):
  - Pindutin at i-hold ang BOOT button sa ESP32 habang nag-a-upload,
    bitawan kapag nagsimula na ang "Writing...".
  - I-check ang tamang Port.
  - I-try ang ibang USB cable/port.

---

## STEP 7 — PATUNAYAN na pumasok ang bagong code

Buksan ang Serial Monitor (Tools > Serial Monitor), set sa 115200 baud.
I-reset ang ESP32 (pindutin ang EN/RST button).

Sa boot log, HANAPIN ang linyang ito:

    [COIN] Acceptor pin GPIO27 ready (interrupt on RISING)

- Kung LUMABAS ito  → TAMA na naka-flash ang bagong code. Tuloy sa STEP 8.
- Kung `(idle=LOW, pulses HIGH)` pa rin → HINDI pumasok. Balik sa STEP 2-3.

---

## STEP 8 — Test at kunin ang TIMING data

Habang nakabukas ang Serial Monitor (115200), mag-drop ng ISANG ₱1 coin.

Hanapin ang mga bagong linyang ganito:

    [COIN] Pulse 1 @ 12345ms (t+0ms from 1st pulse)
    [TIMING] servo commanded @ t+2ms from 1st pulse (prePosition took 1ms)
    [SERVO] Pre-position @ 1 pulse(s)

I-COPY o i-screenshot ang lahat ng lumabas (mula boot hanggang pagkatapos
ng coin), tapos ipadala kay Jericho.

Ang mahalagang numero: ang "servo commanded @ t+___ms from 1st pulse".
  - Kung maliit (0-50ms) at mabilis pa rin ang servo → HARDWARE na (servo/power).
  - Kung malaki (daan/libong ms) → may aayusin pa sa code base sa numero.

---

## Buod ng ii-type (quick copy)

    cd path/to/CoinVerge
    git fetch origin
    git checkout main
    git pull origin main
    git log --oneline -3

(dapat 8d3e01e ang nasa taas)

Tapos: Arduino IDE > buksan CoinVerge/Coinverge/Coinverge.ino >
pilidiin Board+Port > Upload > Serial Monitor 115200 > i-reset >
tingnan kung "(interrupt on RISING)" > mag-drop ng barya > i-screenshot.
