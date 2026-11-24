import type { Pool } from "pg";
import { keysFor, type ContentIndexEntry } from "./catalog-content-index.js";
import { cloudBlobKey, type CloudObjectStore } from "./cloud-store.js";

/*
 * Confirms which library skill a personal skill is by comparing its SKILL.md text with same-named
 * library skills, in the background, so page loads only read the result (content_match_results).
 * Rules from the match trial (~/Projects/match-trial-20261124, 2026-11-24, 243 known older versions
 * and 147 skills not in the library): link when the same name and description belong to exactly one
 * library skill AND at least 30% of the text is shared, or when one candidate is at least 80% the same
 * text and 30 points ahead of the next. That linked 101 correctly, 2 to a near-identical fork, and 1 of
 * 147 unrelated (against 9 for name and description alone). Everything else stays a suggestion.
 * Only copies whose text we hold (saved to the owner's cloud, or shared in a Set) are compared.
 */

export type CatalogText = { name: string; description: string; url: string | null };

export type ContentMatchDeps = {
  store: CloudObjectStore;
  readIndex: (keys: string[]) => Promise<Record<string, ContentIndexEntry>>;
  /** A library skill's name, description and where its SKILL.md is (raw URL at the pinned commit). */
  catalogSkill: (catalogSkillId: string) => Promise<CatalogText | null>;
  fetchText: (url: string) => Promise<string | null>;
  /** The catalog build the results are for; a new build recomputes them. */
  catalogKey: string;
};

/** Versions compared per run, and library skills compared per version. */
const BATCH = 100;
const MAX_CANDIDATES = 8;

const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export function frontmatter(text: string): { name: string; description: string } {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const name = /^name:[ \t]*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  let description = /^description:[ \t]*(.*(?:\r?\n[ \t]+.+)*)/m.exec(block)?.[1] ?? "";
  if (/^[>|][-+]?[ \t]*\r?\n/.test(description)) description = description.replace(/^[>|][-+]?[ \t]*\r?\n/, "");
  return { name, description: norm(description.replace(/^["']|["']$/g, "")) };
}

function shingles(text: string, size = 5): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + size <= Math.max(size, words.length); i += 1) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/** Shared five-word runs over all of them (0 to 1): how much of the instructions' text two versions share. */
export function textSimilarity(a: string, b: string): number {
  const left = shingles(a), right = shingles(b);
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / Math.max(1, left.size + right.size - shared);
}

/** The trial's rule: which candidate the text confirms, or none. */
export function confirmByText(
  copy: { name: string; description: string },
  scored: { id: string; score: number; name: string; description: string }[],
): string | null {
  const sameNameAndDescription = scored.filter((c) => norm(c.name) === norm(copy.name) && norm(c.description) === norm(copy.description));
  if (sameNameAndDescription.length === 1 && sameNameAndDescription[0].score >= 0.3) return sameNameAndDescription[0].id;
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  if (ranked[0] && ranked[0].score >= 0.8 && (ranked.length < 2 || ranked[0].score - ranked[1].score >= 0.3)) return ranked[0].id;
  return null;
}

export async function computeContentMatches(pool: Pool, deps: ContentMatchDeps): Promise<{ checked: number; confirmed: number }> {
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
  const texts = new Map<string, Promise<CatalogText & { text: string | null } | null>>();
  const candidateText = (id: string) => {
    let value = texts.get(id);
    if (!value) {
      value = deps.catalogSkill(id).then(async (skill) => skill && { ...skill, text: skill.url ? await deps.fetchText(skill.url) : null });
      texts.set(id, value);
    }
    return value;
  };
  for (const row of pending.rows) {
    let catalogSkillId: string | null = null;
    let best: number | null = null;
    try {
      const text = (await deps.store.get(row.storageKey ?? cloudBlobKey(row.userId, row.sha))).toString("utf8");
      const copy = frontmatter(text);
      const keys = keysFor({ skillMdSha: row.sha, ...copy }).filter((key) => !key.startsWith("sha:"));
      const entries = await deps.readIndex(keys);
      const ids = [...new Set(keys.flatMap((key) => entries[key]?.ids ?? []))].slice(0, MAX_CANDIDATES);
      const scored = (await Promise.all(ids.map(async (id) => {
        const skill = await candidateText(id);
        return skill?.text ? { id, score: textSimilarity(text, skill.text), name: skill.name, description: norm(skill.description) } : null;
      }))).filter((item): item is NonNullable<typeof item> => !!item);
      best = scored.length ? Math.max(...scored.map((item) => item.score)) : null;
      catalogSkillId = confirmByText(copy, scored);
    } catch {
      // Unreadable now (store or GitHub down): tried again next run, nothing stored.
      continue;
    }
    if (catalogSkillId) confirmed += 1;
    await pool.query(
      `INSERT INTO content_match_results (skill_md_sha, catalog_key, catalog_skill_id, best_score) VALUES ($1, $2, $3, $4)
       ON CONFLICT (skill_md_sha) DO UPDATE SET catalog_key = EXCLUDED.catalog_key, catalog_skill_id = EXCLUDED.catalog_skill_id,
         best_score = EXCLUDED.best_score, computed_at = now()`,
      [row.sha, deps.catalogKey, catalogSkillId, best],
    );
  }
  return { checked: pending.rows.length, confirmed };
}

/** Confirmed library skills for these SKILL.md versions (any catalog build; a new one recomputes them). */
export async function readConfirmedMatches(pool: Pool, shas: string[]): Promise<Map<string, string>> {
  if (!shas.length) return new Map();
  const result = await pool.query<{ sha: string; catalogSkillId: string }>(
    `SELECT skill_md_sha AS sha, catalog_skill_id AS "catalogSkillId" FROM content_match_results
     WHERE skill_md_sha = ANY($1::text[]) AND catalog_skill_id IS NOT NULL`,
    [shas],
  );
  return new Map(result.rows.map((row) => [row.sha, row.catalogSkillId]));
}
