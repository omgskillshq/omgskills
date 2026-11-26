import assert from "node:assert/strict";
import test from "node:test";
import { handleSkillLinkChoice } from "./skill-link-choices.js";

const key = `sha:${"a".repeat(40)}`;
function call(body: unknown, opts: { entries?: Record<string, { ids: string[] }>; queries?: unknown[][]; unavailable?: boolean; full?: boolean } = {}) {
  const queries = opts.queries ?? [];
  return handleSkillLinkChoice(new Request("https://omgskills.com/api/portal/skill-link", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), {
    requirePortalUser: async () => ({ id: "user-1" }) as never,
    getPgPool: () => ({ query: async (_sql: string, params: unknown[]) => { queries.push(params); return { rows: opts.full ? [] : [{ match_key: params[1] }] }; } }) as never,
    readContentIndex: async () => { if (opts.unavailable) throw new Error("down"); return opts.entries ?? { [key]: { ids: ["big/repo:x", "fork/repo:x"] } }; },
  });
}

test("a person picks one of the library skills sharing their copy's content, or says it's their own", async () => {
  const queries: unknown[][] = [];
  assert.equal((await call({ matchKey: key, catalogSkillId: "fork/repo:x" }, { queries })).status, 200);
  assert.equal((await call({ matchKey: key, catalogSkillId: null }, { queries })).status, 200);
  assert.deepEqual(queries.map((params) => params.slice(0, 3)), [["user-1", key, "fork/repo:x"], ["user-1", key, null]]);
});

test("only a listed candidate can be chosen, for a real key, and an unavailable index never saves", async () => {
  assert.equal((await call({ matchKey: key, catalogSkillId: "someone/else:x" })).status, 404);
  assert.equal((await call({ matchKey: "sha:nope", catalogSkillId: null })).status, 400);
  assert.equal((await call({ matchKey: key, catalogSkillId: 5 })).status, 400);
  const queries: unknown[][] = [];
  assert.equal((await call({ matchKey: key, catalogSkillId: "big/repo:x" }, { unavailable: true, queries })).status, 503);
  assert.equal(queries.length, 0);
  // "My own" too only for content the library has several matches for, and within the cap.
  assert.equal((await call({ matchKey: `sha:${"b".repeat(40)}`, catalogSkillId: null }, { queries })).status, 404);
  assert.equal(queries.length, 0);
  // A single suggestion (by name) can be confirmed or declined too.
  const byName = `n:${"c".repeat(64)}`;
  assert.equal((await call({ matchKey: byName, catalogSkillId: "only/one:x" }, { entries: { [byName]: { ids: ["only/one:x"] } } })).status, 200);
  assert.equal((await call({ matchKey: key, catalogSkillId: null }, { full: true })).status, 409);
});

test("keeping another library skill with the copies' name: saved for their own key, only when the name's list holds it", async () => {
  const byName = `n:${"c".repeat(64)}`;
  const entries = { [key]: { ids: ["big/repo:x", "fork/repo:x"] }, [byName]: { ids: ["big/repo:x", "fork/repo:x", "kept/repo:x"] } };
  const queries: unknown[][] = [];
  assert.equal((await call({ matchKey: key, catalogSkillId: "kept/repo:x", nameKey: byName }, { entries, queries })).status, 200);
  assert.deepEqual(queries.map((params) => params.slice(0, 3)), [["user-1", key, "kept/repo:x"]]);
  // Not under that name, no name given, or a name list that shares no candidate (another name): refused.
  assert.equal((await call({ matchKey: key, catalogSkillId: "other/repo:x", nameKey: byName }, { entries })).status, 404);
  assert.equal((await call({ matchKey: key, catalogSkillId: "kept/repo:x" }, { entries })).status, 404);
  assert.equal((await call({ matchKey: key, catalogSkillId: "kept/repo:x", nameKey: byName },
    { entries: { ...entries, [byName]: { ids: ["kept/repo:x"] } } })).status, 404);
});

test("none of these: saved with the library skills listed now, never with a skill", async () => {
  const queries: unknown[][] = [];
  const saved = await call({ matchKey: key, catalogSkillId: null, noneOf: true }, { queries });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { matchKey: key, catalogSkillId: null, noneOf: true });
  assert.deepEqual(queries[0], ["user-1", key, null, 2000, ["big/repo:x", "fork/repo:x"]]);
  // Any other choice clears it.
  await call({ matchKey: key, catalogSkillId: null }, { queries });
  assert.equal(queries[1][4], null);
  assert.equal((await call({ matchKey: key, catalogSkillId: "big/repo:x", noneOf: true })).status, 400);
  assert.equal((await call({ matchKey: key, catalogSkillId: null, noneOf: "yes" })).status, 400);
  assert.equal((await call({ matchKey: `sha:${"b".repeat(40)}`, catalogSkillId: null, noneOf: true })).status, 404);
});
