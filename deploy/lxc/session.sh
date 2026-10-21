#!/usr/bin/env bash
# Kiosk session: Xvfb + PulseAudio null sink + Chrome with CDP on localhost.
# This is the v1 remote browser; in v2 it is only used for the one-time Google/YouTube sign-in
# at /signin (the server exports the YouTube cookies from this profile for yt-dlp).
# Run by teslatv-session.service as the unprivileged `teslatv` user.
set -euo pipefail

: "${TV_DISPLAY:=:99}"
: "${TV_SCREEN_W:=1920}"
: "${TV_SCREEN_H:=1200}"
: "${TV_CDP_PORT:=9222}"
: "${TV_HOME_URL:=https://www.youtube.com/}"
: "${TV_CHROME:=/usr/bin/google-chrome-stable}"
: "${TV_PROFILE:=/var/lib/teslatv/chrome-profile}"
: "${TV_EXTENSIONS:=}"          # comma-separated unpacked extension dirs (optional)

RUN=/run/teslatv
export XDG_RUNTIME_DIR="$RUN"
export PULSE_RUNTIME_PATH="$RUN/pulse"
export PULSE_SERVER="unix:$RUN/pulse/native"
export DISPLAY="$TV_DISPLAY"
mkdir -p "$RUN/pulse" "$TV_PROFILE"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait || true; }
trap cleanup EXIT INT TERM

# 1) virtual screen (24-bit, no listening TCP socket)
Xvfb "$TV_DISPLAY" -screen 0 "${TV_SCREEN_W}x${TV_SCREEN_H}x24" -nolisten tcp -noreset -dpi 96 &
pids+=($!)
for _ in $(seq 50); do xdpyinfo -display "$TV_DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done

# 2) audio: a null sink called "tv"; ffmpeg records its .monitor
pulseaudio --daemonize=no --exit-idle-time=-1 --disallow-exit --disable-shm=yes \
  -n --load="module-native-protocol-unix socket=$RUN/pulse/native auth-anonymous=1" \
  --load="module-null-sink sink_name=tv rate=44100 channels=2 sink_properties=device.description=TeslaTV" \
  --load="module-always-sink" &
pids+=($!)
for _ in $(seq 50); do pactl info >/dev/null 2>&1 && break; sleep 0.1; done
pactl set-default-sink tv

# 3) Chrome kiosk. Restarted by the loop if it crashes; profile persists (YouTube login, settings).
rm -f "$TV_PROFILE/SingletonLock" "$TV_PROFILE/SingletonSocket" "$TV_PROFILE/SingletonCookie"
# --window-size is in DIPs, so divide by the scale factor or the window overflows the screen.
SCALE="${TV_SCALE:-1.25}"
WIN_W=$(awk -v w="$TV_SCREEN_W" -v s="$SCALE" 'BEGIN{printf "%d", w/s}')
WIN_H=$(awk -v h="$TV_SCREEN_H" -v s="$SCALE" 'BEGIN{printf "%d", h/s}')
EXT_ARGS=()
[ -n "$TV_EXTENSIONS" ] && EXT_ARGS=(--load-extension="$TV_EXTENSIONS")
# GPU mode: "off" = Chrome's CPU software compositor (cheapest without a GPU; measured far
# fewer dropped frames than swiftshader GL), "swiftshader" = emulated GL (WebGL works).
case "${TV_GPU_MODE:-off}" in
  swiftshader) GPU_ARGS=(--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader) ;;
  *)           GPU_ARGS=(--disable-gpu --disable-gpu-compositing --disable-software-rasterizer=false) ;;
esac
while true; do
  "$TV_CHROME" \
    --user-data-dir="$TV_PROFILE" \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port="$TV_CDP_PORT" \
    --remote-allow-origins=http://127.0.0.1 \
    --window-position=0,0 --window-size="${WIN_W},${WIN_H}" --kiosk \
    --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
    --disable-background-timer-throttling \
    --no-first-run --no-default-browser-check --disable-infobars --disable-translate \
    --disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion \
    --disable-session-crashed-bubble --hide-crash-restore-bubble --noerrdialogs \
    --autoplay-policy=no-user-gesture-required \
    --password-store=basic --disable-background-networking=false \
    --enable-features=OverlayScrollbar \
    --touch-events=enabled \
    --force-device-scale-factor="$SCALE" \
    "${GPU_ARGS[@]}" \
    --disable-dev-shm-usage \
    "${EXT_ARGS[@]}" \
    "$TV_HOME_URL" &
  cpid=$!
  wait "$cpid" || true
  echo "chrome exited, restarting in 2s" >&2
  sleep 2
done
