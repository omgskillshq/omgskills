#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function loadEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function reportingWindow(now = new Date(), timezone = "America/New_York") {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const wallTime = date => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  };
  const today = new Date(wallTime(now));
  today.setUTCHours(0, 0, 0, 0);
  // Resolve each local midnight independently: a daylight-saving day need not be 24 hours.
  const midnight = calendar => {
    let instant = calendar;
    for (let attempt = 0; attempt < 4; attempt++) {
      const adjustment = calendar - wallTime(new Date(instant));
      if (!adjustment) return new Date(instant).toISOString();
      instant += adjustment;
    }
    throw new Error(`Could not resolve midnight in ${timezone}`);
  };
  const previous = today.getTime() - 24 * 60 * 60 * 1000;
  return { start: midnight(previous), end: midnight(today.getTime()),
    date: new Date(previous).toISOString().slice(0, 10), timezone };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), ...options });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const message = json?.errors?.[0]?.message ?? json?.error ?? response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return json;
}

function count(value, label) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`Missing or invalid ${label}`);
  }
  return Number(value);
}

// Public app and static library entries; private account pages deliberately have no pixel.
const webAppEntryPages = new Set(["/", "/developers/"]);
export const webAppEvents = {
  webSearches: "App Search",
  webSkillOpens: "App Skill Open",
  webCopyInstalls: "App Copy Install",
  webInstallStarts: "App Install Start",
  webSetupDownloads: "App Setup Download",
  webSignIns: "App Sign In",
  webGetMacAppClicks: "App Get Mac App",
};

export function isWebAppPage(row) {
  const path = row.path ?? row.page ?? "";
  return webAppEntryPages.has(path) || /^\/(?:app|library)(?:\/|$)/.test(path) || row.page_group === "app";
}

export async function breakdownRows(url, headers) {
  const rows = [];
  const seen = new Set();
  const next = new URL(url);
  next.searchParams.set("limit", "50");
  for (let offset = 0; offset < 5000; offset += 50) {
    next.searchParams.set("offset", String(offset));
    const json = await fetchJson(next.href, { headers });
    const page = Array.isArray(json?.data) ? json.data : json?.data?.clicks;
    if (!Array.isArray(page)) throw new Error("Invalid analytics breakdown response");
    if (!page.length) return rows;
    const fingerprint = JSON.stringify(page);
    if (seen.has(fingerprint)) throw new Error("Analytics pagination repeated a page");
    seen.add(fingerprint);
    rows.push(...page);
    if (page.length < 50) return rows;
  }
  throw new Error("Analytics breakdown exceeded 5000 rows; totals are unavailable");
}

export function webAppFunnel(pages, clicks) {
  const funnel = { webVisitors: 0, webAppPageViews: 0 };
  for (const row of pages) {
    if ((row.path ?? row.page) === "/") funnel.webVisitors += Number(row.unique_visitors) || 0;
    if (isWebAppPage(row)) funnel.webAppPageViews += Number(row.page_views) || 0;
  }
  for (const [key, target] of Object.entries(webAppEvents)) {
    funnel[key] = clicks.filter(isWebAppPage).flatMap((row) => row.top_targets ?? [row])
      .filter((item) => item.target === target)
      .reduce((total, item) => total + (Number(item.clicks) || 0), 0);
  }
  // Homepage visitors and actions on other pages are not a matched conversion cohort.
  funnel.webSearchRate = null;
  funnel.webSetupDownloadRate = null;
  return funnel;
}

