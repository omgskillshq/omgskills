import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The names and descriptions library skills had before (description-history-<hash>.json): a copy of
 * an older version (a fork that froze it, or a person who never updated) still carries the old
 * description, so the match index lists the original for it too. Built from each publish's change
 * against the previous catalog, plus a one-time backfill from the catalog's git history
 * (index/seeds/description-history-backfill.json).
 */

export type DescriptionHistoryAsset = {
  version: 1;
  generatedAt: string;
  /** Live library skill ID → its earlier name-and-description keys (never its current one). */
  keysById: Record<string, string[]>;
};

type Skill = { id?: unknown; name?: unknown; description?: unknown };
type Asset = { path: string; sha256: string; bytes: number };

/** The same key as the match index (netlify/functions/_shared/catalog-content-index.ts namedKey). */
export function namedKey(name: string, description: string): string | null {
  const clean = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const n = clean(name), d = clean(description);
  if (!n || !d) return null;
  return `nd:${createHash("sha256").update(`${n}\n${d}`, "utf8").digest("hex")}`;
}

function keyOf(skill: Skill): string | null {
  return typeof skill.name === "string" && typeof skill.description === "string" ? namedKey(skill.name, skill.description) : null;
}

/** Most earlier keys kept for one skill. */
export const MAX_KEYS_PER_SKILL = 50;

/**
 * Earlier keys for today's skills: those already recorded (and from the backfill), plus each
 * skill's key in the previous catalog when it changed. A skill no longer listed is dropped.
 */
export function buildDescriptionHistory(
  sources: readonly (Pick<DescriptionHistoryAsset, "keysById"> | null)[],
  previous: readonly Skill[] | null,
  current: readonly Skill[],
  generatedAt: string,
): DescriptionHistoryAsset {
  const now = new Map<string, string | null>();
  for (const skill of current) if (typeof skill.id === "string") now.set(skill.id, keyOf(skill));
  const keys = new Map<string, Set<string>>();
  const add = (id: string, key: unknown) => {
    if (!now.has(id) || typeof key !== "string" || !/^nd:[0-9a-f]{64}$/.test(key) || key === now.get(id)) return;
    const set = keys.get(id) ?? new Set<string>();
    set.add(key);
    keys.set(id, set);
  };
  for (const source of sources) {
    for (const [id, list] of Object.entries(source?.keysById ?? {})) if (Array.isArray(list)) for (const key of list) add(id, key);
  }
  for (const skill of previous ?? []) if (typeof skill.id === "string") add(skill.id, keyOf(skill));
  const keysById: Record<string, string[]> = {};
  for (const id of [...keys.keys()].sort()) keysById[id] = [...keys.get(id)!].sort().slice(0, MAX_KEYS_PER_SKILL);
  return { version: 1, generatedAt, keysById };
}

export function sameDescriptionHistory(left: DescriptionHistoryAsset | null, right: DescriptionHistoryAsset): boolean {
  return !!left && JSON.stringify(left.keysById) === JSON.stringify(right.keysById);
}

export function parseDescriptionHistory(value: unknown): DescriptionHistoryAsset | null {
  if (!value || typeof value !== "object") return null;
  const asset = value as Partial<DescriptionHistoryAsset>;
  if (asset.version !== 1 || !asset.keysById || typeof asset.keysById !== "object") return null;
  return { version: 1, generatedAt: typeof asset.generatedAt === "string" ? asset.generatedAt : "", keysById: asset.keysById };
}

export function writeDescriptionHistoryAsset(dataDir: string, asset: DescriptionHistoryAsset): Asset {
  mkdirSync(dataDir, { recursive: true });
  const data = Buffer.from(`${JSON.stringify(asset)}\n`);
  const hash = createHash("sha256").update(data).digest("hex");
  const filename = `description-history-${hash.slice(0, 12)}.json`;
  const outputPath = join(dataDir, filename);
  if (!existsSync(outputPath)) writeFileSync(outputPath, data);
  return { path: filename, sha256: hash, bytes: data.length };
}

/** Keeps the current file and the one before it (a reader may still hold the older manifest). */
export function pruneDescriptionHistoryAssets(dataDir: string, keepPaths: string[]): void {
  const keep = new Set(keepPaths.filter(Boolean));
  for (const file of readdirSync(dataDir)) {
    if (!/^description-history-[0-9a-f]{12}\.json$/.test(file) || keep.has(file)) continue;
    rmSync(join(dataDir, file), { force: true });
  }
}

export function readJsonIfPresent(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
