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

test("a catalog skill carries the hash get_skill pins, only when it's a real hash; summaries have none", () => {
  // The shape get_skill returns (omgskills MCP): the hash only inside pinned_install.
  const base = { id: "a/b:c", name: "c", author_handle: "a", description: "", github_url: "https://github.com/a/b", tags: [] };
  const pin = { repo: "a/b", path: "c", commit_sha: "c".repeat(40), skill_md_sha: "d".repeat(40), skill_tree_sha: "a".repeat(40) };
  assert.equal(parsePublicSkill({ ...base, pinned_install: pin }).treeSha, "a".repeat(40));
  assert.equal(parsePublicSkill({ ...base, pinned_install: { ...pin, skill_tree_sha: "nope" } }).treeSha, undefined);
  assert.equal(parsePublicSkill(base).treeSha, undefined);
  // A stray top-level field (not what the MCP sends) is ignored.
  assert.equal(parsePublicSkill({ ...base, skill_tree_sha: "a".repeat(40) }).treeSha, undefined);
});

test("switching skills never shows the previous skill's answer", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { ReviewBadge } = await import("../src/app/unified/ReviewBadge");
  // First render, before any answer: not reviewed.
  assert.match(renderToStaticMarkup(createElement(ReviewBadge, { catalogId: "a/b:c", treeSha: "a".repeat(40) })), /Not reviewed yet/);
});
