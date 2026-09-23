#!/usr/bin/env node
/**
 * Check GitHub + Claude status pages and post a Discord alert only when a
 * service's status *changes* since the last run.
 *
 * State is kept in a JSON file (see STATE_FILE) so that during an ongoing
 * incident you get ONE alert on degradation and ONE on recovery, rather than a
 * message every run.
 *
 * Env:
 *   DISCORD_WEBHOOK_URL  (required)  Discord webhook to POST to.
 *   STATE_FILE           (optional)  Path to the state file. Default: state.json
 *                                   next to this script.
 *
 * No dependencies — uses Node's built-in fetch (Node 18+). Runs on any
 * always-on box (e.g. a Raspberry Pi) via deploy/pi/.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths relative to this script, not the cwd, so it behaves the same
// under cron/systemd (which run from / or $HOME) as it does from the repo.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Load a local .env if present (otherwise the secret comes from the
// environment). Uses Node's built-in loader on 20.6+, with a minimal fallback
// for older Node (e.g. the nodejs package in Raspberry Pi OS). Variables that
// are already set in the environment win.
function loadEnv(path) {
  if (!existsSync(path)) return;
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path);
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv(join(SCRIPT_DIR, ".env"));

const SERVICES = [
  {
    key: "github",
    name: "GitHub",
    api: "https://www.githubstatus.com/api/v2/status.json",
    incidentsApi: "https://www.githubstatus.com/api/v2/incidents/unresolved.json",
    page: "https://www.githubstatus.com",
    logo: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
  },
  {
    key: "claude",
    name: "Anthropic / Claude",
    api: "https://status.claude.com/api/v2/status.json",
    incidentsApi: "https://status.claude.com/api/v2/incidents/unresolved.json",
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

const STATE_FILE = process.env.STATE_FILE || join(SCRIPT_DIR, "state.json");
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

// Fetch unresolved incidents for services that expose a statuspage incidents
// endpoint. Returns [] on any failure or when the service has no such endpoint.
async function fetchIncidents(svc) {
  if (!svc.incidentsApi) return [];
  try {
    const res = await fetch(svc.incidentsApi, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.incidents) ? data.incidents : [];
  } catch (err) {
    console.error(`${svc.name}: failed to fetch incidents — ${err.message}`);
    return [];
  }
}

// Discord embed field values cap at 1024 chars; names at 256.
function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// Turn unresolved incidents into embed fields: one per incident with its
// current status and the latest update body.
function incidentFields(incidents) {
  return incidents.slice(0, 5).map((inc) => {
    const latest = inc.incident_updates?.[0];
    const parts = [`**${inc.status}** · impact: ${inc.impact}`];
    if (latest?.body) parts.push(latest.body);
    if (inc.shortlink) parts.push(inc.shortlink);
    return {
      name: truncate(`🔧 ${inc.name}`, 256),
      value: truncate(parts.join("\n"), 1024),
      inline: false,
    };
  });
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function buildEmbed(svc, prev, cur, incidents = []) {
  const color = SEVERITY_COLORS[cur.indicator] ?? 15158332;
  const previously = prev ? prev.description : "operational (baseline)";
  const fields = [
    { name: "Severity", value: cur.indicator, inline: true },
    { name: "Previously", value: previously, inline: true },
  ];
  if (incidents.length) fields.push(...incidentFields(incidents));
  return {
    author: { name: svc.name, url: svc.page, icon_url: svc.logo },
    title: cur.description,
    url: svc.page,
    thumbnail: { url: svc.logo },
    fields,
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
      // Only fetch incident detail when we're actually posting, and only for
      // services that expose the endpoint — "if anything" attaches nothing when
      // there are no unresolved incidents.
      const incidents = await fetchIncidents(svc);
      if (incidents.length) console.log(`${svc.name}: ${incidents.length} unresolved incident(s).`);
      embeds.push(buildEmbed(svc, prev, cur, incidents));
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
