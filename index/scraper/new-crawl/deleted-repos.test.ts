import assert from "node:assert/strict";
import test from "node:test";
import type { Skill } from "../types.js";
import {
  MAX_GONE_SKILLS_PER_RUN,
  MAX_MISSING_REPOS_PER_RUN,
  applyMissingRepoPlan,
  curatedSkillIds,
  describeMissingRepos,
  planMissingRepos,
} from "./deleted-repos.js";
import { resolveCurrentRepoNames } from "./repo-moves.js";

const skill = (id: string, repo: string, overrides: Partial<Skill> = {}): Skill => ({
  id, name: id.split(":").pop()!, description: "d", github_url: `https://github.com/${repo}`,
  install_cmd: `git clone https://github.com/${repo} ~/.claude/skills/x`, author_handle: repo.split("/")[0],
  tags: [], stars: 1, last_updated: "2026-11-01", first_seen: "2026-01-01", ...overrides,
});
const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const answered = (...repos: string[]) => new Map(repos.map((repo) => [repo, repo]));

test("a first miss marks the repository's skills and removes nothing", () => {
  const rows = [skill("Gone/r:a", "Gone/r"), skill("Gone/r:b", "Gone/r"), skill("live/r:c", "live/r")];
  const plan = planMissingRepos(rows, new Set(["gone/r"]), answered("live/r"), day("2026-11-28"));
  const result = applyMissingRepoPlan(rows, plan);
  assert.deepEqual(result.map((row) => [row.id, row.repo_missing_since]),
    [["Gone/r:a", "2026-11-28"], ["Gone/r:b", "2026-11-28"], ["live/r:c", undefined]]);
  assert.equal(result[2], rows[2]);
  assert.deepEqual(plan.removed, []);
  assert.match(describeMissingRepos(plan)[0], /1 missing \(1 awaiting a second check\), 0 confirmed gone/);
});

test("a second miss a week later removes the skills; one a day later doesn't", () => {
  const rows = [skill("gone/r:a", "gone/r", { repo_missing_since: "2026-11-21" }), skill("gone/r:b", "gone/r"),
    skill("new/r:c", "new/r", { repo_missing_since: "2026-11-27" })];
  const plan = planMissingRepos(rows, new Set(["gone/r", "new/r"]), answered(), day("2026-11-28"));
  assert.deepEqual(plan.removed, [{ repo: "gone/r", skills: 2, since: "2026-11-21" }]);
  assert.deepEqual(applyMissingRepoPlan(rows, plan).map((row) => [row.id, row.repo_missing_since]), [["new/r:c", "2026-11-27"]]);
  assert.match(describeMissingRepos(plan)[1], /\[repo-gone\] gone\/r \(2, missing since 2026-11-21\)/);
});

test("a repository GitHub serves again loses its mark; unchecked repositories keep theirs", () => {
  const rows = [skill("back/r:a", "back/r", { repo_missing_since: "2026-11-21" }),
    skill("other/r:b", "other/r", { repo_missing_since: "2026-11-21" })];
  const plan = planMissingRepos(rows, new Set(), answered("back/r"), day("2026-11-28"));
  const [back, other] = applyMissingRepoPlan(rows, plan);
  assert.equal("repo_missing_since" in back, false);
  assert.equal(other, rows[1]);
});

test("too many missing repositories looks like a fault and changes nothing", () => {
  const rows = Array.from({ length: MAX_MISSING_REPOS_PER_RUN + 1 }, (_, index) =>
    skill(`o/r${index}:s`, `o/r${index}`, { repo_missing_since: "2026-11-01" }));
  const plan = planMissingRepos(rows, new Set(rows.map((_, index) => `o/r${index}`)), answered(), day("2026-11-28"));
  assert.equal(plan.faulted, true);
  assert.deepEqual(applyMissingRepoPlan(rows, plan), rows);
  assert.match(describeMissingRepos(plan)[0], /nothing changed/);
});

test("removals past the per-run limit wait for a later run, still marked", () => {
  const big = Array.from({ length: MAX_GONE_SKILLS_PER_RUN }, (_, index) => skill(`a/big:s${String(index).padStart(3, "0")}`, "a/big", { repo_missing_since: "2026-11-01" }));
  const small = skill("b/small:s", "b/small", { repo_missing_since: "2026-11-01" });
  const plan = planMissingRepos([...big, small], new Set(["a/big", "b/small"]), answered(), day("2026-11-28"));
  assert.deepEqual(plan.removed.map((gone) => gone.repo), ["a/big"]);
  assert.deepEqual(plan.held, [{ repo: "b/small", skills: 1, since: "2026-11-01" }]);
  assert.deepEqual(applyMissingRepoPlan([...big, small], plan), [small]);
});

