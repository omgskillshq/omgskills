import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("skill pages carry a review badge that starts as not reviewed and never says safe", async () => {
  const generator = await readFile(new URL("./build-web-library.mjs", import.meta.url), "utf8");
  const badge = generator.slice(generator.indexOf("function reviewBadge("), generator.indexOf("function installsBadge("));
  assert.match(badge, /data-state="not_reviewed"/);
  assert.match(badge, /Not reviewed yet/);
  assert.match(generator, /\$\{reviewBadge\(skill\)\}/);
  assert.ok(generator.includes('<script src="/skill-review.js" defer></script>'));
  const script = await readFile(new URL("../site/skill-review.js", import.meta.url), "utf8");
  assert.doesNotMatch(script + badge, /\bsafe\b/i);
});

async function run(answer) {
  const script = await readFile(new URL("../site/skill-review.js", import.meta.url), "utf8");
  const attrs = { "data-skill-review": "acme/skills:notes", "data-tree": "a".repeat(40), "data-state": "not_reviewed" };
  const badge = { textContent: "Not reviewed yet", getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } };
  const asked = [];
  const window = { fetch: async (url) => { asked.push(url); return answer; } };
  vm.runInNewContext(script, { document: { querySelectorAll: () => [badge] }, window, fetch: window.fetch, Array, Date, isNaN, encodeURIComponent });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { badge, attrs, asked };
}

test("the page asks for its exact version and shows what comes back; no answer leaves not reviewed", async () => {
  const ok = await run({ ok: true, json: async () => ({ badge: "no_issues", reviewedAt: "2026-11-23T11:00:00Z" }) });
  assert.deepEqual(ok.asked, [`/api/skill-review?id=acme%2Fskills%3Anotes&tree=${"a".repeat(40)}`]);
  assert.equal(ok.badge.textContent, "No issues found");
  assert.equal(ok.attrs["data-state"], "no_issues");
  assert.match(ok.attrs.title, /not a guarantee/);
  const review = await run({ ok: true, json: async () => ({ badge: "under_review" }) });
  assert.equal(review.badge.textContent, "Under review");
  for (const answer of [{ ok: false }, { ok: true, json: async () => ({ badge: "safe" }) }]) {
    const none = await run(answer);
    assert.equal(none.badge.textContent, "Not reviewed yet");
    assert.equal(none.attrs["data-state"], "not_reviewed");
  }
});
