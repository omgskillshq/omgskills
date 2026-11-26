import type { Pool } from "pg";
import { listUserDevices } from "./device-auth.js";
import { cloudSkillKeys } from "./cloud-skill-keys.js";
import { readCloudRecordNames } from "./cloud-save.js";
import { verifiedCatalogHint } from "./github-skill-resolution.js";
import { isIncompleteRead, keysFor, linkChoiceOf, nameKey, readBlobContentIndex, resolveCopy, type ContentIndexEntry, type LinkChoice } from "./catalog-content-index.js";
import { readTextMatches, type TextMatch } from "./content-match.js";
import { withTimeout } from "./http.js";
import { loadCatalogHintIdentity, type PublishedCatalogIdentity } from "./published-catalog.js";
import { installationFolderFromKey } from "./sync-skill.js";
import type { RootCoverage } from "./inventory-reconciliation.js";
import { readLegacySyncInventory } from "./sync-inventory.js";

export function inventoryReadVersion(req: Request, allowReconciliation = false): 1 | 2 | 3 {
  const url = new URL(req.url);
  const versions = url.searchParams.getAll("version");
  if (!versions.length || (versions.length === 1 && versions[0] === "1")) return 1;
  if (allowReconciliation && versions.length === 1 && versions[0] === "3" && url.search === "?version=3") return 3;
  if (versions.length !== 1 || versions[0] !== "2") {
    throw new Response("Unsupported inventory version", { status: 400 });
  }
  return 2;
}

