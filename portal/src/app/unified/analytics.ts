import { isDiscovery, parseNavigation, parsePublicNavigationPath } from "./model";

// Only public production pages may load or use the automatic tracker.
type EventName = "App Search" | "App Skill Open" | "App Copy Install";
type Humblytics = { trackClickEvent?: (name: string) => void };
const trackerSource = "https://app.humblytics.com/hmbl.min.js?id=a156a68";
const trackerSelector = 'script[src="' + trackerSource + '"]';
const campaignKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"];

function isPublicAnalyticsPage(hostname: string, pathname: string) {
  return (hostname === "omgskills.com" || hostname === "www.omgskills.com")
    && parsePublicNavigationPath(pathname.slice(1), "") !== null;
}

function isPublicAppPage(url: URL) {
  if (url.hostname !== "omgskills.com" && url.hostname !== "www.omgskills.com") return false;
  if (!url.pathname.startsWith("/app/")) return false;
  if (url.pathname !== "/app/") return parsePublicNavigationPath(url.pathname.slice("/app/".length), url.search) !== null;
  const params = new URLSearchParams(url.search);
  for (const key of campaignKeys) params.delete(key);
  // A bare /app/ opens public Discover, not the signed-in library.
  if (params.size === 0) return true;
  if ([...params.keys()].some(key => !["view", "id", "q", "skill", "source", "sort"].includes(key))) return false;
  const nav = parseNavigation(params.toString());
  return params.get("view") === nav.view && isDiscovery(nav.view) && nav.source === "all"
    && (!nav.selected || nav.selected.startsWith("catalog:"));
}

function isTrackedPublicPage(url: URL) {
  return isPublicAnalyticsPage(url.hostname, url.pathname) || isPublicAppPage(url);
}

/** Keep public entry attribution through URL normalization, never across the private boundary. */
export function publicCampaignAddress(href: string, entryHref: string) {
  try {
    const entry = new URL(entryHref);
    const next = new URL(href, entry);
    if (entry.origin !== next.origin || !isTrackedPublicPage(entry) || !isTrackedPublicPage(next)) return href;
    for (const key of campaignKeys) {
      const value = entry.searchParams.get(key);
      if (value && !next.searchParams.has(key)) next.searchParams.set(key, value);
    }
    return next.pathname + next.search + next.hash;
  } catch { return href; }
}

export function startPublicAnalytics() {
  try {
    if (!isTrackedPublicPage(new URL(window.location.href))
      || (window as { Humblytics?: Humblytics }).Humblytics
      || document.querySelector(trackerSelector)) return;
    const script = document.createElement("script");
    script.async = true;
    script.src = trackerSource;
    document.head.append(script);
  } catch { /* A blocked tracker must not break the public page. */ }
}

// A full navigation discards the SDK's automatic listeners before private UI loads.
export function needsAnalyticsDocumentReload(href: string) {
  if (window.location.hostname !== "omgskills.com" && window.location.hostname !== "www.omgskills.com") return false;
  const next = new URL(href, window.location.href);
  return !isTrackedPublicPage(next)
    && !!document.querySelector(trackerSelector);
}

/** Sends the event once Humblytics has loaded (it loads async), giving up after ~5 seconds. */
export function trackEvent(name: EventName, attempts = 10) {
  try {
    if (!isTrackedPublicPage(new URL(window.location.href))) return;
    const track = (window as { Humblytics?: Humblytics }).Humblytics?.trackClickEvent;
    if (track) track(name);
    else if (attempts > 1) setTimeout(() => trackEvent(name, attempts - 1), 500);
  } catch { /* Analytics never breaks the app. */ }
}
