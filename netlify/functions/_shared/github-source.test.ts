import assert from "node:assert/strict";
import test from "node:test";
import { parseGithubSource } from "./github-source.js";

test("a GitHub source is kept only whole and sane", () => {
  const commitSha = "c".repeat(40);
  assert.deepEqual(parseGithubSource({ repo: "janestreet/agent_skills", folder: "socratic-tutor", commitSha, stars: 11700 }),
    { repo: "janestreet/agent_skills", folder: "socratic-tutor", commitSha, stars: 11700 });
  assert.deepEqual(parseGithubSource({ repo: "o/r", folder: "", commitSha, stars: -1 }), { repo: "o/r", folder: "", commitSha });
  for (const bad of [null, "o/r", { repo: "", folder: "", commitSha }, { repo: "o/r", folder: "", commitSha: "" },
    { repo: "o/r/x", folder: "", commitSha }, { repo: "o/r", folder: "../x", commitSha }, { repo: "o/r", commitSha }]) {
    assert.equal(parseGithubSource(bad), null, JSON.stringify(bad));
  }
});
