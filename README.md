# Status Monitor → Discord

Checks the GitHub and Claude/Anthropic status pages on a schedule and posts a
rich Discord embed **only when a service's status changes** — one alert when it
degrades, one when it recovers. No spam while an incident is ongoing.

## How it works

- [`status-monitor.mjs`](status-monitor.mjs) — fetches both `status.json` APIs
  (Node built-in `fetch`, no dependencies), compares against the last-known
  state in `state.json`, and posts to Discord on change.
- [`.github/workflows/status-monitor.yml`](.github/workflows/status-monitor.yml)
  — runs the script every 15 minutes and commits the updated `state.json` back
  to the repo so change-detection survives across runs.

## Setup

1. **Push this repo to GitHub.**

2. **Add the webhook as a secret** (never commit it):
   - Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `DISCORD_WEBHOOK_URL`
   - Value: your Discord webhook URL

3. **Enable Actions** if prompted (Actions tab). Scheduled workflows only run on
   the **default branch**.

4. **Test it:** Actions tab → *Status Monitor* → **Run workflow** (manual trigger).

## Run locally

```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
node status-monitor.mjs   # requires Node 18+
```

## Notes

- **Schedule:** `*/15 * * * *` (UTC). GitHub cron is best-effort and can be
  delayed a few minutes; the minimum granularity is 5 minutes.
- **First run** on a healthy service stays silent (baseline is treated as
  operational). You'll only be alerted on an actual change from that point on.
- **Inactive repos:** GitHub disables scheduled workflows after 60 days with no
  repo activity — the state commits usually keep it alive, but a push resets the
  clock if needed.
- **State commits** are authored by `github-actions[bot]` and tagged
  `[skip ci]`.
