import assert from "node:assert/strict";
import test from "node:test";
import { loadSetData } from "../src/integration/data";
import { cloudSharedLabel, setSkillDisplays } from "../src/app/unified/model";
import { cloudSkillRows, setsNote, type CloudSaveState } from "../src/cloud-save/cloud-save";
import { updateMembershipItem } from "../src/integration/membership-data";

const group = { id: "set-1", name: "Team", description: "", visibility: "restricted", isFavorites: false, ownerDisplayName: "Jon" };
const items = [
  { id: "a", kind: "synced", name: "notes", description: "", githubUrl: null, position: 0, cloudShared: true, updateAvailable: true },
  { id: "b", kind: "catalog", catalogSkillId: "owner/repo:pdf", name: "pdf", description: "", githubUrl: null, position: 1 },
];

test("a skill shared from cloud save is marked in the Set; only the owner hears about a newer version", async () => {
  const owner = await loadSetData(async <T>() => ({ group, accessRole: "owner", items }) as T, "set-1");
  assert.equal(owner.items[0].cloudShared, true);
  assert.equal(owner.items[0].updateAvailable, true);
  assert.equal(owner.items[1].cloudShared, undefined);
  const member = await loadSetData(async <T>() => ({ group, accessRole: "invited", items }) as T, "set-1");
  assert.equal(member.items[0].cloudShared, true);
  assert.equal(member.items[0].updateAvailable, undefined);

  const [shared] = setSkillDisplays(owner, []);
  assert.equal(shared.setItemCloudShared, true);
  assert.equal(shared.setItemUpdateAvailable, true);
  assert.equal(cloudSharedLabel(shared, "owner"), "Shared from My skills · newer version synced");
  assert.equal(cloudSharedLabel({ ...shared, setItemUpdateAvailable: undefined }, "owner"), "Shared from My skills");
  assert.equal(cloudSharedLabel(setSkillDisplays(member, [])[0], "invited"), "Private skill · installs with the Set");
});

