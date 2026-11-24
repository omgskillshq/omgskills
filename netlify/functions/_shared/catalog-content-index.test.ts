import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCopy,
  buildContentIndex, contentIndexReader, contentKey, ensureContentIndex, keysFor, matchCopy, namedKey, partitionOf, writeContentIndex,
  type ContentIndexStore,
} from "./catalog-content-index.js";

function memoryStore(): ContentIndexStore & { data: Map<string, unknown>; reads: string[] } {
  const data = new Map<string, unknown>();
  const reads: string[] = [];
  return { data, reads, async get(key) { reads.push(key); return data.get(key) ?? null; }, async set(key, value) { data.set(key, value); } };
}

test("the index holds only live skills, mirrors as their originals, and name+description keys", () => {
  const sha = "a".repeat(40);
  const parts = buildContentIndex([
    { id: "o/r:x", name: "x", description: "Does X." },
    { id: "m/all:x", name: "x", description: "Does X.", provenance_type: "mirrored", skill_md_path: "mirrors/repos/o@r/x/SKILL.md" },
  ], { version: 1, shaToSkillIds: { [sha]: ["m/all:x", "gone/repo:x"] } });
  const get = (key: string) => parts.get(partitionOf(key))?.[key];
  assert.deepEqual(get(contentKey(sha)), { ids: ["o/r:x"] });
  assert.deepEqual(get(namedKey("X", "does   x.")!), { ids: ["o/r:x"] });
});

test("written in 256 parts with meta last; a reader fetches only the parts it needs, once", async () => {
  const store = memoryStore();
  const parts = buildContentIndex([{ id: "o/r:x", name: "x", description: "Does X." }], { version: 1, shaToSkillIds: { ["b".repeat(40)]: ["o/r:x"] } });
  await writeContentIndex(store, "2026-11-23", parts);
  assert.equal([...store.data.keys()].filter((key) => key.startsWith("p/")).length, 256);
  assert.equal([...store.data.keys()].at(-1), "meta.json");
  const read = contentIndexReader(store);
  const copy = { skillMdSha: "B".repeat(40), name: "x", description: "Does X." };
  const entries = await read(keysFor(copy));
  assert.equal(matchCopy(copy, entries), "o/r:x");
  await read(keysFor(copy));
  assert.equal(store.reads.length, new Set(keysFor(copy).map(partitionOf)).size, "parts are cached");
});

test("the background run rebuilds only for a new catalog", async () => {
  const store = memoryStore();
  const files: Record<string, unknown> = {
    "https://omgskills.com/data/crawl4/manifest.json": { generatedAt: "g1", skills: { path: "skills.json" }, shaHistory: { path: "sha.json" } },
    "https://omgskills.com/data/crawl4/skills.json": [{ id: "o/r:x", name: "x", description: "Does X." }],
    "https://omgskills.com/data/crawl4/sha.json": { version: 1, shaToSkillIds: {} },
  };
  const fetcher = (async (url: string) => files[url] ? Response.json(files[url]) : new Response("", { status: 404 })) as unknown as typeof fetch;
  assert.equal(await ensureContentIndex(store, fetcher), true);
  assert.equal(await ensureContentIndex(store, fetcher), false);
  (files["https://omgskills.com/data/crawl4/manifest.json"] as { generatedAt: string }).generatedAt = "g2";
  assert.equal(await ensureContentIndex(store, fetcher), true);
});

test("an exact fingerprint shared by an original and its fork never falls back to a fork's description", () => {
  const sha = "c".repeat(40);
  const parts = buildContentIndex([
    { id: "blader/humanizer", name: "humanizer", description: "New wording." },
    { id: "fork/humanizer", name: "humanizer", description: "Old wording." },
  ], { version: 1, shaToSkillIds: { [sha]: ["blader/humanizer", "fork/humanizer"] } });
  const entries = Object.fromEntries([...parts.values()].flatMap((part) => Object.entries(part)));
  // The copy is the old version: exactly published by both, so it stays unlinked rather than following the fork's description.
  assert.equal(matchCopy({ skillMdSha: sha, name: "humanizer", description: "Old wording." }, entries), null);
  assert.equal(matchCopy({ skillMdSha: sha, name: "humanizer", description: "Old wording.", githubUrl: "https://github.com/blader/humanizer" }, entries), "blader/humanizer");
});

test("a part that isn't written yet isn't remembered", async () => {
  const store = memoryStore();
  const read = contentIndexReader(store);
  const copy = { skillMdSha: "d".repeat(40), name: "x", description: "Does X." };
  assert.deepEqual(await read(keysFor(copy)), {});
  await writeContentIndex(store, "g1", buildContentIndex([{ id: "o/r:x", name: "x", description: "Does X." }], { version: 1, shaToSkillIds: { ["d".repeat(40)]: ["o/r:x"] } }));
  assert.equal(matchCopy(copy, await read(keysFor(copy))), "o/r:x");
});

