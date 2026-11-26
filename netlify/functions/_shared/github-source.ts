/*
 * Where a skill added on the web from GitHub came from (cloud_saved_skills.github_source): kept so the
 * skill shows its creator, GitHub link and stars instead of showing as unknown. Stars are as of the add.
 */

export type GithubSource = {
  /** owner/repo. */
  repo: string;
  /** The skill's folder in the repo, "" at the root. */
  folder: string;
  commitSha: string;
  stars?: number;
};

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

/** A stored or incoming source, checked; null when it isn't a whole, sane one. */
export function parseGithubSource(value: unknown): GithubSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { repo, folder, commitSha, stars } = value as Record<string, unknown>;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof commitSha !== "string" || !SHA.test(commitSha)) return null;
  if (typeof folder !== "string" || folder.length > 500 || /[\\\u0000-\u001f\u007f]/.test(folder)
    || (folder && folder.split("/").some(part => !part || part === "." || part === ".."))) return null;
  return { repo, folder, commitSha, ...(typeof stars === "number" && Number.isSafeInteger(stars) && stars >= 0 ? { stars } : {}) };
}
