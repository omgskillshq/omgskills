import { createHash } from "node:crypto";
import type { PublishedCatalogIdentity, ShaHistoryAsset } from "./published-catalog.js";
import { withTimeout } from "./http.js";

const maximumSkillMdBytes = 2 * 1024 * 1024;
const gitBlobShaPattern = /^[a-f0-9]{40}$/;

export type ValidatedGithubSkill = {
  githubUrl: string;
  rawSkillUrl: string;
  name: string;
  description: string;
  skillMdSha: string;
};

export type CatalogResolution =
  | { status: "resolved"; catalogSkillId: string; reason: "unique" | "canonical" }
  | { status: "unresolved"; reason: "missing" | "ambiguous" | "invalid" };

export type ResolvedGroupItem =
  | {
      kind: "catalog";
      catalogSkillId: string;
      githubUrl: string;
      name: string;
      description: string;
    }
  | {
      kind: "github";
      githubUrl: string;
      name: string;
      description: string;
    };

export class GithubSkillValidationError extends Error {}

function parseGithubSkillUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GithubSkillValidationError("GitHub URL is invalid");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new GithubSkillValidationError("Only public https://github.com URLs are supported");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo] = parts;
  if (!owner || !repo || !/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo)) {
    throw new GithubSkillValidationError("GitHub URL must include a valid owner and repo");
  }
  if (parts.length === 2) {
    return url;
  }
  if (
    parts[2] !== "blob" ||
    !parts[3] ||
    parts.length < 5 ||
    parts.at(-1)?.toLowerCase() !== "skill.md"
  ) {
    throw new GithubSkillValidationError("GitHub URL must reference a repository or SKILL.md file");
  }
  return url;
}

function rawSkillMdCandidates(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo] = parts;
  if (parts[2] === "blob") {
    const branch = parts[3];
    const skillPath = parts.slice(4).join("/");
    return [`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillPath}`];
  }
  return [
    `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
    `https://raw.githubusercontent.com/${owner}/${repo}/master/SKILL.md`,
  ];
}

function frontmatter(markdown: string): string | null {
  return markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? null;
}