test("a repository larger than the limit leaves in parts over later runs", () => {
  const rows = Array.from({ length: MAX_GONE_SKILLS_PER_RUN + 5 }, (_, index) =>
    skill(`a/huge:s${String(index).padStart(3, "0")}`, "a/huge", { repo_missing_since: "2026-11-01" }));
  const plan = planMissingRepos(rows, new Set(["a/huge"]), answered(), day("2026-11-28"));
  assert.deepEqual(plan.removed, [{ repo: "a/huge", skills: MAX_GONE_SKILLS_PER_RUN, since: "2026-11-01" }]);
  assert.deepEqual(plan.held, [{ repo: "a/huge", skills: 5, since: "2026-11-01" }]);
  assert.equal(plan.goneRepos.size, 0, "the repository stays until its last skill leaves");
  const left = applyMissingRepoPlan(rows, plan);
  assert.deepEqual(left.map((row) => [row.id, row.repo_missing_since]), rows.slice(-5).map((row) => [row.id, "2026-11-01"]));
  const next = planMissingRepos(left, new Set(["a/huge"]), answered(), day("2026-12-05"));
  assert.deepEqual(applyMissingRepoPlan(left, next), []);
  assert.deepEqual([...next.goneRepos], ["a/huge"]);
  assert.match(describeMissingRepos(plan)[0], /1 missing \(0 awaiting a second check\), 1 confirmed gone \(200 skills removed\), 5 skills from 1 repos held/);
});

test("the plan applies to records merged in later: a removed skill stays removed and a new copy is marked", () => {
  const rows = [skill("gone/r:a", "gone/r", { repo_missing_since: "2026-11-20" }), skill("miss/r:b", "miss/r")];
  const plan = planMissingRepos(rows, new Set(["gone/r", "miss/r"]), answered(), day("2026-11-28"));
  const merged = [skill("gone/r:a", "gone/r"), skill("miss/r:b", "miss/r"), skill("miss/r:c", "miss/r")];
  assert.deepEqual(applyMissingRepoPlan(merged, plan).map((row) => [row.id, row.repo_missing_since]),
    [["miss/r:b", "2026-11-28"], ["miss/r:c", "2026-11-28"]]);
});

test("only a NOT_FOUND answer counts as missing, not a failed or forbidden lookup", async () => {
  const graphql = async (_query: string, vars: Record<string, string>) => {
    const repos = Object.keys(vars).filter((key) => key.startsWith("o")).map((key) => `${vars[key]}/${vars[`n${key.slice(1)}`]}`);
    if (repos[0] === "down/one") throw new Error("timeout");
    throw Object.assign(new Error("partial"), {
      data: { r0: { nameWithOwner: repos[0] }, r1: null, r2: null },
      errors: [{ type: "NOT_FOUND", path: ["r1"] }, { type: "FORBIDDEN", path: ["r2"] }],
    });
  };
  const { names, missing } = await resolveCurrentRepoNames(["live/one", "Gone/One", "blocked/one", "down/one", "down/two"], graphql,
    { batchSize: 3, wait: async () => {} });
  assert.deepEqual([...missing], ["gone/one"]);
  assert.deepEqual([...names.keys()], ["live/one"]);
});

test("a skill a collection lists stays when its repository is removed, so collections still publish", () => {
  const rows = [skill("gone/r:listed", "gone/r", { repo_missing_since: "2026-11-20" }),
    skill("gone/r:other", "gone/r", { repo_missing_since: "2026-11-20" })];
  const curated = curatedSkillIds({
    collections: [{ id: "c", skillIds: ["gone/r:listed"], featuredSkillIds: ["x/y:z"] }],
    authorOverrides: { someone: { featuredSkillIds: ["a/b:c"] } },
  });
  assert.deepEqual([...curated].sort(), ["a/b:c", "gone/r:listed", "x/y:z"]);
  const plan = planMissingRepos(rows, new Set(["gone/r"]), answered(), day("2026-11-28"), curated);
  assert.deepEqual(plan.removed, [{ repo: "gone/r", skills: 1, since: "2026-11-20" }]);
  assert.deepEqual(applyMissingRepoPlan(rows, plan).map((row) => row.id), ["gone/r:listed"]);
  assert.match(describeMissingRepos(plan)[0], /1 skills kept because a collection lists them/);
});

test("the real curations file parses", async () => {
  const { readFileSync } = await import("node:fs");
  const ids = curatedSkillIds(JSON.parse(readFileSync(new URL("../../curations/collections.json", import.meta.url), "utf8")));
  assert.ok(ids.size > 10);
});

test("a marked repository GitHub now serves under a new name loses its mark", () => {
  const rows = [skill("old/r:a", "New/R", { repo_missing_since: "2026-11-14" })];
  const plan = planMissingRepos(rows, new Set(), new Map([["old/r", "New/R"]]), day("2026-11-28"));
  assert.equal("repo_missing_since" in applyMissingRepoPlan(rows, plan)[0], false);
});
