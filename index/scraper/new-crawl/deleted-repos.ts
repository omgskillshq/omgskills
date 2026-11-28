import type { Skill } from "../types.js";
import { repoKeyFromUrl } from "./refresh-unpinned-skills.js";
import type { CurrentRepoNames } from "./repo-moves.js";

// The weekly repository check (repo-moves.ts) also learns which repositories GitHub says no longer
// exist. A skill whose repository is gone can't be installed, so it leaves the catalog, but only
// after two checks a week apart both say so: a repository made private for a day, or a GitHub fault,
// doesn't cost it its listing. The first miss is recorded on the skill (`repo_missing_since`), so
// the next week's check, in a later run, can confirm it.

/** A second miss at least this long after the first confirms the repository is gone. */
export const REPO_GONE_CONFIRM_MS = 6 * 24 * 60 * 60 * 1000;
/**
 * A run's slice holds about 900 repositories, of which a dozen or so go missing in a typical week.
 * More than this looks like a lookup fault, so nothing is marked or removed.
 */
export const MAX_MISSING_REPOS_PER_RUN = 100;
/**
 * At most this many skills leave the catalog per run, well under the publication check's 500-skill
 * limit. Confirmed repositories past it stay marked and leave on a later run.
 */
export const MAX_GONE_SKILLS_PER_RUN = 200;

export type GoneRepo = { repo: string; skills: number; since: string };

/**
 * Skill IDs the editorial curations list (collections and creator overrides). Publishing them
 * requires every listed ID to exist, so the crawl never removes them; an editor takes them out.
 */
export function curatedSkillIds(source: unknown): Set<string> {
  const ids = new Set<string>();
  const add = (list: unknown) => { if (Array.isArray(list)) for (const id of list) if (typeof id === "string") ids.add(id); };
  const curations = source as { collections?: unknown; authorOverrides?: unknown } | null;
  if (Array.isArray(curations?.collections)) {
    for (const collection of curations.collections as { skillIds?: unknown; featuredSkillIds?: unknown }[]) {
      add(collection?.skillIds);
      add(collection?.featuredSkillIds);
    }
  }
  if (curations?.authorOverrides && typeof curations.authorOverrides === "object") {
    for (const override of Object.values(curations.authorOverrides as Record<string, { featuredSkillIds?: unknown }>)) {
      add(override?.featuredSkillIds);
    }
  }
  return ids;
}

