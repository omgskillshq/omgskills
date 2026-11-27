import { PortalApiError } from "../api-error";
import type { PortalApi } from "../portal-api";

import type { CloudFinding, CloudLabel, CloudScan, CloudScanFinding, CloudSkipReason, CloudSkillRow, CloudSummary } from "./cloud-rows";
import { cloudCounts, installationCloudKey, needsAttention, statusOrder } from "./cloud-rows";

// The rows and counts are shared with the server (cloud-rows.ts).
export type { CloudFinding, CloudLabel, CloudScan, CloudScanFinding, CloudSkipReason, CloudSkillRow, CloudSummary } from "./cloud-rows";
export { cloudCounts, cloudSkillKey, cloudSkillRows, installationCloudKey, isLiveCopy, needsAttention } from "./cloud-rows";

export type CloudSaveState = {
  settings: { enabled: boolean; excludedSkillKeys: string[] };
  usage: { bytes: number; limitBytes: number };
  skills: {
    key: string;
    /** The SKILL.md description, kept only for skills added from GitHub; older servers leave it out. */
    description?: string | null;
    versionCount: number;
    deletedLocallyAt: string | null;
    /** Sets that share this skill; older servers leave it out. */
    setCount?: number;
    /** Where a skill added from GitHub came from (stars as of the add); null or absent otherwise. */
    githubSource?: { repo: string; folder: string; commitSha: string; stars?: number } | null;
    currentVersion: { id: string; savedAt: string; fileCount: number; totalBytes: number; labels?: CloudLabel[]; scan?: CloudScan | null };
  }[];
  needsReview: { key: string; files: { path: string; findings: CloudFinding[] }[]; confirmed: boolean; updatedAt: string }[];
  /** Why a Mac didn't save each skill on its last pass. */
  skipped: Record<string, CloudSkipReason>;
  /** The Mac whose report gave each reason; older servers leave it out. */
  skippedBy?: Record<string, string>;
  /** The counts every screen shows, worked out by the server; older servers leave it out. */
  summary?: CloudSummary;
};

export type CloudSaveView =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "ready"; state: CloudSaveState };

const base = "/api/portal/cloud-save";

export async function loadCloudSave(api: PortalApi, signal?: AbortSignal): Promise<CloudSaveView> {
  try {
    const state = await api<CloudSaveState>(base, { signal, cache: "no-store" });
    return { status: "ready", state: { ...state, needsReview: state.needsReview ?? [], skipped: state.skipped ?? {} } };
  } catch (error) {
    if (error instanceof PortalApiError && error.status === 503) return { status: "unavailable" };
    throw error;
  }
}

export function saveCloudSettings(api: PortalApi, update: { enabled?: boolean; excludedSkillKeys?: string[] }) {
  return api<{ settings: CloudSaveState["settings"] }>(`${base}/settings`, { method: "PUT", body: JSON.stringify(update) });
}

export type CloudDeleteResult = { deletedSkills: number; freedBytes: number; pendingFiles: number };

/** Deletes one saved skill and stops saving it, or, with no key, everything saved and turns cloud save off. */
export function deleteCloudSaved(api: PortalApi, key?: string) {
  return api<CloudDeleteResult>(key === undefined ? base : `${base}/skills/${encodeURIComponent(key)}`, { method: "DELETE" });
}

export type SavedSkillMd = { key: string; markdown: string; truncated: boolean; savedAt: string };
export type SavedSkillMdLoader = (keys: string[], signal: AbortSignal) => Promise<SavedSkillMd | null>;

export type SharedSkillMd = { markdown: string; truncated: boolean };
export type SharedSkillMdLoader = (releaseId: string, signal: AbortSignal) => Promise<SharedSkillMd>;

/** A private Set item's instructions, for people the Set is shared with (checked like the Mac download). */
/** Not cached: every open asks the server again, so taking away access (or marking a version secret) applies at once. */
export function loadSharedSkillMd(api: PortalApi, releaseId: string, signal: AbortSignal): Promise<SharedSkillMd> {
  return api<SharedSkillMd>(`/api/portal/private-releases/${encodeURIComponent(releaseId)}/skill-md`, { signal, cache: "no-store" });
}

export type SavedVersions = { key: string; versions: { id: string; savedAt: string }[] };
export type SavedVersionsLoader = (keys: string[], signal: AbortSignal) => Promise<SavedVersions | null>;

/** A saved skill's versions, newest first, for the first of these keys that is saved; null when none is. */
export async function loadSavedVersions(api: PortalApi, keys: string[], signal: AbortSignal): Promise<SavedVersions | null> {
  // A skill's copies may be saved under several folder names; show the one with the most history.
  let best: SavedVersions | null = null;
  for (const key of keys) {
    try {
      const { versions } = await api<{ versions: { id: string; savedAt: string }[] }>(
        `${base}/skills/${encodeURIComponent(key)}/versions`, { signal, cache: "no-store" });
      if (!best || versions.length > best.versions.length) best = { key, versions: versions.map(({ id, savedAt }) => ({ id, savedAt })) };
    } catch (error) {
      if (error instanceof PortalApiError && (error.status === 404 || error.status === 503)) continue;
      throw error;
    }
  }
  return best;
}

