import { createHash } from "node:crypto";
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
  /** Live library skills with this content (or this name and description). */
  ids: string[];
  /** For a fingerprint shared by several skills: the catalog's high-confidence pick. */
  canonical?: string;
};
export type ContentIndexPartition = Record<string, ContentIndexEntry>;

type IndexedSkill = { id?: unknown; name?: unknown; description?: unknown; provenance_type?: unknown; skill_md_path?: unknown };

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

export function partitionOf(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 2);
}

/** Builds the index from the published skills and their fingerprint history. */
export function buildContentIndex(skills: readonly IndexedSkill[], history: ShaHistoryAsset | null): Map<string, ContentIndexPartition> {
  const live = new Set<string>();
  const originalOf = new Map<string, string>();
  const mirrors = new Set<string>();
  for (const skill of skills) {
    if (typeof skill.id !== "string") continue;
    live.add(skill.id);
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
    if (typeof skill.id !== "string" || typeof skill.name !== "string" || typeof skill.description !== "string") continue;
    const key = namedKey(skill.name, skill.description);
    const id = resolve(skill.id);
    if (!key || !id) continue;
    const entry = entries.get(key) ?? { ids: [] };
    if (!entry.ids.includes(id)) entry.ids.push(id);
    entries.set(key, entry);
  }
  const partitions = new Map<string, ContentIndexPartition>();
  for (const [key, entry] of entries) {
    const partition = partitions.get(partitionOf(key)) ?? {};
    partition[key] = { ...entry, ids: [...entry.ids].sort() };
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

/** The index keys a copy needs: its fingerprint, then its name and description. */
export function keysFor(copy: IndexedCopy): string[] {
  const keys: string[] = [];
  if (copy.skillMdSha && /^[0-9a-f]{40}$/i.test(copy.skillMdSha.trim())) keys.push(contentKey(copy.skillMdSha));
  const named = copy.name && copy.description ? namedKey(copy.name, copy.description) : null;
  if (named) keys.push(named);
  return keys;
}

/**
 * Exact content first (this exact version is published); then the same name and description (another
 * version of a library skill, e.g. a little older or newer than the one we recorded).
 */
export function matchCopy(copy: IndexedCopy, entries: Readonly<Record<string, ContentIndexEntry>>): string | null {
  const exactEntry = copy.skillMdSha ? entries[contentKey(copy.skillMdSha)] : undefined;
  // This exact version is published: it decides alone. Falling back to name and description could
  // pick a fork that still carries a description the original has since changed.
  if (exactEntry?.ids.length) return pick(exactEntry, copy);
  const named = copy.name && copy.description ? namedKey(copy.name, copy.description) : null;
  return named ? pick(entries[named], copy) : null;
}

/** Where the index lives: Netlify Blobs store "catalog-index", one file per partition plus meta.json. */
export type ContentIndexStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export const CONTENT_INDEX_VERSION = 1;

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
      const value = store.get(`p/${name}.json`).then((data) => (data && typeof data === "object" ? data as ContentIndexPartition : {}));
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
