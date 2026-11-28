import type { Skill } from "../types.js";
import { deriveInstallCmd } from "../install-cmd.js";
import { planMovedRepoDuplicates, type MovedRepoDuplicate } from "../../scripts/moved-repo-duplicates.js";
import { evaluateEffectiveRepoPolicy } from "../policy/effective-policy.js";
import { repoKeyFromUrl } from "./refresh-unpinned-skills.js";
import type { TrustedSeeds } from "./types.js";

// Scheduled crawls ask GitHub for the current name of each catalog repository (a slice per run, so
// each weekly) and re-point skills whose repository was renamed or transferred, so links, installs and Add by link follow the
// move. IDs, authors and first-seen dates stay (the 2026-10-30 moved-repo decision), so installs and
// Sets keep working. Git history survives a move, so pinned commits stay valid under the new name.

export const REPO_MOVE_BATCH_SIZE = 100;
/**
 * Repositories are split into this many slices, one checked per half day, so the twice-daily crawl
 * checks each repository once a week.
 */
export const REPO_MOVE_CHECK_SLICES = 14;
export const REPO_MOVE_SLICE_MS = 12 * 60 * 60 * 1000;
/** A lookup GitHub hasn't answered in this long counts as failed. */
export const REPO_MOVE_REQUEST_TIMEOUT_MS = 30_000;
/**
 * A 100-repository lookup takes GitHub about 3s of server time, and back-to-back lookups trip its
 * secondary rate limit, so lookups are spaced out.
 */
export const REPO_MOVE_BATCH_PAUSE_MS = 3000;
/** After this many failed lookups in a row, the rest of the run's lookups are skipped. */
const MAX_CONSECUTIVE_FAILED_BATCHES = 3;
/** More moves than this in one run looks like a lookup fault, not real renames; nothing is changed. */
export const MAX_REPO_MOVES_PER_RUN = 500;

/** owner/name as stored → GitHub's current owner/name. Repos GitHub didn't answer for are absent. */
export type CurrentRepoNames = Map<string, string>;

type GraphQL = (query: string, variables: Record<string, string>) => Promise<unknown>;

type RepoLookupData = Record<string, { nameWithOwner?: string | null } | null | undefined>;

/** One aliased query for a batch of owner/name pairs, with every value passed as a variable. */
export function repoNamesQuery(repos: readonly string[]): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = {};
  const declarations: string[] = [];
  const fields: string[] = [];
  repos.forEach((repo, index) => {
    const [owner, name] = repo.split("/");
    variables[`o${index}`] = owner;
    variables[`n${index}`] = name;
    declarations.push(`$o${index}: String!`, `$n${index}: String!`);
    fields.push(`r${index}: repository(owner: $o${index}, name: $n${index}) { nameWithOwner }`);
  });
  return { query: `query(${declarations.join(", ")}) { ${fields.join(" ")} }`, variables };
}

function lookupData(result: unknown): RepoLookupData | null {
  return result && typeof result === "object" ? result as RepoLookupData : null;
}

/**
 * Looks up the current name of each repository. A repository that no longer exists comes back as
 * an error beside the others' data, so a failed batch still yields its answered repositories; a
 * batch with no data at all is skipped, and its repositories stay as they are.
 */
export async function resolveCurrentRepoNames(
  repos: readonly string[],
  graphql: GraphQL,
  { batchSize = REPO_MOVE_BATCH_SIZE, pauseMs = REPO_MOVE_BATCH_PAUSE_MS, wait = defaultWait } = {},
): Promise<{ names: CurrentRepoNames; failedBatches: number; skipped: number }> {
  const names: CurrentRepoNames = new Map();
  let failedBatches = 0;
  let failedInARow = 0;
  for (let start = 0; start < repos.length; start += batchSize) {
    if (failedInARow >= MAX_CONSECUTIVE_FAILED_BATCHES) return { names, failedBatches, skipped: repos.length - start };
    if (start > 0) await wait(pauseMs);
    const batch = repos.slice(start, start + batchSize);
    const { query, variables } = repoNamesQuery(batch);
    let data: RepoLookupData | null;
    try {
      data = lookupData(await graphql(query, variables));
    } catch (error) {
      data = lookupData((error as { data?: unknown } | null)?.data);
    }
    failedInARow = data ? 0 : failedInARow + 1;
    if (!data) failedBatches++;
    batch.forEach((repo, index) => {
      const current = data?.[`r${index}`]?.nameWithOwner;
      if (typeof current === "string" && /^[^/\s]+\/[^/\s]+$/.test(current)) names.set(repo.toLowerCase(), current);
    });
  }
  return { names, failedBatches, skipped: 0 };
}