export async function humblyticsMetrics(window, env = process.env) {
  const propertyId = requireEnv("HUMBLYTICS_PROPERTY_ID", env);
  const token = requireEnv("HUMBLYTICS_API_KEY", env);
  const { start, timezone } = window;
  const end = new Date(Date.parse(window.end) - 1).toISOString();
  const params = new URLSearchParams({ start, end, timezone, include_bots: "false" });
  const base = `https://app.humblytics.com/api/external/v1/properties/${propertyId}`;
  const headers = { authorization: `Bearer ${token}` };

  const [summary, comparison, traffic, clicks, pageRows, namedClickRows] = await Promise.all([
    fetchJson(`${base}/traffic/summary?${params}`, { headers }),
    fetchJson(`${base}/traffic/bots-comparison?${params}`, { headers }),
    fetchJson(`${base}/traffic/breakdown?${params}`, { headers }),
    breakdownRows(`${base}/clicks/details?${params}&page=/`, headers),
    breakdownRows(`${base}/pages/breakdown?${params}`, headers),
    // A page's top_targets is capped. Filter each named event before pagination to avoid losing it.
    Promise.all(Object.values(webAppEvents).map(async target => {
      const rows = await breakdownRows(`${base}/clicks/breakdown?${params}&search=${encodeURIComponent(target)}`, headers);
      // Do not trust search to filter nested targets on every API version.
      return rows.map(row => ({ ...row, top_targets: (row.top_targets ?? [row]).filter(item => item.target === target) }));
    })),
  ]);

  const human = comparison?.data?.human;
  const bots = comparison?.data?.bot;
  const visitors = count(human?.unique_visitors, "bot-filtered visitors");
  const pageViews = count(human?.page_views, "bot-filtered page views");
  const paidX = (traffic?.data?.utm ?? [])
    .filter((row) => ["x", "twitter"].includes(String(row.source ?? "").toLowerCase()))
    .reduce((total, row) => ({
      sessions: total.sessions + (Number(row.sessions) || 0),
      pageViews: total.pageViews + (Number(row.page_views) || 0),
    }), { sessions: 0, pageViews: 0 });

  const cta = { hero: 0, reviews: 0, legacy: 0, total: 0, uniqueSessions: 0, paidXDownloads: 0 };
  for (const click of clicks) {
    const target = String(click.target ?? "");
    const secondary = String(click.secondary ?? "");
    const isDownload = target === "Hero Download Mac DMG" ||
      target === "Reviews Download Mac DMG" ||
      secondary === "/downloads/omgskills-mac.dmg" || secondary === "/download";
    if (!isDownload) continue;

    const clickCount = Number(click.clicks) || 0;
    cta.total += clickCount;
    cta.uniqueSessions += Number(click.unique_sessions) || 0;
    if (target === "Hero Download Mac DMG") cta.hero += clickCount;
    else if (target === "Reviews Download Mac DMG") cta.reviews += clickCount;
    else cta.legacy += clickCount;

    for (const utm of click.utm_breakdown ?? []) {
      const source = String(utm.utm_source ?? "").toLowerCase();
      if (["x", "twitter"].includes(source)) {
        cta.paidXDownloads += Number(utm.clicks) || 0;
      }
    }
  }

  return {
    // Some API versions include bots in /summary even when include_bots=false.
    reportedVisitors: count(summary?.data?.unique_visitors, "summary visitors"),
    visitors,
    pageViews,
    detectedBotVisitors: count(bots?.unique_visitors, "detected bot visitors"),
    detectedBotPageViews: count(bots?.page_views, "detected bot page views"),
    sessions: human?.sessions == null ? null : count(human.sessions, "bot-filtered sessions"),
    downloadClicks: cta.total,
    downloadUniqueSessions: null,
    downloadSessionTargetPairs: cta.uniqueSessions,
    heroDownloadClicks: cta.hero,
    reviewsDownloadClicks: cta.reviews,
    legacyDownloadClicks: cta.legacy,
    paidXSessions: paidX.sessions,
    paidXPageViews: paidX.pageViews,
    paidXDownloadClicks: cta.paidXDownloads,
    ...webAppFunnel(pageRows, namedClickRows.flat()),
    webBreakdownPossiblyTruncated: false,
    webFunnelScope: "Visitors exclude detected bots, not all automation. Public action counts are events, not unique people or conversion rates. Private account activity is untracked. webVisitors is homepage-only.",
  };
}

export function telemetryQuery(appID, dataSource, type, window) {
  return {
    queryType: "topN",
    dataSource,
    granularity: "all",
    dimension: { type: "default", dimension: "type", outputName: "type" },
    metric: { type: "numeric", metric: "count" },
    aggregations: [{ type: "userCount", name: "count" }],
    filter: {
      type: "and",
      fields: [
        { type: "selector", dimension: "appID", value: appID },
        { type: "selector", dimension: "isTestMode", value: "false" },
        { type: "selector", dimension: "type", value: type },
        ...(type === "connected.install" ? [{ type: "selector", dimension: "outcome", value: "installed" }] : []),
      ],
    },
    intervals: [`${window.start}/${window.end}`],
    threshold: 1,
  };
}

