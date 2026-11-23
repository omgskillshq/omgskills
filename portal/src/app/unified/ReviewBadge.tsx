// Our review of a library skill, for the exact version the catalog installs: the same answer the
// skill's web page shows (/api/skill-review). It only reports what the review found.

import { ShieldCheck, ShieldCogCorner, ShieldQuestionMark } from "lucide-react";
import { useEffect, useState } from "react";

// One shield per state; the words show on hover, tap or focus, like the scan tip beside it.
const ICONS = { no_issues: ShieldCheck, under_review: ShieldCogCorner, not_reviewed: ShieldQuestionMark } as const;

export type ReviewAnswer = { badge: "no_issues" | "under_review" | "not_reviewed"; reviewedAt: string | null };

export function reviewWords(answer: ReviewAnswer): { text: string; title: string } {
  if (answer.badge === "no_issues") {
    const day = answer.reviewedAt ? new Date(answer.reviewedAt) : null;
    const when = day && !Number.isNaN(day.getTime())
      ? ` on ${day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "";
    return { text: "No issues found", title: `No issues found: our rules and an AI review checked this version${when}. It's a check, not a guarantee.` };
  }
  if (answer.badge === "under_review") return { text: "Under review", title: "Under review: our checks flagged something in this version and the second look didn't clear it. Read it closely before you install it." };
  return { text: "Not reviewed yet", title: "Not reviewed yet: we haven't checked this version." };
}

export function parseReviewAnswer(value: unknown): ReviewAnswer | null {
  if (!value || typeof value !== "object") return null;
  const { badge, reviewedAt } = value as Record<string, unknown>;
  if (badge !== "no_issues" && badge !== "under_review" && badge !== "not_reviewed") return null;
  return { badge, reviewedAt: typeof reviewedAt === "string" ? reviewedAt : null };
}

export function ReviewBadge({ catalogId, treeSha }: { catalogId: string; treeSha: string }) {
  const version = `${catalogId}@${treeSha}`;
  // Each answer remembers which skill version it's for, so switching skills never shows the last one's.
  const [answer, setAnswer] = useState<ReviewAnswer & { version: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/skill-review?id=${encodeURIComponent(catalogId)}&tree=${encodeURIComponent(treeSha)}`, { credentials: "omit" })
      .then(response => response.ok ? response.json() : null)
      .then(value => { const parsed = parseReviewAnswer(value); if (live && parsed) setAnswer({ ...parsed, version }); })
      .catch(() => {});
    return () => { live = false; };
  }, [catalogId, treeSha, version]);
  const current: ReviewAnswer = answer?.version === version ? answer : { badge: "not_reviewed", reviewedAt: null };
  const words = reviewWords(current);
  const [open, setOpen] = useState(false);
  const Icon = ICONS[current.badge];
  const label = words.title;
  return (
    <button type="button" className="ua-scan-tip ua-review-badge" data-state={current.badge} aria-label={label} data-open={open}
      onClick={() => setOpen(value => !value)} onBlur={() => setOpen(false)}
      onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
      <Icon aria-hidden="true" />
      <span className="ua-scan-tip-text" aria-hidden="true">{label}</span>
    </button>
  );
}
