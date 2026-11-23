import { createHash } from "node:crypto";
import { withTimeout } from "./http.js";

export type CatalogSkill = {
  id?: string;
  name?: string;
  description?: string;
  github_url?: string;
  githubUrl?: string;
  skill_md_path?: string;
  skill_md_sha?: string;
  install_target_name?: string;
};

export type CanonicalShaEntry = {
  skillId?: unknown;
  confidence?: unknown;
  reason?: unknown;
};

export type ShaHistoryAsset = {
  version: 1;
  shaToSkillIds: Record<string, unknown>;
  canonicalBySha?: Record<string, CanonicalShaEntry>;
};

export type PublishedCatalogIdentity = {
  track: string;
  liveSkillIds: ReadonlySet<string>;
  shaHistory: ShaHistoryAsset | null;
  /** For checked mirror skills: the original skill's ID, when that original is live too. */
  originalOf?: ReadonlyMap<string, string>;
  /** Checked skills the catalog lists as mirrors of another repo's skill. */
  mirrorIds?: ReadonlySet<string>;
};

type AssetReference = {
  path?: unknown;
};

type PublishedManifest = {
  skills?: AssetReference;
  shaHistory?: AssetReference;
  searchCatalog?: AssetReference;
};

type PublishedTrack = {
  name: string;
  manifestUrl: string;
};

type LoaderOptions = {
  fetcher?: typeof fetch;
  tracks?: PublishedTrack[];
  now?: () => number;
  cacheMs?: number;
};

