import { useState } from "react";
import { PortalApiError } from "../api-error";
import type { SyncedSkill } from "../synced-skill-grouping";
import { cloudSkillRows, cloudSummaryText, formatBytes, type CloudSaveState, type CloudSaveView } from "./cloud-save";

/**
 * Sync for the whole account, in the profile: the switch, what's synced and the storage it uses, the skills left
 * out, and deleting everything synced. Each skill's own sync (its status, versions, switch and synced copy) is in
 * its panel. `status` is null until the first load is in.
 */
export function SyncSettings({ state, status, skills, setEnabled, deleteAll, retry, find }: {
  state: CloudSaveState | null; status: CloudSaveView["status"] | null; skills: SyncedSkill[];
  setEnabled?: (enabled: boolean) => Promise<void>;
  deleteAll?: () => Promise<void>;
  retry?: () => void;
  /** Shows a skill in My skills, by name. */
  find?: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  // Stays busy until the change and the reload after it are both done.
  const run = (work: () => Promise<void>, failed: string, done = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    void work().then(() => setNotice(done), (cause: unknown) => setError(cause instanceof PortalApiError && cause.message ? cause.message : failed))
      .finally(() => setBusy(false));
  };
  if (!status) return <section className="ua-sync-settings" aria-label="Sync"><h2>Sync</h2><p className="ua-muted" role="status">Loading sync...</p></section>;
  if (status === "unavailable") return <section className="ua-sync-settings" aria-label="Sync"><h2>Sync</h2>
    <p className="ua-muted">Sync isn't available yet. It's coming soon: a private, versioned copy of the skills you write or change.</p>
  </section>;
  if (!state) return <section className="ua-sync-settings" aria-label="Sync">
    <h2>Sync</h2>
    <p className="ua-muted" role="alert">Sync couldn't be loaded.</p>
    {retry && <button type="button" className="ua-pill" onClick={retry}>Try again</button>}
  </section>;
  const rows = cloudSkillRows(state, skills);
  const enabled = state.settings.enabled;
  const leftOut = rows.filter(row => row.status === "excluded");
  return <section className="ua-sync-settings" aria-label="Sync">
    <h2>Sync</h2>
    <div className="ua-account-row">
      <div>
        <strong>Sync My skills</strong>
        <p className="ua-muted">A private, versioned copy of every skill in My skills, so you can get it back or install it
          on another Mac. Only you can see it. Each skill's sync is in its panel.</p>
      </div>
      {setEnabled && <button type="button" role="switch" className="ua-switch" aria-label="Sync My skills" aria-checked={enabled} disabled={busy}
        onClick={() => run(() => setEnabled(!enabled), "Sync couldn't be changed. Try again.")}><span /></button>}
    </div>
    {enabled && <p className="ua-muted" role="status">
      {cloudSummaryText(rows, state.summary)} · {formatBytes(state.usage.bytes)} of {formatBytes(state.usage.limitBytes)} used.
      Your Mac syncs changes in the background.
    </p>}
    {enabled && leftOut.length > 0 && <p className="ua-sync-left-out">
      <span className="ua-muted">Left out of sync:</span>
      {leftOut.map(row => find
        ? <button type="button" className="ua-link" key={row.key} onClick={() => find(row.name)}>{row.name}</button>
        : <span key={row.key}>{row.name}</span>)}
    </p>}
    {deleteAll && (state.skills.length > 0 || state.usage.bytes > 0) && <div className="ua-account-row ua-sync-delete-all">
      {deleting ? <div className="ua-sync-confirm" role="group" aria-label="Delete all synced skills">
        <p><strong>Delete everything you synced?</strong> Every synced version of every skill is removed and sync is turned
          off. Skills on your Macs aren't touched.
          {state.skills.some(skill => (skill.setCount ?? 0) > 0) && " Skills you share in Sets are taken out of them; people keep what they installed."}
          {" "}This can't be undone.</p>
        <div>
          <button type="button" className="ua-pill ua-pill-danger" disabled={busy} onClick={() => run(async () => {
            await deleteAll();
            setDeleting(false);
          }, "Your synced skills couldn't be deleted. Try again.", "Everything you synced was deleted, and sync is off.")}>
            {busy ? "Deleting..." : "Delete everything"}</button>
          <button type="button" className="ua-pill" autoFocus disabled={busy} onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      </div> : <>
        <div><strong>Delete all synced skills</strong><p className="ua-muted">Removes every synced version. Skills on your Macs stay.</p></div>
        <button type="button" className="ua-pill ua-pill-danger" disabled={busy} onClick={() => setDeleting(true)}>Delete all</button>
      </>}
    </div>}
    {(error || notice) && <p role={error ? "alert" : "status"}>{error || notice}</p>}
  </section>;
}
