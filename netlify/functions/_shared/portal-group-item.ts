import type { Pool } from "pg";
import { scanSummarySql, type CloudScanSummary } from "./cloud-save.js";
import type { GroupAccessRole } from "./group-access.js";

export type PortalGroupItemRow = {
  id: string;
  kind: string;
  syncedSkillId: string | null;
  catalogSkillId: string | null;
  itemGithubUrl: string | null;
  snapshotName: string | null;
  snapshotDescription: string | null;
  note: string | null;
  position: number;
  skillName: string | null;
  skillDescription: string | null;
  githubUrl: string | null;
  source: string | null;
  sourceKind?: string | null;
  metadataOnlyReason?: string | null;
  releaseId?: string | null;
  /** The owner's newest saved version, for owners only. */
  savedReleaseId?: string | null;
  /** Owner only: the cloud save key of the item's saved skill, so My skills can tell it's in the Set. */
  savedKey?: string | null;
  /** The Set's owner owns the item's source (false in a duplicated Set). */
  sharedByOwner?: boolean | null;
  /** The background scan of the shared version; null before its first scan. Private items only. */
  scan?: CloudScanSummary | null;
};

export function portalGroupItem(row: PortalGroupItemRow, role: GroupAccessRole) {
  const shared = role !== "public" && (row.sourceKind === "cloud" || row.sourceKind === "private_github") && !!row.releaseId
    && !row.metadataOnlyReason && row.sharedByOwner === true;
  const publicCloudItem = role === "public" && (row.sourceKind === "cloud"
    || row.metadataOnlyReason === "cloud_deleted"
    || row.metadataOnlyReason === "cloud_confirmed_secret"
    || row.metadataOnlyReason === "synced_local_only");
  return {
    id: row.id,
    kind: row.kind,
    ...(role === "owner" ? { syncedSkillId: row.kind === "synced" ? row.syncedSkillId ?? null : null } : {}),
    ...(role === "owner" ? { catalogSkillId: row.kind === "catalog" ? row.catalogSkillId ?? null : null } : {}),
    name: row.skillName || row.snapshotName || row.catalogSkillId || row.itemGithubUrl || "Skill",
    description: publicCloudItem ? "" : row.skillDescription || row.snapshotDescription || row.note || "",
    githubUrl: publicCloudItem ? null : row.githubUrl || row.itemGithubUrl || null,
    source: publicCloudItem ? row.kind : row.source || row.kind,
    position: row.position,
    // Shared from the owner's cloud save; the owner also learns when a newer version is saved.
    ...(row.sourceKind === "cloud" && role !== "public" ? { cloudShared: true } : {}),
    // Only for the owner's own saved skill: a duplicated Set's item is someone else's.
    ...(role === "owner" && row.sourceKind === "cloud" && row.savedKey && row.sharedByOwner === true ? { cloudKey: row.savedKey } : {}),
    // Invitees and the owner can read a private item's instructions on the web (same check as the download).
    ...(shared ? { sharedReleaseId: row.releaseId } : {}),
    // What the background scan found in that version, so people see it before they install: file and line, never the text.
    ...(shared ? { scan: row.scan ?? null } : {}),
    ...(role === "owner" && row.sourceKind === "cloud" && row.savedReleaseId && row.savedReleaseId !== row.releaseId
      ? { updateAvailable: true } : {}),
  };
}

type Queryable = Pick<Pool, "query">;

/** A Set's items as the role reading them may see them, in order. */
export async function readPortalGroupItems(db: Queryable, groupId: string, role: GroupAccessRole) {
  const result = await db.query<PortalGroupItemRow>(
    `
      SELECT
        i.id,
        i.kind,
        CASE WHEN $2 = 'owner' THEN i.synced_skill_id ELSE NULL END AS "syncedSkillId",
        i.catalog_skill_id AS "catalogSkillId",
        i.github_url AS "itemGithubUrl",
        i.name AS "snapshotName",
        i.description AS "snapshotDescription",
        i.note,
        i.position,
        s.name AS "skillName",
        s.description AS "skillDescription",
        s.github_url AS "githubUrl",
        s.source,
        src.kind AS "sourceKind",
        i.metadata_only_reason AS "metadataOnlyReason",
        i.release_id AS "releaseId",
        -- A duplicated Set holds someone else's version, which only that person's Sets can share.
        (src.owner_user_id = (SELECT owner_user_id FROM skill_groups WHERE id = $1)) AS "sharedByOwner",
        CASE WHEN $2 = 'owner' THEN saved.current_release_id ELSE NULL END AS "savedReleaseId",
        CASE WHEN $2 = 'owner' THEN saved.skill_key ELSE NULL END AS "savedKey",
        -- The background scan of the version people install, for private items only (public ones aren't scanned yet).
        CASE WHEN $2 <> 'public' AND src.kind IN ('cloud', 'private_github') AND i.metadata_only_reason IS NULL
          THEN ${scanSummarySql("release.tree_sha")} END AS scan
      FROM skill_group_items i
      LEFT JOIN synced_skills s ON s.id = i.synced_skill_id
      LEFT JOIN skill_sources src ON src.id = i.source_id
      LEFT JOIN cloud_saved_skills saved ON saved.source_id = i.source_id
      LEFT JOIN skill_releases release ON release.id = i.release_id
      WHERE i.group_id = $1
      ORDER BY i.position ASC
    `,
    [groupId, role]
  );
  return result.rows.map((row) => portalGroupItem(row, role));
}
