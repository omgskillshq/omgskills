import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { mirroredOriginalId, parseShaHistory, publishedCatalogTracks, type ShaHistoryAsset } from "./published-catalog.js";

/*
 * Which library skill a copy installed outside omgskills is, without loading the catalog on every
 * page load. When a new catalog is published, the background scan builds this index: for each
 * published SKILL.md fingerprint, and for each skill name + description, the live library skills it
 * belongs to (a mirror listed as its original; a mirror whose original isn't listed left out). It's
 * stored in 256 small files by key, so reading a user's skills fetches only the few files it needs.
 * Built hourly by catalog-index-background (apart from the public scan) when the catalog changed.
 */

export type ContentIndexEntry = {
  /** Live library skills with this content (or this name and description), most stars first. */
  ids: string[];
  /** For a fingerprint shared by several skills: the catalog's high-confidence pick. */
  canonical?: string;
};
export type ContentIndexPartition = Record<string, ContentIndexEntry>;

type IndexedSkill = { id?: unknown; name?: unknown; description?: unknown; provenance_type?: unknown; skill_md_path?: unknown; stars?: unknown };

export function contentKey(skillMdSha: string): string {
  return `sha:${skillMdSha.trim().toLowerCase()}`;
}

/** Name and description as the Mac reports them (whitespace collapsed), compared without case. */
export function namedKey(name: string, description: string): string | null {
  const clean = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const n = clean(name), d = clean(description);
  if (!n || !d) return null;
  return `nd:${createHash("sha256").update(`${n}\n${d}`, "utf8").digest("hex")}`;
}

/** The name alone (compared without case): only ever a suggestion, never a link on its own. */
export function nameKey(name: string): string | null {
  const n = name.replace(/\s+/g, " ").trim().toLowerCase();
  return n ? `n:${createHash("sha256").update(n, "utf8").digest("hex")}` : null;
}

/** Most library skills kept per name: the most-starred ones. */
const MAX_PER_NAME = 20;

export function partitionOf(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 2);
}

