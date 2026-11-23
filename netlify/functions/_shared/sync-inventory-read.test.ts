import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { PublishedCatalogIdentity } from "./published-catalog.js";
import { readSyncInventory } from "./sync-inventory-read.js";

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

test("a copy installed from GitHub directly is linked when its SKILL.md is exactly one library skill's", async () => {
  const forkSha = "e".repeat(40);
  const shared: PublishedCatalogIdentity = {
    track: "fixture",
    liveSkillIds: new Set(["remotion-dev/skills:remotion-render", "acme/skills:notes", "fork/skills:notes", "acme/skills:tools/notes", "acme/skills:other/notes"]),
    shaHistory: { version: 1, shaToSkillIds: {
      [sha]: ["remotion-dev/skills:remotion-render"],
      [forkSha]: ["acme/skills:notes", "fork/skills:notes"],
      ["f".repeat(40)]: ["acme/skills:tools/notes", "acme/skills:other/notes"],
    } },
  };
  let picked: readonly string[] = [];
  let hintsAsked: string[] | null = null;
  const rows = [
    row({ id: "cloned", catalogSkillIdHint: null, githubUrl: "https://github.com/remotion-dev/skills" }),
    row({ id: "copied", catalogSkillIdHint: null }),
    row({ id: "edited", catalogSkillIdHint: null, skillMdSha: "d".repeat(40) }),
    // Two published skills share the content: the copy's own repo picks one, or it stays unlinked.
    row({ id: "fork-picked", catalogSkillIdHint: null, skillMdSha: forkSha, githubUrl: "https://github.com/fork/skills" }),
    row({ id: "fork-unknown", catalogSkillIdHint: null, skillMdSha: forkSha }),
    row({ id: "same-repo-path", catalogSkillIdHint: null, skillMdSha: "f".repeat(40), githubUrl: "https://github.com/acme/skills", gitRelativePath: "tools/notes" }),
    row({ id: "same-repo-no-path", catalogSkillIdHint: null, skillMdSha: "f".repeat(40), githubUrl: "https://github.com/acme/skills" }),
  ];
  const { skills } = await readSyncInventory(pool(rows), "user", 2, new Date(), async (hints, candidates) => {
    if (candidates) picked = candidates(shared.shaHistory!);
    else hintsAsked = hints;
    return shared;
  }) as { skills: Array<{ id: string; catalogSkillId: string | null; isLocalOnly: boolean }> };
  const linked = Object.fromEntries(skills.map((skill) => [skill.id, skill.catalogSkillId]));
  assert.deepEqual(linked, {
    cloned: "remotion-dev/skills:remotion-render",
    copied: "remotion-dev/skills:remotion-render",
    edited: null,
    "fork-picked": "fork/skills:notes",
    "fork-unknown": null,
    "same-repo-path": "acme/skills:tools/notes",
    "same-repo-no-path": null,
  });
  assert.equal(skills.find((skill) => skill.id === "copied")?.isLocalOnly, false);
  // No hinted copies, so no hint lookup; the content lookup checks only skills that can decide a match.
  assert.equal(hintsAsked, null);
  assert.deepEqual([...new Set(picked)].sort(), ["acme/skills:other/notes", "acme/skills:tools/notes", "fork/skills:notes", "remotion-dev/skills:remotion-render"]);
});

test("a hinted copy is still checked against its hint only, never re-matched by content", async () => {
  const other: PublishedCatalogIdentity = { track: "fixture", liveSkillIds: new Set(["acme/skills:notes"]),
    shaHistory: { version: 1, shaToSkillIds: { [sha]: ["acme/skills:notes"] } } };
  const { skills } = await readSyncInventory(pool([row({})]), "user", 2, new Date(), async () => other) as {
    skills: Array<{ catalogSkillId: string | null }>
  };
  assert.equal(skills[0].catalogSkillId, null);
});

test("popular content copied into many repos never checks them all, and a slow content lookup keeps hints", async () => {
  const many = Array.from({ length: 40 }, (_, index) => `copy${index}/skills:canvas`);
  const history = { version: 1 as const, shaToSkillIds: { [sha]: many } };
  const copy = row({ id: "clone", catalogSkillIdHint: null, githubUrl: "https://github.com/copy7/skills" });
  let picked: readonly string[] = [];
  const hinted = row({ id: "hinted", skillMdSha: "a".repeat(40), catalogSkillIdHint: "remotion-dev/skills:remotion-render" });
  const identity: PublishedCatalogIdentity = { track: "fixture", liveSkillIds: new Set(["remotion-dev/skills:remotion-render", ...many]),
    shaHistory: { version: 1, shaToSkillIds: { ...history.shaToSkillIds, ["a".repeat(40)]: ["remotion-dev/skills:remotion-render"] } } };
  const { skills } = await readSyncInventory(pool([copy, hinted]), "user", 2, new Date(), async (_hints, candidates) => {
    if (candidates) { picked = candidates(identity.shaHistory!); return new Promise(() => {}); }
    return identity;
  }) as { skills: Array<{ id: string; catalogSkillId: string | null }> };
  assert.deepEqual(picked, ["copy7/skills:canvas"], "only the copy's own repo is checked");
  assert.deepEqual(skills.map((skill) => [skill.id, skill.catalogSkillId]), [["clone", null], ["hinted", "remotion-dev/skills:remotion-render"]]);
});
