import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewAnswer, reviewWords } from "../src/app/unified/ReviewBadge";
import { parsePublicSkill } from "../src/app/unified/public-catalog";

test("the app shows the same review words as the web page, and never more than the answer says", () => {
  assert.equal(reviewWords({ badge: "no_issues", reviewedAt: "2026-11-23T11:00:00Z" }).text, "No issues found");
  assert.match(reviewWords({ badge: "no_issues", reviewedAt: "2026-11-23T11:00:00Z" }).title, /not a guarantee/);
  assert.equal(reviewWords({ badge: "under_review", reviewedAt: null }).text, "Under review");
  assert.equal(reviewWords({ badge: "not_reviewed", reviewedAt: null }).text, "Not reviewed yet");
  for (const bad of [null, {}, { badge: "safe" }, "no_issues"]) assert.equal(parseReviewAnswer(bad), null);
  assert.deepEqual(parseReviewAnswer({ badge: "no_issues", reviewedAt: 5 }), { badge: "no_issues", reviewedAt: null });
  for (const badge of ["no_issues", "under_review", "not_reviewed"] as const) assert.doesNotMatch(JSON.stringify(reviewWords({ badge, reviewedAt: null })), /\bsafe\b/i);
});

test("a catalog skill carries the content hash of the version it installs, only when it's a real hash", () => {
  const base = { id: "a/b:c", name: "c", author_handle: "a", description: "", github_url: "https://github.com/a/b", tags: [] };
  assert.equal(parsePublicSkill({ ...base, skill_tree_sha: "a".repeat(40) }).treeSha, "a".repeat(40));
  assert.equal(parsePublicSkill({ ...base, skill_tree_sha: "nope" }).treeSha, undefined);
  assert.equal(parsePublicSkill(base).treeSha, undefined);
});