function defaultWait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // FNV's low bits barely vary across similar names; mix them so slices come out even.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** This half day's share of the repositories: each lands in one of REPO_MOVE_CHECK_SLICES, by name. */
export function repoMoveCheckSlice(repos: readonly string[], sliceNumber: number): string[] {
  const slice = ((sliceNumber % REPO_MOVE_CHECK_SLICES) + REPO_MOVE_CHECK_SLICES) % REPO_MOVE_CHECK_SLICES;
  return repos.filter((repo) => stableHash(repo.toLowerCase()) % REPO_MOVE_CHECK_SLICES === slice);
}

/** Each catalog repository once, as its skills' github_url spells it. */
export function catalogRepos(skills: readonly Skill[]): string[] {
  const repos = new Map<string, string>();
  for (const skill of skills) {
    const key = repoKeyFromUrl(skill.github_url);
    if (!key || repos.has(key)) continue;
    const [owner, name] = new URL(skill.github_url).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
    repos.set(key, `${owner}/${name}`);
  }
  return [...repos.values()].sort((left, right) => left.localeCompare(right));
}

export type RepoMove = { from: string; to: string; skills: number };

export type RepoMoveResult<T extends Skill = Skill> = {
  skills: T[];
  moves: RepoMove[];
  /** Moved aliases dropped because the new repository already lists the same SKILL.md. */
  duplicates: MovedRepoDuplicate[];
  /** Moves left alone because policy excludes the new repository (do-not-crawl or an exclude override). */
  blocked: RepoMove[];
  /** True when there were too many moves to trust, so nothing changed. */
  capped: boolean;
};

function repointSkill<T extends Skill>(skill: T, to: string): T {
  const githubUrl = `https://github.com/${to}`;
  const oldUrl = skill.github_url.replace(/\/+$/, "").replace(/\.git$/i, "");
  const oldName = oldUrl.split("/").pop() ?? "";
  const newName = to.split("/").pop() ?? "";
  const install_cmd = skill.skill_md_path && skill.name
    ? deriveInstallCmd(githubUrl, skill.skill_md_path, skill.name)
    : skill.install_cmd
      .replace(new RegExp(`${oldUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s/]|$)`, "gi"), githubUrl)
      .replace(new RegExp(`/tmp/${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s/]|$)`, "g"), `/tmp/${newName}`);
  return {
    ...skill,
    github_url: githubUrl,
    install_cmd,
    ...(skill.repo_slug ? { repo_slug: to } : {}),
  };
}

/**
 * Re-points skills whose repository GitHub now serves under another name, and drops a moved copy
 * when the new repository already lists the same SKILL.md (the existing row wins, as in the
 * 2026-10-30 duplicate planner). Repositories GitHub didn't answer for, and moves into
 * repositories policy excludes, are left as they are.
 */