test("Update Set calls the item route and checks the answer", async () => {
  const calls: string[] = [];
  await updateMembershipItem(async <T>(path: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${path} ${init?.body}`);
    return { itemId: "a", releaseId: "r2", updated: true } as T;
  }, "set-1", "a", new AbortController().signal);
  assert.deepEqual(calls, ['PATCH /api/portal/groups/set-1/items {"updateItemId":"a"}']);
  await assert.rejects(updateMembershipItem(async <T>() => ({ itemId: "other" }) as T, "set-1", "a", new AbortController().signal));
});

test("deleting a skill shared in Sets says so", () => {
  assert.equal(setsNote(0), "");
  assert.equal(setsNote(1), " It's also taken out of 1 Set; people keep what they installed.");
  assert.equal(setsNote(3), " It's also taken out of 3 Sets; people keep what they installed.");
  const state: CloudSaveState = {
    settings: { enabled: true, excludedSkillKeys: [] }, usage: { bytes: 0, limitBytes: 1 }, needsReview: [], skipped: {},
    skills: [{ key: "notes", versionCount: 1, deletedLocallyAt: null, setCount: 2,
      currentVersion: { id: "r1", savedAt: "2026-11-03T10:00:00Z", fileCount: 1, totalBytes: 1 } }],
  };
  assert.equal(cloudSkillRows(state, [])[0].setCount, 2);
});

test("people a Set is shared with can read a private item's instructions from its version", async () => {
  const releaseId = "22222222-2222-4222-8222-222222222222";
  const shared = [{ ...items[0], sharedReleaseId: releaseId }, { ...items[1], sharedReleaseId: "not an id" }];
  const member = await loadSetData(async <T>() => ({ group, accessRole: "invited", items: shared }) as T, "set-1");
  assert.equal(member.items[0].sharedReleaseId, releaseId);
  assert.equal(member.items[1].sharedReleaseId, undefined, "Only a well-formed version ID is kept");
  const [row] = setSkillDisplays(member, []);
  assert.equal(row.setItemReleaseId, releaseId);
  const paths: string[] = [];
  const { loadSharedSkillMd } = await import("../src/cloud-save/cloud-save");
  await loadSharedSkillMd(async <T>(path: string) => { paths.push(path); return { markdown: "# x", truncated: false } as T; },
    releaseId, new AbortController().signal);
  assert.deepEqual(paths, [`/api/portal/private-releases/${releaseId}/skill-md`]);
  // Access taken away: the next open asks the server again and shows nothing it no longer allows.
  await assert.rejects(loadSharedSkillMd(async <T>(path: string) => { paths.push(path); throw new Error("404") as T; },
    releaseId, new AbortController().signal));
  assert.equal(paths.length, 2, "Never answered from an earlier read");
});

test("a saved skill's versions list newest first, and Restore opens the Mac app with that version", async () => {
  const { loadSavedVersions, restoreVersionLink } = await import("../src/cloud-save/cloud-save");
  const { PortalApiError } = await import("../src/api-error");
  const paths: string[] = [];
  const saved = await loadSavedVersions(async <T>(path: string) => {
    paths.push(path);
    if (path.includes("/notes-copy/")) throw new PortalApiError("Not found", 404);
    if (path.includes("/notes-short/")) return { versions: [{ id: "only", savedAt: "2026-11-04T10:00:00Z" }] } as T;
    return { versions: [{ id: "r2", savedAt: "2026-11-04T10:00:00Z", treeSha: "t" }, { id: "r1", savedAt: "2026-11-01T10:00:00Z" }] } as T;
  }, ["notes-copy", "notes-short", "notes"], new AbortController().signal);
  assert.deepEqual(paths, ["/api/portal/cloud-save/skills/notes-copy/versions", "/api/portal/cloud-save/skills/notes-short/versions",
    "/api/portal/cloud-save/skills/notes/versions"], "Shows the folder with the most history");
  assert.deepEqual(saved, { key: "notes", versions: [{ id: "r2", savedAt: "2026-11-04T10:00:00Z" }, { id: "r1", savedAt: "2026-11-01T10:00:00Z" }] });
  assert.equal(restoreVersionLink(" my notes ", "my notes", "22222222-2222-4222-8222-222222222222"),
    "omgskills://restore?name=my%20notes&key=my%20notes&version=22222222-2222-4222-8222-222222222222");
});

test("a private Set item carries its scan to the row; unreadable results are dropped, never shown as clean", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { SetItemScan } = await import("../src/app/unified/SetItemScan");
  const release = "00000000-0000-4000-8000-000000000001";
  const flagged = { status: "flagged", scannedAt: "2026-11-21T10:00:00.000Z", findingCount: 3,
    findings: [{ rule: "download_and_run", label: "download_and_run", severity: "high", path: "SKILL.md", line: 37, text: "dropped" }] };
  const withScan = (scan: unknown) => [{ ...items[0], sharedReleaseId: release, scan }];
  const load = (scan: unknown) => loadSetData(async <T>() => ({ group, accessRole: "invited", items: withScan(scan) }) as T, "set-1");

  const set = await load(flagged);
  assert.deepEqual(set.items[0].scan, { status: "flagged", scannedAt: flagged.scannedAt, findingCount: 3,
    findings: [{ rule: "download_and_run", label: "download_and_run", severity: "high", path: "SKILL.md", line: 37 }] });
  assert.deepEqual(setSkillDisplays(set, [])[0].setItemScan, set.items[0].scan);
  assert.equal((await load(null)).items[0].scan, null, "not scanned yet");
  assert.equal((await load({ status: "safe", scannedAt: "x" })).items[0].scan, undefined, "an unknown status shows nothing");
  assert.equal((await load(undefined)).items[0].scan, undefined, "older servers send none");

  const html = (scan: Parameters<typeof SetItemScan>[0]["scan"]) => renderToStaticMarkup(createElement(SetItemScan, { scan }));
  const flaggedHtml = html(set.items[0].scan!);
  assert.match(flaggedHtml, /Worth a look before you install/);
  assert.match(flaggedHtml, /Downloads and runs code/);
  assert.match(flaggedHtml, /SKILL\.md, line 37/);
  assert.match(flaggedHtml, /And 2 more/);
  assert.doesNotMatch(flaggedHtml, /dropped/);
  assert.match(html({ status: "clean", scannedAt: flagged.scannedAt, findings: [], findingCount: 0 }), /Team-safe/);
  assert.match(html({ status: "incomplete", scannedAt: flagged.scannedAt }), /Scan didn&#x27;t finish/);
  assert.match(html(null), /Not scanned yet/);
  const unfinished = html({ status: "incomplete", scannedAt: flagged.scannedAt, findingCount: 1, findings: [flagged.findings[0]] });
  assert.match(unfinished, /Worth a look before you install/, "an unfinished scan still lists what it found");
  assert.match(unfinished, /there may be more/);
  // "Team-safe" is the one badge (for sharing, with what was checked beside it); nothing claims a skill is safe.
  const clean = html({ status: "clean", scannedAt: flagged.scannedAt });
  assert.doesNotMatch(clean.replace("<strong>Team-safe</strong>", ""), /verified safe|\bsafe\b|<strong>[^<]*safe/i, "never claims a skill is safe");
  assert.match(clean, /pattern check, not a guarantee/);
  // The owner's own email is advice for them, not a warning to the people installing.
  const email = { rule: "personal_email", label: "personal_email", severity: "medium", path: "SKILL.md", line: 3 };
  const advice = html({ status: "flagged", scannedAt: flagged.scannedAt, findingCount: 1, findings: [email] });
  assert.match(advice, /No issues found/);
  assert.doesNotMatch(advice, /Worth a look|email address/i);
  const mixed = html({ status: "flagged", scannedAt: flagged.scannedAt, findingCount: 2, findings: [email, flagged.findings[0]] });
  assert.match(mixed, /Worth a look before you install/);
  assert.doesNotMatch(mixed, /email address|And \d+ more/i);
  // The Set's header uses the same view, so it never warns about a skill whose panel says no issues.
  const { installerView } = await import("../src/cloud-save/scan-findings");
  assert.equal(installerView({ status: "flagged", scannedAt: flagged.scannedAt, findingCount: 1, findings: [email] }).clean, true);
  assert.equal(installerView({ status: "flagged", scannedAt: flagged.scannedAt, findingCount: 2, findings: [email] }).clean, false);
});
