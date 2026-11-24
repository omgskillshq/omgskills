import type { Pool } from "pg";
import { keysFor, resolveCopy, type ContentIndexEntry } from "./catalog-content-index.js";
import { incrementGroupRevision, lockGroupForMutation } from "./group-storage.js";

/*
 * A Set item shared from someone's My skills holds their saved copy, pinned to a version. Once that
 * copy is recognized as a library skill (by the same content index and choices My skills uses), the
 * item follows the library instead: it becomes that library skill, so it stays up to date and shows
 * as a library skill. Run hourly by catalog-index-background.
 */

type Candidate = {
  itemId: string; groupId: string; ownerUserId: string;
  name: string | null; description: string | null;
  itemSha: string; currentSha: string | null;
};

export type SetLinkResult = { checked: number; linked: number; skipped: number };

/** Most items switched in one run, so a large first pass is spread over a few hours. */
const MAX_PER_RUN = 500;

export async function linkSetItemsToLibrary(
  pool: Pool,
  readIndex: (keys: string[]) => Promise<Record<string, ContentIndexEntry>>,
): Promise<SetLinkResult> {
  const candidates = await pool.query<Candidate>(
    `
      SELECT item.id AS "itemId", item.group_id AS "groupId", source.owner_user_id AS "ownerUserId",
        COALESCE(NULLIF(btrim(item.name), ''), saved.skill_name) AS name,
        COALESCE(NULLIF(btrim(item.description), ''), saved.skill_description) AS description,
        release.skill_md_sha AS "itemSha", current.skill_md_sha AS "currentSha"
      FROM skill_group_items item
      JOIN skill_sources source ON source.id = item.source_id AND source.kind = 'cloud'
      JOIN skill_releases release ON release.id = item.release_id
      LEFT JOIN cloud_saved_skills saved ON saved.source_id = source.id
      LEFT JOIN skill_releases current ON current.id = saved.current_release_id
      ORDER BY item.created_at
      LIMIT $1
    `,
    [MAX_PER_RUN * 4],
  );
  const result: SetLinkResult = { checked: candidates.rows.length, linked: 0, skipped: 0 };
  if (!candidates.rows.length) return result;
  // A copy matches by the version the Set holds, or by the owner's newest saved version (what My skills shows).
  const copiesOf = (row: Candidate) => [...new Set([row.itemSha, row.currentSha].filter((sha): sha is string => !!sha))]
    .map((skillMdSha) => ({ skillMdSha, name: row.name, description: row.description }));
  const keys = [...new Set(candidates.rows.flatMap((row) => copiesOf(row).flatMap((copy) => keysFor(copy))))];
  const index = await readIndex(keys);
  const owners = [...new Set(candidates.rows.map((row) => row.ownerUserId))];
  const choiceRows = await pool.query<{ userId: string; matchKey: string; catalogSkillId: string | null }>(
    `SELECT user_id AS "userId", match_key AS "matchKey", catalog_skill_id AS "catalogSkillId"
     FROM skill_link_choices WHERE user_id = ANY($1::uuid[])`,
    [owners],
  );
  const choicesBy = new Map<string, Map<string, string | null>>();
  for (const row of choiceRows.rows) {
    const map = choicesBy.get(row.userId) ?? new Map<string, string | null>();
    map.set(row.matchKey, row.catalogSkillId);
    choicesBy.set(row.userId, map);
  }
  for (const row of candidates.rows) {
    if (result.linked >= MAX_PER_RUN) break;
    let catalogSkillId: string | null = null;
    for (const copy of copiesOf(row)) {
      const resolved = resolveCopy(copy, index, choicesBy.get(row.ownerUserId));
      if (resolved && "catalogSkillId" in resolved) { catalogSkillId = resolved.catalogSkillId; break; }
    }
    if (!catalogSkillId) continue;
    if (await switchToLibrary(pool, row, catalogSkillId)) result.linked += 1;
    else result.skipped += 1;
  }
  return result;
}

/** Turns one shared copy into the library skill, unless the Set already lists that library skill. */
async function switchToLibrary(pool: Pool, row: Candidate, catalogSkillId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockGroupForMutation(client, row.groupId);
    const duplicate = await client.query(
      "SELECT 1 FROM skill_group_items WHERE group_id = $1 AND kind = 'catalog' AND catalog_skill_id = $2 AND id <> $3",
      [row.groupId, catalogSkillId, row.itemId],
    );
    if (duplicate.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    const moved = await client.query(
      `
        UPDATE skill_group_items
        SET kind = 'catalog', catalog_skill_id = $3, synced_skill_id = NULL,
          source_id = NULL, release_id = NULL, metadata_only_reason = NULL
        WHERE id = $1 AND group_id = $2 AND source_id IS NOT NULL
      `,
      [row.itemId, row.groupId, catalogSkillId],
    );
    if (moved.rowCount) await incrementGroupRevision(client, row.groupId);
    await client.query("COMMIT");
    return Boolean(moved.rowCount);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
