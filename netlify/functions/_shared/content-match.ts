import type { Pool } from "pg";
import { keysFor, MAX_PER_NAME, type ContentIndexEntry } from "./catalog-content-index.js";
import { cloudBlobKey, type CloudObjectStore } from "./cloud-store.js";

/*
 * Confirms which library skill a personal skill is by comparing its SKILL.md text with same-named
 * library skills, in the background, so page loads only read the result (content_match_results).
 * Rules from the match trial (~/Projects/match-trial-20261124, 2026-11-24, 243 known older versions
 * and 147 skills not in the library), then checked on real skills: see confirmByText. Everything else
 * stays a suggestion.
 * Only copies whose text we hold (saved to the owner's cloud, or shared in a Set) are compared.
 */

export type CatalogText = { name: string; description: string; url: string | null };

export type ContentMatchDeps = {
  store: CloudObjectStore;
  readIndex: (keys: string[]) => Promise<Record<string, ContentIndexEntry>>;
  /** A library skill's name, description and where its SKILL.md is (raw URL at the pinned commit). */
  catalogSkill: (catalogSkillId: string) => Promise<CatalogText | null>;
  /** null only when the file is gone (404); any other failure throws, so the version is tried again. */
  fetchText: (url: string) => Promise<string | null>;
  now?: () => number;
  /** Stops taking new versions after this long (from the call), so the run ends inside its time limit. */
  budgetMs?: number;
  /** The catalog build the results are for; a new build recomputes them. */
  catalogKey: string;
};

/**
 * Versions compared per run, and library skills compared per version. A version with more candidates
 * than that (or a name the index cut off at its limit) is never confirmed: the original could be one
 * that wasn't compared, so it stays a suggestion.
 */
const BATCH = 100;
const MAX_CANDIDATES = MAX_PER_NAME;

