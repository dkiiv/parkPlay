#!/usr/bin/env bash
# Idempotent installer for the TeslaTV host (Ubuntu 24.04+/Debian 13, LXC or VM).
# Usage (as root, from a checkout copied to /opt/teslatv):
#   TV_PUBLIC_HOST=tv.example.com TV_STREAM_HOST=tv-stream.example.com \
#   TV_ACCESS_TEAM=yourteam.cloudflareaccess.com TV_ACCESS_AUD=<audience tag> \
#   TV_ACME_EMAIL=you@example.com TV_TUNNEL_TOKEN_FILE=/root/tunnel.token \
#   ./deploy/lxc/install.sh
# TV_TUNNEL_TOKEN_FILE: token of a remotely-managed Cloudflare Tunnel whose ingress maps
# TV_PUBLIC_HOST -> http://localhost:8090. Copied to /etc/cloudflared/teslatv.token.
# Not installed here: yt-dlp (needed by the v2 player). Put a current release in /usr/local/bin.
# Third-party software this script installs or downloads (Google Chrome, uBlock Origin Lite,
# cloudflared, distro packages) is not part of TeslaTV and keeps its own license; see
# THIRD_PARTY_NOTICES.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
[ "$ROOT" = /opt/teslatv ] || { echo "copy the repo to /opt/teslatv first (got $ROOT)"; exit 1; }
: "${TV_PUBLIC_HOST:?set TV_PUBLIC_HOST}"
: "${TV_STREAM_HOST:?set TV_STREAM_HOST}"
: "${TV_ACCESS_TEAM:?set TV_ACCESS_TEAM}"
: "${TV_ACCESS_AUD:?set TV_ACCESS_AUD}"
: "${TV_ACME_EMAIL:?set TV_ACME_EMAIL}"

export DEBIAN_FRONTEND=noninteractive
echo "== packages"
apt-get update -qq
apt-get install -y -qq xvfb x11-utils ffmpeg pulseaudio pulseaudio-utils nodejs npm caddy \
  fonts-noto-core fonts-noto-color-emoji fonts-liberation curl gnupg unzip jq >/dev/null
if ! command -v google-chrome-stable >/dev/null; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq && apt-get install -y -qq google-chrome-stable >/dev/null
fi
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod 755 /usr/local/bin/cloudflared
fi

echo "== user + dirs"
id teslatv >/dev/null 2>&1 || useradd -r -m -d /var/lib/teslatv -s /usr/sbin/nologin teslatv
install -d -o teslatv -g teslatv -m 750 /var/lib/teslatv /var/lib/teslatv/probe /var/lib/teslatv/extensions
install -d -m 750 -g teslatv /etc/teslatv

echo "== node deps"
(cd server && npm install --omit=dev --no-audit --no-fund --silent)

echo "== probe test clips"
G=web/generated; mkdir -p "$G"
[ -s $G/probe-clip.ts ] || ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=30 \
  -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 10 -c:v mpeg1video -b:v 800k -bf 0 \
  -c:a mp2 -b:a 128k -f mpegts $G/probe-clip.ts
[ -s $G/probe-clip.mp4 ] || ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=30 -t 10 \
  -c:v libx264 -pix_fmt yuv420p -profile:v baseline -movflags +faststart $G/probe-clip.mp4
[ -s $G/probe-tone.mp3 ] || ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=660:sample_rate=44100" -t 10 \
  -c:a libmp3lame -b:a 96k $G/probe-tone.mp3

# uBlock Origin Lite (GPL-3.0) is downloaded unmodified from its GitHub releases at install
# time; it is not bundled in this repository.
echo "== uBlock Origin Lite (MV3, unpacked)"
UBOL=/var/lib/teslatv/extensions/ublock-lite
if [ ! -f "$UBOL/manifest.json" ]; then
  url=$(curl -fsSL https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest \
        | jq -r '.assets[] | select(.name|test("chromium.*\\.zip$")) | .browser_download_url' | head -1)
  if [ -n "$url" ]; then
    tmp=$(mktemp -d); curl -fsSL -o "$tmp/u.zip" "$url"; mkdir -p "$UBOL"; unzip -q -o "$tmp/u.zip" -d "$UBOL"; rm -rf "$tmp"
    chown -R teslatv:teslatv /var/lib/teslatv/extensions
  else
    echo "WARN: could not find uBOL release asset; continuing without ad blocking"
  fi
fi

echo "== env file"
ENVF=/etc/teslatv/teslatv.env
[ -f "$ENVF" ] || { cp deploy/lxc/teslatv.env.example "$ENVF"; sed -i "s|^TV_SECRET=.*|TV_SECRET=$(openssl rand -hex 32)|" "$ENVF"; }
setkv() { grep -q "^$1=" "$ENVF" && sed -i "s|^$1=.*|$1=$2|" "$ENVF" || echo "$1=$2" >> "$ENVF"; }
setkv TV_PUBLIC_HOST "$TV_PUBLIC_HOST"
setkv TV_STREAM_HOST "$TV_STREAM_HOST"
setkv TV_ACCESS_TEAM "$TV_ACCESS_TEAM"
setkv TV_ACCESS_AUD "$TV_ACCESS_AUD"
grep -q '^TV_STREAM_PORT=' "$ENVF" || echo 'TV_STREAM_PORT=8091' >> "$ENVF"
sed -i '/^TV_PASSWORD_HASH=/d;/^TV_SECURE_COOKIE=/d' "$ENVF"   # legacy password login (removed)
chown root:teslatv "$ENVF"; chmod 640 "$ENVF"

echo "== caddy (stream hostname only)"
sed -e "s|{\$TV_STREAM_HOST}|$TV_STREAM_HOST|" -e "s|{\$TV_ACME_EMAIL}|$TV_ACME_EMAIL|" deploy/lxc/Caddyfile > /etc/caddy/Caddyfile
install -d -o caddy -g caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

echo "== cloudflared (UI hostname via Access)"
install -d -m 755 /etc/cloudflared
if [ -n "${TV_TUNNEL_TOKEN_FILE:-}" ]; then
  install -m 644 "$TV_TUNNEL_TOKEN_FILE" /etc/cloudflared/teslatv.token   # DynamicUser must read it
fi
[ -s /etc/cloudflared/teslatv.token ] || echo "WARN: /etc/cloudflared/teslatv.token missing; UI will be unreachable"

echo "== systemd"
install -m 644 deploy/systemd/teslatv-session.service deploy/systemd/teslatv-web.service \
  deploy/systemd/cloudflared-teslatv.service /etc/systemd/system/
chmod 755 deploy/lxc/session.sh
systemctl daemon-reload
systemctl enable --now teslatv-session
systemctl enable teslatv-web cloudflared-teslatv
systemctl restart teslatv-web cloudflared-teslatv
systemctl reload-or-restart caddy
sleep 3
systemctl --no-pager --lines=0 status teslatv-session teslatv-web cloudflared-teslatv caddy | grep -E "●|Active"
curl -fsS http://127.0.0.1:8090/healthz && echo
echo "done: https://$TV_PUBLIC_HOST (Access)  stream: https://$TV_STREAM_HOST"
