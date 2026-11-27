import { useState, type ReactNode } from "react";
import { Cloud } from "lucide-react";
import { PortalApiError } from "../../api-error";
import { needsAttention, setsNote, statusHelp, statusText, labelText, type CloudSaveState, type CloudSkillRow } from "../../cloud-save/cloud-save";

/** The account's cloud save state, and confirming a skill flagged for a key is safe to save. */
export type CloudInfo = { state: CloudSaveState; confirm: (key: string) => Promise<void>;
  /** Deletes a saved skill and stops syncing it; for one no Mac has, that takes it out of My skills. */
  remove?: (key: string) => Promise<void>;
  /** A skill's own switch: leaves its folders' keys out of sync, or syncs them again. */
  leaveOut?: (keys: string[], leftOut: boolean) => Promise<void>;
  /** "Delete synced copy": deletes the saved folders and leaves the skill's other folders out, then reloads once. */
  deleteSynced?: (saved: string[], others: string[]) => Promise<void> };

/**
 * A skill's sync, at the bottom of its panel: how it syncs (versions, last synced), what the scan found, what
 * to do when it's local only, its synced versions, and its own switch and "Delete synced copy".
 * `keys` are the skill's folders' keys (one skill can be in several agents' folders).
 */
export function SkillSyncSection({ row: shown, keys, cloud, installed, editable, versions, openSettings }: {
  row: CloudSkillRow | null; keys: string[]; cloud: CloudInfo; installed: boolean; editable: boolean;
  versions?: ReactNode; openSettings?: () => void;
}) {
  const [busy, setBusy] = useState<"" | "confirm" | "switch" | "delete">("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  if (!shown) return null;
  // A skill no Mac has just reads Synced, as its "Not installed" tag already says the rest.
  const row = !installed && shown.status === "deleted" ? { ...shown, status: "saved" as const } : shown;
  const { settings } = cloud.state;
  const attention = needsAttention(row.status);
  const saved = ["saved", "deleted", "library", "set"].includes(row.status);
  const excluded = new Set(settings.excludedSkillKeys);
  const leftOutKeys = keys.filter(key => excluded.has(key));
  const leftOut = keys.length > 0 && leftOutKeys.length === keys.length;
  // Every saved folder of this skill: deleting its synced copy deletes them all, so the warning counts them all.
  const savedCopies = cloud.state.skills.filter(skill => keys.includes(skill.key));
  const savedVersions = savedCopies.reduce((total, skill) => total + skill.versionCount, 0);
  const inSets = savedCopies.reduce((total, skill) => total + (skill.setCount ?? 0), 0);
  // Stays busy until the change and the reload after it are both done, so nothing shows the old state.
  const run = (kind: "confirm" | "switch" | "delete", work: () => Promise<void>, failed: string) => {
    setBusy(kind);
    setError("");
    void work().catch((cause: unknown) => setError(cause instanceof PortalApiError && cause.message ? cause.message : failed))
      .finally(() => setBusy(""));
  };
  const line = [statusText[row.status],
    saved && row.versionCount > 0 ? `${row.versionCount} ${row.versionCount === 1 ? "version" : "versions"}` : "",
    saved && row.savedAt ? `last synced ${new Date(row.savedAt).toLocaleDateString()}` : ""].filter(Boolean).join(" · ");
  return <section className="ua-skill-sync" aria-label="Sync" data-status={row.status}>
    <h3>Sync</h3>
    {settings.enabled ? <p className="ua-skill-sync-line">
      {attention ? <span className="ua-local-dot" aria-hidden="true" /> : <Cloud aria-hidden="true" />}{line}
    </p> : <p className="ua-muted">Sync is off.{openSettings && <> <button type="button" className="ua-link" onClick={openSettings}>Turn it on in Settings</button></>}</p>}
    {settings.enabled && !leftOut && leftOutKeys.length > 0 && <p className="ua-muted">
      Left out in {leftOutKeys.length} of its {keys.length} folders.</p>}
    {row.labels.length > 0 && <p className="ua-cloud-labels">{row.labels.map(label => <span key={label}>{labelText[label]}</span>)}</p>}
    {attention && statusHelp[row.status] && <p className="ua-muted">{row.status === "review" && row.origin
      ? `A file in this skill from ${row.origin === "library" ? "the library" : "a Set"} looks like it contains a key or password, so it stays on your Mac. If it's only an example, confirm it's safe.`
      : statusHelp[row.status]}</p>}
    {row.findings.map(file => <p className="ua-muted ua-cloud-finding" key={file.path}>
      {file.path}: {file.findings.map(finding => `${finding.kind} on line ${finding.line}`).join(", ")}
    </p>)}
    {row.status === "review" && editable && <button type="button" className="ua-pill" disabled={!!busy}
      onClick={() => run("confirm", () => cloud.confirm(row.key), "It couldn't be confirmed. Try again.")}>
      {busy === "confirm" ? "Confirming..." : "It's safe, sync it"}</button>}
    {versions}
    {editable && installed && settings.enabled && cloud.leaveOut && <label className="ua-skill-sync-switch">
      <span>Sync this skill</span>
      <button type="button" role="switch" className="ua-switch" aria-label="Sync this skill" aria-checked={!leftOut} disabled={!!busy || keys.length === 0}
        onClick={() => run("switch", () => cloud.leaveOut!(keys, !leftOut), "Sync couldn't be changed. Try again.")}><span /></button>
    </label>}
    {editable && installed && cloud.deleteSynced && savedCopies.length > 0 && (deleting
      ? <div className="ua-skill-sync-confirm" role="group" aria-label="Delete synced copy">
        <p>{savedVersions === 1 ? "Delete its synced version" : `Delete all ${savedVersions} synced versions`} and stop
          syncing it? It stays on your Mac.{setsNote(inSets)}</p>
        <div>
          <button type="button" className="ua-pill ua-pill-danger" disabled={!!busy} onClick={() => run("delete", async () => {
            // Its other folders (not synced yet, or held for review) stop syncing too.
            await cloud.deleteSynced!(savedCopies.map(skill => skill.key),
              keys.filter(key => !excluded.has(key) && !savedCopies.some(skill => skill.key === key)));
            setDeleting(false);
          }, "The synced copy couldn't be deleted. Try again.")}>{busy === "delete" ? "Deleting..." : "Delete"}</button>
          <button type="button" className="ua-pill" autoFocus disabled={!!busy} onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      </div>
      : <button type="button" className="ua-skill-sync-delete" disabled={!!busy} onClick={() => setDeleting(true)}>Delete synced copy</button>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