export async function readSyncInventory(
  pool: Pool,
  userId: string,
  version: 1 | 2 | 3,
  now = new Date(),
  loadCatalogIdentity: (hintIds: string[]) => Promise<PublishedCatalogIdentity> = loadCatalogHintIdentity,
  readContentIndex: (keys: string[]) => Promise<Record<string, ContentIndexEntry>> = readBlobContentIndex,
) {
  if (version === 1) {
    const { skills } = await readLegacySyncInventory(pool, userId);
    return { skills };
  }
  const result = await pool.query(
    `SELECT id, stable_key AS "stableKey", skill_md_sha AS "skillMdSha",
       identity_status AS "identityStatus", name, description,
       catalog_skill_id AS "catalogSkillId", github_url AS "githubUrl",
       is_local_only AS "isLocalOnly", source, is_current AS "isCurrent",
       last_seen_at AS "lastSeenAt"
       , device_id AS "deviceId", git_relative_path AS "gitRelativePath", catalog_skill_id_hint AS "catalogSkillIdHint"
       , to_jsonb(skill)->>'installed_from_set' AS "installedFromSet"
     FROM synced_skills skill
     WHERE user_id = $1 ${version === 3 ? "" : "AND is_current = true"}
       -- A disconnected Mac's rows stay for a same-account reconnect, but are hidden.
       AND NOT EXISTS (SELECT 1 FROM device_tokens device
         WHERE device.id = skill.device_id AND device.revoked_at IS NOT NULL)
     ORDER BY lower(name), source, id`,
    [userId]
  );

  const skills = result.rows.map(({ stableKey, ...row }) => ({
    ...row,
    installationFolder: installationFolderFromKey(stableKey, row.source),
    // Historical uploads accepted arbitrary URLs. Do not repeat credentials.
    githubUrl: safeRepositoryUrl(row.githubUrl)
  }));
  // The cloud save record each copy uses; same-name folders holding different skills are saved apart.
  const records = await readCloudRecordNames(pool, userId);
  const sources = new Map(records.flatMap((record) => record.githubSource ? [[record.key, record.githubSource] as const] : []));
  for (const [skill, cloudKey] of cloudSkillKeys(skills, records)) Object.assign(skill, { cloudKey });
  // Presence reports store the Mac's catalog hint unverified; link the rows it proves.
  // Copies with no hint (installed from GitHub directly) are matched by the prebuilt content index:
  // the exact SKILL.md first, then the same name and description (another version of a library
  // skill, possibly edited). The two lookups run apart, so a slow one never costs the other.
  const hinted = skills.filter((skill) => !skill.catalogSkillId && skill.catalogSkillIdHint && skill.skillMdSha);
  const unhinted = skills.filter((skill) => !skill.catalogSkillId && !skill.catalogSkillIdHint);
  const keys = [...new Set(unhinted.flatMap((skill) => keysFor(skill)))];
  // A lookup that failed or timed out: its copies may be library skills, so none is offered "Make it mine".
  let hintFailed = false, indexFailed = false;
  const [hintIdentity, index] = await Promise.all([
    hinted.length
      ? withTimeout(loadCatalogIdentity(hinted.map((skill) => skill.catalogSkillIdHint as string)), 4_000).catch(() => { hintFailed = true; return null; })
      : null,
    keys.length ? withTimeout(readContentIndex(keys), 3_000).catch(() => { indexFailed = true; return {}; }) : {},
  ]);
  // An index not built yet (a partition missing) is no answer either.
  if (isIncompleteRead(index)) indexFailed = true;
  for (const skill of hinted) {
    const catalogSkillId = verifiedCatalogHint(skill.catalogSkillIdHint, skill.skillMdSha, hintIdentity);
    if (catalogSkillId) Object.assign(skill, { catalogSkillId, identityStatus: "resolved", isLocalOnly: false });
  }
  // A person's own choices between library skills sharing a copy's content (see skill_link_choices).
  // Read whenever a copy is unlinked: "It's my own" also applies to a skill with no library match.
  const choices = skills.some((skill) => !skill.catalogSkillId) ? await readLinkChoices(pool, userId) : new Map<string, LinkChoice>();
  // What the background job found comparing these versions' text.
  const byText = unhinted.length && Object.keys(index).length
    ? await readTextMatches(pool, [...new Set(unhinted.flatMap((skill) => skill.skillMdSha ? [skill.skillMdSha as string] : []))])
    : new Map<string, TextMatch>();
  for (const skill of unhinted) {
    const text = skill.skillMdSha ? byText.get(skill.skillMdSha as string) : undefined;
    const resolved = resolveCopy(skill, index, choices, text?.confirmed, text?.related);
    if (resolved && "catalogSkillId" in resolved) {
      Object.assign(skill, { catalogSkillId: resolved.catalogSkillId, identityStatus: "resolved", isLocalOnly: false });
    } else if (resolved && "own" in resolved) {
      // The person said "It's my own": their name shows as its creator.
      Object.assign(skill, { markedOwn: true });
    } else if (resolved) {
      // Several library skills have this content: the person picks (most stars first).
      Object.assign(skill, { catalogMatchKey: resolved.matchKey, catalogCandidates: resolved.candidates, catalogNameKey: resolved.nameKey, catalogAlsoByName: resolved.alsoByName });
    }
  }
  // Added on the web from GitHub, then installed by the app (no git remote of its own, not a library or
  // Set install): the repo it came from, so it shows its creator, link and stars. Applied after matching,
  // so it never decides a link (nor overrides the person's own choice).
  for (const skill of skills) {
    const source = typeof skill.cloudKey === "string" ? sources.get(skill.cloudKey) : undefined;
    if (!source || skill.githubUrl || skill.catalogSkillId || skill.catalogSkillIdHint || skill.installedFromSet) continue;
    Object.assign(skill, { githubUrl: `https://github.com/${source.repo}`, gitRelativePath: source.folder || null,
      ...(source.stars !== undefined ? { githubStars: source.stars } : {}) });
  }
  const offeredNames = new Set(skills.flatMap((skill) => "catalogMatchKey" in skill && typeof skill.name === "string"
    ? [nameKey(skill.name)].filter((key): key is string => !!key) : []));
  // Still unknown (no library skill, nothing to choose from): "It's my own" said for any of its keys
  // marks it the person's; otherwise its name is the key to say so with ("Make it mine" under "Unavailable").
  for (const skill of skills) {
    if (skill.catalogSkillId || "catalogMatchKey" in skill || "markedOwn" in skill) continue;
    if (keysFor(skill).some((key) => choices.has(key) && choices.get(key) === null)) {
      Object.assign(skill, { markedOwn: true });
      continue;
    }
    if (skill.catalogSkillIdHint ? hintFailed : indexFailed) continue;
    const key = typeof skill.name === "string" ? nameKey(skill.name) : null;
    // A same-name copy (shown as one skill) asks which library skill it is: that's answered first.
    if (key && !offeredNames.has(key)) Object.assign(skill, { catalogOwnKey: key });
  }
  const devices = await listUserDevices(pool, userId, now);
  const reports = await pool.query<{ deviceId: string; lastReportedAt: Date | null; scanCoverage?: RootCoverage[] | null }>(
    version === 3
      ? `SELECT DISTINCT ON (device_id) device_id AS "deviceId", completed_at AS "lastReportedAt",
           scan_coverage AS "scanCoverage"
         FROM sync_runs WHERE user_id = $1 AND device_id IS NOT NULL AND status = 'completed'
         ORDER BY device_id, completed_at DESC NULLS LAST, started_at DESC, id DESC`
      : `SELECT device_id AS "deviceId", max(completed_at) AS "lastReportedAt"
     FROM sync_runs WHERE user_id = $1 AND device_id IS NOT NULL AND status = 'completed'
     GROUP BY device_id`,
    [userId]
  );
  const lastReports = new Map(reports.rows.map((row) => [row.deviceId, row]));
  const checks = version === 3 ? await pool.query<{ id: string; checkedAt: Date | null; appBuild: number | null }>(
    'SELECT id, inventory_checked_at AS "checkedAt", app_build AS "appBuild" FROM device_tokens WHERE user_id=$1', [userId]
  ) : null;
  const lastChecks = new Map(checks?.rows.map(row => [row.id, row]));
  return {
    inventoryVersion: version,
    skills,
    devices: devices.map((device) => ({
      id: device.id,
      deviceName: device.deviceName,
      status: device.status,
      lastReportedAt: lastReports.get(device.id)?.lastReportedAt ?? null,
      ...(version === 3 ? { scanCoverage: lastReports.get(device.id)?.scanCoverage ?? null,
        lastCheckedAt: lastChecks.get(device.id)?.checkedAt ?? null, appBuild: lastChecks.get(device.id)?.appBuild ?? null } : {})
    }))
  };
}

function safeRepositoryUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port
      || !/^\/[a-z0-9-]+\/[a-z0-9_.-]+\/?$/i.test(url.pathname)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

async function readLinkChoices(pool: Pool, userId: string): Promise<Map<string, LinkChoice>> {
  const result = await pool.query<{ matchKey: string; catalogSkillId: string | null; noneOf: string[] | null }>(
    'SELECT match_key AS "matchKey", catalog_skill_id AS "catalogSkillId", none_of AS "noneOf" FROM skill_link_choices WHERE user_id = $1',
    [userId],
  );
  return new Map(result.rows.map((row) => [row.matchKey, linkChoiceOf(row)]));
}
