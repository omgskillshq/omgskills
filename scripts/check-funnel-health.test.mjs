import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { breakdownRows, collectFunnelHealth, humblyticsMetrics, isWebAppPage, reportingWindow, telemetryQuery, webAppFunnel } from "./check-funnel-health.mjs";

async function withFetch(fetcher, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await run(); }
  finally { globalThis.fetch = originalFetch; }
}

test("breakdown fetching follows offsets past 50 rows, without trusting a stale total_count", async () => {
  const calls = [];
  const rows = Array.from({ length: 101 }, (_, i) => ({ path: `/page-${i}`, page_views: 1 }));
  await withFetch(async href => {
    const url = new URL(href);
    calls.push(url);
    const offset = +url.searchParams.get("offset");
    return Response.json({ meta: { total_count: 50 }, data: rows.slice(offset, offset + 50) });
  }, async () => assert.deepEqual(await breakdownRows("https://example.invalid/breakdown?start=today", {}), rows));
  assert.deepEqual(calls.map(url => url.searchParams.get("offset")), ["0", "50", "100"]);
  assert.ok(calls.every(url => url.searchParams.get("limit") === "50"));
});

test("detail pagination accepts nested click rows and stops on an empty page", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ target: `target-${i}` }));
  const offsets = [];
  await withFetch(async href => {
    const offset = +new URL(href).searchParams.get("offset");
    offsets.push(offset);
    return Response.json({ data: { clicks: offset ? [] : rows } });
  }, async () => assert.deepEqual(await breakdownRows("https://example.invalid/details?page=/", {}), rows));
  assert.deepEqual(offsets, [0, 50]);
});

test("broken pagination and invalid data fail rather than publish partial totals", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ page: `/page-${i}` }));
  await withFetch(async () => Response.json({ data: rows }), async () =>
    assert.rejects(breakdownRows("https://example.invalid/breakdown", {}), /repeated a page/));
  await withFetch(async () => Response.json({ data: {} }), async () =>
    assert.rejects(breakdownRows("https://example.invalid/breakdown", {}), /Invalid analytics/));
});

test("both providers use the previous complete day in the requested timezone", () => {
  assert.deepEqual(reportingWindow(new Date("2026-11-23T13:00:00Z")), {
    start: "2026-11-22T05:00:00.000Z", end: "2026-11-23T05:00:00.000Z", date: "2026-11-22", timezone: "America/New_York",
  });
  assert.equal(reportingWindow(new Date("2026-11-23T02:00:00Z")).date, "2026-11-21", "UTC date must not shift a New York day");
  const utc = reportingWindow(new Date("2026-11-23T02:00:00Z"), "UTC");
  assert.equal(utc.date, "2026-11-22");
  assert.equal(utc.start, "2026-11-22T00:00:00.000Z");
});

test("complete-day bounds honor both daylight-saving transitions and year boundaries", () => {
  const spring = reportingWindow(new Date("2026-03-09T12:00:00Z"));
  assert.equal(spring.start, "2026-03-08T05:00:00.000Z");
  assert.equal(spring.end, "2026-03-09T04:00:00.000Z");
  const fall = reportingWindow(new Date("2026-11-02T12:00:00Z"));
  assert.equal(fall.start, "2026-11-01T04:00:00.000Z");
  assert.equal(fall.end, "2026-11-02T05:00:00.000Z");
  assert.equal(reportingWindow(new Date("2027-01-01T12:00:00Z")).date, "2026-12-31");
  assert.throws(() => reportingWindow(new Date(), "Invalid/Timezone"));
});

test("documented API paths and flat click rows are counted", () => {
  const funnel = webAppFunnel([
    { path: "/", page_views: 10, unique_visitors: 8 },
    { path: "/app/library/", page_views: 4, unique_visitors: 2 },
    { path: "/library/anthropics/", page_views: 3, unique_visitors: 2 },
  ], [
    { page: "/library/anthropics/", target: "App Search", clicks: 2 },
    { page: "/library/anthropics/", target: "App Skill Open", clicks: 3 },
  ]);
  assert.equal(funnel.webVisitors, 8);
  assert.equal(funnel.webAppPageViews, 17);
  assert.equal(funnel.webSearches, 2);
  assert.equal(funnel.webSkillOpens, 3);
});