test("forks are offered most stars first; a choice decides, and 'my own' keeps it personal", () => {
  const sha = "e".repeat(40);
  const parts = buildContentIndex([
    { id: "small/repo:x", name: "x", description: "X.", stars: 3 },
    { id: "big/repo:x", name: "x", description: "X.", stars: 900 },
  ], { version: 1, shaToSkillIds: { [sha]: ["small/repo:x", "big/repo:x"] } });
  const entries = Object.fromEntries([...parts.values()].flatMap((part) => Object.entries(part)));
  const copy = { skillMdSha: sha, name: "x", description: "X." };
  assert.deepEqual(resolveCopy(copy, entries), { matchKey: `sha:${sha}`, candidates: ["big/repo:x", "small/repo:x"] });
  assert.deepEqual(resolveCopy(copy, entries, new Map([[`sha:${sha}`, "small/repo:x"]])), { catalogSkillId: "small/repo:x" });
  assert.equal(resolveCopy(copy, entries, new Map([[`sha:${sha}`, null]])), null);
  // A choice never overrides a copy's own evidence: one from a candidate's repo keeps that repo's skill.
  const fromRepo = { ...copy, githubUrl: "https://github.com/small/repo" };
  assert.deepEqual(resolveCopy(fromRepo, entries, new Map([[`sha:${sha}`, null]])), { catalogSkillId: "small/repo:x" });
  assert.deepEqual(resolveCopy(fromRepo, entries, new Map([[`sha:${sha}`, "big/repo:x"]])), { catalogSkillId: "small/repo:x" });
  // A choice no longer among the candidates is asked again.
  assert.deepEqual(resolveCopy(copy, entries, new Map([[`sha:${sha}`, "gone/repo:x"]])), { matchKey: `sha:${sha}`, candidates: ["big/repo:x", "small/repo:x"] });
});

test("a text match links only a current candidate, and never over the person's own choice", () => {
  const parts = buildContentIndex([
    { id: "a/r:notes", name: "notes", description: "Notes.", stars: 50 },
    { id: "b/r:notes", name: "notes", description: "Notes.", stars: 5 },
  ], { version: 1, shaToSkillIds: {} });
  const entries = Object.fromEntries([...parts.values()].flatMap((part) => Object.entries(part)));
  const copy = { skillMdSha: "f".repeat(40), name: "notes", description: "Notes." };
  const suggested = resolveCopy(copy, entries);
  assert.ok(suggested && "matchKey" in suggested);
  assert.deepEqual(resolveCopy(copy, entries, new Map(), "a/r:notes"), { catalogSkillId: "a/r:notes" });
  // Removed from the library (no longer a candidate): not linked.
  assert.deepEqual(resolveCopy(copy, entries, new Map(), "gone/r:notes"), suggested);
  // "It's my own" stays their own; a pick of the other skill stays that pick.
  assert.equal(resolveCopy(copy, entries, new Map([[suggested.matchKey, null]]), "a/r:notes"), null);
  assert.deepEqual(resolveCopy(copy, entries, new Map([[suggested.matchKey, "b/r:notes"]]), "a/r:notes"), { catalogSkillId: "b/r:notes" });
  // "My own", said under the name alone (maybe for another copy with that name): asked again, not linked.
  const byName = keysFor(copy).find((key) => key.startsWith("n:"))!;
  assert.notEqual(byName, suggested.matchKey);
  assert.deepEqual(resolveCopy(copy, entries, new Map([[byName, null]]), "a/r:notes"), suggested);
  // The copy's repo among the deciding candidates links even so; it's the same skill.
  assert.deepEqual(resolveCopy({ ...copy, githubUrl: "https://github.com/b/r" }, entries, new Map([[suggested.matchKey, null]])), { catalogSkillId: "b/r:notes" });
});

test("the name alone never suggests: a second sign is needed (shared text, the same description or content)", () => {
  const parts = buildContentIndex([
    { id: "athola/market:curate", name: "curate", description: "Add knowledge annotations.", stars: 273 },
    { id: "rweekly/site:curate", name: "curate", description: "Prepare the weekly issue.", stars: 823 },
  ], { version: 1, shaToSkillIds: {} });
  const entries = Object.fromEntries([...parts.values()].flatMap((part) => Object.entries(part)));
  const mine = { skillMdSha: "a".repeat(40), name: "curate", description: "Add creators to the omgskills catalog." };
  // Same name, other description, text not compared or sharing nothing: their own skill.
  assert.equal(resolveCopy(mine, entries), null);
  assert.equal(resolveCopy(mine, entries, new Map(), null, []), null);
  // Shared text with a skill that's no longer a candidate (an older catalog build): still their own.
  assert.equal(resolveCopy(mine, entries, new Map(), null, ["gone/repo:curate"]), null);
  // Its text shares real text with one of them: offered to choose, that one first.
  const offered = resolveCopy(mine, entries, new Map(), null, ["athola/market:curate"]);
  assert.ok(offered && "matchKey" in offered && offered.matchKey.startsWith("n:"));
  assert.deepEqual(offered.candidates, ["athola/market:curate", "rweekly/site:curate"]);
  // The same description is a second sign on its own.
  const sameDescription = resolveCopy({ ...mine, description: "Add knowledge annotations." }, entries);
  assert.deepEqual(sameDescription && "candidates" in sameDescription ? sameDescription.candidates : null, ["athola/market:curate"]);
});
