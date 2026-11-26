import assert from "node:assert/strict";
import test from "node:test";
import { cloudSkillRows, type CloudSaveState } from "../src/cloud-save/cloud-save";
import { notInstalledSkills, skillDisplays } from "../src/app/unified/model";

const source = { repo: "janestreet/agent_skills", folder: "socratic-tutor", commitSha: "c".repeat(40), stars: 11700 };

test("a skill added from GitHub, not installed: its repo link, owner photo and stars", () => {
  const state = { settings: { enabled: true, excludedSkillKeys: [] }, usage: { bytes: 0, limitBytes: 1 }, needsReview: [], skipped: {},
    skills: [{ key: "socratic-tutor", name: "socratic-tutor", description: "Tutor.", versionCount: 1, deletedLocallyAt: null, githubSource: source,
      currentVersion: { id: "v", savedAt: "2026-11-26T00:00:00Z", fileCount: 1, totalBytes: 1 } },
    { key: "uploaded", description: "", versionCount: 1, deletedLocallyAt: null, githubSource: null,
      currentVersion: { id: "u", savedAt: "2026-11-26T00:00:00Z", fileCount: 1, totalBytes: 1 } }] } as unknown as CloudSaveState;
  const rows = cloudSkillRows(state, []);
  assert.deepEqual(rows.find(row => row.key === "socratic-tutor")?.githubSource, { repo: "janestreet/agent_skills", folder: "socratic-tutor", stars: 11700 });
  const shown = notInstalledSkills(rows, [], [], skill => [skill.cloudKey ?? ""]);
  const tutor = shown.find(skill => skill.key === "cloud:socratic-tutor")!;
  const uploaded = shown.find(skill => skill.key === "cloud:uploaded")!;
  assert.equal(tutor.githubUrl, "https://github.com/janestreet/agent_skills");
  assert.equal(tutor.avatar, "https://github.com/janestreet.png?size=80");
  assert.equal(tutor.stars, 11700);
  assert.equal(uploaded.githubUrl, null);
  assert.equal(uploaded.avatar, undefined);
});

test("an installed skill from GitHub that isn't in the library: owner photo and the stars from when it was added", () => {
  const copy = (id: string, extra = {}) => ({ id, name: id, description: null, githubUrl: null, isLocalOnly: false, source: "claude",
    lastSeenAt: "2026-11-26T00:00:00Z", ...extra });
  const { mine } = skillDisplays({ skills: [
    copy("tutor", { githubUrl: "https://github.com/janestreet/agent_skills", githubStars: 11700 }),
    copy("cloned", { githubUrl: "https://github.com/me/skills" }),
    copy("local", { isLocalOnly: true }),
  ] } as never, { skills: [] } as never);
  const by = Object.fromEntries(mine.map(skill => [skill.name, skill]));
  assert.equal(by.tutor.avatar, "https://github.com/janestreet.png?size=80");
  assert.equal(by.tutor.stars, 11700);
  assert.equal(by.cloned.avatar, "https://github.com/me.png?size=80");
  assert.equal(by.cloned.stars, undefined);
  assert.equal(by.local.avatar, undefined);
});
