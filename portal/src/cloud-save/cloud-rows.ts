// One status per synced skill and the counts every screen shows (the web's Sync and My skills, the Mac's
// menu, agents through the library MCP). Pure: the web runs it in the browser and the server runs the same
// code, so the screens can't drift apart.
import type { SyncedSkill } from "../synced-skill-grouping.js";

export type CloudFinding = { rule: string; kind: string; line: number };
export type CloudLabel = "scripts" | "download_and_run" | "invisible_characters" | "hidden_instructions" | "confirmed_secret";
/** The background scan of a saved version; "incomplete" is never shown as clean. */
export type CloudScan = { status: "clean" | "flagged" | "incomplete"; scannedAt: string; findings?: CloudScanFinding[]; findingCount?: number };
/** Something a scan found worth a look: the rule, file and line, never the matched text. Older servers leave the list out. */
export type CloudScanFinding = { rule: string; label: string; severity: string; path: string; line: number | null };
export type CloudSkipReason = "library" | "links" | "too_large" | "unreadable" | "failed";

/** What the rows need of the account's cloud save (the server's and the web's state both fit). */
export type CloudRowsState = {
  settings: { enabled: boolean; excludedSkillKeys: string[] };
  skills: {
    key: string;
    description?: string | null;
    versionCount?: number;
    deletedLocallyAt: string | null;
    setCount?: number;
    githubSource?: unknown;
    currentVersion: { savedAt: string; labels?: readonly string[]; scan?: CloudScan | null };
  }[];
  needsReview: { key: string; files: { path: string; findings: CloudFinding[] }[]; confirmed: boolean }[];
  skipped: Record<string, string>;
};

export type CloudSkillStatus = "saved" | "deleted" | "review" | "confirmed" | "excluded" | "library" | "set" | "waiting" | "off"
  | "links" | "too_large" | "unreadable" | "failed";

export type CloudSkillRow = {
  key: string;
  name: string;
  /** The saved description, for a skill added from GitHub; empty otherwise (the Mac's report gives it). */
  description: string;
  status: CloudSkillStatus;
  versionCount: number;
  setCount: number;
  savedAt: string | null;
  labels: CloudLabel[];
  /** The saved version's background scan, once it has run. */
  scan: CloudScan | null;
  findings: { path: string; findings: CloudFinding[] }[];
  /** Installed on one of your Macs now, as opposed to kept only in the cloud. */
  onMac: boolean;
  /** Installed from the library or a Set rather than written by you. */
  origin: "library" | "set" | null;
  /** Where a skill added from GitHub came from. */
  githubSource: { repo: string; folder: string; stars?: number } | null;
};

/** A skill's identity across agents and Macs, matching the server and the Mac: the folder name, NFC and lower case, untrimmed. */
export function cloudSkillKey(name: string) {
  return name.normalize("NFC").toLowerCase();
}

/** The cloud save key one installed copy uses: the server's, else its folder name. */
export function installationCloudKey(skill: { cloudKey?: string | null; installationFolder?: string | null; name: string }) {
  return skill.cloudKey || cloudSkillKey(skill.installationFolder || skill.name);
}

/** A copy from an app too old to say which Mac it's on stops counting after this long without a report. */
export const LEGACY_COPY_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A copy some Mac has now: one a Mac reports, or one from an app too old to say which Mac, while recent.
 * (The server also drops those old copies as soon as a Mac reports with its own; see readSyncInventory.)
 */
export function isLiveCopy(copy: Pick<SyncedSkill, "isCurrent" | "deviceId" | "lastSeenAt">, now = Date.now()) {
  if (copy.isCurrent === false) return false;
  if (copy.deviceId != null) return true;
  // The database gives a Date; JSON gives a string.
  const value: unknown = copy.lastSeenAt;
  const seen = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return !Number.isFinite(seen) || now - seen < LEGACY_COPY_STALE_MS;
}

/** Skills cloud save can't keep a copy of until something is done about them. */
export function needsAttention(status: CloudSkillStatus) {
  return status === "review" || status === "failed" || status === "links" || status === "too_large" || status === "unreadable";
}

/** A Mac's reason for not saving the version it has now. */
const cantSave = (reason: string | undefined): reason is "links" | "too_large" | "unreadable" | "failed" =>
  reason === "links" || reason === "too_large" || reason === "unreadable" || reason === "failed";

export const statusOrder: Record<CloudSkillStatus, number> = {
  review: 0, confirmed: 1, saved: 2, deleted: 3, failed: 4, links: 5, too_large: 6, unreadable: 7, waiting: 8, off: 9,
  library: 10, set: 10, excluded: 11,
};

