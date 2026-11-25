import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDescriptionHistory, type DescriptionHistoryAsset } from "./description-history.js";

/*
 * One-time: walks every committed index/skills.json (oldest first) and records each skill's earlier
 * names and descriptions into index/seeds/description-history-backfill.json, which the publish step
 * merges in (see description-history.ts). Usage: npx tsx scripts/backfill-description-history.ts [ref]
 */

const indexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(indexRoot, "..");
const ref = process.argv[2] ?? "origin/main";
const git = (args: string[]) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });

const commits = git(["log", "--reverse", "--format=%H", ref, "--", "index/skills.json"]).trim().split("\n").filter(Boolean);
let history: DescriptionHistoryAsset | null = null;
let previous: unknown[] | null = null;
for (const [index, commit] of commits.entries()) {
  let skills: unknown;
  try { skills = JSON.parse(git(["show", `${commit}:index/skills.json`])); } catch { continue; }
  if (!Array.isArray(skills)) continue;
  // Every skill ever listed is kept until the last step, which keeps only today's.
  const listed = new Set(skills.flatMap((skill) => typeof skill?.id === "string" ? [skill.id] : []));
  const everListed = [...skills, ...Object.keys(history?.keysById ?? {}).filter((id) => !listed.has(id)).map((id) => ({ id }))];
  history = buildDescriptionHistory([history], previous as never, everListed as never, "");
  previous = skills;
  if ((index + 1) % 20 === 0) console.error(`${index + 1}/${commits.length}`);
}
const today = JSON.parse(git(["show", `${ref}:index/skills.json`]));
const result = buildDescriptionHistory([history], previous as never, today, new Date().toISOString());
writeFileSync(join(indexRoot, "seeds", "description-history-backfill.json"), `${JSON.stringify(result)}\n`);
const keys = Object.values(result.keysById).reduce((sum, list) => sum + list.length, 0);
console.log(`${commits.length} catalogs: ${Object.keys(result.keysById).length} skills with ${keys} earlier descriptions`);
