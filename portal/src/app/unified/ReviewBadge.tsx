// Our review of a library skill, for the exact version the catalog installs: the same answer the
// skill's web page shows (/api/skill-review). It only reports what the review found.

import { useEffect, useState } from "react";

export type ReviewAnswer = { badge: "no_issues" | "under_review" | "not_reviewed"; reviewedAt: string | null };

export function reviewWords(answer: ReviewAnswer): { text: string; title: string } {
  if (answer.badge === "no_issues") {
    const day = answer.reviewedAt ? new Date(answer.reviewedAt) : null;
    const when = day && !Number.isNaN(day.getTime())
      ? ` (checked ${day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })})` : "";
    return { text: "No issues found", title: `Our rules and an AI review found no issues in this version${when}. It's a check, not a guarantee.` };
  }
  if (answer.badge === "under_review") return { text: "Under review", title: "Our checks flagged something in this version; a person is looking at it." };
  return { text: "Not reviewed yet", title: "We haven't reviewed this version yet." };
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
  return <span className="ua-review-badge" data-state={current.badge} title={words.title}>{words.text}</span>;
}