function frontmatterField(markdown: string, field: string): string | null {
  const value = frontmatter(markdown)?.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1];
  return value?.trim().replace(/^["']|["']$/g, "") || null;
}

export function gitBlobSha(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return createHash("sha1").update(header).update(body).digest("hex");
}

export async function validateGithubSkill(
  rawUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<ValidatedGithubSkill> {
  const githubUrl = parseGithubSkillUrl(rawUrl);
  for (const candidate of rawSkillMdCandidates(githubUrl)) {
    const response = await withTimeout(fetcher(candidate), 8_000);
    if (!response.ok) {
      continue;
    }
    const declaredBytes = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumSkillMdBytes) {
      throw new GithubSkillValidationError("SKILL.md is too large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumSkillMdBytes) {
      throw new GithubSkillValidationError("SKILL.md is too large");
    }
    const markdown = new TextDecoder().decode(bytes);
    const name = frontmatterField(markdown, "name");
    const description = frontmatterField(markdown, "description");
    if (!name || !description) {
      throw new GithubSkillValidationError("SKILL.md must include name and description frontmatter");
    }
    return {
      githubUrl: githubUrl.toString(),
      rawSkillUrl: candidate,
      name,
      description,
      skillMdSha: gitBlobSha(bytes),
    };
  }
  throw new GithubSkillValidationError("Could not find a valid public SKILL.md");
}

export function resolveCatalogSkillId(
  skillMdSha: string,
  identity: PublishedCatalogIdentity | null,
): CatalogResolution {
  const normalizedSha = skillMdSha.trim().toLowerCase();
  if (!gitBlobShaPattern.test(normalizedSha) || !identity?.shaHistory) {
    return { status: "unresolved", reason: "missing" };
  }

  const mappedIds = identity.shaHistory.shaToSkillIds[normalizedSha];
  if (!Array.isArray(mappedIds)) {
    return {
      status: "unresolved",
      reason: mappedIds === undefined ? "missing" : "invalid",
    };
  }

  const liveCandidates = [...new Set(
    mappedIds.filter(
      (id): id is string => typeof id === "string" && identity.liveSkillIds.has(id),
    ),
  )].sort();
  if (liveCandidates.length === 1) {
    return {
      status: "resolved",
      catalogSkillId: liveCandidates[0],
      reason: "unique",
    };
  }
  if (liveCandidates.length === 0) {
    return { status: "unresolved", reason: "missing" };
  }

  const canonical = identity.shaHistory.canonicalBySha?.[normalizedSha];
  if (
    canonical?.confidence === "high" &&
    canonical.reason === "same-repo" &&
    typeof canonical.skillId === "string" &&
    liveCandidates.includes(canonical.skillId)
  ) {
    return {
      status: "resolved",
      catalogSkillId: canonical.skillId,
      reason: "canonical",
    };
  }
  return { status: "unresolved", reason: "ambiguous" };
}

function repoOf(githubUrl: string | null | undefined): string | null {
  return githubUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/i.exec(githubUrl)?.[1]?.toLowerCase() ?? null : null;
}

/**
 * The only catalog skills that can decide a content match, so just those are checked: a sha's
 * single published skill, its high-confidence same-repo canonical skill, or skills from the
 * copy's own repo. Popular content copied into dozens of repos never fetches them all.
 */
export function contentMatchCandidates(
  history: ShaHistoryAsset,
  copies: readonly { skillMdSha?: string | null; githubUrl?: string | null }[],
): string[] {
  return copies.flatMap((copy) => {
    const sha = copy.skillMdSha?.trim().toLowerCase();
    const raw: unknown = sha ? history.shaToSkillIds[sha] : undefined;
    const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    // A few historical IDs (a fork, a moved skill): check them all, so the one still live is found.
    if (ids.length <= FEW_CANDIDATES) return ids;
    const canonical = history.canonicalBySha?.[sha!];
    const repo = repoOf(copy.githubUrl);
    return [
      ...(canonical?.confidence === "high" && canonical.reason === "same-repo" && typeof canonical.skillId === "string" ? [canonical.skillId] : []),
      ...(repo ? ids.filter((id) => id.split(":")[0].toLowerCase() === repo) : []),
    ];
  });
}

/** Up to this many skills sharing one SKILL.md are all checked; more (popular content copied around) aren't. */
const FEW_CANDIDATES = 6;

/**
 * The library skill a copy installed outside omgskills is, by its content: its SKILL.md is
 * byte-for-byte one of that skill's published versions. When the copy comes from a known GitHub
 * repo, only that repo's skills count (and its folder decides between them); otherwise the content
 * must point to one live skill, or a high-confidence canonical one. Anything unclear stays unlinked.
 */
export function catalogSkillForContent(
  skillMdSha: string | null | undefined,
  identity: PublishedCatalogIdentity | null,
  source: { githubUrl?: string | null; gitRelativePath?: string | null } = {},
): string | null {
  if (!skillMdSha || !identity?.shaHistory) return null;
  const raw: unknown = identity.shaHistory.shaToSkillIds[skillMdSha.trim().toLowerCase()];
  const live: string[] = [...new Set((Array.isArray(raw) ? raw : [])
    .filter((id): id is string => typeof id === "string" && identity.liveSkillIds.has(id)))];
  if (!live.length) return null;
  const repo = repoOf(source.githubUrl);
  const sameRepo = repo ? live.filter((id) => id.split(":")[0].toLowerCase() === repo) : [];
  if (sameRepo.length) {
    if (sameRepo.length === 1) return sameRepo[0];
    // Several folders in the copy's repo share this content: its own folder decides, or none.
    const path = source.gitRelativePath?.replace(/^\/+|\/+$/g, "").toLowerCase() ?? "";
    const samePath = sameRepo.filter((id) => id.split(":").slice(1).join(":").toLowerCase() === path);
    return samePath.length === 1 ? samePath[0] : null;
  }
  const resolution = resolveCatalogSkillId(skillMdSha, identity);
  return resolution.status === "resolved" ? resolution.catalogSkillId : null;
}

/**
 * A Mac's catalog hint is only a claim. It names the catalog skill when that skill is still
 * published and the reported SKILL.md is one of its published versions.
 */
export function verifiedCatalogHint(
  hint: string | null | undefined,
  skillMdSha: string | null | undefined,
  identity: PublishedCatalogIdentity | null,
): string | null {
  const normalizedSha = skillMdSha?.trim().toLowerCase() ?? "";
  if (!hint || !gitBlobShaPattern.test(normalizedSha) || !identity?.shaHistory || !identity.liveSkillIds.has(hint)) {
    return null;
  }
  const mappedIds = identity.shaHistory.shaToSkillIds[normalizedSha];
  return Array.isArray(mappedIds) && mappedIds.includes(hint) ? hint : null;
}

export function groupItemForValidatedGithubSkill(
  skill: ValidatedGithubSkill,
  identity: PublishedCatalogIdentity | null,
): ResolvedGroupItem {
  const resolution = resolveCatalogSkillId(skill.skillMdSha, identity);
  const snapshot = {
    githubUrl: skill.githubUrl,
    name: skill.name,
    description: skill.description,
  };
  return resolution.status === "resolved"
    ? {
        kind: "catalog",
        catalogSkillId: resolution.catalogSkillId,
        ...snapshot,
      }
    : {
        kind: "github",
        ...snapshot,
      };
}
