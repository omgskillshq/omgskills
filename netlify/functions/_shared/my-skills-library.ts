// My skills, built on the server for one user: the same list and count the web builds in the browser
// (portal/src/app/unified/model.ts and cloud-save/cloud-save.ts), plus what an agent may read of each skill.
// Agents reach it through the library MCP; nothing here returns skill contents.
import {
  groupSyncedSkills,
  hasCatalogId,
  type GroupedSyncedSkill,
  type SyncedSkill,
} from "../../../portal/src/synced-skill-grouping.js";
import type { CloudSaveState } from "./cloud-save.js";
import {
  cloudSkillKey,
  cloudSkillRows,
  installationCloudKey,
  isLiveCopy,
  needsAttention,
  statusOrder,
  type CloudSkillRow,
  type CloudSkillStatus,
} from "../../../portal/src/cloud-save/cloud-rows.js";

export type LibraryCloudStatus = CloudSkillStatus;

/** Where an agent's read of a skill comes from: the account's saved copy, or the public library version. */
export type LibraryReadSource = "saved" | "public";

export type LibrarySkill = {
  /** Stable within the account: `lib:<catalog id>` for library skills, `key:<folder key>` for your own. */
  id: string;
  name: string;
  description: string;
  author: string;
  catalogId: string | null;
  githubUrl: string | null;
  origin: "personal" | "library" | "set";
  /** On one of your Macs now. */
  installed: boolean;
  /** The saved copy's folder key, when the account keeps one. */
  savedKey: string | null;
  status: LibraryCloudStatus | null;
  available: boolean;
  source: LibraryReadSource | null;
  /** Why it can't be read, when it can't. */
  reason: string | null;
};

export type MySkillsLibrary = {
  skills: LibrarySkill[];
  /** The web's My skills count. */
  count: number;
  notInstalledCount: number;
};

export type CatalogDetails = { name?: string; description?: string; author?: string; githubUrl?: string | null };

export type MySkillsInputs = {
  inventory: SyncedSkill[];
  /** Null when cloud save couldn't be read; the web then counts it as empty. */
  cloud: CloudSaveState | null;
  /** Added library skills, by catalog ID. */
  additions: string[];
  /** Library details by catalog ID, for names and authors; missing entries fall back to the ID. */
  catalog?: Map<string, CatalogDetails>;
  now?: number;
};

/** The folder key cloud save uses (same as the web and the Mac). */
export { cloudSkillKey };

const copyKey = (copy: SyncedSkill) => installationCloudKey(copy);
const isLive = (copy: SyncedSkill, now: number) => isLiveCopy(copy, now);

function catalogOwner(id: string | null | undefined) {
  const owner = id?.split("/")[0] ?? "";
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(owner) && id!.includes("/") ? owner : "";
}

function keysOf(copies: SyncedSkill[]) {
  return [...new Set(copies.map(copyKey))];
}

type CloudRow = CloudSkillRow & { confirmedSecret: boolean };

/** One row per folder key: the web's own rows (cloud-rows.ts), so agents see what the web shows. */
function cloudRows(state: CloudSaveState, installed: SyncedSkill[], now: number): Map<string, CloudRow> {
  return new Map(cloudSkillRows(state, installed, now).map((row): [string, CloudRow] =>
    [row.key, { ...row, confirmedSecret: row.labels.includes("confirmed_secret") }]));
}

/** The status a skill with copies in several folders shows: the one that needs attention first. */
function pickRow(rows: Map<string, CloudRow>, keys: string[]): CloudRow | null {
  let best: CloudRow | null = null;
  const rank = (row: CloudRow) => (needsAttention(row.status) ? 0 : 100) + statusOrder[row.status];
  for (const key of keys) {
    const row = rows.get(key);
    if (row && (!best || rank(row) < rank(best))) best = row;
  }
  return best;
}

