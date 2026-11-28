import assert from "node:assert/strict";
import test from "node:test";
import type { Skill } from "../types.js";
import {
  MAX_REPO_MOVES_PER_RUN,
  REPO_MOVE_CHECK_SLICES,
  applyRepoMoves,
  catalogRepos,
  keepRepoMoveSlugs,
  repoMoveCheckSlice,
  repoNamesQuery,
  resolveCurrentRepoNames,
} from "./repo-moves.js";
import type { TrustedSeeds } from "./types.js";

const seeds = (blocked: string[] = [], excluded: string[] = []) => ({ doNotCrawlRepos: new Set(blocked), doNotCrawlOwners: new Set<string>(),
  repoOverrides: excluded.map((repo) => ({ repo, exclude: true })) }) as unknown as TrustedSeeds;

const skill = (id: string, repo: string, path: string | undefined, overrides: Partial<Skill> = {}): Skill => {
  const name = id.split(":").pop()!.split("/").pop()!;
  const url = `https://github.com/${repo}`;
  const repoName = repo.split("/")[1];
  return {
    id, name, description: "d", github_url: url, skill_md_path: path,
    install_cmd: path === "SKILL.md"
      ? `git clone ${url} ~/.claude/skills/${name}`
      : `git clone ${url} /tmp/${repoName} && ln -s /tmp/${repoName}/${(path ?? `skills/${name}/SKILL.md`).replace(/\/SKILL\.md$/, "")} ~/.claude/skills/${name}`,
    author_handle: id.split("/")[0], tags: [], stars: 10, last_updated: "2026-11-01", first_seen: "2026-01-01",
    skill_md_sha: "a".repeat(40), ...overrides,
  } as Skill;
};

test("a renamed repository's skills take the new name and keep their IDs, authors and pins", () => {
  const pinned = skill("Old/tools:review", "Old/tools", "skills/review/SKILL.md", {
    repo_slug: "Old/tools", repo_commit_sha: "b".repeat(40), skill_tree_sha: "c".repeat(40), install_target_name: "review",
  });
  const other = skill("keep/repo:x", "keep/repo", "x/SKILL.md");
  const result = applyRepoMoves([pinned, other], new Map([["old/tools", "New/toolkit"], ["keep/repo", "keep/repo"]]), seeds());
  assert.equal(result.capped, false);
  assert.deepEqual(result.moves, [{ from: "old/tools", to: "New/toolkit", skills: 1 }]);
  const [moved, kept] = result.skills;
  assert.equal(moved.id, "Old/tools:review");
  assert.equal(moved.author_handle, "Old");
  assert.equal(moved.first_seen, "2026-01-01");
  assert.equal(moved.github_url, "https://github.com/New/toolkit");
  assert.equal(moved.repo_slug, "New/toolkit");
  assert.equal(moved.repo_commit_sha, "b".repeat(40));
  assert.equal(moved.install_cmd, "git clone https://github.com/New/toolkit /tmp/toolkit && ln -s /tmp/toolkit/skills/review ~/.claude/skills/review");
  assert.equal(kept, other);
});

test("a skill without a stored path has its install command rewritten in place", () => {
  const root = skill("old/one", "old/one", undefined, { install_cmd: "git clone https://github.com/old/one /tmp/one && ln -s /tmp/one/a ~/.claude/skills/a" });
  const [moved] = applyRepoMoves([root], new Map([["old/one", "new/two"]]), seeds()).skills;
  assert.equal(moved.install_cmd, "git clone https://github.com/new/two /tmp/two && ln -s /tmp/two/a ~/.claude/skills/a");
  assert.equal(moved.repo_slug, undefined);
});

test("nothing changes for unanswered repositories, case-only differences or destinations policy excludes", () => {
  const rows = [skill("a/b:x", "a/b", "x/SKILL.md"), skill("C/D:y", "C/D", "y/SKILL.md"), skill("e/f:z", "e/f", "z/SKILL.md"),
    skill("g/h:w", "g/h", "w/SKILL.md")];
  const result = applyRepoMoves(rows, new Map([["c/d", "c/d"], ["e/f", "blocked/f"], ["g/h", "Excluded/h"]]),
    seeds(["blocked/f"], ["excluded/h"]));
  assert.deepEqual(result.skills, rows);
  assert.deepEqual(result.moves, []);
  assert.deepEqual(result.blocked, [{ from: "e/f", to: "blocked/f", skills: 1 }, { from: "g/h", to: "Excluded/h", skills: 1 }]);
});

test("an old ID re-listed after its move doesn't displace the row listed under the new name", () => {
  const alias = skill("old/repo:review", "new/repo", "skills/review/SKILL.md", { stars: 99 });
  const listed = skill("new/repo:review", "new/repo", "skills/review/SKILL.md", { stars: 1 });
  const result = applyRepoMoves([alias, listed], new Map(), seeds());
  assert.deepEqual(result.skills.map((row) => row.id), ["new/repo:review"]);
  assert.deepEqual(result.moves, []);
});

