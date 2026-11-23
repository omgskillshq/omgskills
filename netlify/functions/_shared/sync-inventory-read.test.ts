import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { PublishedCatalogIdentity } from "./published-catalog.js";
import { readSyncInventory } from "./sync-inventory-read.js";
import { buildContentIndex, partitionOf, type ContentIndexEntry } from "./catalog-content-index.js";

const sha = "c".repeat(40);
const row = (overrides: Record<string, unknown>) => ({
  id: "row", stableKey: "location:v1:codex:remotion-render", skillMdSha: sha, identityStatus: "ambiguous",
  name: "remotion-render", description: "Export a Remotion video", catalogSkillId: null, githubUrl: null,
  isLocalOnly: false, source: "codex", isCurrent: true, lastSeenAt: null, deviceId: "mac",
  gitRelativePath: null, catalogSkillIdHint: "remotion-dev/skills:remotion-render", ...overrides,
});

function pool(rows: unknown[]): Pool {
  return { query: async (sql: string) => ({ rows: sql.includes("FROM synced_skills") ? rows : [] }) } as unknown as Pool;
}

const catalog: PublishedCatalogIdentity = {
  track: "fixture",
  liveSkillIds: new Set(["remotion-dev/skills:remotion-render"]),
  shaHistory: { version: 1, shaToSkillIds: { [sha]: ["remotion-dev/skills:remotion-render"] } },
};

test("inventory reads link hinted rows whose fingerprint is a published version", async () => {
  const edited = row({ id: "edited", skillMdSha: "d".repeat(40) });
  const { skills } = await readSyncInventory(pool([row({}), edited]), "user", 2, new Date(), async () => catalog) as {
    skills: Array<{ id: string; catalogSkillId: string | null; identityStatus: string }>
  };
  assert.deepEqual(skills.map(({ id, catalogSkillId, identityStatus }) => ({ id, catalogSkillId, identityStatus })), [
    { id: "row", catalogSkillId: "remotion-dev/skills:remotion-render", identityStatus: "resolved" },
    { id: "edited", catalogSkillId: null, identityStatus: "ambiguous" },
  ]);
});

test("inventory reads skip the catalog when no copy has a fingerprint, and survive it being unavailable", async () => {
  let loads = 0;
  await readSyncInventory(pool([row({ catalogSkillIdHint: null, skillMdSha: null })]), "user", 2, new Date(), async () => { loads++; return catalog; });
  assert.equal(loads, 0);
  const { skills } = await readSyncInventory(pool([row({})]), "user", 2, new Date(), async () => { throw new Error("offline"); }) as {
    skills: Array<{ catalogSkillId: string | null }>
  };
  assert.equal(skills[0].catalogSkillId, null);
});

test("inventory reads give each copy its cloud save key, apart when same-name folders hold different skills", async () => {
  const library = row({ id: "library", source: "claude", stableKey: "location:v1:claude:last30days", name: "last30days",
    catalogSkillIdHint: null });
  const spec = row({ id: "spec", stableKey: "location:v1:codex:last30days", name: "last30days-v3-spec", catalogSkillIdHint: null });
  const { skills } = await readSyncInventory(pool([library, spec]), "user", 2, new Date(), async () => catalog) as {
    skills: Array<{ id: string; cloudKey: string }>
  };
  assert.deepEqual(skills.map(({ id, cloudKey }) => [id, cloudKey]), [["library", "last30days"], ["spec", "last30days@codex"]]);
});

test("inventory reads keep a saved skill on its own key after the other same-name skill is gone", async () => {
  const spec = row({ id: "spec", stableKey: "location:v1:codex:last30days", name: "last30days-v3-spec", catalogSkillIdHint: null });
  const records = [{ key: "last30days", name: "last30days" }, { key: "last30days@codex", name: "last30days-v3-spec" }];
  const withRecords = { query: async (sql: string) =>
    ({ rows: sql.includes("FROM synced_skills") ? [spec] : sql.includes("FROM cloud_saved_skills") ? records : [] }) } as unknown as Pool;
  const { skills } = await readSyncInventory(withRecords, "user", 2, new Date(), async () => catalog) as {
    skills: Array<{ cloudKey: string }>
  };
  assert.equal(skills[0].cloudKey, "last30days@codex");
});

// The content index as the background scan builds it, read in memory.
function index(skills: Record<string, unknown>[], history: Record<string, string[]>, canonicalBySha = {}) {
  const partitions = buildContentIndex(skills, { version: 1, shaToSkillIds: history, canonicalBySha });
  return async (keys: string[]) => {
    const entries: Record<string, ContentIndexEntry> = {};
    for (const key of keys) {
      const entry = partitions.get(partitionOf(key))?.[key];
      if (entry) entries[key] = entry;
    }
    return entries;
  };
}
const skill = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.split(/[:/]/).pop(), description: `About ${id}.`, ...extra });
async function linked(rows: unknown[], read: ReturnType<typeof index>) {
  const { skills } = await readSyncInventory(pool(rows), "user", 2, new Date(), async () => catalog, read) as {
    skills: Array<{ id: string; catalogSkillId: string | null; isLocalOnly: boolean }>
  };
  return Object.fromEntries(skills.map((s) => [s.id, s.catalogSkillId]));
}