const reasons: Partial<Record<LibraryCloudStatus, string>> = {
  review: "A file may contain a key or password; review it on the web.",
  confirmed: "A file contains a key or password, so it is never shared with agents.",
  failed: "It couldn't be synced.",
  links: "It contains links outside the skill, so it couldn't be synced.",
  too_large: "It's too large to sync.",
  unreadable: "It couldn't be read on your Mac.",
};

/**
 * What an agent may read. Locked skills (anything needing attention, or a saved key or password) never are.
 * Your saved copy comes first; a library skill without one reads its public version. A personal skill with no
 * saved copy is only on your Mac.
 */
const isLocked = (row: CloudRow) => needsAttention(row.status) || row.status === "confirmed" || row.confirmedSecret;

function access(row: CloudRow | null, catalogId: string | null, saved: boolean, locked: CloudRow | null = null):
  Pick<LibrarySkill, "available" | "source" | "reason"> {
  // Any copy that is locked locks the skill, even when another folder's copy looks fine.
  const lock = locked ?? (row && isLocked(row) ? row : null);
  if (lock) {
    return { available: false, source: null, reason: reasons[lock.confirmedSecret ? "confirmed" : lock.status] ?? "It needs a look on the web." };
  }
  if (saved && row?.status !== "excluded") return { available: true, source: "saved", reason: null };
  if (catalogId) return { available: true, source: "public", reason: null };
  if (row?.status === "excluded") return { available: false, source: null, reason: "It's left out of sync, so it's only on your Mac." };
  return { available: false, source: null, reason: "It's only on your Mac (not synced)." };
}

function originOf(catalogId: string | null, copies: SyncedSkill[]): LibrarySkill["origin"] {
  if (catalogId) return "library";
  return copies.some(copy => copy.installedFromSet) ? "set" : "personal";
}

