import assert from "node:assert/strict";
import test from "node:test";
import type { SyncedSkill } from "../../../portal/src/synced-skill-grouping.js";
import type { CloudSaveState } from "./cloud-save.js";
import { cloudSummary } from "./cloud-summary.js";
import { portalCloudSave } from "../portal-cloud-save.mjs";

const now = Date.parse("2026-11-26T00:00:00Z");
const copy = (name: string, extra: Partial<SyncedSkill> = {}): SyncedSkill => ({
  id: `${name}-${extra.deviceId ?? "old"}`, name, description: null, githubUrl: null, isLocalOnly: true, source: "claude",
  lastSeenAt: "2026-11-25T00:00:00Z", deviceId: "mac", ...extra,
});
const state = (overrides: Partial<CloudSaveState> = {}) => ({
  settings: { enabled: true, excludedSkillKeys: ["left"] }, usage: { bytes: 0, limitBytes: 1 }, needsReview: [], skipped: { pptx: "links" }, skippedBy: { pptx: "mac" },
  skills: [{ key: "kept", name: "kept", description: null, versionCount: 1, deletedLocallyAt: null, setCount: 0, githubSource: null,
    currentVersion: { savedAt: "2026-11-02T00:00:00.000Z" } }],
  ...overrides,
}) as unknown as CloudSaveState;

test("the counts every screen shows, from the same rules as the web", () => {
  const inventory = [copy("here"), copy("pptx", { catalogSkillId: "a/b:pptx", isLocalOnly: false }), copy("left"),
    copy("other-mac", { deviceId: "mac-2" }), copy("stale", { deviceId: null, lastSeenAt: "2026-09-28T00:00:00Z" })];
  const summary = cloudSummary(state(), { inventory, additions: ["x/y:added"] }, "mac", now);
  assert.deepEqual(summary, { skills: 5, cantSync: 1, notSyncedYet: 2, leftOut: 1, notOnMacs: 1, mySkills: 6, onThisMac: 3 });
  // The web asking: no per-Mac count.
  assert.equal(cloudSummary(state(), { inventory, additions: [] }, null, now).onThisMac, undefined);
});

test("the state carries the counts when they could be read, and is unchanged when they couldn't", async () => {
  const pool = { query: async (sql: string) => ({ rows: sql.includes("AS bytes") ? [{ bytes: "0" }] : [], rowCount: 0 }) };
  const call = (summaryInputs: () => Promise<unknown>, mac?: { query: string }) => portalCloudSave(
    new Request(`https://omgskills.com/api/portal/cloud-save${mac?.query ?? ""}`,
      mac ? { headers: { authorization: `Bearer device_${"a".repeat(43)}` } } : {}), {} as never, {
      available: () => true, pool: () => pool, store: () => { throw new Error("unused"); },
      requireUser: async () => ({ userId: "u", deviceId: null }), requireDevice: async () => ({ userId: "u", deviceId: "mac" }),
      summaryInputs,
    } as never).then((response) => response.json());
  const withCounts = await call(async () => ({ inventory: [copy("here")], additions: [] }));
  // Sync is off in this account (no settings yet), so nothing is waiting to sync.
  assert.deepEqual(withCounts.summary, { skills: 1, cantSync: 0, notSyncedYet: 0, leftOut: 0, notOnMacs: 0, mySkills: 1 });
  assert.equal((await call(async () => null)).summary, undefined);
  // A Mac gets them only when it asks (one that shows them), so older Macs' passes don't pay for the read.
  let reads = 0;
  const counted = async () => { reads += 1; return { inventory: [copy("here")], additions: [] }; };
  assert.equal((await call(counted, { query: "" })).summary, undefined);
  assert.equal(reads, 0);
  assert.equal((await call(counted, { query: "?summary=1" })).summary.onThisMac, 1);
});
