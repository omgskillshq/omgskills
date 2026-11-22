// What the background scan found in a private skill shared in a Set, shown before people install it.
// The scan matches patterns, so a finding is something worth a look, never proof a skill is harmful.

import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { CloudScan } from "../../cloud-save/cloud-save";
import { findingInfo, findingPlace } from "../../cloud-save/scan-findings";

function day(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SetItemScan({ scan }: { scan: CloudScan | null }) {
  if (!scan) return <section className="ua-set-scan" aria-label="Safety scan">
    <ShieldQuestion aria-hidden="true" />
    <div><strong>Not scanned yet</strong>
      <p className="ua-muted">We check shared skills in the background. Look again soon, or read the instructions below first.</p></div>
  </section>;
  if (scan.status === "clean") return <section className="ua-set-scan" aria-label="Safety scan">
    <ShieldCheck aria-hidden="true" />
    <div><strong>Passed our checks</strong> <span className="ua-muted">· {day(scan.scannedAt)}</span>
      <p className="ua-muted">No leaked keys, hidden instructions or download-and-run commands found. Passing our checks
        doesn't guarantee a skill is safe.</p></div>
  </section>;
  const findings = scan.findings ?? [];
  const found = findings.length > 0 || (scan.findingCount ?? 0) > 0;
  if (scan.status === "incomplete" && !found) return <section className="ua-set-scan" aria-label="Safety scan">
    <ShieldQuestion aria-hidden="true" />
    <div><strong>Scan didn't finish</strong>
      <p className="ua-muted">Part of this skill couldn't be checked, so it isn't marked as passed.</p></div>
  </section>;
  const more = Math.max(0, (scan.findingCount ?? findings.length) - findings.length);
  return <section className="ua-set-scan" data-flagged aria-label="Safety scan">
    <ShieldAlert aria-hidden="true" />
    <div><strong>Worth a look before you install</strong> <span className="ua-muted">· {day(scan.scannedAt)}</span>
      <p className="ua-muted">Our checks matched a pattern. Most turn out fine, like an example key or an install
        command, so a match doesn't mean the skill is harmful.
        {scan.status === "incomplete" && " Part of the skill couldn't be checked, so there may be more."}</p>
      {findings.length > 0 && <ul className="ua-safety-findings">
        {findings.map((finding, index) => {
          const info = findingInfo(finding);
          return <li key={`${index}:${finding.path}:${finding.line}:${finding.rule}`}>
            <span><strong>{info.title}</strong> <span className="ua-muted">· {findingPlace(finding)}</span></span>
            <small className="ua-muted">{info.usuallyFine}</small>
          </li>;
        })}
        {more > 0 && <li className="ua-muted">And {more} more</li>}
      </ul>}
    </div>
  </section>;
}
