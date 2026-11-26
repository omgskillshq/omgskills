import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { PublishedCatalogIdentity } from "./published-catalog.js";
import { readSyncInventory } from "./sync-inventory-read.js";
import { buildContentIndex, contentIndexReader, nameKey, partitionOf, type ContentIndexEntry } from "./catalog-content-index.js";

const sha = "c".repeat(40);
const row = (overrides: Record<string, unknown>) => ({
  id: "row", stableKey: "location:v1:codex:remotion-render", skillMdSha: sha, identityStatus: "ambiguous",
  name: "remotion-render", description: "Export a Remotion video", catalogSkillId: null, githubUrl: null,
  isLocalOnly: false, source: "codex", isCurrent: true, lastSeenAt: null, deviceId: "mac",
  gitRelativePath: null, catalogSkillIdHint: "remotion-dev/skills:remotion-render", ...overrides,
});

function pool(rows: unknown[], confirmed: { sha: string; catalogSkillId: string | null; relatedIds?: string[] }[] = [],
  choices: { matchKey: string; catalogSkillId: string | null; noneOf?: string[] | null }[] = [], saved: unknown[] = []): Pool {
  return { query: async (sql: string) => ({ rows: sql.includes("FROM synced_skills") ? rows
    : sql.includes("FROM content_match_results") ? confirmed : sql.includes("FROM skill_link_choices") ? choices
    : sql.includes("FROM cloud_saved_skills") ? saved : [] }) } as unknown as Pool;
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
async function linked(rows: unknown[], read: ReturnType<typeof index>, confirmed: { sha: string; catalogSkillId: string | null; relatedIds?: string[] }[] = []) {
  const { skills } = await readSyncInventory(pool(rows, confirmed), "user", 2, new Date(), async () => catalog, read) as {
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

test("another version is suggested by name and description, by name only with shared text, and linked once its text is confirmed", async () => {
  const read = index([
    skill("inference-sh/skills:app-store-screenshots", { name: "app-store-screenshots", description: "Make App Store screenshots." }),
    skill("exiao/skills:app-store-screenshots", { name: "app-store-screenshots", description: "Something else entirely." }),
    skill("a/x:twin", { name: "twin", description: "Same words." }),
    skill("b/y:twin", { name: "twin", description: "Same words." }),
  ], {});
  const copy = (id: string, name: string, description: string, extra = {}) =>
    row({ id, catalogSkillIdHint: null, skillMdSha: "9".repeat(40), name, description, ...extra });
  const rows = [
    copy("older", "app-store-screenshots", "Make  App Store\nscreenshots."),
    copy("renamed", "app-store-screenshots", "My own version."),
    copy("twin-unknown", "twin", "Same words."),
    copy("twin-picked", "twin", "Same words.", { githubUrl: "https://github.com/b/y" }),
  ];
  // Name and description alone never link (they matched unrelated skills in the trial); its own repo does.
  assert.deepEqual(await linked(rows, read), { older: null, renamed: null, "twin-unknown": null, "twin-picked": "b/y:twin" });
  // Once the background job confirms the text, it links.
  const confirmed = [{ sha: "9".repeat(40), catalogSkillId: "inference-sh/skills:app-store-screenshots" }];
  assert.equal((await linked(rows.slice(0, 1), read, confirmed)).older, "inference-sh/skills:app-store-screenshots");
  // Unconfirmed: the same name and description is offered to choose; the name alone isn't (it's
  // no sign by itself), until its text shares real text with one of them.
  const offeredWith = async (results: { sha: string; catalogSkillId: string | null; relatedIds?: string[] }[]) => {
    const { skills } = await readSyncInventory(pool(rows, results), "user", 2, new Date(), async () => catalog, read) as {
      skills: Array<{ id: string; catalogCandidates?: string[] }>
    };
    return Object.fromEntries(skills.map((s) => [s.id, s.catalogCandidates]));
  };
  const offered = await offeredWith([]);
  assert.deepEqual(offered.older, ["inference-sh/skills:app-store-screenshots"]);
  assert.equal(offered.renamed, undefined);
  assert.equal((await offeredWith([{ sha: "9".repeat(40), catalogSkillId: null, relatedIds: [] }])).renamed, undefined);
  assert.deepEqual((await offeredWith([{ sha: "9".repeat(40), catalogSkillId: null, relatedIds: ["exiao/skills:app-store-screenshots"] }])).renamed,
    ["exiao/skills:app-store-screenshots", "inference-sh/skills:app-store-screenshots"]);
});

test("a copy the person said is their own is marked so; one never asked, or turned down, isn't", async () => {
  const read = index([
    skill("a/x:twin", { name: "twin", description: "Same words." }),
    skill("b/y:twin", { name: "twin", description: "Same words." }),
  ], {});
  const rows = [row({ id: "twin", catalogSkillIdHint: null, skillMdSha: "9".repeat(40), name: "twin", description: "Same words." })];
  const read1 = async (choices: { matchKey: string; catalogSkillId: string | null; noneOf?: string[] | null }[]) => {
    const { skills } = await readSyncInventory(pool(rows, [], choices), "user", 2, new Date(), async () => catalog, read) as {
      skills: Array<{ catalogMatchKey?: string; markedOwn?: boolean; catalogSkillId?: string | null }>
    };
    return skills[0];
  };
  const asked = await read1([]);
  assert.ok(asked.catalogMatchKey);
  assert.equal(asked.markedOwn, undefined);
  const own = await read1([{ matchKey: asked.catalogMatchKey!, catalogSkillId: null }]);
  assert.equal(own.markedOwn, true);
  assert.equal(own.catalogMatchKey, undefined);
  assert.equal(own.catalogSkillId ?? null, null);
  const noneOf = await read1([{ matchKey: asked.catalogMatchKey!, catalogSkillId: null, noneOf: ["a/x:twin", "b/y:twin"] }]) as typeof asked & { catalogOwnKey?: string };
  assert.equal(noneOf.markedOwn, undefined);
  // Unknown after "None of these": it can be made theirs, by its name.
  assert.equal(noneOf.catalogOwnKey, nameKey("twin"));
});

test("a skill the library doesn't know offers 'Make it mine' by its name, and is theirs once they say so", async () => {
  const read = index([], {});
  const rows = [row({ id: "solo", catalogSkillIdHint: null, skillMdSha: "8".repeat(40), name: "Solo  Skill", description: "Mine." })];
  const first = async (choices: { matchKey: string; catalogSkillId: string | null }[]) => {
    const { skills } = await readSyncInventory(pool(rows, [], choices), "user", 2, new Date(), async () => catalog, read) as {
      skills: Array<{ markedOwn?: boolean; catalogOwnKey?: string; catalogMatchKey?: string }>
    };
    return skills[0];
  };
  const unknown = await first([]);
  assert.equal(unknown.catalogOwnKey, nameKey("solo skill"));
  assert.equal(unknown.markedOwn, undefined);
  assert.equal(unknown.catalogMatchKey, undefined);
  const mine = await first([{ matchKey: unknown.catalogOwnKey!, catalogSkillId: null }]);
  assert.equal(mine.markedOwn, true);
  assert.equal(mine.catalogOwnKey, undefined);
  // "My own" saved under its content key, once the library dropped that entry: still theirs.
  assert.equal((await first([{ matchKey: `sha:${"8".repeat(40)}`, catalogSkillId: null }])).markedOwn, true);
  // The library couldn't be read: it may be a library skill, so it isn't offered (a saved "mine" still shows).
  const down = async (choices: { matchKey: string; catalogSkillId: string | null }[]) => {
    const { skills } = await readSyncInventory(pool(rows, [], choices), "user", 2, new Date(), async () => catalog,
      async () => { throw new Error("down"); }) as { skills: Array<{ markedOwn?: boolean; catalogOwnKey?: string }> };
    return skills[0];
  };
  assert.equal((await down([])).catalogOwnKey, undefined);
  // Nor when the index isn't built yet (its partition missing).
  const { skills: unbuilt } = await readSyncInventory(pool(rows), "user", 2, new Date(), async () => catalog,
    contentIndexReader({ get: async () => null, set: async () => {} })) as { skills: Array<{ catalogOwnKey?: string }> };
  assert.equal(unbuilt[0].catalogOwnKey, undefined);
  assert.equal((await down([{ matchKey: unknown.catalogOwnKey!, catalogSkillId: null }])).markedOwn, true);
});

test("a same-name copy asking which library skill it is: no Make it mine on the other", async () => {
  const read = index([
    skill("a/x:twin", { name: "twin", description: "Same words." }),
    skill("b/y:twin", { name: "twin", description: "Same words." }),
  ], {});
  const rows = [
    row({ id: "asks", catalogSkillIdHint: null, skillMdSha: "9".repeat(40), name: "twin", description: "Same words." }),
    row({ id: "edited", catalogSkillIdHint: null, skillMdSha: "7".repeat(40), name: "twin", description: "Rewritten." }),
  ];
  const { skills } = await readSyncInventory(pool(rows), "user", 2, new Date(), async () => catalog, read) as {
    skills: Array<{ id: string; catalogMatchKey?: string; catalogOwnKey?: string }>
  };
  const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
  assert.ok(byId.asks.catalogMatchKey);
  assert.equal(byId.edited.catalogMatchKey, undefined);
  assert.equal(byId.edited.catalogOwnKey, undefined);
});

test("a skill added from GitHub and installed by the app shows that repo, its stars, and links to its library skill", async () => {
  const added = { key: "socratic-tutor", name: "socratic-tutor", deviceId: null,
    githubSource: { repo: "janestreet/agent_skills", folder: "socratic-tutor", commitSha: "c".repeat(40), stars: 11700 } };
  const copy = row({ id: "tutor", stableKey: "location:v1:claude:socratic-tutor", name: "socratic-tutor", description: "Tutor.",
    catalogSkillIdHint: null, skillMdSha: "5".repeat(40), source: "claude" });
  const first = async (read: (keys: string[]) => Promise<Record<string, ContentIndexEntry>>, githubUrl: string | null = null) => {
    const { skills } = await readSyncInventory(pool([{ ...copy, githubUrl }], [], [], [added]), "user", 2, new Date(), async () => catalog, read) as {
      skills: Array<{ githubUrl?: string | null; gitRelativePath?: string | null; githubStars?: number; catalogSkillId?: string | null; cloudKey?: string }>
    };
    return skills[0];
  };
  const unknown = await first(index([], {}));
  assert.equal(unknown.cloudKey, "socratic-tutor");
  assert.equal(unknown.githubUrl, "https://github.com/janestreet/agent_skills");
  assert.equal(unknown.gitRelativePath, "socratic-tutor");
  assert.equal(unknown.githubStars, 11700);
  // Its own git remote wins.
  assert.equal((await first(index([], {}), "https://github.com/me/fork")).githubUrl, "https://github.com/me/fork");
  // It only shows where the skill came from; it never decides a link (the person's choice, or a match, does).
  const listed = index([
    skill("janestreet/agent_skills:socratic-tutor", { name: "socratic-tutor", description: "Tutor.", github_url: "https://github.com/janestreet/agent_skills" }),
    skill("someone/fork:socratic-tutor", { name: "socratic-tutor", description: "Tutor." }),
  ], {});
  const offered = await first(listed) as { catalogSkillId?: string | null; catalogMatchKey?: string; githubUrl?: string | null };
  assert.equal(offered.catalogSkillId ?? null, null);
  assert.ok(offered.catalogMatchKey);
  assert.equal(offered.githubUrl, "https://github.com/janestreet/agent_skills");
  // A library install under that key keeps its own (library) link.
  const { skills } = await readSyncInventory(pool([{ ...copy, catalogSkillId: "a/b:socratic-tutor" }], [], [], [added]), "user", 2, new Date(),
    async () => catalog, index([], {})) as { skills: Array<{ githubUrl?: string | null }> };
  assert.equal(skills[0].githubUrl, null);
});

test("copies from an app too old to say which Mac are superseded once a Mac reports with its own", async () => {
  const tagged = row({ id: "tagged", name: "here", catalogSkillIdHint: null, deviceId: "mac" });
  const old = row({ id: "old", name: "gone", catalogSkillIdHint: null, deviceId: null, source: "Claude" });
  const read = async (rows: unknown[], version: 2 | 3) => ((await readSyncInventory(pool(rows), "user", version, new Date(), async () => catalog,
    index([], {}))) as { skills: Array<{ id: string; isCurrent?: boolean }> }).skills.map((skill) => [skill.id, skill.isCurrent]);
  // With a Mac reporting: v3 keeps them as history (not current), v2 leaves them out.
  assert.deepEqual(await read([tagged, old], 3), [["tagged", true], ["old", false]]);
  assert.deepEqual(await read([tagged, old], 2), [["tagged", true]]);
  // An account whose only reports are from the old app keeps them.
  assert.deepEqual(await read([old], 3), [["old", true]]);
  // A Mac's history alone (nothing current) doesn't supersede them.
  assert.deepEqual(await read([{ ...tagged, isCurrent: false }, old], 3), [["tagged", false], ["old", true]]);
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
