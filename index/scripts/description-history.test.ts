import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDescriptionHistory, namedKey, pruneDescriptionHistoryAssets, writeDescriptionHistoryAsset } from "./description-history.js";

const skill = (id: string, description: string, name = "qa") => ({ id, name, description });

test("records a skill's earlier description when it changes, never its current one", () => {
  const before = [skill("garrytan/gstack:qa", "Systematically QA test a web application."), skill("fork/r:qa", "Systematically QA test a web application.")];
  const after = [skill("garrytan/gstack:qa", "Fix browser bugs."), skill("fork/r:qa", "Systematically QA test a web application.")];
  const built = buildDescriptionHistory([], before, after, "t");
  assert.deepEqual(built.keysById, { "garrytan/gstack:qa": [namedKey("qa", "Systematically QA test a web application.")] });
  // Kept on later runs; when the old description comes back it's current again, and the other one is earlier.
  assert.deepEqual(buildDescriptionHistory([built], after, after, "t2").keysById, built.keysById);
  assert.deepEqual(buildDescriptionHistory([built], after, before, "t3").keysById, { "garrytan/gstack:qa": [namedKey("qa", "Fix browser bugs.")] });
  // A skill that's gone is dropped.
  assert.deepEqual(buildDescriptionHistory([built], after, [after[1]], "t4").keysById, {});
});

test("merges every source, ignores malformed keys, and works without a previous catalog", () => {
  const key = namedKey("qa", "Old.")!;
  const built = buildDescriptionHistory([{ keysById: { "a/b:qa": [key, "nd:nope", 5 as never] } }, null, { keysById: { "a/b:qa": [key] } }],
    null, [skill("a/b:qa", "New.")], "t");
  assert.deepEqual(built.keysById, { "a/b:qa": [key] });
  assert.equal(namedKey("  QA ", "Old.\n"), key, "Whitespace and case don't matter, as in the match index");
});

test("assets are content-named; pruning keeps the current and previous ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "description-history-"));
  try {
    const first = writeDescriptionHistoryAsset(dir, { version: 1, generatedAt: "a", keysById: {} });
    const second = writeDescriptionHistoryAsset(dir, { version: 1, generatedAt: "b", keysById: { "a/b:c": [namedKey("c", "d")!] } });
    writeFileSync(join(dir, "description-history-000000000000.json"), "{}");
    writeFileSync(join(dir, "sha-history-000000000000.json"), "{}");
    pruneDescriptionHistoryAssets(dir, [second.path, first.path]);
    assert.deepEqual(readdirSync(dir).sort(), [first.path, second.path, "sha-history-000000000000.json"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