const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export function frontmatter(text: string): { name: string; description: string } {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const name = /^name:[ \t]*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  let description = /^description:[ \t]*(.*(?:\r?\n[ \t]+.+)*)/m.exec(block)?.[1] ?? "";
  if (/^[>|][-+]?[ \t]*\r?\n/.test(description)) description = description.replace(/^[>|][-+]?[ \t]*\r?\n/, "");
  return { name, description: norm(description.replace(/^["']|["']$/g, "")) };
}

/**
 * Words in any script; Chinese and Japanese characters count one each (they aren't spaced into words),
 * so instructions in those languages are compared on their own text, not only the English around them.
 */
const UNSPACED = String.raw`\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}`;
const WORD = new RegExp(String.raw`[${UNSPACED}]|(?:(?![${UNSPACED}])[\p{L}\p{N}\p{M}])+`, "gu");
function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** Too little instruction text (beyond name and description) to tell two skills apart. */
const MIN_BODY_WORDS = 20;
const bodyOf = (text: string) => text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[^\n]*\n?/, "");

function shingles(text: string, size = 5): Set<string> {
  const words_ = words(text);
  const out = new Set<string>();
  for (let i = 0; i + size <= Math.max(size, words_.length); i += 1) out.add(words_.slice(i, i + size).join(" "));
  return out;
}

/**
 * Shared five-word runs over all of them (0 to 1): how much of the instructions' text two versions
 * share. Name and description (the frontmatter) aren't counted: confirmByText weighs those apart.
 */
export function textSimilarity(a: string, b: string): number {
  const left = shingles(bodyOf(a)), right = shingles(bodyOf(b));
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / Math.max(1, left.size + right.size - shared);
}

/** Shares real text: 30% or more of the instructions' five-word runs. */
export const RELATED_SCORE = 0.3;

/**
 * Which candidate the text confirms, or none. Linked only when exactly one same-named library skill
 * shares real text with the copy (30% or more): with an original and its forks both sharing text, a
 * fork that kept an older version can read closest, so those are left for the person to choose. That
 * one is linked when it also has the same name and description, or when 80% or more of the text is
 * the same. On the trial set: 99 right, 1 wrong, 1 unrelated of 147 (name and description alone: 9).
 */
export function confirmByText(
  copy: { name: string; description: string },
  scored: { id: string; score: number; name: string; description: string }[],
): string | null {
  const related = scored.filter((c) => c.score >= RELATED_SCORE);
  if (related.length !== 1) return null;
  const only = related[0];
  const sameNameAndDescription = norm(only.name) === norm(copy.name) && norm(only.description) === norm(copy.description);
  return sameNameAndDescription || only.score >= 0.8 ? only.id : null;
}

export async function computeContentMatches(pool: Pool, deps: ContentMatchDeps): Promise<{ checked: number; confirmed: number }> {
  // Results for versions nobody holds any more (a copy removed or changed on the Mac, a Mac moved to
  // another account) go here; deletes in the portal remove theirs right away.
  await pool.query(`DELETE FROM content_match_results result WHERE ${NOT_HELD}`);
  // Versions of personal copies (and of shared Set copies) whose text we hold, not yet compared
  // against this catalog build. Copies installed through omgskills carry a hint and don't need this.
  const pending = await pool.query<{ sha: string; userId: string; storageKey: string | null }>(
    `
      SELECT DISTINCT ON (blob.blob_sha) blob.blob_sha AS sha, blob.user_id AS "userId", blob.storage_key AS "storageKey"
      FROM cloud_blobs blob
      WHERE blob.blob_sha IN (
          SELECT skill.skill_md_sha FROM synced_skills skill
          WHERE skill.is_current AND skill.skill_md_sha IS NOT NULL AND skill.catalog_skill_id_hint IS NULL
          UNION
          SELECT release.skill_md_sha FROM skill_group_items item
          JOIN skill_sources source ON source.id = item.source_id AND source.kind = 'cloud'
          JOIN skill_releases release ON release.id = item.release_id
        )
        AND NOT EXISTS (SELECT 1 FROM content_match_results result WHERE result.skill_md_sha = blob.blob_sha AND result.catalog_key = $1)
      ORDER BY blob.blob_sha
      LIMIT $2
    `,
    [deps.catalogKey, BATCH],
  );
  let confirmed = 0;
  let checked = 0;
  const now = deps.now ?? Date.now;
  const started = now();
  const texts = new Map<string, Promise<CatalogText & { text: string | null } | null>>();
  const candidateText = (id: string) => {
    let value = texts.get(id);
    if (!value) {
      value = deps.catalogSkill(id).then(async (skill) => skill && { ...skill, text: skill.url ? await deps.fetchText(skill.url) : null });
      // A failure isn't remembered: the next version that needs this skill asks again.
      value.catch(() => texts.delete(id));
      texts.set(id, value);
    }
    return value;
  };
  for (const row of pending.rows) {
    if (now() - started >= (deps.budgetMs ?? 8 * 60_000)) break;
    checked += 1;
    let catalogSkillId: string | null = null;
    let best: number | null = null;
    let related: string[] = [];
    try {
      const text = (await deps.store.get(row.storageKey ?? cloudBlobKey(row.userId, row.sha))).toString("utf8");
      const copy = frontmatter(text);
      const keys = keysFor({ skillMdSha: row.sha, ...copy }).filter((key) => !key.startsWith("sha:"));
      const entries = await deps.readIndex(keys);
      // Most stars first across the same name (the name's list is in star order), then any others.
      const ordered = [...keys].sort((a, b) => Number(b.startsWith("n:")) - Number(a.startsWith("n:")));
      const all = [...new Set(ordered.flatMap((key) => entries[key]?.ids ?? []))];
      const ids = all.slice(0, MAX_CANDIDATES);
      // Every candidate compared, the name's list not cut off, the copy's own instructions long enough.
      let complete = all.length <= MAX_CANDIDATES
        && !keys.some((key) => key.startsWith("n:") && (entries[key]?.ids.length ?? 0) >= MAX_PER_NAME)
        && words(bodyOf(text)).length >= MIN_BODY_WORDS;
      // A candidate that couldn't be read now throws (below), so it's tried again; one that's gone
      // leaves the comparison incomplete. Either way a fork never looks like the only related skill.
      const scored = (await Promise.all(ids.map(async (id) => {
        const skill = await candidateText(id);
        // A candidate whose text is gone or too short to compare could be the original: nothing is confirmed.
        if (!skill?.text || words(bodyOf(skill.text)).length < MIN_BODY_WORDS) { complete = false; return null; }
        return { id, score: textSimilarity(text, skill.text), name: skill.name, description: norm(skill.description) };
      }))).filter((item): item is NonNullable<typeof item> => !!item);
      best = scored.length ? Math.max(...scored.map((item) => item.score)) : null;
      related = scored.filter((item) => item.score >= RELATED_SCORE).sort((a, b) => b.score - a.score).map((item) => item.id);
      catalogSkillId = complete ? confirmByText(copy, scored) : null;
    } catch {
      // Unreadable now (store or GitHub down): tried again next run, nothing stored.
      continue;
    }
    if (catalogSkillId) confirmed += 1;
    // Only while the version is still saved: one deleted during the run leaves nothing behind.
    await pool.query(
      `INSERT INTO content_match_results (skill_md_sha, catalog_key, catalog_skill_id, best_score, related_ids)
       SELECT $1, $2, $3, $4, $5::text[] WHERE EXISTS (SELECT 1 FROM cloud_blobs WHERE blob_sha = $1)
       ON CONFLICT (skill_md_sha) DO UPDATE SET catalog_key = EXCLUDED.catalog_key, catalog_skill_id = EXCLUDED.catalog_skill_id,
         best_score = EXCLUDED.best_score, related_ids = EXCLUDED.related_ids, computed_at = now()`,
      [row.sha, deps.catalogKey, catalogSkillId, best, related],
    );
  }
  return { checked, confirmed };
}

/** What comparing a version's text found: the library skill it confirms, and those it shares real text with (closest first). */
export type TextMatch = { confirmed: string | null; related: string[] };

/** Text results for these SKILL.md versions (any catalog build; a new one recomputes them). */
export async function readTextMatches(pool: Pool, shas: string[]): Promise<Map<string, TextMatch>> {
  if (!shas.length) return new Map();
  const result = await pool.query<{ sha: string; catalogSkillId: string | null; relatedIds: string[] | null }>(
    `SELECT skill_md_sha AS sha, catalog_skill_id AS "catalogSkillId", related_ids AS "relatedIds" FROM content_match_results
     WHERE skill_md_sha = ANY($1::text[])`,
    [shas],
  );
  return new Map(result.rows.map((row) => [row.sha, { confirmed: row.catalogSkillId, related: row.relatedIds ?? [] }]));
}

/**
 * Drops results for SKILL.md versions nobody holds any more (their last copy or saved version was
 * deleted), as scan results are: a deleted private skill leaves nothing behind.
 */
export async function forgetContentMatches(client: { query: Pool["query"] }, skillMdShas: string[]): Promise<void> {
  if (!skillMdShas.length) return;
  await client.query(`DELETE FROM content_match_results result WHERE result.skill_md_sha = ANY($1::text[]) AND ${NOT_HELD}`, [skillMdShas]);
}

/** No current copy on a Mac and no live saved or shared version has this SKILL.md. */
const NOT_HELD = `
  NOT EXISTS (SELECT 1 FROM synced_skills skill WHERE skill.skill_md_sha = result.skill_md_sha AND skill.is_current)
  AND NOT EXISTS (
    SELECT 1 FROM skill_releases release
    JOIN skill_sources source ON source.id = release.source_id
    WHERE release.skill_md_sha = result.skill_md_sha AND source.tombstoned_at IS NULL
  )`;
