#!/usr/bin/env bash
# Remove the status-monitor systemd timer/service. Leaves the repo, .env and
# /var/lib/status-monitor/state.json in place.
set -euo pipefail
sudo systemctl disable --now status-monitor.timer 2>/dev/null || true
sudo rm -f /etc/systemd/system/status-monitor.service /etc/systemd/system/status-monitor.timer
sudo systemctl daemon-reload
echo "status-monitor removed."
