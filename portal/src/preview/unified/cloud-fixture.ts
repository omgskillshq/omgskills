import type { CloudSaveState } from "../../cloud-save/cloud-save";
import { installationCloudKey } from "../../cloud-save/cloud-save";
import type { SyncedSkill } from "../../synced-skill-grouping";

/** Sample cloud save state for the preview: one skill to review, three that can't be saved, the rest saved. */
const flagged: Record<string, NonNullable<CloudSaveState["skills"][number]["currentVersion"]["scan"]>> = {
  copywriting: { status: "flagged", scannedAt: "2026-11-21T10:00:00Z", findings: [
    { rule: "download_and_run", label: "download_and_run", severity: "high", path: "SKILL.md", line: 37 },
    { rule: "hidden_instructions", label: "hidden_instructions", severity: "high", path: "references/workflows.md", line: 83 },
  ] },
  "seo-audit": { status: "flagged", scannedAt: "2026-11-21T10:00:00Z", findings: [
    { rule: "assigned_password", label: "secret", severity: "high", path: "rules/1-safety.md", line: 580 },
  ] },
};

export function previewCloudState(skills: SyncedSkill[]): CloudSaveState {
  const own = [...new Set(skills.filter(skill => skill.isCurrent !== false && !skill.catalogSkillId && !skill.installedFromSet)
    .map(installationCloudKey))];
  const [review, ...rest] = own;
  const reasons = ["links", "links", "too_large"] as const;
  const skipped = Object.fromEntries(rest.slice(0, reasons.length).map((key, index) => [key, reasons[index]]));
  const saved = rest.slice(reasons.length);
  return {
    settings: { enabled: true, excludedSkillKeys: [] },
    usage: { bytes: 6_800_000, limitBytes: 1024 ** 3 },
    skills: saved.map((key, index): CloudSaveState["skills"][number] => ({ key, versionCount: 1 + (index % 3), deletedLocallyAt: null,
      currentVersion: { id: `v-${key}`, savedAt: "2026-11-03T10:00:00Z", fileCount: 3, totalBytes: 12_000,
        labels: index % 4 === 0 ? ["scripts" as const] : [],
        // Most have been scanned and came back clean; the rest wait for the background scan.
        scan: index % 3 === 2 ? null : { status: "clean" as const, scannedAt: "2026-11-21T10:00:00Z", findings: [] } } })).concat(
      // Two flagged by the background scan.
      Object.entries(flagged).map(([key, scan]) => ({ key, versionCount: 1, deletedLocallyAt: null,
        currentVersion: { id: `v-${key}`, savedAt: "2026-11-03T10:00:00Z", fileCount: 6, totalBytes: 40_000, labels: [], scan } })),
      // Two kept only in the account: deleted from this Mac, or saved from another one.
      ["meeting-notes", "old-deploy-checklist"].map(key => ({ key, versionCount: 2, deletedLocallyAt: "2026-11-01T10:00:00Z",
        currentVersion: { id: `v-${key}`, savedAt: "2026-10-30T10:00:00Z", fileCount: 2, totalBytes: 8_000, labels: [],
          scan: key === "meeting-notes" ? { status: "clean" as const, scannedAt: "2026-11-21T10:00:00Z" } : null } }))),
    needsReview: review ? [{ key: review, confirmed: false, updatedAt: "2026-11-05T10:00:00Z",
      files: [{ path: "rules/1-safety.md", findings: [{ rule: "password", kind: "Password", line: 580 }] }] }] : [],
    skipped,
  };
}
