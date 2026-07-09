#!/usr/bin/env node
/**
 * Check GitHub + Claude status pages and post a Discord alert only when a
 * service's status *changes* since the last run.
 *
 * State is kept in state.json (committed back by the workflow) so that during
 * an ongoing incident you get ONE alert on degradation and ONE on recovery,
 * rather than a message every run.
 *
 * Env:
 *   DISCORD_WEBHOOK_URL  (required)  Discord webhook to POST to.
 *   STATE_FILE           (optional)  Path to the state file. Default: state.json.
 *
 * No dependencies — uses Node's built-in fetch (Node 18+).
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// Load a local .env when running outside CI (in CI the secret comes from the
// environment). Uses Node's built-in loader (Node 20.6+); no dependency needed.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const SERVICES = [
  {
    key: "github",
    name: "GitHub",
    api: "https://www.githubstatus.com/api/v2/status.json",
    page: "https://www.githubstatus.com",
    logo: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
  },
  {
    key: "claude",
    name: "Anthropic / Claude",
    api: "https://status.claude.com/api/v2/status.json",
    page: "https://status.claude.com",
    logo: "https://claude.ai/images/claude_app_icon.png",
  },
];

// Statuspage severity -> Discord embed color.
const SEVERITY_COLORS = {
  none: 3066993, // green (operational / recovered)
  minor: 16755200, // orange
  major: 15158332, // red
  critical: 10038562, // dark red
  maintenance: 3447003, // blue
  error: 10038562, // dark red (fetch failure)
};

const STATE_FILE = process.env.STATE_FILE || "state.json";
// Discord (Cloudflare) rejects requests with a default agent — send a real UA.
const USER_AGENT = "status-monitor (https://github.com, 1.0)";

async function fetchStatus(svc) {
  try {
    const res = await fetch(svc.api, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const status = data.status ?? {};
    return {
      indicator: status.indicator ?? "unknown",
      description: status.description ?? "Unknown status",
    };
  } catch (err) {
    return { indicator: "error", description: `Failed to fetch status: ${err.message}` };
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function buildEmbed(svc, prev, cur) {
  const color = SEVERITY_COLORS[cur.indicator] ?? 15158332;
  const previously = prev ? prev.description : "operational (baseline)";
  return {
    author: { name: svc.name, url: svc.page, icon_url: svc.logo },
    title: cur.description,
    url: svc.page,
    thumbnail: { url: svc.logo },
    fields: [
      { name: "Severity", value: cur.indicator, inline: true },
      { name: "Previously", value: previously, inline: true },
    ],
    color,
    footer: { text: "Status monitor" },
  };
}

async function postDiscord(webhook, embeds, allRecovered) {
  const content = allRecovered ? "✅ Service status update" : "⚠️ Service status alert";
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ content, embeds }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord POST failed: HTTP ${res.status} ${text}`);
  }
  return res.status;
}

async function main() {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.error("ERROR: DISCORD_WEBHOOK_URL is not set.");
    process.exit(1);
  }

  const state = await loadState();
  const embeds = [];
  const changedIndicators = [];

  for (const svc of SERVICES) {
    const cur = await fetchStatus(svc);
    const prev = state[svc.key];
    // No history yet -> treat baseline as "none" so a healthy first run stays quiet.
    const prevIndicator = prev ? prev.indicator : "none";
    console.log(`${svc.name}: ${cur.indicator} — ${cur.description}`);

    if (cur.indicator !== prevIndicator) {
      embeds.push(buildEmbed(svc, prev, cur));
      changedIndicators.push(cur.indicator);
    }

    state[svc.key] = { indicator: cur.indicator, description: cur.description };
  }

  if (embeds.length) {
    const allRecovered = changedIndicators.every((i) => i === "none");
    const code = await postDiscord(webhook, embeds, allRecovered);
    console.log(`Status changed — posted ${embeds.length} embed(s) to Discord (HTTP ${code}).`);
  } else {
    console.log("No status change since last run — nothing sent.");
  }

  await saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
