import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import type { PublicReviewBadges } from "./_shared/public-scan-driver.js";

// A public skill page's review badge: "no_issues", "under_review" or "not_reviewed", for the exact
// version the page shows (its content hash). Read from the badges the public scan writes after each
// run. Anything unknown, older or newer is "not_reviewed", never a pass.

const ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?::[^\s]{1,400})?$/;
const SHA = /^[0-9a-f]{40}$/;
const CACHE_MS = 5 * 60_000;

export type ReviewDeps = { loadBadges(): Promise<PublicReviewBadges | null>; now?: () => number };

let cached: { at: number; badges: PublicReviewBadges | null } | null = null;

const defaults: ReviewDeps = {
  async loadBadges() {
    return (await getStore("public-scan").get("badges.json", { type: "json" })) as PublicReviewBadges | null;
  }
};

function reply(status: number, body: unknown, maxAge: number) {
  // Errors aren't kept anywhere, so a passing skill shows again as soon as the badges can be read.
  const headers: Record<string, string> = maxAge > 0
    ? { "cache-control": `public, max-age=${Math.min(maxAge, 300)}`, "netlify-cdn-cache-control": `public, s-maxage=${maxAge}, stale-while-revalidate=600` }
    : { "cache-control": "no-store", "netlify-cdn-cache-control": "no-store" };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export async function skillReview(request: Request, deps: ReviewDeps = defaults) {
  if (request.method !== "GET") return reply(405, { error: "method_not_allowed" }, 0);
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const tree = url.searchParams.get("tree") ?? "";
  if (!ID.test(id) || !SHA.test(tree)) return reply(400, { error: "bad_request" }, 3600);
  const now = deps.now?.() ?? Date.now();
  if (deps !== defaults || !cached || now - cached.at > CACHE_MS) {
    try {
      cached = { at: now, badges: await deps.loadBadges() };
    } catch {
      // Not readable right now: say nothing rather than "not reviewed" for a skill that was.
      return reply(503, { error: "unavailable" }, 0);
    }
  }
  const entry = cached.badges?.skills[id];
  // Only the version that was reviewed gets its badge.
  if (!entry || entry.treeSha !== tree) return reply(200, { badge: "not_reviewed", reviewedAt: null }, 900);
  return reply(200, { badge: entry.badge, reviewedAt: entry.reviewedAt }, 900);
}

export default (request: Request) => skillReview(request);
export const config: Config = { path: "/api/skill-review" };