function telemetryTopNCount(result, type) {
  if (!Array.isArray(result) || result.some(bucket => !Array.isArray(bucket.result))) {
    throw new Error("Invalid TelemetryDeck activity response");
  }
  const rows = result.flatMap(bucket => bucket.result);
  const row = rows.find((item) => item.type === type);
  return row ? count(row.count, `${type} user count`) : 0;
}

async function telemetryMetrics(window, env) {
  const token = requireEnv("TELEMETRYDECK_TOKEN", env);
  const appID = requireEnv("TELEMETRYDECK_APP_ID", env);
  const dataSource = env.TELEMETRYDECK_DATASOURCE ?? "com.omgskills";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const types = ["app.installed.v2", "app.launched", "skill.searched", "skill.opened", "skill.installed",
    "popover.opened", "connected.install", "connected.connection", "connected.inventory"];
  const counts = {};

  for (const type of types) {
    const result = await fetchJson("https://api.telemetrydeckapi.com/api/v4/query/tql", {
      method: "POST",
      headers,
      body: JSON.stringify(telemetryQuery(appID, dataSource, type, window)),
    });
    counts[type] = telemetryTopNCount(result, type);
  }

  return {
    installs: counts["app.installed.v2"] ?? 0,
    launches: counts["app.launched"] ?? 0,
    searches: counts["skill.searched"] ?? 0,
    skillOpens: counts["skill.opened"] ?? 0,
    skillInstalls: counts["skill.installed"] ?? 0,
    legacyForegroundUsers: counts["popover.opened"] ?? 0,
    connectedInstallUsers: counts["connected.install"] ?? 0,
    // These include failed outcomes, not just successful connections or syncs.
    connectedConnectionEventUsers: counts["connected.connection"] ?? 0,
    connectedInventoryEventUsers: counts["connected.inventory"] ?? 0,
    engagedUsersLowerBound: Math.max(
      counts["skill.searched"] ?? 0,
      counts["skill.opened"] ?? 0,
      counts["skill.installed"] ?? 0,
    ),
  };
}

export async function collectFunnelHealth({ now = new Date(), env = process.env } = {}) {
  const checkedAt = now.toISOString();
  const window = reportingWindow(now, env.FUNNEL_TIMEZONE ?? "America/New_York");
  const issues = [];
  let web = null;
  let app = null;

  try {
    web = await humblyticsMetrics(window, env);
  } catch (error) {
    issues.push(`Humblytics: ${error.message}`);
  }

  try {
    app = await telemetryMetrics(window, env);
  } catch (error) {
    issues.push(`TelemetryDeck: ${error.message}`);
  }

  const metrics = {
    ...(web ?? {}),
    ...(app ?? {}),
  };

  metrics.downloadClickRate = null;
  metrics.downloadToInstallRate = null;

  const payload = {
    status: issues.length ? "degraded" : "ok",
    checkedAt,
    window: `${window.date} (${window.timezone}, complete day)`,
    windowStart: window.start,
    windowEnd: window.end,
    timezone: window.timezone,
    issues,
    appFunnelScope: "First tracked launches are not installs. Process launches and syncs may be background activity. Foreground opens cover the legacy app only; connected helper opens are not instrumented yet. Counts are device identifiers, not necessarily people.",
    ...metrics,
  };
  return payload;
}

async function main() {
  loadEnv();
  const payload = await collectFunnelHealth();
  console.log(JSON.stringify(payload));
  const output = `marketing_funnel_json=${JSON.stringify(payload)}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  const payload = {
    status: "degraded",
    checkedAt: new Date().toISOString(),
    window: "previous complete day (unavailable)",
    timezone: process.env.FUNNEL_TIMEZONE ?? "America/New_York",
    issues: [error.message],
  };
  console.log(JSON.stringify(payload));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `marketing_funnel_json=${JSON.stringify(payload)}\n`);
  }
});
