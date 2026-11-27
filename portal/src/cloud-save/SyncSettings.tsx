import { useState } from "react";
import type { SyncedSkill } from "../synced-skill-grouping";
import { cloudSkillRows, cloudSummaryText, formatBytes, type CloudSaveState } from "./cloud-save";

/**
 * Sync for the whole account, in the profile: the switch, what's synced and the storage it uses, and deleting
 * everything synced. Each skill's own sync (its status, versions, switch and synced copy) is in its panel.
 */
export function SyncSettings({ state, skills, setEnabled, deleteAll, retry }: {
  state: CloudSaveState | null; skills: SyncedSkill[];
  setEnabled?: (enabled: boolean) => Promise<void>;
  deleteAll?: () => Promise<void>;
  retry?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const run = (work: () => Promise<void>, failed: string, done = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    void work().then(() => setNotice(done), () => setError(failed)).finally(() => setBusy(false));
  };
  if (!state) return <section className="ua-sync-settings" aria-label="Sync">
    <h2>Sync</h2>
    <p className="ua-muted">Sync couldn't be loaded.</p>
    {retry && <button type="button" className="ua-pill" onClick={retry}>Try again</button>}
  </section>;
  const rows = cloudSkillRows(state, skills);
  const enabled = state.settings.enabled;
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
    {deleteAll && (state.skills.length > 0 || state.usage.bytes > 0) && <div className="ua-account-row ua-sync-delete-all">
      {deleting ? <div>
        <p><strong>Delete everything you synced?</strong> Every synced version of every skill is removed and sync is turned
          off. Skills on your Macs aren't touched.
          {state.skills.some(skill => (skill.setCount ?? 0) > 0) && " Skills you share in Sets are taken out of them; people keep what they installed."}
          {" "}This can't be undone.</p>
        <div className="ua-toolbar">
          <button type="button" className="ua-pill ua-pill-danger" disabled={busy} onClick={() => run(async () => {
            await deleteAll();
            setDeleting(false);
          }, "Your synced skills couldn't be deleted. Try again.", "Everything you synced was deleted, and sync is off.")}>Delete everything</button>
          <button type="button" className="ua-pill" disabled={busy} onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      </div> : <>
        <div><strong>Delete all synced skills</strong><p className="ua-muted">Removes every synced version. Skills on your Macs stay.</p></div>
        <button type="button" className="ua-pill ua-pill-danger" disabled={busy} onClick={() => setDeleting(true)}>Delete all</button>
      </>}
    </div>}
    {(error || notice) && <p role={error ? "alert" : "status"}>{error || notice}</p>}
  </section>;
}
