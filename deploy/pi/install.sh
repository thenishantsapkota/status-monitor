#!/usr/bin/env bash
# Install the status monitor as a systemd timer on a Raspberry Pi (or any
# systemd Linux box). Run from anywhere inside the cloned repo:
#
#   ./deploy/pi/install.sh            # every 5 minutes (default)
#   INTERVAL=15 ./deploy/pi/install.sh
#
# Re-run it after moving the repo or to change the interval.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
INTERVAL="${INTERVAL:-5}"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found. Install it first:  sudo apt install -y nodejs" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "Node $NODE_MAJOR found; Node 18+ is required (built-in fetch)." >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/.env" ]]; then
  echo "Missing $REPO_DIR/.env — create it with:" >&2
  echo "  echo 'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...' > $REPO_DIR/.env" >&2
  exit 1
fi
chmod 600 "$REPO_DIR/.env"

echo "Installing status-monitor: user=$RUN_USER node=$NODE_BIN every ${INTERVAL}m"

sudo tee /etc/systemd/system/status-monitor.service >/dev/null <<UNIT
[Unit]
Description=Check GitHub/Claude status and alert Discord on change
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_DIR
# Keep state outside the repo so it never conflicts with git pulls
# (/var/lib/status-monitor, created and owned by \$RUN_USER by systemd).
StateDirectory=status-monitor
Environment=STATE_FILE=/var/lib/status-monitor/state.json
ExecStart=$NODE_BIN $REPO_DIR/status-monitor.mjs
Nice=10
UNIT

sudo tee /etc/systemd/system/status-monitor.timer >/dev/null <<UNIT
[Unit]
Description=Run status-monitor every ${INTERVAL} minutes

[Timer]
OnCalendar=*:0/${INTERVAL}
# Run a missed check on boot if the Pi was off at the scheduled time.
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now status-monitor.timer
sudo systemctl start status-monitor.service

echo
echo "Done. Useful commands:"
echo "  systemctl list-timers status-monitor.timer   # next run"
echo "  journalctl -u status-monitor -n 50           # recent logs"
echo "  sudo systemctl start status-monitor          # run now"