export function buildMySkills(input: MySkillsInputs): MySkillsLibrary {
  const now = input.now ?? Date.now();
  const catalog = input.catalog ?? new Map<string, CatalogDetails>();
  const grouped = groupSyncedSkills(input.inventory, { groupInstallations: true });
  // Skills some Mac has now, with only their live copies (the web's liveMine).
  const mine = grouped.map(skill => ({ skill, live: skill.sourceSkills.filter(copy => isLive(copy, now)) }))
    .filter(entry => entry.live.length > 0);
  const rows = input.cloud ? cloudRows(input.cloud, input.inventory, now) : new Map<string, CloudRow>();

  const installedSkills: LibrarySkill[] = mine.map(({ skill, live }) => {
    const catalogId = skill.catalogSkillId || null;
    const keys = keysOf(live);
    const row = pickRow(rows, keys);
    const locked = keys.map(key => rows.get(key)).find((item): item is CloudRow => !!item && isLocked(item)) ?? null;
    // The saved copy read is the shown folder's when it has one; never a left-out folder's.
    const readable = (key: string) => !!rows.get(key)?.savedAt && rows.get(key)?.status !== "excluded";
    const savedKey = (row && readable(row.key) ? row.key : keys.find(readable)) ?? null;
    const details = catalogId ? catalog.get(catalogId) : undefined;
    return {
      // Every folder the skill was ever in, sorted, so a copy going stale doesn't move the ID.
      id: catalogId ? `lib:${catalogId}` : `key:${keysOf(skill.sourceSkills).sort()[0]}`,
      name: skill.name,
      description: skill.description || "",
      author: details?.author || catalogOwner(catalogId),
      catalogId,
      githubUrl: skill.githubUrl,
      origin: originOf(catalogId, live),
      installed: true,
      savedKey,
      status: row?.status ?? null,
      ...access(row, catalogId, !!savedKey, locked),
    };
  });

  // Saved copies no Mac has now; details from the last copy a Mac reported, unless that skill is still installed.
  const listed = new Set(mine.flatMap(({ live }) => keysOf(live)));
  const notInstalled: LibrarySkill[] = [...rows.values()].filter(row => row.savedAt && !listed.has(row.key)).map(row => {
    const last = grouped.find(skill => keysOf(skill.sourceSkills).includes(row.key));
    const stillInstalled = last && mine.some(entry => entry.skill.id === last.id);
    const from = last && !stillInstalled ? last : null;
    const catalogId = from?.catalogSkillId || null;
    return {
      id: catalogId ? `lib:${catalogId}` : `key:${row.key}`,
      name: from?.name ?? row.name,
      description: from?.description || row.description || "",
      author: from ? (catalogId ? catalog.get(catalogId)?.author || catalogOwner(catalogId) : "") : "",
      catalogId,
      githubUrl: from?.githubUrl ?? null,
      origin: from ? originOf(catalogId, from.sourceSkills) : "personal",
      installed: false,
      savedKey: row.key,
      status: row.status,
      ...access(row, catalogId, true),
    };
  });

  // Library skills added to My skills that no Mac has; once installed, the installed skill stands for them.
  const seen = new Set<string>();
  const added: LibrarySkill[] = input.additions.filter(id => !seen.has(id) && seen.add(id)
    && !mine.some(({ skill, live }) => skill.catalogSkillId === id
      || hasCatalogId({ ...skill, sourceSkills: live } as GroupedSyncedSkill, id)))
    .map(id => {
      const details = catalog.get(id);
      return {
        id: `lib:${id}`,
        name: details?.name || id.split(":").at(-1) || id,
        description: details?.description ?? "",
        author: details?.author || (id.split("/")[0] ?? ""),
        catalogId: id,
        githubUrl: details?.githubUrl ?? null,
        origin: "library",
        installed: false,
        savedKey: null,
        status: null,
        available: true,
        source: "public",
        reason: null,
      };
    });

  const notInstalledAll = [...notInstalled,
    ...added.filter(skill => !notInstalled.some(other => other.catalogId === skill.catalogId))];
  const skills = [...installedSkills, ...notInstalledAll];
  // Two skills can share a library ID (different names, or saved in two folders); then each is told apart by its
  // saved folder, else its name, whatever order they came in.
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1);
  for (const skill of skills) {
    if ((counts.get(skill.id) ?? 0) > 1) skill.id = `${skill.id}#${skill.savedKey ?? cloudSkillKey(skill.name)}`;
  }
  return { skills, count: skills.length, notInstalledCount: notInstalledAll.length };
}

export type MySkillsLoadDependencies = {
  readInventory: (userId: string) => Promise<SyncedSkill[]>;
  readCloud: (userId: string) => Promise<CloudSaveState>;
  readAdditions: (userId: string) => Promise<string[]>;
  /** Library details for these IDs; may return fewer, or throw (then names fall back to IDs). */
  catalogDetails?: (ids: string[]) => Promise<Map<string, CatalogDetails>>;
  now?: () => number;
};

/**
 * Loads one user's My skills. Inventory and additions must load; cloud save and library details are best effort,
 * like the web, and what failed is listed in `partial` so a caller can say so.
 */
export async function loadMySkills(userId: string, deps: MySkillsLoadDependencies):
  Promise<MySkillsLibrary & { partial: ("cloud" | "catalog")[] }> {
  const partial: ("cloud" | "catalog")[] = [];
  const [inventory, cloud, additions] = await Promise.all([
    deps.readInventory(userId),
    deps.readCloud(userId).catch(() => { partial.push("cloud"); return null; }),
    deps.readAdditions(userId),
  ]);
  const ids = [...new Set([...inventory.map(skill => skill.catalogSkillId).filter((id): id is string => !!id), ...additions])];
  let catalog = new Map<string, CatalogDetails>();
  if (deps.catalogDetails && ids.length) {
    try { catalog = await deps.catalogDetails(ids); } catch { partial.push("catalog"); }
  }
  return { ...buildMySkills({ inventory, cloud, additions, catalog, now: deps.now?.() }), partial };
}