test("the web app funnel counts the front door, app pages and named app events", () => {
  const pages = [
    { page: "/", page_group: "root", page_views: 10, unique_visitors: 8 },
    { page: "/developers/", page_group: "root", page_views: 2, unique_visitors: 2 },
    { page: "/app/library/trending/", page_group: "app", page_views: 3, unique_visitors: 1 },
    { page: "/home/", page_group: "root", page_views: 50, unique_visitors: 40 },
  ];
  const clicks = [
    { page: "/", top_targets: [{ target: "App Search", clicks: 2 }, { target: "Hero Download Mac DMG", clicks: 9 }] },
    { page: "/app/library/anthropics/", top_targets: [{ target: "App Search", clicks: 1 }, { target: "App Skill Open", clicks: 3 },
      { target: "App Copy Install", clicks: 1 }, { target: "App Setup Download", clicks: 1 }] },
  ];
  const funnel = webAppFunnel(pages, clicks);
  assert.equal(funnel.webVisitors, 8);
  assert.equal(funnel.webAppPageViews, 15);
  assert.equal(funnel.webSearches, 3);
  assert.equal(funnel.webSkillOpens, 3);
  assert.equal(funnel.webCopyInstalls, 1);
  assert.equal(funnel.webSetupDownloads, 1);
  assert.equal(funnel.webInstallStarts, 0);
  assert.equal(funnel.webSearchRate, null);
  assert.equal(funnel.webSetupDownloadRate, null);
  assert.equal(isWebAppPage({ page: "/home/", page_group: "root" }), false);
});

const window = reportingWindow(new Date("2026-11-23T13:00:00Z"));
const env = { HUMBLYTICS_PROPERTY_ID: "test-property", HUMBLYTICS_API_KEY: "test-only",
  TELEMETRYDECK_APP_ID: "test-app", TELEMETRYDECK_TOKEN: "test-only", FUNNEL_TIMEZONE: "America/New_York" };

function webResponse(href) {
  const url = new URL(href);
  if (url.pathname.endsWith("/traffic/summary")) return { data: { unique_visitors: 495, page_views: 1386, total_sessions: 495 } };
  if (url.pathname.endsWith("/traffic/bots-comparison")) return {
    data: { human: { unique_visitors: 358, page_views: 1244 }, bot: { unique_visitors: 137, page_views: 142 } },
  };
  if (url.pathname.endsWith("/traffic/breakdown")) return { data: { utm: [
    { source: "reddit", medium: "paid", sessions: 100 }, { source: "x", medium: "paid", sessions: 3 },
  ] } };
  if (url.pathname.endsWith("/pages/breakdown")) return { data: [{ page: "/", unique_visitors: 20, page_views: 30 }] };
  if (url.pathname.endsWith("/clicks/details")) return { data: { clicks: [
    { target: "Hero Download Mac DMG", clicks: 3, unique_sessions: 2 },
    { target: "Reviews Download Mac DMG", clicks: 1, unique_sessions: 1 },
  ] } };
  if (url.pathname.endsWith("/clicks/breakdown")) {
    const target = url.searchParams.get("search");
    assert.ok(target, "each named event must be filtered before the server caps top_targets");
    return { data: [{ page: "/app/library/", top_targets: [{ target, clicks: 7 }] }] };
  }
  throw Error(`Unexpected route ${url.pathname}`);
}

test("web counts use explicit bot classification, not the inflated summary or guessed session totals", async () => {
  await withFetch(async href => Response.json(webResponse(href)), async () => {
    const metrics = await humblyticsMetrics(window, env);
    assert.equal(metrics.reportedVisitors, 495);
    assert.equal(metrics.visitors, 358);
    assert.equal(metrics.detectedBotVisitors, 137);
    assert.equal(metrics.pageViews, 1244);
    assert.equal(metrics.detectedBotPageViews, 142);
    assert.equal(metrics.sessions, null, "visitors must not be relabeled as sessions");
    assert.equal(metrics.webSkillOpens, 7);
    assert.equal(metrics.webSearches, 7);
    assert.equal(metrics.downloadUniqueSessions, null, "do not sum overlapping unique users per CTA");
    assert.equal(metrics.downloadSessionTargetPairs, 3);
    assert.equal(metrics.paidXSessions, 3, "paid Reddit traffic is not X traffic");
    assert.equal(metrics.webBreakdownPossiblyTruncated, false);
  });
});

