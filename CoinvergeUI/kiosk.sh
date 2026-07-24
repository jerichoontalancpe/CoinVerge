#!/bin/bash
# CoinVerge Kiosk — Auto-start script for Raspberry Pi
# This script starts the Flask server and opens Chromium in kiosk mode.
#
# Install:
#   1. Copy CoinvergeUI/ to /home/pi/CoinvergeUI
#   2. pip3 install flask pyserial
#   3. sudo cp coinverge-kiosk.service /etc/systemd/system/
#   4. sudo systemctl enable coinverge-kiosk
#   5. sudo systemctl start coinverge-kiosk
#   6. Reboot — it auto-starts

cd /home/pi/CoinvergeUI

# Wait for display to be ready
sleep 3

# Disable screen blanking
export DISPLAY=:0
xset s off
xset -dpms
xset s nofill

# Hide mouse cursor (install: sudo apt install unclutter)
unclutter -idle 0.5 &

# Start Flask server in background
python3 app.py --port /dev/ttyUSB0 --web-port 8080 &
FLASK_PID=$!

# Wait for server to be ready
sleep 3

# Launch Chromium in kiosk mode
chromium-browser \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --disable-translate \
    --disable-features=TranslateUI \
    --check-for-update-interval=31536000 \
    --disable-session-crashed-bubble \
    --hide-scrollbars \
    --app=http://localhost:8080

# If Chromium exits, kill Flask
kill $FLASK_PID
