#!/usr/bin/env bash
# Push the working tree to the ParkPlay host and restart the web service.
#   ./tools/push.sh [ssh-host]        (default: $TV_HOST, else "parkplay")
set -euo pipefail
HOST=${1:-${TV_HOST:-parkplay}}
cd "$(dirname "$0")/.."
tar czf - --exclude node_modules --exclude web/generated . | ssh "$HOST" \
  'set -e; rm -rf /tmp/parkplay-src; mkdir -p /tmp/parkplay-src; tar xzf - -C /tmp/parkplay-src;
   sudo cp -a /tmp/parkplay-src/. /opt/parkplay/; sudo chmod 755 /opt/parkplay/deploy/lxc/*.sh;
   sudo install -m 644 /opt/parkplay/deploy/systemd/*.service /etc/systemd/system/; sudo systemctl daemon-reload;
   sudo systemctl restart parkplay-web; sleep 2; systemctl is-active parkplay-session parkplay-web'