test("a copy installed from GitHub directly is linked when its SKILL.md is exactly one library skill's", async () => {
  const fork = "e".repeat(40), folders = "f".repeat(40);
  const read = index(
    ["remotion-dev/skills:remotion-render", "acme/skills:notes", "fork/skills:notes", "acme/skills:tools/notes", "acme/skills:other/notes"].map((id) => skill(id)),
    { [sha]: ["remotion-dev/skills:remotion-render"], [fork]: ["acme/skills:notes", "fork/skills:notes"],
      [folders]: ["acme/skills:tools/notes", "acme/skills:other/notes"] },
  );
  const plain = { catalogSkillIdHint: null, name: "local", description: "Not in the library." };
  assert.deepEqual(await linked([
    row({ id: "cloned", ...plain, githubUrl: "https://github.com/remotion-dev/skills" }),
    row({ id: "copied", ...plain }),
    row({ id: "edited", ...plain, skillMdSha: "d".repeat(40) }),
    row({ id: "fork-picked", ...plain, skillMdSha: fork, githubUrl: "https://github.com/fork/skills" }),
    row({ id: "fork-unknown", ...plain, skillMdSha: fork }),
    row({ id: "same-repo-path", ...plain, skillMdSha: folders, githubUrl: "https://github.com/acme/skills", gitRelativePath: "tools/notes" }),
    row({ id: "same-repo-no-path", ...plain, skillMdSha: folders, githubUrl: "https://github.com/acme/skills" }),
  ], read), {
    cloned: "remotion-dev/skills:remotion-render", copied: "remotion-dev/skills:remotion-render", edited: null,
    "fork-picked": "fork/skills:notes", "fork-unknown": null, "same-repo-path": "acme/skills:tools/notes", "same-repo-no-path": null,
  });
});

test("another version of a library skill is linked by its name and description, only when that's clear", async () => {
  const read = index([
    skill("inference-sh/skills:app-store-screenshots", { name: "app-store-screenshots", description: "Make App Store screenshots." }),
    skill("exiao/skills:app-store-screenshots", { name: "app-store-screenshots", description: "Something else entirely." }),
    skill("a/x:twin", { name: "twin", description: "Same words." }),
    skill("b/y:twin", { name: "twin", description: "Same words." }),
  ], {});
  const copy = (id: string, name: string, description: string, extra = {}) =>
    row({ id, catalogSkillIdHint: null, skillMdSha: "9".repeat(40), name, description, ...extra });
  assert.deepEqual(await linked([
    copy("older", "app-store-screenshots", "Make  App Store\nscreenshots."),
    copy("renamed", "app-store-screenshots", "My own version."),
    copy("twin-unknown", "twin", "Same words."),
    copy("twin-picked", "twin", "Same words.", { githubUrl: "https://github.com/b/y" }),
  ], read), { older: "inference-sh/skills:app-store-screenshots", renamed: null, "twin-unknown": null, "twin-picked": "b/y:twin" });
});

test("a mirror counts for its original when that's listed, and never on its own", async () => {
  const old = "7".repeat(40), orphan = "6".repeat(40);
  const read = index([
    skill("mirror/all:review", { provenance_type: "mirrored", skill_md_path: "mirrors/repos/garrytan@gstack/review/SKILL.md" }),
    skill("garrytan/gstack:review"),
    skill("mirror/all:gone", { provenance_type: "mirrored", skill_md_path: "mirrors/repos/nobody@missing/gone/SKILL.md" }),
  ], { [old]: ["mirror/all:review"], [orphan]: ["mirror/all:gone"] });
  assert.deepEqual(await linked([
    row({ id: "older-gstack", catalogSkillIdHint: null, skillMdSha: old, name: "x", description: "y" }),
    row({ id: "orphan", catalogSkillIdHint: null, skillMdSha: orphan, name: "x", description: "y" }),
  ], read), { "older-gstack": "garrytan/gstack:review", orphan: null });
});

test("the catalog's canonical pick decides only when the copy has no repo of its own among the candidates", async () => {
  const shared = "9".repeat(40);
  const read = index([skill("acme/skills:a"), skill("acme/skills:b")], { [shared]: ["acme/skills:a", "acme/skills:b"] },
    { [shared]: { skillId: "acme/skills:a", confidence: "high", reason: "same-repo" } });
  const copy = (id: string, extra = {}) => row({ id, catalogSkillIdHint: null, skillMdSha: shared, name: "n", description: "d", ...extra });
  assert.deepEqual(await linked([
    copy("folder-b", { githubUrl: "https://github.com/acme/skills", gitRelativePath: "b" }),
    copy("no-folder", { githubUrl: "https://github.com/acme/skills" }),
    copy("no-repo"),
  ], read), { "folder-b": "acme/skills:b", "no-folder": null, "no-repo": "acme/skills:a" });
});

test("a hinted copy is still checked against its hint only, and a slow index never costs it", async () => {
  const other: PublishedCatalogIdentity = { track: "fixture", liveSkillIds: new Set(["acme/skills:notes"]),
    shaHistory: { version: 1, shaToSkillIds: { [sha]: ["acme/skills:notes"] } } };
  const { skills } = await readSyncInventory(pool([row({}), row({ id: "hinted-ok", skillMdSha: "a".repeat(40), catalogSkillIdHint: "acme/skills:notes" }),
    row({ id: "unhinted", catalogSkillIdHint: null })]),
    "user", 2, new Date(), async () => ({ ...other, shaHistory: { version: 1, shaToSkillIds: { ...other.shaHistory!.shaToSkillIds, ["a".repeat(40)]: ["acme/skills:notes"] } } }),
    () => new Promise(() => {})) as { skills: Array<{ id: string; catalogSkillId: string | null }> };
  assert.deepEqual(skills.map((s) => [s.id, s.catalogSkillId]), [["row", null], ["hinted-ok", "acme/skills:notes"], ["unhinted", null]]);
});
