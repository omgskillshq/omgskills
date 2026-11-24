import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { keysFor } from "./catalog-content-index.js";
import { computeContentMatches, confirmByText, frontmatter, textSimilarity, type ContentMatchDeps } from "./content-match.js";

const body = (extra = "") => `---\nname: notes\ndescription: Take notes.\n---\n# Notes\nWrite down what was decided in the meeting and who owns each follow up item. Send the notes to everyone who attended within an hour, and keep a copy in the shared folder.${extra}\n`;

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
  // Gone (404): the original could be the one missing, so stored as no match.
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

test("instructions in Chinese are compared on their own text, not the English name and description", () => {
  const meta = "---\nname: writer\ndescription: Writes marketing copy for product launches.\n---\n";
  const a = meta + "你是一名资深的营销文案撰写人。根据产品的功能和目标用户，撰写简洁有力的发布文案，突出核心卖点，并提供三个不同风格的标题供选择。";
  const b = meta + "这个技能用于整理会议记录。请列出每项决定、负责人和截止日期，然后把记录发送给所有参会人员，并在共享文件夹中保存一份副本。";
  assert.ok(textSimilarity(a, b) < 0.3, String(textSimilarity(a, b)));
  assert.equal(textSimilarity(a, a), 1);
});

test("never confirmed when some candidates weren't compared", async () => {
  const key = keysFor({ name: "notes", description: "Take notes." }).find((k) => k.startsWith("n:"))!;
  const many = Array.from({ length: 20 }, (_, i) => `r${i}/x:notes`);
  const capped = fakeRun(["s1"], async () => body(), { readIndex: async () => ({ [key]: { ids: many } }),
    catalogSkill: async (id) => ({ name: "notes", description: id === "r0/x:notes" ? "Take notes." : "Other.", url: `https://raw/${id}` }),
    fetchText: async (url) => url.endsWith("r0/x:notes") ? body() : "Deploy the app to production with the release script, then check the logs and the dashboards for errors over the next hour." });
  assert.deepEqual(await capped.run(), { checked: 1, confirmed: 0 });
  assert.equal(capped.stored[0][2], null);
});