/** Opens the Mac app, which asks first and then puts this saved version in place of the skill's copies. */
export function restoreVersionLink(name: string, key: string, versionId: string) {
  return `omgskills://restore?name=${encodeURIComponent(name.trim())}&key=${encodeURIComponent(key)}&version=${encodeURIComponent(versionId)}`;
}

/** The first of these skill keys with a saved copy, or null when none is saved. */
export async function loadSavedSkillMd(api: PortalApi, keys: string[], signal: AbortSignal): Promise<SavedSkillMd | null> {
  for (const key of keys) {
    try {
      return await api<SavedSkillMd>(`${base}/skills/${encodeURIComponent(key)}/skill-md`, { signal, cache: "no-store" });
    } catch (error) {
      if (error instanceof PortalApiError && (error.status === 404 || error.status === 503)) continue;
      throw error;
    }
  }
  return null;
}

export function confirmCloudReview(api: PortalApi, key: string) {
  return api(`${base}/skills/${encodeURIComponent(key)}/review`, { method: "POST", body: JSON.stringify({ confirm: true }) });
}


export type CloudDeleteSelection = { kind: "skill"; key: string } | { kind: "all" } | null;

export function isDeletingCloudSkill(selection: CloudDeleteSelection, key: string): boolean {
  return selection?.kind === "skill" && selection.key === key;
}

export function isDeletingAllCloudSkills(selection: CloudDeleteSelection): boolean {
  return selection?.kind === "all";
}

export const statusText: Record<CloudSkillRow["status"], string> = {
  saved: "Synced",
  deleted: "Synced · deleted on a Mac",
  review: "Local only: needs review",
  confirmed: "Syncs next time",
  excluded: "Left out",
  library: "Synced · from the library",
  set: "Synced · from a Set",
  waiting: "Not synced yet",
  off: "Not synced",
  links: "Local only: uses files outside its folder",
  too_large: "Local only: too large to sync",
  unreadable: "Local only: couldn't be read",
  failed: "Not synced yet: the last try failed, trying again",
};

/** Why a local-only skill stays on the Mac, in a few words, beside its blue dot in lists. */
export const localOnlyReason: Partial<Record<CloudSkillRow["status"], string>> = {
  review: "Needs review",
  links: "Uses files outside its folder",
  too_large: "Too large to sync",
  unreadable: "Couldn't be read",
  failed: "Last sync failed",
};

export const labelText: Record<CloudLabel, string> = {
  confirmed_secret: "Contains a key you confirmed",
  download_and_run: "Downloads and runs code",
  hidden_instructions: "Contains hidden instructions",
  invisible_characters: "Contains invisible characters",
  scripts: "Contains scripts",
};

/**
 * One line for every screen: all your skills (on your Macs or kept in the cloud), then only what
 * needs a look. The cloud keeps a record of every skill, so a skill whose files need attention still counts.
 * Takes the server's counts when it sent them, so every screen says the same.
 */
export function cloudSummaryText(rows: CloudSkillRow[], summary?: CloudSummary) {
  const counts = summary ?? cloudCounts(rows);
  // Everything in My skills when the server counted it (library skills you added too), as the Mac shows.
  const total = counts.mySkills ?? counts.skills;
  const parts = [`${total} ${total === 1 ? "skill" : "skills"}`];
  if (!counts.cantSync && !counts.notSyncedYet && !counts.leftOut) parts.push("all synced");
  if (counts.cantSync) parts.push(`${counts.cantSync} local only`);
  if (counts.notSyncedYet) parts.push(`${counts.notSyncedYet} not synced yet`);
  if (counts.leftOut) parts.push(`${counts.leftOut} left out`);
  if (counts.notOnMacs) parts.push(`${counts.notOnMacs} not on your Macs`);
  return parts.join(" · ");
}

/** One status for a skill whose copies sit in several folders: the one that needs attention first. */
export function skillCloudRow(rows: Map<string, CloudSkillRow>, keys: string[]): CloudSkillRow | null {
  let best: CloudSkillRow | null = null;
  for (const key of keys) {
    const row = rows.get(key);
    if (!row) continue;
    const rank = (item: CloudSkillRow) => (needsAttention(item.status) ? 0 : 100) + statusOrder[item.status];
    if (!best || rank(row) < rank(best)) best = row;
  }
  return best;
}

/**
 * When the scan shield may show for a skill: every one of the given copies has a saved copy that
 * is what's installed now and whose scan came back clean. Returns the newest scan time, or null.
 */
/**
 * The saved keys of your installed copies of a skill, for its scan badge: every current copy the
 * panel groups under it (most Macs don't report a library ID, so copies are grouped by name).
 * cleanScan then needs every one saved and scanned clean, so any flagged copy hides the badge.
 */
export function scanCopyKeys(
  copies: { isCurrent?: boolean | null; cloudKey?: string | null; installationFolder?: string | null; name: string }[],
): string[] {
  return [...new Set(copies.filter(copy => copy.isCurrent !== false).map(installationCloudKey))];
}

