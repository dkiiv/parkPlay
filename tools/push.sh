#!/usr/bin/env bash
# Push the working tree to the TeslaTV host and restart the web service.
#   ./tools/push.sh [ssh-host]        (default: $TV_HOST, else "teslatv")
set -euo pipefail
HOST=${1:-${TV_HOST:-teslatv}}
cd "$(dirname "$0")/.."
tar czf - --exclude node_modules --exclude web/generated . | ssh "$HOST" \
  'set -e; rm -rf /tmp/teslatv-src; mkdir -p /tmp/teslatv-src; tar xzf - -C /tmp/teslatv-src;
   sudo cp -a /tmp/teslatv-src/. /opt/teslatv/; sudo chmod 755 /opt/teslatv/deploy/lxc/*.sh;
   sudo install -m 644 /opt/teslatv/deploy/systemd/*.service /etc/systemd/system/; sudo systemctl daemon-reload;
   sudo systemctl restart teslatv-web; sleep 2; systemctl is-active teslatv-session teslatv-web'
