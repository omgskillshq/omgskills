// The counts every screen shows (web Sync line, the Mac's menu), worked out once on the server with the same
// code the web uses (portal/src/cloud-save/cloud-rows.ts), so the screens can't disagree.
import type { Pool } from "pg";
import type { SyncedSkill } from "../../../portal/src/synced-skill-grouping.js";
import {
  cloudCounts,
  cloudSkillRows,
  installationCloudKey,
  isLiveCopy,
  type CloudSummary,
} from "../../../portal/src/cloud-save/cloud-rows.js";
import type { CloudSaveState } from "./cloud-save.js";
import { withTimeout } from "./http.js";
import { buildMySkills } from "./my-skills-library.js";
import { readSyncInventory } from "./sync-inventory-read.js";

export type CloudSummaryInputs = { inventory: SyncedSkill[]; additions: string[] };

/** What the counts need besides cloud save: what the Macs have now, and library skills added to My skills. */
export async function readCloudSummaryInputs(pool: Pool, userId: string): Promise<CloudSummaryInputs> {
  const [inventory, additions] = await Promise.all([
    readSyncInventory(pool, userId, 3).then((read) => read.skills as unknown as SyncedSkill[]),
    pool.query<{ id: string }>("SELECT catalog_skill_id AS id FROM my_skill_additions WHERE user_id = $1", [userId])
      .then((result) => result.rows.map((row) => row.id)),
  ]);
  return { inventory, additions };
}

/** Best effort: a slow read leaves the counts out (the screens then count as before) rather than failing the state. */
export function readCloudSummaryInputsSoon(pool: Pool, userId: string, timeoutMs = 6_000): Promise<CloudSummaryInputs | null> {
  return withTimeout(readCloudSummaryInputs(pool, userId), timeoutMs).catch(() => null);
}

/** The counts, and for a Mac asking, how many skills it has now. */
export function cloudSummary(state: CloudSaveState, inputs: CloudSummaryInputs, deviceId: string | null, now = Date.now()): CloudSummary {
  const rows = cloudSkillRows(state, inputs.inventory, now);
  const mySkills = buildMySkills({ inventory: inputs.inventory, cloud: state, additions: inputs.additions, now }).count;
  const here = deviceId
    ? new Set(inputs.inventory.filter((copy) => copy.deviceId === deviceId && isLiveCopy(copy, now)).map(installationCloudKey)).size
    : undefined;
  return { ...cloudCounts(rows), mySkills, ...(here !== undefined ? { onThisMac: here } : {}) };
}
