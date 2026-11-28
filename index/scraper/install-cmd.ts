/** The catalog's install command for a skill: a clone of its repository, linked into the skills folder. */
export function deriveInstallCmd(githubUrl: string, path: string, name: string): string {
  if (path === "SKILL.md") {
    return `git clone ${githubUrl} ~/.claude/skills/${name}`;
  }
  const repoName = githubUrl.split("/").pop() ?? "repo";
  const skillDir = path.replace(/\/SKILL\.md$/, "");
  return `git clone ${githubUrl} /tmp/${repoName} && ln -s /tmp/${repoName}/${skillDir} ~/.claude/skills/${name}`;
}
