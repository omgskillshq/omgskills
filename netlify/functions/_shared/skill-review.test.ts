import assert from "node:assert/strict";
import test from "node:test";
import { skillReview } from "../skill-review.mjs";
import { publicReviewBadges, publicScanBadge, type PublicReviewBadges } from "./public-scan-driver.js";

const tree = "a".repeat(40);
const badges: PublicReviewBadges = { generatedAt: "2026-11-23T12:00:00Z", skills: {
  "acme/skills:notes": { badge: "no_issues", treeSha: tree, reviewedAt: "2026-11-23T11:00:00Z" },
  "acme/skills:setup": { badge: "under_review", treeSha: tree, reviewedAt: "2026-11-23T11:00:00Z" }
} };
const ask = async (id: string, sha = tree, load: () => Promise<PublicReviewBadges | null> = async () => badges) => {
  const response = await skillReview(new Request(`https://omgskills.com/api/skill-review?id=${encodeURIComponent(id)}&tree=${sha}`), { loadBadges: load });
  return { status: response.status, body: await response.json(), cache: response.headers.get("netlify-cdn-cache-control") };
};

test("a skill page gets the badge for the exact version it shows, and nothing unknown is a pass", async () => {
  assert.deepEqual((await ask("acme/skills:notes")).body, { badge: "no_issues", reviewedAt: "2026-11-23T11:00:00Z" });
  assert.equal((await ask("acme/skills:setup")).body.badge, "under_review");
  // Another version than the one reviewed, an unknown skill, or no badges written yet: not reviewed.
  assert.deepEqual((await ask("acme/skills:notes", "b".repeat(40))).body, { badge: "not_reviewed", reviewedAt: null });
  assert.equal((await ask("other/repo")).body.badge, "not_reviewed");
  assert.equal((await ask("acme/skills:notes", tree, async () => null)).body.badge, "not_reviewed");
  // Can't read them: an error, never "not reviewed" for a skill that was.
  const down = await ask("acme/skills:notes", tree, async () => { throw new Error("down"); });
  assert.deepEqual([down.status, down.cache], [503, "no-store"]);
  assert.equal((await ask("not an id")).status, 400);
  assert.equal((await ask("acme/skills:notes", "nope")).status, 400);
  assert.match((await ask("acme/skills:notes")).cache ?? "", /s-maxage=900/);
});

test("the badges file carries only badges, versions and dates", () => {
  const row = { id: "acme/skills:notes", treeSha: tree, verdict: "clear", checks: [], notes: [], rules: [], aiStatus: "complete",
    rulesStatus: "complete", lastError: null, held: false, scannedAt: "2026-11-23T11:00:00Z", secondLook: null, secondLookStatus: null };
  const out = publicReviewBadges({ generatedAt: "x", skills: [{ ...row, badge: publicScanBadge(row) }] });
  assert.deepEqual(out, { generatedAt: "x", skills: { "acme/skills:notes": { badge: "no_issues", treeSha: tree, reviewedAt: "2026-11-23T11:00:00Z" } } });
});
