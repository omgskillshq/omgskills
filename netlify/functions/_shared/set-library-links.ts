import type { Pool } from "pg";
import { keysFor, resolveCopy, type ContentIndexEntry } from "./catalog-content-index.js";
import { appendSkillRelease, incrementGroupRevision, lockGroupForMutation, upsertPublicSkillSource } from "./group-storage.js";
import type { PreparedPublicRelease } from "./public-releases.js";

/*
 * A Set item shared from someone's My skills holds their saved copy, pinned to a version. Once that
 * version is recognized as a library skill (by the same content index and choices My skills uses),
 * the item becomes that library skill, pinned to the library's current release exactly as adding the
 * library skill would, so members can install it and it shows as a library skill. Run hourly by
 * catalog-index-background, a slice of the Set items at a time.
 */

type Candidate = {
  itemId: string; groupId: string; ownerUserId: string; releaseId: string;
  name: string | null; description: string | null; itemSha: string;
};

export type SetLinkResult = { checked: number; linked: number; skipped: number; cursor: string | null };

export type SetLinkDeps = {
  readIndex: (keys: string[]) => Promise<Record<string, ContentIndexEntry>>;
  /** The library skill's current release, as a catalog add pins it; throws when it can't be resolved. */
  resolveRelease: (catalogSkillId: string) => Promise<PreparedPublicRelease>;
  /** Where the last run stopped (item id), so every item gets checked in turn. */
  cursor: string | null;
};

/** Items checked per run; the next run carries on after the last one, then starts over. */
const BATCH = 500;
/** Most items switched per run (each resolves the library release). */
const MAX_SWITCHES = 50;

export async function linkSetItemsToLibrary(pool: Pool, deps: SetLinkDeps): Promise<SetLinkResult> {
  const candidates = await pool.query<Candidate>(
    `
      SELECT item.id AS "itemId", item.group_id AS "groupId", source.owner_user_id AS "ownerUserId",
        item.release_id AS "releaseId",
        COALESCE(NULLIF(btrim(item.name), ''), saved.skill_name) AS name,
        COALESCE(NULLIF(btrim(item.description), ''), saved.skill_description) AS description,
        release.skill_md_sha AS "itemSha"
      FROM skill_group_items item
      JOIN skill_sources source ON source.id = item.source_id AND source.kind = 'cloud'
      JOIN skill_releases release ON release.id = item.release_id
      LEFT JOIN cloud_saved_skills saved ON saved.source_id = source.id
      WHERE $1::uuid IS NULL OR item.id > $1::uuid
      ORDER BY item.id
      LIMIT $2
    `,
    [deps.cursor, BATCH],
  );
  const rows = candidates.rows;
  // A full batch: carry on after it next time; a short one: the end was reached, start over.
  const result: SetLinkResult = { checked: rows.length, linked: 0, skipped: 0, cursor: rows.length === BATCH ? rows[rows.length - 1].itemId : null };
  if (!rows.length) return result;
  // Only the version the Set holds counts: a newer saved version the owner hasn't put in the Set doesn't.
  const copyOf = (row: Candidate) => ({ skillMdSha: row.itemSha, name: row.name, description: row.description });
  const index = await deps.readIndex([...new Set(rows.flatMap((row) => keysFor(copyOf(row))))]);
  const choiceRows = await pool.query<{ userId: string; matchKey: string; catalogSkillId: string | null }>(
    `SELECT user_id AS "userId", match_key AS "matchKey", catalog_skill_id AS "catalogSkillId"
     FROM skill_link_choices WHERE user_id = ANY($1::uuid[])`,
    [[...new Set(rows.map((row) => row.ownerUserId))]],
  );
  const choicesBy = new Map<string, Map<string, string | null>>();
  for (const row of choiceRows.rows) {
    const map = choicesBy.get(row.userId) ?? new Map<string, string | null>();
    map.set(row.matchKey, row.catalogSkillId);
    choicesBy.set(row.userId, map);
  }
  for (const row of rows) {
    if (result.linked + result.skipped >= MAX_SWITCHES) break;
    const resolved = resolveCopy(copyOf(row), index, choicesBy.get(row.ownerUserId));
    if (!resolved || !("catalogSkillId" in resolved)) continue;
    let release: PreparedPublicRelease;
    try {
      release = await deps.resolveRelease(resolved.catalogSkillId);
    } catch {
      result.skipped += 1;
      continue;
    }
    if (await switchToLibrary(pool, row, resolved.catalogSkillId, release)) result.linked += 1;
    else result.skipped += 1;
  }
  return result;
}

/**
 * Turns one shared copy into the library skill, pinned to its release, unless the Set already lists
 * that skill or the item changed since it was read. Its note and description were written while the
 * public couldn't see them, so they're cleared; the library's own description shows instead.
 */
async function switchToLibrary(pool: Pool, row: Candidate, catalogSkillId: string, release: PreparedPublicRelease): Promise<boolean> {
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
    const sourceId = await upsertPublicSkillSource(client, release.source);
    const releaseId = await appendSkillRelease(client, { sourceId, ...release.coordinates, createdBy: release.createdBy });
    const moved = await client.query(
      `
        UPDATE skill_group_items
        SET kind = 'catalog', catalog_skill_id = $3, synced_skill_id = NULL, github_url = NULL,
          description = NULL, note = NULL, source_id = $5, release_id = $6, metadata_only_reason = NULL
        WHERE id = $1 AND group_id = $2 AND release_id = $4
      `,
      [row.itemId, row.groupId, catalogSkillId, row.releaseId, sourceId, releaseId],
    );
    if (!moved.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    await incrementGroupRevision(client, row.groupId);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
