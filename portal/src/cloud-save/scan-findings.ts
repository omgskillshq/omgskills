// Plain words for what the background scan found, and a note to hand to your agent. The scan
// matches patterns, so a finding is something worth a look, never proof a skill is harmful.

import type { CloudScanFinding } from "./cloud-save";

export type FindingInfo = {
  /** What was matched, in a few words. */
  title: string;
  /** When it's usually nothing to worry about. */
  usuallyFine: string;
};

const INFO: Record<string, FindingInfo> = {
  secret: {
    title: "Looks like a key or password",
    usuallyFine: "Often an example, like a sample password in a “don't do this” snippet.",
  },
  download_and_run: {
    title: "Downloads and runs code",
    usuallyFine: "Often a tool's official install step, like curl … | sh.",
  },
  hidden_instructions: {
    title: "Instructions aimed at the agent",
    usuallyFine: "Often a skill warning against tricks like “ignore previous instructions”.",
  },
  invisible_characters: {
    title: "Invisible characters",
    usuallyFine: "Often a stray character left by copy and paste.",
  },
};

export function findingInfo(finding: Pick<CloudScanFinding, "label">): FindingInfo {
  return INFO[finding.label] ?? { title: "Matched one of our checks", usuallyFine: "Worth a quick look." };
}

/** Where a finding is: the file, and its line when there is one. */
export function findingPlace(finding: Pick<CloudScanFinding, "path" | "line">) {
  return finding.line ? `${finding.path}, line ${finding.line}` : finding.path;
}

const AGENT_FOLDERS: Record<string, string> = {
  claude: "~/.claude/skills",
  "claude code": "~/.claude/skills",
  codex: "~/.codex/skills",
  agents: "~/.agents/skills",
};

/** The usual folder of an installed copy, for the agent to look in; null when we can't tell. */
export function skillFolder(copy: { source: string; installationFolder?: string | null; name: string }): string | null {
  const root = AGENT_FOLDERS[copy.source.trim().toLowerCase()];
  return root ? `${root}/${copy.installationFolder || copy.name}` : null;
}

export type FlaggedSkill = { name: string; folders: string[]; findings: CloudScanFinding[] };

/**
 * A note to paste into your agent: what was found where, that it's only a pattern match, and to
 * explain and recommend before changing anything. Never asks the agent to repeat a key.
 */
export function agentReviewPrompt(skills: FlaggedSkill[]): string {
  const lines = [
    `omgskills' safety scan flagged ${skills.length === 1 ? "this skill" : `these ${skills.length} skills`} for a closer look. The scan only matches patterns, so most flags turn out fine (an example key, an install command, a skill that warns about prompt tricks). A flag doesn't mean a skill is harmful.`,
    "",
    "For each finding below, open the file at that line and tell me:",
    "1. In one sentence, what the line does.",
    "2. Your call: fine as is, worth a small edit, or remove the skill. Say why.",
    "If something is a real key or password, tell me which file it's in but don't repeat it. Don't change any files until I say so.",
    "",
  ];
  skills.forEach((skill, index) => {
    const where = skill.folders.length ? ` (${skill.folders.join(", ")})` : " (saved in omgskills, not installed here)";
    lines.push(`${index + 1}. ${skill.name}${where}`);
    for (const finding of skill.findings) lines.push(`   - ${findingPlace(finding)}: ${findingInfo(finding).title.toLowerCase()}`);
    if (!skill.findings.length) lines.push("   - The details aren't available yet; look over the skill's files.");
  });
  return lines.join("\n");
}
