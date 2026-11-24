// A personal skill whose content several library skills share (forks): the person says which one
// it is, most stars first, or that it's their own. One choice covers every copy with that content.

import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import type { CatalogSummary } from "./model";

/** nameKey: where a pick of a library skill not among the candidates is saved (for the skill's name). */
export type LibraryMatch = { matchKey: string; candidates: string[]; nameKey?: string };

/** The first copy's offer to choose, checked: a real index key and a few catalog IDs. */
export function libraryMatchOf(copies: readonly { catalogMatchKey?: unknown; catalogCandidates?: unknown; catalogNameKey?: unknown }[]): LibraryMatch | null {
  for (const copy of copies) {
    const key = copy.catalogMatchKey, ids = copy.catalogCandidates, byName = copy.catalogNameKey;
    if (typeof key === "string" && /^(?:sha:[0-9a-f]{40}|nd:[0-9a-f]{64}|n:[0-9a-f]{64})$/.test(key) && Array.isArray(ids)
      && ids.length >= 1 && ids.length <= 5 && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 500)) {
      return { matchKey: key, candidates: ids as string[],
        ...(typeof byName === "string" && /^n:[0-9a-f]{64}$/.test(byName) ? { nameKey: byName } : {}) };
    }
  }
  return null;
}

/** Candidates most stars first (the server already sends them so; this keeps it true either way). */
export function byStars(ids: readonly string[], details: readonly (CatalogSummary | null)[]): string[] {
  return ids.map((id, index) => ({ id, index, stars: details[index]?.stars ?? -1 }))
    .sort((a, b) => b.stars - a.stars || a.index - b.index).map(item => item.id);
}

/** A skill with a copy still unlinked that several library skills match: tagged "Potential match". */
export function potentialMatch(skill: { installed?: { sourceSkills: readonly { catalogSkillId?: string | null; catalogMatchKey?: unknown; catalogCandidates?: unknown }[] } }): boolean {
  return !!skill.installed && !!libraryMatchOf(skill.installed.sourceSkills.filter(copy => !copy.catalogSkillId?.trim()));
}

function starCount(stars?: number) {
  return stars === undefined ? "" : stars >= 1000 ? `${(stars / 1000).toFixed(stars >= 10_000 ? 0 : 1)}K` : String(stars);
}

export function LibraryMatchPicker({ match, current, load, choose }: {
  match: LibraryMatch;
  /** The library skill this is shown under, when it isn't one of the candidates: offered to keep. */
  current?: { catalogId: string; author: string };
  /** Library details for the candidates (name, author, stars); a failed one shows its ID. */
  load: (ids: string[], signal: AbortSignal) => Promise<(CatalogSummary | null)[]>;
  choose: (matchKey: string, catalogSkillId: string | null) => Promise<void>;
}) {
  const [details, setDetails] = useState<(CatalogSummary | null)[]>([]);
  const [selected, setSelected] = useState(match.candidates[0]);
  // Until the person picks, the most-starred one is selected, once stars are known.
  const touched = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Refreshes (on focus, on a tab coming back) hand over new arrays and loaders for the same choice;
  // only a different list of candidates resets the selection, so a pick survives switching tabs.
  const loadRef = useRef(load);
  loadRef.current = load;
  const candidates = match.candidates.join("\n");
  useEffect(() => {
    const controller = new AbortController();
    const ids = candidates.split("\n");
    setSelected(current => ids.includes(current) ? current : ids[0]);
    loadRef.current(ids, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setDetails(value);
      if (!touched.current) setSelected(byStars(ids, value)[0]);
    }).catch(() => {});
    return () => controller.abort();
  }, [match.matchKey, candidates]);
  const headingId = `library-match-${match.matchKey}`;
  const keep = current && match.nameKey && !match.candidates.includes(current.catalogId) ? current : null;
  const save = async (catalogSkillId: string | null, matchKey = match.matchKey) => {
    setBusy(true);
    setError("");
    try {
      await choose(matchKey, catalogSkillId);
    } catch {
      setError("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ua-library-match" aria-label="Library match">
      <strong id={headingId}>Looks like a library skill</strong>
      <p className="ua-muted">{match.candidates.length === 1
        ? "It may be this library skill. Is it?"
        : `It may be one of these ${match.candidates.length} library skills. Which one is it?`}</p>
      <ul role="radiogroup" aria-labelledby={headingId}>
        {byStars(match.candidates, details).map(id => {
          const skill = details[match.candidates.indexOf(id)];
          return (
            <li key={id}>
              <label>
                <input type="radio" name={`library-match-${match.matchKey}`} checked={selected === id} disabled={busy}
                  onChange={() => { touched.current = true; setSelected(id); }} />
                <span className="ua-library-match-name">{skill?.name ?? id.split(":").pop()}</span>
                <span className="ua-library-match-author ua-muted">{skill?.author ? `@${skill.author}` : id.split(":")[0]}</span>
                {skill?.stars !== undefined && <span className="ua-library-match-stars ua-muted"><Star aria-hidden="true" />{starCount(skill.stars)}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="ua-library-match-actions">
        <button type="button" className="ua-pill ua-primary" disabled={busy} onClick={() => void save(selected)}>This one</button>
        {keep && <button type="button" className="ua-pill" disabled={busy}
          onClick={() => void save(keep.catalogId, match.nameKey)}>Keep {keep.author ? `@${keep.author}` : "this one"}</button>}
        <button type="button" className="ua-pill" disabled={busy} onClick={() => void save(null)}>It's my own</button>
      </div>
      {error && <p role="alert" className="ua-muted">{error}</p>}
    </section>
  );
}