test("missing classification is unavailable, while valid zero traffic stays zero", async () => {
  await withFetch(async href => {
    const json = webResponse(href);
    if (href.includes("bots-comparison")) json.data.human = {};
    return Response.json(json);
  }, async () => assert.rejects(humblyticsMetrics(window, env), /bot-filtered visitors/));
  await withFetch(async href => {
    const json = webResponse(href);
    if (href.includes("bots-comparison")) json.data.human = { unique_visitors: 0, page_views: 0 };
    return Response.json(json);
  }, async () => assert.equal((await humblyticsMetrics(window, env)).visitors, 0));
});

test("the report aligns providers, separates background signals, and filters install successes", async () => {
  const queries = [];
  await withFetch(async (href, options) => {
    if (options?.method !== "POST") {
      const url = new URL(href);
      assert.equal(url.searchParams.get("start"), window.start);
      assert.equal(url.searchParams.get("end"), "2026-11-23T04:59:59.999Z");
      return Response.json(webResponse(href));
    }
    const query = JSON.parse(options.body);
    queries.push(query);
    const type = query.filter.fields.find(field => field.dimension === "type").value;
    return Response.json([{ result: [{ type, count: type === "connected.inventory" ? 5 : 1 }] }]);
  }, async () => {
    const result = await collectFunnelHealth({ now: new Date("2026-11-23T13:00:00Z"), env });
    assert.equal(result.status, "ok");
    assert.equal(result.connectedInventoryEventUsers, 5);
    assert.equal(result.legacyForegroundUsers, 1);
    assert.equal(result.connectedInstallUsers, 1);
    assert.equal(result.downloadToInstallRate, null);
    assert.equal(result.downloadClickRate, null);
    assert.match(result.window, /2026-11-22.*complete day/);
    assert.match(result.appFunnelScope, /connected helper opens are not instrumented/);
  });
  assert.ok(queries.every(query => query.intervals[0] === `${window.start}/${window.end}` && !query.relativeIntervals));
  const installed = telemetryQuery("test-app", "com.omgskills", "connected.install", window);
  assert.ok(installed.filter.fields.some(field => field.dimension === "outcome" && field.value === "installed"));
});

test("provider failure degrades only the report, without fabricating zero activity", async () => {
  await withFetch(async (href, options) => options?.method === "POST"
    ? Response.json([{ result: [] }]) : Response.json({ error: "provider unavailable" }, { status: 503 }), async () => {
    const result = await collectFunnelHealth({ now: new Date("2026-11-23T13:00:00Z"), env });
    assert.equal(result.status, "degraded");
    assert.equal(result.visitors, undefined);
    assert.equal(result.launches, 0);
    assert.match(result.issues[0], /Humblytics.*503/);
  });
});

test("malformed app metrics are unavailable, not a healthy day with zero users", async () => {
  await withFetch(async (href, options) => Response.json(options?.method === "POST" ? {} : webResponse(href)), async () => {
    const result = await collectFunnelHealth({ now: new Date("2026-11-23T13:00:00Z"), env });
    assert.equal(result.status, "degraded");
    assert.equal(result.visitors, 358);
    assert.equal(result.launches, undefined);
    assert.match(result.issues[0], /TelemetryDeck.*Invalid/);
  });
});

test("health page renders separated counts and no unsupported conversion rates", async () => {
  const html = readFileSync(new URL("../site/health/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", className: "" });
    return elements.get(id);
  } };
  const health = { status: "ok", sections: { marketingFunnel: {
    visitors: 358, detectedBotVisitors: 137, pageViews: 1244, legacyForegroundUsers: 2, connectedInventoryEventUsers: 5,
  } } };
  await vm.runInNewContext(script, { document, URL, location: new URL("https://omgskills.com/health/"),
    fetch: async () => ({ ok: true, json: async () => health }), console });
  const shown = elements.get("marketingFunnel").innerHTML;
  assert.match(shown, /detected bots excluded.*358/);
  assert.match(shown, /Detected bot visitors.*137/);
  assert.match(shown, /legacy app only.*2/);
  assert.match(shown, /Background sync activity users.*5/);
  assert.doesNotMatch(shown, /Download → install|Download click rate|Engaged app users/);
  assert.match(html, /Traffic And App Activity/);
});