export function cleanScan(rows: Map<string, CloudSkillRow>, keys: string[]): string | null {
  if (keys.length === 0) return null;
  let newest: string | null = null;
  for (const key of keys) {
    const row = rows.get(key);
    if (!row || !["saved", "deleted", "set", "library"].includes(row.status) || row.scan?.status !== "clean") return null;
    if (!newest || row.scan.scannedAt > newest) newest = row.scan.scannedAt;
  }
  return newest;
}

/** What to do about a skill that isn't saved, for its detail panel. */
export const statusHelp: Partial<Record<CloudSkillRow["status"], string>> = {
  review: "It works as usual on your Mac. A file looks like it contains a key or password, so it stays there. Remove the key and it syncs by itself, or confirm it's safe.",
  confirmed: "You confirmed it's safe. Your Mac syncs it next time.",
  links: "It works as usual on your Mac. It uses files outside its folder, which don't sync; copy them into the skill and it syncs by itself.",
  too_large: "It works as usual on your Mac. It's over the sync size limit (12 MB, 4 MB per file).",
  unreadable: "Your Mac couldn't read its folder, so it stays on your Mac.",
  failed: "The last sync failed. Your Mac tries again next time.",
  library: "The version you installed from the library is synced. If you change it, your version is synced too.",
  set: "The version you installed from a Set is synced. If you change it, your version is synced too.",
  excluded: "You left it out of sync.",
  waiting: "Your Mac syncs it next time.",
  off: "Sync is off.",
};

/** What deleting also does to Sets, for the confirmation; empty when no Set shares it. */
export function setsNote(setCount: number) {
  if (setCount <= 0) return "";
  return ` It's also taken out of ${setCount === 1 ? "1 Set" : `${setCount} Sets`}; people keep what they installed.`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Where one skill stands with the background scan, for the Safety scan page. Worst copy wins. */
export type SafetyGroup = "flagged" | "held" | "incomplete" | "not_scanned" | "not_saved" | "off" | "no_copy" | "clean";

/** Sections of the Safety scan page, worst first. */
export const safetyGroups: { group: Exclude<SafetyGroup, "clean">; title: string; help: string }[] = [
  { group: "flagged", title: "Worth a look", help: "Our checks matched a pattern here, like a key, an email address or an install command. Most turn out fine, but look before you share. Ask your agent to look them over." },
  { group: "held", title: "Held back", help: "A file looks like it holds a key or password, so it wasn't saved or scanned." },
  { group: "incomplete", title: "Scan didn't finish", help: "Part of the skill was scanned; the rest was too big or couldn't be read." },
  { group: "not_scanned", title: "Not scanned yet", help: "Saved, but the scan hasn't finished. It keeps trying in the background." },
  { group: "not_saved", title: "Not saved", help: "Only saved copies are scanned." },
  { group: "off", title: "Saving turned off", help: "Saving is turned off for these, or for all your skills, so they aren't scanned." },
  { group: "no_copy", title: "No copy of yours to scan", help: "In My skills, but nothing of yours is saved or installed to scan." },
];

const safetyRank: Record<SafetyGroup, number> = {
  clean: 0, no_copy: 1, off: 2, not_saved: 3, not_scanned: 4, incomplete: 5, held: 6, flagged: 7,
};

export type SafetyStatus = {
  group: SafetyGroup;
  note?: string;
  scannedAt?: string;
  /** For a flagged skill: what each flagged copy's scan found, by its saved key. */
  flagged?: { key: string; findings: CloudScanFinding[]; more: number }[];
};

/** One skill's scan state from its saved copies (keys). No keys means nothing of yours to scan. */
export function safetyStatus(rows: Map<string, CloudSkillRow>, keys: string[]): SafetyStatus {
  if (keys.length === 0) return { group: "no_copy" };
  let worst: SafetyStatus = { group: "clean" };
  const flagged: { key: string; findings: CloudScanFinding[]; more: number }[] = [];
  for (const key of keys) {
    const row = rows.get(key);
    const next: SafetyStatus =
      !row ? { group: "not_saved", note: "Not synced yet" }
      : row.status === "excluded" || row.status === "off" ? { group: "off" }
      : row.status === "review" || row.status === "confirmed" ? { group: "held", note: statusText[row.status] }
      : !["saved", "deleted", "set", "library"].includes(row.status) ? { group: "not_saved", note: statusText[row.status] }
      : !row.scan ? { group: "not_scanned" }
      : row.scan.status === "clean" ? { group: "clean", scannedAt: row.scan.scannedAt }
      : { group: row.scan.status, scannedAt: row.scan.scannedAt };
    if (next.group === "flagged") {
      const findings = row?.scan?.findings ?? [];
      flagged.push({ key, findings, more: Math.max(0, (row?.scan?.findingCount ?? findings.length) - findings.length) });
    }
    if (safetyRank[next.group] > safetyRank[worst.group]) worst = next;
    else if (next.group === "clean" && worst.group === "clean" && (!worst.scannedAt || (next.scannedAt ?? "") > worst.scannedAt)) worst = next;
  }
  return worst.group === "flagged" ? { ...worst, flagged } : worst;
}