export type MissingRepoPlan = {
  /** Repositories to mark as missing, with the date of their first miss. */
  marked: Map<string, string>;
  /** Marked repositories GitHub answered for again. */
  cleared: Set<string>;
  /** Confirmed gone: these skills leave the catalog this run (a large repository may leave in parts). */
  removed: GoneRepo[];
  /** Confirmed-gone skills over this run's limit: they stay marked and leave on a later run. */
  held: GoneRepo[];
  /** Skills leaving this run. */
  removedIds: Set<string>;
  /** Repositories all of whose skills leave this run (curated ones aside): any copy merged in later leaves too. */
  goneRepos: Set<string>;
  /** Skills in a removed repository that a curation lists: they stay, marked, for an editor. */
  keptIds: Set<string>;
  /** Missing catalog repositories this run (after the fault check). */
  missing: number;
  /** True when too many repositories were missing to trust, so nothing changed. */
  faulted: boolean;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Decides, per repository, what this run's answers mean for its skills. `missing` holds the
 * repositories GitHub said don't exist; `answered` the ones it served (any name).
 */
export function planMissingRepos(
  skills: readonly Skill[],
  missing: ReadonlySet<string>,
  answered: CurrentRepoNames,
  now = Date.now(),
  curated: ReadonlySet<string> = new Set(),
): MissingRepoPlan {
  const today = new Date(now).toISOString().slice(0, 10);
  const byRepo = new Map<string, { ids: string[]; curated: string[]; since?: string }>();
  const cleared = new Set<string>();
  for (const skill of skills) {
    const repo = repoKeyFromUrl(skill.github_url);
    if (!repo) continue;
    if (answered.has(repo) && skill.repo_missing_since) cleared.add(repo);
    if (!missing.has(repo)) continue;
    const entry = byRepo.get(repo) ?? { ids: [], curated: [] };
    (curated.has(skill.id) ? entry.curated : entry.ids).push(skill.id);
    const since = DAY.test(skill.repo_missing_since ?? "") ? skill.repo_missing_since : undefined;
    if (since && (!entry.since || since < entry.since)) entry.since = since;
    byRepo.set(repo, entry);
  }
  const empty = { marked: new Map<string, string>(), removed: [], held: [], keptIds: new Set<string>(),
    removedIds: new Set<string>(), goneRepos: new Set<string>() };
  if (byRepo.size > MAX_MISSING_REPOS_PER_RUN) return { ...empty, cleared, missing: byRepo.size, faulted: true };
  const marked = new Map<string, string>();
  const confirmed: { repo: string; since: string; ids: string[]; curated: string[] }[] = [];
  for (const [repo, entry] of [...byRepo].sort(([left], [right]) => left.localeCompare(right))) {
    const since = entry.since ?? today;
    marked.set(repo, since);
    if (entry.since && now - Date.parse(`${entry.since}T00:00:00Z`) >= REPO_GONE_CONFIRM_MS) {
      confirmed.push({ repo, since, ids: [...new Set(entry.ids)].sort(), curated: entry.curated });
    }
  }
  const removed: GoneRepo[] = [];
  const held: GoneRepo[] = [];
  const keptIds = new Set<string>();
  const removedIds = new Set<string>();
  const goneRepos = new Set<string>();
  let budget = MAX_GONE_SKILLS_PER_RUN;
  for (const { repo, since, ids, curated: listed } of confirmed) {
    // A repository larger than what's left of the limit leaves in parts, over later runs.
    const leaving = ids.slice(0, budget);
    budget -= leaving.length;
    if (leaving.length || !ids.length) {
      for (const id of listed) keptIds.add(id);
    }
    if (leaving.length) removed.push({ repo, skills: leaving.length, since });
    for (const id of leaving) removedIds.add(id);
    if (leaving.length === ids.length) goneRepos.add(repo);
    if (leaving.length < ids.length) held.push({ repo, skills: ids.length - leaving.length, since });
  }
  return { marked, cleared, removed, held, keptIds, removedIds, goneRepos, missing: byRepo.size, faulted: false };
}

/**
 * Applies a plan to any list of skills: the first pass over the saved catalog, and again to records
 * merged in later in the run, so a saved record can't bring a removed skill back or drop its mark.
 */
export function applyMissingRepoPlan<T extends Skill>(skills: readonly T[], plan: MissingRepoPlan): T[] {
  const result: T[] = [];
  for (const skill of skills) {
    const repo = repoKeyFromUrl(skill.github_url) ?? "";
    if (!plan.keptIds.has(skill.id) && (plan.removedIds.has(skill.id) || plan.goneRepos.has(repo))) continue;
    const since = plan.marked.get(repo);
    if (since) {
      result.push(skill.repo_missing_since === since ? skill : { ...skill, repo_missing_since: since });
    } else if (plan.cleared.has(repo) && skill.repo_missing_since) {
      const { repo_missing_since: _cleared, ...rest } = skill;
      result.push(rest as T);
    } else {
      result.push(skill);
    }
  }
  return result;
}

export function describeMissingRepos(plan: MissingRepoPlan): string[] {
  if (plan.faulted) {
    return [`Deleted repos: GitHub said ${plan.missing} repos are gone, more than expected, so nothing changed.`];
  }
  const removedSkills = plan.removed.reduce((sum, gone) => sum + gone.skills, 0);
  return [
    `Deleted repos: ${plan.missing} missing (${plan.marked.size - new Set([...plan.removed, ...plan.held].map((gone) => gone.repo)).size} awaiting a second check), ` +
      `${plan.removed.length} confirmed gone (${removedSkills} skills removed)` +
      `${plan.held.length ? `, ${plan.held.reduce((sum, gone) => sum + gone.skills, 0)} skills from ${plan.held.length} repos held for a later run` : ""}` +
      `${plan.cleared.size ? `, ${plan.cleared.size} back on GitHub` : ""}` +
      `${plan.keptIds.size ? `, ${plan.keptIds.size} skills kept because a collection lists them (remove them from index/curations/collections.json)` : ""}.`,
    ...plan.removed.slice(0, 20).map((gone) => `  [repo-gone] ${gone.repo} (${gone.skills}, missing since ${gone.since})`),
  ];
}