/** A saved skill's GitHub source, when the server sent a sane one. */
function githubSourceOf(value: unknown): CloudSkillRow["githubSource"] {
  if (!value || typeof value !== "object") return null;
  const { repo, folder, stars } = value as Record<string, unknown>;
  if (typeof repo !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) || typeof folder !== "string") return null;
  return { repo, folder, ...(typeof stars === "number" && Number.isSafeInteger(stars) && stars >= 0 ? { stars } : {}) };
}

/**
 * One row per skill: every skill some Mac has now, plus any saved skill no longer there.
 * Library and Set installs aren't uploaded while unchanged, since they can be fetched again.
 * A Mac's own reason for not saving the version it has now wins over an older saved copy.
 */
export function cloudSkillRows(state: CloudRowsState, installed: readonly SyncedSkill[], now = Date.now()): CloudSkillRow[] {
  const names = new Map<string, string>();
  const fromLibrary = new Set<string>();
  const fromCatalog = new Set<string>();
  for (const skill of installed) {
    if (!isLiveCopy(skill, now)) continue;
    const key = installationCloudKey(skill);
    if (!key) continue;
    if (!names.has(key)) names.set(key, skill.name);
    if (skill.catalogSkillId || skill.installedFromSet) fromLibrary.add(key);
    if (skill.catalogSkillId) fromCatalog.add(key);
  }
  const saved = new Map(state.skills.map(skill => [skill.key, skill]));
  const reviews = new Map(state.needsReview.map(review => [review.key, review]));
  const excluded = new Set(state.settings.excludedSkillKeys);
  const keys = [...new Set([...names.keys(), ...saved.keys(), ...reviews.keys()])];
  // Two folders can hold skills with the same name; they're saved apart, so say which folder is which.
  const nameCounts = new Map<string, number>();
  for (const key of keys) {
    const name = names.get(key) ?? key;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const label = (key: string) => {
    const name = names.get(key) ?? key;
    return (nameCounts.get(name) ?? 0) > 1 && cloudSkillKey(name) !== key ? `${name} (folder ${key})` : name;
  };
  return keys.map((key): CloudSkillRow => {
    const copy = saved.get(key);
    const review = reviews.get(key);
    const reason = state.skipped[key];
    const found: CloudSkillStatus = excluded.has(key) ? "excluded"
      : review ? (review.confirmed ? "confirmed" : "review")
      // On a Mac now and that version can't be saved: an older saved copy doesn't make it synced.
      : names.has(key) && state.settings.enabled && cantSave(reason) ? reason
      : copy ? (copy.deletedLocallyAt ? "deleted" : fromLibrary.has(key) ? "library" : "saved")
      : !state.settings.enabled ? "off"
      // Only a saved copy is "from the library"; an older Mac reports unchanged installs as not uploaded.
      : reason === "library" ? "waiting"
      : cantSave(reason) ? reason : "waiting";
    // A private skill installed from a Set isn't in the library; say where it came from.
    const status = found === "library" && fromLibrary.has(key) && !fromCatalog.has(key) ? "set" : found;
    return {
      key,
      name: label(key),
      description: copy?.description ?? "",
      status,
      versionCount: copy?.versionCount ?? 0,
      setCount: copy?.setCount ?? 0,
      savedAt: copy?.currentVersion.savedAt ?? null,
      labels: (copy?.currentVersion.labels ?? []) as CloudLabel[],
      scan: copy?.currentVersion.scan ?? null,
      findings: review?.files ?? [],
      onMac: names.has(key),
      origin: fromCatalog.has(key) ? "library" : fromLibrary.has(key) ? "set" : null,
      githubSource: githubSourceOf(copy?.githubSource),
    };
  }).sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name));
}

/** The counts every screen shows. `mySkills`: everything in My skills (added library skills too), when known. */
export type CloudSummary = { skills: number; mySkills?: number; cantSync: number; notSyncedYet: number; leftOut: number; notOnMacs: number;
  /** For the Mac that asked: skills on it now. */
  onThisMac?: number };

export function cloudCounts(rows: readonly CloudSkillRow[]): CloudSummary {
  const count = (test: (row: CloudSkillRow) => boolean) => rows.filter(test).length;
  return {
    skills: rows.length,
    cantSync: count(row => needsAttention(row.status)),
    notSyncedYet: count(row => row.status === "waiting" || row.status === "confirmed"),
    leftOut: count(row => row.status === "excluded"),
    notOnMacs: count(row => !row.onMac),
  };
}