export function applyRepoMoves<T extends Skill>(skills: readonly T[], current: CurrentRepoNames, seeds: TrustedSeeds): RepoMoveResult<T> {
  const moves = new Map<string, RepoMove>();
  const blocked = new Map<string, RepoMove>();
  for (const skill of skills) {
    const from = repoKeyFromUrl(skill.github_url);
    const to = from ? current.get(from) : undefined;
    if (!from || !to || to.toLowerCase() === from) continue;
    const target = evaluateEffectiveRepoPolicy(to, seeds).excluded ? blocked : moves;
    const move = target.get(from) ?? { from, to, skills: 0 };
    move.skills++;
    target.set(from, move);
  }
  const sortedBlocked = [...blocked.values()].sort((left, right) => left.from.localeCompare(right.from));
  const capped = moves.size > MAX_REPO_MOVES_PER_RUN;
  const repointed = capped ? [...skills] : skills.map((skill) => {
    const move = moves.get(repoKeyFromUrl(skill.github_url) ?? "");
    return move ? repointSkill(skill, move.to) : skill;
  });
  // A skill whose ID names another repository than its link was listed before a move. Where it and
  // a row listed under the current name hold the same SKILL.md, the listed row is kept. Checked every
  // run, not only on a move's day, so an old ID a source still lists can't displace the listed row.
  const aliases = new Set(repointed.filter((skill) => skill.id.split(":")[0].toLowerCase() !== repoKeyFromUrl(skill.github_url))
    .map((skill) => skill.id));
  const duplicates = planMovedRepoDuplicates(repointed, aliases);
  const dropped = new Set(duplicates.map((duplicate) => duplicate.id));
  return {
    skills: dropped.size ? repointed.filter((skill) => !dropped.has(skill.id)) : repointed,
    moves: [...moves.values()].sort((left, right) => left.from.localeCompare(right.from)),
    duplicates,
    blocked: sortedBlocked,
    capped,
  };
}

/**
 * One crawl run's step: looks up this run's slice of repositories and re-points the moved ones.
 * Lookups that fail leave their repositories as they are, so the step never blocks the crawl.
 */
export type RepoMoveStep = RepoMoveResult & {
  /** GitHub's answers, to apply again to records merged in later in the run. */
  names: CurrentRepoNames;
  checked: number;
  answered: number;
  failedBatches: number;
  skipped: number;
};

export async function followRepoMoves(
  skills: readonly Skill[],
  seeds: TrustedSeeds,
  graphql: GraphQL,
  now = Date.now(),
): Promise<RepoMoveStep> {
  const repos = repoMoveCheckSlice(catalogRepos(skills), Math.floor(now / REPO_MOVE_SLICE_MS));
  const { names, failedBatches, skipped } = await resolveCurrentRepoNames(repos, graphql);
  return { ...applyRepoMoves(skills, names, seeds), names, checked: repos.length, answered: names.size, failedBatches, skipped };
}

export function describeRepoMoves(result: RepoMoveStep): string[] {
  const moved = result.moves.reduce((sum, move) => sum + move.skills, 0);
  return [
    `Repo moves: GitHub answered for ${result.answered}/${result.checked} repos` +
      `${result.failedBatches ? ` (${result.failedBatches} lookups failed${result.skipped ? `, ${result.skipped} repos skipped` : ""})` : ""}; ` +
      (result.capped
        ? `${result.moves.length} moves is more than expected, so none were applied`
        : `${result.moves.length} moved (${moved} skills re-pointed)`) +
      `, ${result.duplicates.length} duplicates dropped` +
      `${result.blocked.length ? `, ${result.blocked.length} left alone (moved to a repo policy excludes)` : ""}.`,
    ...result.moves.slice(0, 20).map((move) => `  [repo-moved] ${move.from} -> ${move.to} (${move.skills})`),
  ];
}

/** Pins merged in after the move (from an earlier run) take the moved repository's name again. */
export function keepRepoMoveSlugs<T extends Skill>(skills: T[], moves: readonly RepoMove[]): T[] {
  if (!moves.length) return skills;
  const byFrom = new Map(moves.map((move) => [move.from, move.to]));
  const byTo = new Map(moves.map((move) => [move.to.toLowerCase(), move.to]));
  return skills.map((skill) => {
    const to = byTo.get(repoKeyFromUrl(skill.github_url) ?? "");
    const slug = skill.repo_slug?.toLowerCase();
    return to && slug && byFrom.get(slug) === to ? { ...skill, repo_slug: to } : skill;
  });
}
