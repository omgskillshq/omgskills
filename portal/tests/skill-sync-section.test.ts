import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillSyncSection, type CloudInfo } from "../src/app/unified/CloudStatus";
import { SyncSettings } from "../src/cloud-save/SyncSettings";
import { cloudSkillRows, type CloudSaveState } from "../src/cloud-save/cloud-save";
import type { SyncedSkill } from "../src/synced-skill-grouping";

const copy = (key: string, setCount = 0, versionCount = 2) => ({
  key, versionCount, setCount, deletedLocallyAt: null,
  currentVersion: { id: `r-${key}`, savedAt: "2026-11-03T10:00:00Z", fileCount: 1, totalBytes: 10, labels: ["download_and_run" as const] },
});
const state = (overrides: Partial<CloudSaveState> = {}): CloudSaveState => ({
  settings: { enabled: true, excludedSkillKeys: [] }, usage: { bytes: 10, limitBytes: 1024 ** 3 },
  skills: [copy("notes", 1), copy("notes@codex", 2, 3)], needsReview: [], skipped: {}, ...overrides,
});
const installed = (name: string, folder = name, source = "claude"): SyncedSkill => ({
  id: `${source}:${folder}`, name, description: null, githubUrl: null, isLocalOnly: true, source, lastSeenAt: "2026-11-01",
  deviceId: "mac", installationFolder: folder,
}) as SyncedSkill;
const info = (cloudState: CloudSaveState): CloudInfo => ({ state: cloudState, confirm: async () => {}, remove: async () => {}, leaveOut: async () => {}, deleteSynced: async () => {} });
const render = (cloudState: CloudSaveState, keys: string[], props: { installed?: boolean; editable?: boolean } = {}) => {
  const row = cloudSkillRows(cloudState, [installed("notes")]).find(item => item.key === keys[0]) ?? null;
  return renderToStaticMarkup(createElement(SkillSyncSection, { row, keys, cloud: info(cloudState),
    installed: props.installed ?? true, editable: props.editable ?? true }));
};

test("a synced skill's panel says how it syncs, with its labels, switch and delete", () => {
  const html = render(state(), ["notes"]);
  assert.match(html, /Synced · 2 versions · last synced/);
  assert.match(html, /Downloads and runs code/);
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.match(html, /Delete synced copy/);
});

test("a skill no Mac has, or one you can't edit, shows its sync but no switch or delete", () => {
  for (const html of [render(state(), ["notes"], { installed: false }), render(state(), ["notes"], { editable: false })]) {
    assert.match(html, /Synced/);
    assert.doesNotMatch(html, /role="switch"/);
    assert.doesNotMatch(html, /Delete synced copy/);
  }
});

test("with sync off, the panel says so and offers no switch", () => {
  const html = render(state({ settings: { enabled: false, excludedSkillKeys: [] } }), ["notes"]);
  assert.match(html, /Sync is off/);
  assert.doesNotMatch(html, /role="switch"/);
});

test("the switch is off only when every folder is left out, and a partly left-out skill says so", () => {
  const all = render(state({ settings: { enabled: true, excludedSkillKeys: ["notes", "notes@codex"] } }), ["notes", "notes@codex"]);
  assert.match(all, /aria-checked="false"/);
  const part = render(state({ settings: { enabled: true, excludedSkillKeys: ["notes@codex"] } }), ["notes", "notes@codex"]);
  assert.match(part, /aria-checked="true"/);
  assert.match(part, /Left out in 1 of its 2 folders/);
});

test("the profile lists the skills left out, and says when sync isn't available or still loading", () => {
  const skills = [installed("notes"), installed("deploy")];
  const left = renderToStaticMarkup(createElement(SyncSettings, { state: state({ skills: [],
    settings: { enabled: true, excludedSkillKeys: ["deploy"] } }), status: "ready", skills, find: () => {} }));
  assert.match(left, /Left out of sync:.*deploy/);
  assert.match(renderToStaticMarkup(createElement(SyncSettings, { state: null, status: "unavailable", skills })), /isn&#x27;t available yet/);
  assert.match(renderToStaticMarkup(createElement(SyncSettings, { state: null, status: null, skills })), /Loading sync/);
  assert.match(renderToStaticMarkup(createElement(SyncSettings, { state: null, status: "error", skills })), /couldn&#x27;t be loaded/);
});