/** Builds the index from the published skills and their fingerprint history. */
export function buildContentIndex(skills: readonly IndexedSkill[], history: ShaHistoryAsset | null): Map<string, ContentIndexPartition> {
  const live = new Set<string>();
  const originalOf = new Map<string, string>();
  const mirrors = new Set<string>();
  const stars = new Map<string, number>();
  for (const skill of skills) {
    if (typeof skill.id !== "string") continue;
    live.add(skill.id);
    if (typeof skill.stars === "number" && Number.isFinite(skill.stars)) stars.set(skill.id, skill.stars);
    const original = mirroredOriginalId(skill);
    if (skill.provenance_type === "mirrored") mirrors.add(skill.id);
    if (original) originalOf.set(skill.id, original);
  }
  // A mirror stands for its original when that's listed; otherwise it never counts.
  const resolve = (id: string): string | null => {
    if (!live.has(id)) return null;
    if (!mirrors.has(id)) return id;
    const original = originalOf.get(id);
    return original && live.has(original) && !mirrors.has(original) ? original : null;
  };
  const entries = new Map<string, ContentIndexEntry>();
  for (const [sha, raw] of Object.entries(history?.shaToSkillIds ?? {})) {
    if (!/^[0-9a-f]{40}$/.test(sha) || !Array.isArray(raw)) continue;
    const ids = [...new Set(raw.flatMap((id) => (typeof id === "string" ? [resolve(id)] : [])).filter((id): id is string => !!id))].sort();
    if (!ids.length) continue;
    const pick = history?.canonicalBySha?.[sha];
    const canonical = pick?.confidence === "high" && pick.reason === "same-repo" && typeof pick.skillId === "string" ? resolve(pick.skillId) : null;
    entries.set(contentKey(sha), canonical && ids.includes(canonical) ? { ids, canonical } : { ids });
  }
  for (const skill of skills) {
    if (typeof skill.id !== "string" || typeof skill.name !== "string") continue;
    const id = resolve(skill.id);
    if (!id) continue;
    for (const key of [typeof skill.description === "string" ? namedKey(skill.name, skill.description) : null, nameKey(skill.name)]) {
      if (!key) continue;
      const entry = entries.get(key) ?? { ids: [] };
      if (!entry.ids.includes(id)) entry.ids.push(id);
      entries.set(key, entry);
    }
  }
  const partitions = new Map<string, ContentIndexPartition>();
  for (const [key, entry] of entries) {
    const partition = partitions.get(partitionOf(key)) ?? {};
    // Most stars first: the order a person picking between forks sees them.
    const ids = [...entry.ids].sort((a, b) => (stars.get(b) ?? 0) - (stars.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
    partition[key] = { ...entry, ids: key.startsWith("n:") ? ids.slice(0, MAX_PER_NAME) : ids };
    partitions.set(partitionOf(key), partition);
  }
  return partitions;
}

function repoOf(githubUrl: string | null | undefined): string | null {
  return githubUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/i.exec(githubUrl)?.[1]?.toLowerCase() ?? null : null;
}

/**
 * The library skill for one entry's candidates: the copy's own repo (and folder) when it has one
 * among them; otherwise the only candidate, or the catalog's canonical pick. Anything unclear: none.
 */
function pick(entry: ContentIndexEntry | undefined, source: { githubUrl?: string | null; gitRelativePath?: string | null }): string | null {
  if (!entry?.ids.length) return null;
  const repo = repoOf(source.githubUrl);
  const sameRepo = repo ? entry.ids.filter((id) => id.split(":")[0].toLowerCase() === repo) : [];
  if (sameRepo.length) {
    if (sameRepo.length === 1) return sameRepo[0];
    const path = source.gitRelativePath?.replace(/^\/+|\/+$/g, "").toLowerCase() ?? "";
    const samePath = sameRepo.filter((id) => id.split(":").slice(1).join(":").toLowerCase() === path);
    return samePath.length === 1 ? samePath[0] : null;
  }
  if (entry.ids.length === 1) return entry.ids[0];
  return entry.canonical ?? null;
}

export type IndexedCopy = {
  skillMdSha?: string | null; name?: string | null; description?: string | null;
  githubUrl?: string | null; gitRelativePath?: string | null;
};

/** The index keys a copy needs: its fingerprint, its name and description, and its name. */
export function keysFor(copy: IndexedCopy): string[] {
  const keys: string[] = [];
  if (copy.skillMdSha && /^[0-9a-f]{40}$/i.test(copy.skillMdSha.trim())) keys.push(contentKey(copy.skillMdSha));
  const named = copy.name && copy.description ? namedKey(copy.name, copy.description) : null;
  if (named) keys.push(named);
  const byName = copy.name ? nameKey(copy.name) : null;
  if (byName) keys.push(byName);
  return keys;
}

/** The candidates' entry a copy is judged by: exact content when published, else name and description, else name. */
function deciding(copy: IndexedCopy, entries: Readonly<Record<string, ContentIndexEntry>>): string | null {
  const keys = [copy.skillMdSha ? contentKey(copy.skillMdSha) : null,
    copy.name && copy.description ? namedKey(copy.name, copy.description) : null, copy.name ? nameKey(copy.name) : null];
  return keys.find((key): key is string => !!key && !!entries[key]?.ids.length) ?? null;
}

/**
 * Links a copy only on strong evidence, tested on the catalog's own version history (match trial,
 * 2026-11-24): its exact content is published; or it comes from that skill's own GitHub repo (and
 * folder); or its instructions' text was compared and confirmed (`confirmed`, from content_match_results).
 * Name and description, or the name, alone only suggest: they linked unrelated skills.
 */
export function matchCopy(
  copy: IndexedCopy,
  entries: Readonly<Record<string, ContentIndexEntry>>,
  confirmed?: string | null,
): string | null {
  const exactEntry = copy.skillMdSha ? entries[contentKey(copy.skillMdSha)] : undefined;
  // This exact version is published: it decides alone.
  if (exactEntry?.ids.length) return pick(exactEntry, copy);
  // The copy's own repo among any of its candidates is as good as the same content.
  if (repoOf(copy.githubUrl)) {
    for (const key of keysFor(copy)) {
      const own = entries[key] ? pickOwnRepo(entries[key], copy) : null;
      if (own) return own;
    }
  }
  // Confirmed by comparing the instructions' text, while that skill is still one of the candidates.
  return confirmed && keysFor(copy).some((key) => entries[key]?.ids.includes(confirmed)) ? confirmed : null;
}

function pickOwnRepo(entry: ContentIndexEntry, source: { githubUrl?: string | null; gitRelativePath?: string | null }): string | null {
  const repo = repoOf(source.githubUrl);
  const sameRepo = repo ? entry.ids.filter((id) => id.split(":")[0].toLowerCase() === repo) : [];
  if (sameRepo.length === 1) return sameRepo[0];
  const path = source.gitRelativePath?.replace(/^\/+|\/+$/g, "").toLowerCase() ?? "";
  const samePath = sameRepo.filter((id) => id.split(":").slice(1).join(":").toLowerCase() === path);
  return samePath.length === 1 ? samePath[0] : null;
}

/** Where the index lives: Netlify Blobs store "catalog-index", one file per partition plus meta.json. */
export type ContentIndexStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export const CONTENT_INDEX_VERSION = 3;

/**
 * Writes a freshly built index, each part whole, then meta.json (which says which catalog it's for).
 * During a rebuild a reader may see some parts from each catalog; every entry is complete either way.
 */
export async function writeContentIndex(store: ContentIndexStore, catalogKey: string, partitions: Map<string, ContentIndexPartition>) {
  for (let i = 0; i < 256; i += 1) {
    const name = i.toString(16).padStart(2, "0");
    await store.set(`p/${name}.json`, partitions.get(name) ?? {});
  }
  await store.set("meta.json", { version: CONTENT_INDEX_VERSION, catalogKey, builtAt: new Date().toISOString() });
}

export async function contentIndexIsCurrent(store: ContentIndexStore, catalogKey: string): Promise<boolean> {
  const meta = await store.get("meta.json") as { version?: unknown; catalogKey?: unknown } | null;
  return meta?.version === CONTENT_INDEX_VERSION && meta.catalogKey === catalogKey;
}

/** Reads only the partitions these keys fall in; each partition is cached for a few minutes. */
export function contentIndexReader(store: ContentIndexStore, now: () => number = Date.now, cacheMs = 10 * 60_000) {
  const cache = new Map<string, { at: number; value: Promise<ContentIndexPartition> }>();
  return async (keys: readonly string[]): Promise<Record<string, ContentIndexEntry>> => {
    const names = [...new Set(keys.map(partitionOf))];
    const parts = await Promise.all(names.map((name) => {
      const hit = cache.get(name);
      if (hit && now() - hit.at < cacheMs) return hit.value;
      const value = store.get(`p/${name}.json`).then((data) => {
        // Not built yet: don't remember that, so the index is used as soon as it's written.
        if (!data || typeof data !== "object") { cache.delete(name); return {}; }
        return data as ContentIndexPartition;
      });
      value.catch(() => cache.delete(name));
      cache.set(name, { at: now(), value });
      return value;
    }));
    const entries: Record<string, ContentIndexEntry> = {};
    for (const part of parts) for (const key of keys) if (part[key] && Array.isArray(part[key].ids)) entries[key] = part[key];
    return entries;
  };
}

/**
 * Rebuilds the index when the published catalog changed (or it was never built). Reads the full
 * skills list (about 88 MB), so only the background scan calls it. Returns whether it rebuilt.
 */
export async function ensureContentIndex(store: ContentIndexStore, fetcher: typeof fetch = fetch): Promise<boolean> {
  const track = publishedCatalogTracks[0];
  const get = async (url: string, timeoutMs: number) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    return response.json();
  };
  const manifest = await get(track.manifestUrl, 15_000) as { generatedAt?: unknown; skills?: { path?: unknown }; shaHistory?: { path?: unknown } };
  if (typeof manifest.generatedAt !== "string") throw new Error("catalog manifest has no date");
  if (await contentIndexIsCurrent(store, manifest.generatedAt)) return false;
  const asset = (reference: { path?: unknown } | undefined) => {
    const name = reference?.path;
    if (typeof name !== "string" || !/^[\w.-]+\.json$/.test(name)) throw new Error("catalog asset missing");
    return new URL(name, track.manifestUrl).toString();
  };
  const history = parseShaHistory(await get(asset(manifest.shaHistory), 60_000));
  const skills = await get(asset(manifest.skills), 180_000);
  if (!Array.isArray(skills)) throw new Error("catalog skills has the wrong shape");
  await writeContentIndex(store, manifest.generatedAt, buildContentIndex(skills, history));
  return true;
}

/** Most library skills offered to a person choosing which one their copy is. */
export const MAX_CHOICES = 5;

/**
 * A copy's library skill, as matchCopy finds it, after the person's own choices: a choice made for
 * this content (or name and description) wins; "my own" (null) keeps it personal. When the index
 * finds several and nothing decides, the copy gets the candidates (most stars first) to choose from.
 */
export function resolveCopy(
  copy: IndexedCopy,
  entries: Readonly<Record<string, ContentIndexEntry>>,
  choices: ReadonlyMap<string, string | null> = new Map(),
  confirmed?: string | null,
): { catalogSkillId: string } | { matchKey: string; candidates: string[] } | null {
  // The same content or the copy's own repo decides on its own; then the person's choice, which a
  // text comparison never overrides ("It's my own" stays their own); then a confirmed text match.
  const found = matchCopy(copy, entries);
  if (found) return { catalogSkillId: found };
  const key = deciding(copy, entries);
  if (!key) return null;
  const entry = entries[key];
  if (choices.has(key)) {
    const chosen = choices.get(key);
    // A choice of a skill that's no longer a candidate (removed, changed) is asked again.
    if (chosen === null) return null;
    if (chosen && entry.ids.includes(chosen)) return { catalogSkillId: chosen };
  }
  const byText = matchCopy(copy, entries, confirmed);
  if (byText) return { catalogSkillId: byText };
  // Suggested, never linked: the person says which one it is, or that it's their own.
  return { matchKey: key, candidates: entry.ids.slice(0, MAX_CHOICES) };
}

/** A key a person may record a choice for: an index key as keysFor makes them. */
export function isMatchKey(value: unknown): value is string {
  return typeof value === "string" && /^(?:sha:[0-9a-f]{40}|nd:[0-9a-f]{64}|n:[0-9a-f]{64})$/.test(value);
}

let blobReader: ReturnType<typeof contentIndexReader> | null = null;
/** The index as stored in Netlify Blobs ("catalog-index"); fails softly, as a rejection. */
export async function readBlobContentIndex(keys: string[]): Promise<Record<string, ContentIndexEntry>> {
  if (!blobReader) {
    const store = getStore("catalog-index");
    blobReader = contentIndexReader({
      get: (key) => store.get(key, { type: "json" }),
      set: (key, value) => store.setJSON(key, value).then(() => undefined),
    });
  }
  return blobReader(keys);
}
