import assert from "node:assert/strict";
import test from "node:test";
import { confirmByText, frontmatter, textSimilarity } from "./content-match.js";

const body = (extra = "") => `---\nname: notes\ndescription: Take notes.\n---\n# Notes\nWrite down what was decided in the meeting and who owns each follow up item.${extra}\n`;

test("text similarity: the same instructions score 1, a small edit stays high, unrelated text near 0", () => {
  assert.equal(textSimilarity(body(), body()), 1);
  assert.ok(textSimilarity(body(), body(" Keep it short.")) > 0.7);
  assert.ok(textSimilarity(body(), "Deploy the app to production with the release script and check the logs.") < 0.05);
});

test("frontmatter reads name and description, folded descriptions included", () => {
  assert.deepEqual(frontmatter(body()), { name: "notes", description: "take notes." });
  assert.deepEqual(frontmatter("---\nname: x\ndescription: >\n  Two\n  lines\n---\n"), { name: "x", description: "two lines" });
});

test("linked only when exactly one same-named library skill shares real text", () => {
  const copy = { name: "notes", description: "take notes." };
  const c = (id: string, score: number, description = "take notes.") => ({ id, score, name: "notes", description });
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.35)]), "a/r:notes");
  // Same words on the outside, different instructions inside: not linked.
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.05)]), null);
  // Other description: needs 80% the same text.
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.82, "other"), c("b/r:notes", 0.1, "other")]), "a/r:notes");
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.6, "other")]), null);
  // An original and a fork both share text: the person chooses, however close one reads.
  assert.equal(confirmByText(copy, [c("blader/notes", 0.5, "other"), c("fork/notes", 0.99)]), null);
  assert.equal(confirmByText(copy, [c("a/r:notes", 0.9), c("b/r:notes", 0.31)]), null);
});