export const publishedCatalogTracks: PublishedTrack[] = [
  {
    name: "crawl4",
    manifestUrl: "https://omgskills.com/data/crawl4/manifest.json",
  },
  {
    name: "v2",
    manifestUrl: "https://omgskills.com/data/v2/manifest.json",
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await withTimeout(fetcher(url), 8_000);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

function assetUrl(reference: AssetReference | undefined, manifestUrl: string, label: string): string {
  if (typeof reference?.path !== "string" || !reference.path.trim()) {
    throw new Error(`Manifest missing ${label} path`);
  }
  const manifest = new URL(manifestUrl);
  const asset = new URL(reference.path, manifest);
  if (asset.origin !== manifest.origin) {
    throw new Error(`Manifest ${label} path must stay on ${manifest.origin}`);
  }
  return asset.toString();
}

function parseManifest(value: unknown): PublishedManifest {
  if (!isObject(value)) {
    throw new Error("Published manifest must be an object");
  }
  return value as PublishedManifest;
}

function parseSkills(value: unknown): CatalogSkill[] {
  if (!Array.isArray(value)) {
    throw new Error("Published skills asset must be an array");
  }
  return value.filter((skill): skill is CatalogSkill => isObject(skill));
}

function parseShaHistory(value: unknown): ShaHistoryAsset {
  if (!isObject(value) || value.version !== 1 || !isObject(value.shaToSkillIds)) {
    throw new Error("Published SHA history has an invalid shape");
  }
  if (value.canonicalBySha !== undefined && !isObject(value.canonicalBySha)) {
    throw new Error("Published canonical SHA history has an invalid shape");
  }
  return value as ShaHistoryAsset;
}

export async function fetchPublishedSkills(
  options: Pick<LoaderOptions, "fetcher" | "tracks"> = {},
): Promise<CatalogSkill[]> {
  const fetcher = options.fetcher ?? fetch;
  const tracks = options.tracks ?? publishedCatalogTracks;
  for (const track of tracks) {
    try {
      const manifest = parseManifest(await fetchJson(track.manifestUrl, fetcher));
      return parseSkills(await fetchJson(assetUrl(manifest.skills, track.manifestUrl, "skills"), fetcher));
    } catch {
      // Each track is independent. Fall through to the next complete track.
    }
  }
  throw new Error("Published catalog unavailable");
}

export async function fetchPublishedCatalogIdentity(
  options: Pick<LoaderOptions, "fetcher" | "tracks"> = {},
): Promise<PublishedCatalogIdentity> {
  const fetcher = options.fetcher ?? fetch;
  const tracks = options.tracks ?? publishedCatalogTracks;
  for (const track of tracks) {
    try {
      const manifest = parseManifest(await fetchJson(track.manifestUrl, fetcher));
      const skillsPromise = fetchJson(assetUrl(manifest.skills, track.manifestUrl, "skills"), fetcher);
      const shaHistoryPromise = manifest.shaHistory
        ? fetchJson(assetUrl(manifest.shaHistory, track.manifestUrl, "shaHistory"), fetcher)
        : Promise.resolve(null);
      const [skillsValue, shaHistoryValue] = await Promise.all([skillsPromise, shaHistoryPromise]);
      const skills = parseSkills(skillsValue);
      return {
        track: track.name,
        liveSkillIds: new Set(
          skills
            .map((skill) => skill.id)
            .filter((id): id is string => typeof id === "string" && Boolean(id.trim())),
        ),
        shaHistory: shaHistoryValue === null ? null : parseShaHistory(shaHistoryValue),
      };
    } catch {
      // Do not combine skills from one track with SHA history from another.
    }
  }
  throw new Error("Published catalog identity unavailable");
}

function cachedLoader<T>(
  load: () => Promise<T>,
  now: () => number,
  cacheMs: number,
): () => Promise<T> {
  let cache: { expiresAt: number; promise: Promise<T> } | null = null;
  return async () => {
    const currentTime = now();
    if (cache && cache.expiresAt > currentTime) {
      return cache.promise;
    }
    const promise = load();
    cache = { expiresAt: currentTime + cacheMs, promise };
    try {
      return await promise;
    } catch (error) {
      if (cache?.promise === promise) {
        cache = null;
      }
      throw error;
    }
  };
}

export function createPublishedSkillsLoader(options: LoaderOptions = {}): () => Promise<CatalogSkill[]> {
  return cachedLoader(
    () => fetchPublishedSkills(options),
    options.now ?? Date.now,
    options.cacheMs ?? 5 * 60_000,
  );
}

export function createPublishedCatalogIdentityLoader(
  options: LoaderOptions = {},
): () => Promise<PublishedCatalogIdentity> {
  return cachedLoader(
    () => fetchPublishedCatalogIdentity(options),
    options.now ?? Date.now,
    options.cacheMs ?? 5 * 60_000,
  );
}

type HintCatalog = {
  track: string;
  shaHistory: ShaHistoryAsset;
  detailShards: Record<string, string>;
  shards: Map<string, Promise<ShardIndex>>;
};

/** A detail shard's live IDs, and for mirror skills the original skill each one copies. */
type ShardIndex = { ids: ReadonlySet<string>; mirrors: ReadonlyMap<string, string> };

/**
 * The original of a mirror skill, from where the mirror keeps it: a `mirrors/repos/<owner>@<repo>/<folder>/SKILL.md`
 * path names the original as `<owner>/<repo>:<folder>` (or `<owner>/<repo>` for a skill at the repo's root).
 */
export function mirroredOriginalId(row: { provenance_type?: unknown; skill_md_path?: unknown }): string | null {
  if (row.provenance_type !== "mirrored" || typeof row.skill_md_path !== "string") return null;
  const match = /(?:^|\/)repos\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)\/(?:(.+)\/)?SKILL\.md$/.exec(row.skill_md_path);
  if (!match) return null;
  return match[3] ? `${match[1]}/${match[2]}:${match[3]}` : `${match[1]}/${match[2]}`;
}

async function fetchHintCatalog(fetcher: typeof fetch, tracks: PublishedTrack[]): Promise<HintCatalog> {
  for (const track of tracks) {
    try {
      const manifest = parseManifest(await fetchJson(track.manifestUrl, fetcher));
      const searchUrl = assetUrl(manifest.searchCatalog, track.manifestUrl, "searchCatalog");
      const [shaHistoryValue, search] = await Promise.all([
        fetchJson(assetUrl(manifest.shaHistory, track.manifestUrl, "shaHistory"), fetcher),
        fetchJson(searchUrl, fetcher),
      ]);
      const details = isObject(search) && isObject(search.details) ? search.details : undefined;
      const index = await fetchJson(assetUrl(details, searchUrl, "details"), fetcher);
      if (!isObject(index) || index.partition !== "sha256-first-byte" || !isObject(index.shards)) {
        throw new Error("Published skill detail index has an invalid shape");
      }
      const detailShards: Record<string, string> = {};
      for (const [bucket, shard] of Object.entries(index.shards)) {
        detailShards[bucket] = assetUrl(isObject(shard) ? shard : undefined, searchUrl, "detail shard");
      }
      return { track: track.name, shaHistory: parseShaHistory(shaHistoryValue), detailShards, shards: new Map() };
    } catch {
      // Do not combine SHA history from one track with detail shards from another.
    }
  }
  throw new Error("Published catalog hint assets unavailable");
}

function shardIds(catalog: HintCatalog, url: string, fetcher: typeof fetch): Promise<ShardIndex> {
  let ids = catalog.shards.get(url);
  if (!ids) {
    ids = fetchJson(url, fetcher).then((rows) => {
      if (!Array.isArray(rows)) throw new Error("Published skill detail shard must be an array");
      const mirrors = new Map<string, string>();
      const live = new Set(rows.flatMap((row) => {
        if (!isObject(row) || typeof row.id !== "string") return [];
        const original = mirroredOriginalId(row);
        if (original) mirrors.set(row.id, original);
        return [row.id];
      }));
      return { ids: live, mirrors };
    });
    ids.catch(() => catalog.shards.delete(url));
    catalog.shards.set(url, ids);
  }
  return ids;
}

/** Most detail shards (about 370 KB each) one content match may read. */
const MAX_CONTENT_SHARDS = 48;

/**
 * Identity for checking catalog hints without the full skills asset: SHA history plus
 * the detail shards that hold the hinted IDs, so `liveSkillIds` covers only those hints.
 * With `candidates`, the IDs to check are picked from the SHA history instead (for matching
 * copies by content), and at most MAX_CONTENT_SHARDS shards are read; IDs past that stay unchecked.
 */
export function createCatalogHintIdentityLoader(
  options: LoaderOptions = {},
): (hintIds: readonly string[], candidates?: (history: ShaHistoryAsset) => readonly string[]) => Promise<PublishedCatalogIdentity> {
  const fetcher = options.fetcher ?? fetch;
  const loadCatalog = cachedLoader(
    () => fetchHintCatalog(fetcher, options.tracks ?? publishedCatalogTracks),
    options.now ?? Date.now,
    options.cacheMs ?? 5 * 60_000,
  );
  return async (hintIds, candidates) => {
    const catalog = await loadCatalog();
    const live = new Set<string>();
    // One budget for the whole content lookup (both passes): IDs past it stay unchecked.
    const shards = new Set<string>();
    const withinBudget = (id: string) => {
      const shard = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 2);
      if (!shards.has(shard) && shards.size >= MAX_CONTENT_SHARDS) return false;
      shards.add(shard);
      return true;
    };
    let ids = [...new Set(hintIds)];
    if (candidates) ids = (catalog.shaHistory ? [...new Set(candidates(catalog.shaHistory))] : []).filter(withinBudget);
    const mirrors = new Map<string, string>();
    const check = async (id: string) => {
      const url = catalog.detailShards[createHash("sha256").update(id, "utf8").digest("hex").slice(0, 2)];
      if (!url) return;
      const shard = await shardIds(catalog, url, fetcher);
      if (!shard.ids.has(id)) return;
      live.add(id);
      const original = shard.mirrors.get(id);
      if (original) mirrors.set(id, original);
    };
    await Promise.all(ids.map(check));
    // A content match on a mirror counts for its original, so the originals are checked too.
    const originalOf = new Map<string, string>();
    if (candidates && mirrors.size) {
      await Promise.all([...new Set(mirrors.values())].filter(withinBudget).map(check));
      for (const [mirror, original] of mirrors) if (live.has(original)) originalOf.set(mirror, original);
    }
    return { track: catalog.track, liveSkillIds: live, shaHistory: catalog.shaHistory, ...(candidates ? { originalOf, mirrorIds: new Set(mirrors.keys()) } : {}) };
  };
}

export const loadPublishedSkills = createPublishedSkillsLoader();
export const loadPublishedCatalogIdentity = createPublishedCatalogIdentityLoader();
export const loadCatalogHintIdentity = createCatalogHintIdentityLoader();
