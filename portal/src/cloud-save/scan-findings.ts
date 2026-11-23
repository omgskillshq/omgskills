// Plain words for what the background scan found, and a note to hand to your agent. The scan
// matches patterns, so a finding is something worth a look, never proof a skill is harmful.

import type { CloudScan, CloudScanFinding } from "./cloud-save";

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
  personal_email: {
    title: "An email address",
    usuallyFine: "Often your own address in a license, or an example. Remove it if teammates shouldn't see it.",
  },
  home_folder: {
    title: "A path into someone's home folder",
    usuallyFine: "Teammates won't have this folder. Use ~ or a path inside the skill instead.",
  },
  internal_address: {
    title: "An address only your network can reach",
    usuallyFine: "Fine if your team is on the same network; otherwise teammates can't reach it.",
  },
};

/** Advice for the person sharing (their email, a home-folder path), not a reason for others to hold off installing. */
export const SHARING_ONLY = new Set(["personal_email", "home_folder", "internal_address"]);

/**
 * A Set item's scan as the people installing it see it: sharing advice left out. `clean` when that
 * advice was all it found (and all of it is listed, so nothing else could be hiding).
 */
export function installerView(scan: CloudScan): { findings: CloudScanFinding[]; total: number; clean: boolean } {
  const listed = scan.findings ?? [];
  const findings = listed.filter(finding => !SHARING_ONLY.has(finding.label));
  const advice = listed.length - findings.length;
  const total = Math.max(0, (scan.findingCount ?? listed.length) - advice);
  return { findings, total, clean: scan.status === "clean" || (scan.status === "flagged" && advice > 0 && total === 0) };
}

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

export type FlaggedSkill = {
  name: string;
  /** Where its flagged copies are usually installed, on whichever computer has them. */
  folders: string[];
  findings: CloudScanFinding[];
  /** Findings found but not listed. */
  more: number;
};

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
    "Line numbers are from the copy saved to omgskills; if your copy changed since, look near that line. A folder may be on another of my computers; if it isn't here, say so.",
    "If something is a real key or password, tell me which file it's in but don't repeat it. Don't change any files until I say so.",
    "",
  ];
  skills.forEach((skill, index) => {
    const where = skill.folders.length ? ` (usually at ${skill.folders.join(" or ")})` : " (saved in omgskills, not installed)";
    lines.push(`${index + 1}. ${skill.name}${where}`);
    for (const finding of skill.findings) lines.push(`   - ${findingPlace(finding)}: ${findingInfo(finding).title.toLowerCase()}`);
    if (skill.more) lines.push(`   - And ${skill.more} more not listed here; look over the rest of the skill's files too.`);
    if (!skill.findings.length && !skill.more) lines.push("   - The details aren't available yet; look over the skill's files.");
  });
  return lines.join("\n");
}

const SCAN_STATUSES = new Set(["clean", "flagged", "incomplete"]);

/**
 * A scan result from the server, checked: null when it hasn't been scanned, undefined when there's none to
 * show (an older server, or something unreadable, which is never shown as clean).
 */
export function parseScan(value: unknown): CloudScan | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const scan = value as Record<string, unknown>;
  if (typeof scan.status !== "string" || !SCAN_STATUSES.has(scan.status) || typeof scan.scannedAt !== "string") return undefined;
  const findings = Array.isArray(scan.findings) ? scan.findings.flatMap((item): CloudScanFinding[] => {
    if (!item || typeof item !== "object") return [];
    const { rule, label, severity, path, line } = item as Record<string, unknown>;
    if (typeof rule !== "string" || typeof label !== "string" || typeof severity !== "string" || typeof path !== "string") return [];
    return [{ rule, label, severity, path, line: typeof line === "number" && Number.isInteger(line) ? line : null }];
  }) : [];
  const findingCount = typeof scan.findingCount === "number" && scan.findingCount >= findings.length ? scan.findingCount : findings.length;
  return { status: scan.status as CloudScan["status"], scannedAt: scan.scannedAt, findings, findingCount };
}
