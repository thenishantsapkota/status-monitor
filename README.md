# Status Monitor → Discord

Checks the GitHub and Claude/Anthropic status pages on a schedule and posts a
rich Discord embed **only when a service's status changes** — one alert when it
degrades, one when it recovers. No spam while an incident is ongoing.

## How it works

- [`status-monitor.mjs`](status-monitor.mjs) — fetches both `status.json` APIs
  (Node built-in `fetch`, no dependencies), compares against the last-known
  state in `state.json`, and posts to Discord on change.
- [`deploy/pi/install.sh`](deploy/pi/install.sh) — installs a systemd timer
  that runs the script every 5 minutes on a Raspberry Pi (or any systemd Linux
  box).

## Run on a Raspberry Pi

```bash
sudo apt update && sudo apt install -y git nodejs   # Node 18+ required
git clone https://github.com/<you>/status-monitor.git ~/status-monitor
cd ~/status-monitor
echo 'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...' > .env
./deploy/pi/install.sh              # or: INTERVAL=15 ./deploy/pi/install.sh
```

The installer checks your Node version, creates `status-monitor.service` and
`status-monitor.timer` for your user, enables them, and runs one check right away.

- **Logs:** `journalctl -u status-monitor -n 50`
- **Next run:** `systemctl list-timers status-monitor.timer`
- **Run now:** `sudo systemctl start status-monitor`
- **Update:** `git pull`. No reinstall needed unless the repo moves or you change `INTERVAL`.
- **Remove:** `./deploy/pi/uninstall.sh`

## Run locally

```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
node status-monitor.mjs   # requires Node 18+; a .env next to the script is also picked up
```

## Notes

- **State:** on the Pi it lives in `/var/lib/status-monitor/state.json`, outside
  the repo. When run by hand it defaults to `state.json` next to the script
  (override with `STATE_FILE`).
- **First run** on a healthy service stays silent (baseline is treated as
  operational). You'll only be alerted on an actual change from that point on.
- **Missed runs:** if the Pi is off at a scheduled time, the timer catches up
  on boot.