test("a moved copy of a SKILL.md the new repository already lists is dropped; the listed row stays", () => {
  const alias = skill("old/repo:review", "old/repo", "skills/review/SKILL.md");
  const listed = skill("new/repo:review", "new/repo", "skills/review/SKILL.md");
  const other = skill("old/repo:lint", "old/repo", "skills/lint/SKILL.md");
  const result = applyRepoMoves([alias, listed, other], new Map([["old/repo", "new/repo"]]), seeds());
  assert.deepEqual(result.skills.map((row) => row.id), ["new/repo:review", "old/repo:lint"]);
  assert.deepEqual(result.duplicates.map((row) => [row.id, row.replacementId]), [["old/repo:review", "new/repo:review"]]);
});

test("too many moves in one run changes nothing", () => {
  const rows = Array.from({ length: MAX_REPO_MOVES_PER_RUN + 1 }, (_, index) => skill(`o/r${index}`, `o/r${index}`, "SKILL.md"));
  const names = new Map(rows.map((_, index) => [`o/r${index}`, `n/r${index}`]));
  const result = applyRepoMoves(rows, names, seeds());
  assert.equal(result.capped, true);
  assert.deepEqual(result.skills, rows);
});

test("catalog repositories are listed once each, as stored", () => {
  assert.deepEqual(catalogRepos([
    skill("A/b:x", "A/b", "x/SKILL.md"), skill("a/B:y", "a/B", "y/SKILL.md"), skill("c/d", "c/d", "SKILL.md"),
  ]), ["A/b", "c/d"]);
});

test("the lookup passes names as variables and keeps the answers a partly failed batch returns", async () => {
  const { query, variables } = repoNamesQuery(["a/b", 'x/"y']);
  assert.match(query, /r1: repository\(owner: \$o1, name: \$n1\)/);
  assert.deepEqual(variables, { o0: "a", n0: "b", o1: "x", n1: '"y' });

  const calls: string[][] = [];
  const graphql = async (_query: string, vars: Record<string, string>) => {
    const repos = Object.keys(vars).filter((key) => key.startsWith("o")).map((key) => `${vars[key]}/${vars[`n${key.slice(1)}`]}`);
    calls.push(repos);
    if (repos.includes("gone/repo")) throw Object.assign(new Error("NOT_FOUND"), { data: { r0: { nameWithOwner: "Moved/To" }, r1: null } });
    if (repos.includes("down/repo")) throw new Error("timeout");
    return { r0: { nameWithOwner: repos[0] } };
  };
  const waits: number[] = [];
  const { names, failedBatches, skipped } = await resolveCurrentRepoNames(["Old/From", "gone/repo", "down/repo", "same/one"], graphql,
    { batchSize: 2, pauseMs: 5, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(calls, [["Old/From", "gone/repo"], ["down/repo", "same/one"]]);
  assert.deepEqual([...names], [["old/from", "Moved/To"]]);
  assert.deepEqual([failedBatches, skipped], [1, 0]);
  assert.deepEqual(waits, [5]);
});

test("after three failed lookups in a row the rest are skipped", async () => {
  let calls = 0;
  const repos = Array.from({ length: 10 }, (_, index) => `o/r${index}`);
  const result = await resolveCurrentRepoNames(repos, async () => { calls++; throw new Error("secondary rate limit"); },
    { batchSize: 2, wait: async () => {} });
  assert.deepEqual([calls, result.failedBatches, result.skipped, result.names.size], [3, 3, 4, 0]);
});

test("every repository is in exactly one slice, whatever its case", () => {
  const repos = Array.from({ length: 700 }, (_, index) => `owner${index}/repo${index}`);
  const days = Array.from({ length: REPO_MOVE_CHECK_SLICES }, (_, day) => repoMoveCheckSlice(repos, 20_000 + day));
  assert.deepEqual(days.flat().sort(), [...repos].sort());
  for (const day of days) assert.ok(day.length > 20 && day.length < 80, String(day.length));
  assert.deepEqual(repoMoveCheckSlice(["Owner1/Repo1"], 20_000 + REPO_MOVE_CHECK_SLICES), repoMoveCheckSlice(["owner1/repo1"], 20_000).length
    ? ["Owner1/Repo1"] : []);
});

test("a pin saved before the move takes the new repository name; unrelated pins are untouched", () => {
  const moves = [{ from: "old/tools", to: "New/toolkit", skills: 1 }];
  const stale = skill("old/tools:review", "New/toolkit", "skills/review/SKILL.md", { repo_slug: "Old/tools" });
  const publisher = skill("fork/tools:review", "fork/tools", "skills/review/SKILL.md", { repo_slug: "Old/tools" });
  const [fixed, kept] = keepRepoMoveSlugs([stale, publisher], moves);
  assert.equal(fixed.repo_slug, "New/toolkit");
  assert.equal(kept, publisher);
});
