import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { keysFor } from "./catalog-content-index.js";
import { computeContentMatches, confirmByText, frontmatter, textSimilarity, type ContentMatchDeps } from "./content-match.js";

const body = (extra = "") => `---\nname: notes\ndescription: Take notes.\n---\n# Notes\nWrite down what was decided in the meeting and who owns each follow up item.${extra}\n`;

test("text similarity: the same instructions score 1, a small edit stays high, unrelated text near 0", () => {
  assert.equal(textSimilarity(body(), body()), 1);
  assert.ok(textSimilarity(body(), body(" Keep it short.")) > 0.7);
  assert.ok(textSimilarity(body(), "Deploy the app to production with the release script and check the logs.") < 0.05);
});

test("frontmatter reads name and description, folded descriptions included", () => {
  assert.deepEqual(frontmatter(body()), { name: "notes", description: "take notes." });
  assert.deepEqual(frontmatter("---\nname: x\ndescription: >\n  Two\n  lines\n---\n"), { name: "x", description: "two lines" });
});

test("linked only when exactly one same-named library skill shares real text", () => {
  const copy = { name: "notes", description: "take notes." };
  const c = (id: string, score: number, description = "take notes.") => ({ id, score, name: "notes", description });
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.35)]), "a/r:notes");
  // Same words on the outside, different instructions inside: not linked.
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.05)]), null);
  // Other description: needs 80% the same text.
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.82, "other"), c("b/r:notes", 0.1, "other")]), "a/r:notes");
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.6, "other")]), null);
  // An original and a fork both share text: the person chooses, however close one reads.
  assert.equal(confirmByText(copy, [c("blader/notes", 0.5, "other"), c("fork/notes", 0.99)]), null);
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.9), c("b/r:notes", 0.31)]), null);
});

function fakeRun(rows: string[], fetchText: ContentMatchDeps["fetchText"], extra: Partial<ContentMatchDeps> = {}) {
  const stored: unknown[][] = [];
  const pool = { async query(sql: string, params: unknown[]) {
    if (sql.includes("INSERT INTO content_match_results")) { stored.push(params); return { rows: [] }; }
    return { rows: rows.map((sha) => ({ sha, userId: "u", storageKey: null })) };
  } } as unknown as Pool;
  const key = keysFor({ name: "notes", description: "Take notes." }).find((k) => k.startsWith("n:"))!;
  const deps: ContentMatchDeps = {
    store: { async get() { return Buffer.from(body()); } } as unknown as ContentMatchDeps["store"],
    readIndex: async () => ({ [key]: { ids: ["a/r:notes"] } }),
    catalogSkill: async () => ({ name: "notes", description: "Take notes.", url: "https://raw/x" }),
    fetchText, catalogKey: "k1", ...extra,
  };
  return { stored, run: () => computeContentMatches(pool, deps) };
}

test("the background compare stores a confirmed match, and nothing when the library text couldn't be read", async () => {
  const ok = fakeRun(["s1"], async () => body());
  assert.deepEqual(await ok.run(), { checked: 1, confirmed: 1 });
  assert.deepEqual(ok.stored[0].slice(0, 3), ["s1", "k1", "a/r:notes"]);
  // Rate limited or down: tried again next run, never stored as "no match".
  const down = fakeRun(["s1"], async () => { throw new Error("library skill text 503"); });
  await down.run();
  assert.equal(down.stored.length, 0);
  // Gone (404): compared without it, stored as no match.
  const gone = fakeRun(["s1"], async () => null);
  await gone.run();
  assert.deepEqual(gone.stored[0].slice(0, 3), ["s1", "k1", null]);
});

test("the background compare stops taking versions once its time is up", async () => {
  let clock = 0;
  const store = { async get() { clock += 60_000; return Buffer.from(body()); } } as unknown as ContentMatchDeps["store"];
  const slow = fakeRun(["s1", "s2", "s3"], async () => body(), { store, now: () => clock, budgetMs: 90_000 });
  assert.deepEqual(await slow.run(), { checked: 2, confirmed: 2 });
});
