// Which cloud save record each installed skill uses. The Mac applies the same rule (CloudSaveKeys.swift) and
// also remembers each skill's key, so a key never moves to another skill.

/** A folder or skill name as cloud save compares it: NFC and lower case, untrimmed. */
export function cloudNameKey(name: string) {
  return name.normalize("NFC").toLowerCase();
}

/** Longest cloud save key the server takes. */
const MAX_KEY_LENGTH = 200;

export type KeyedInstallation = { deviceId?: string | null; isCurrent?: boolean; source: string; name: string;
  installationFolder?: string | null };

/** A saved skill: its key, and its SKILL.md name as cloud save compares it (null when saved before names were kept). */
export type CloudRecordName = { key: string; name: string | null };

/** The keys a skill in this folder may use, in order: the folder name, then "<folder>@<agent>", "<folder>@<agent>-2", … */
export function candidateKey(folder: string, agent: string, index: number) {
  if (index === 0) return folder;
  const suffix = `@${agent}${index > 1 ? `-${index}` : ""}`;
  // Whole code points within the server's limit (UTF-16 units), as the Mac counts them.
  let base = "";
  for (const point of folder) {
    if (base.length + point.length + suffix.length > MAX_KEY_LENGTH) break;
    base += point;
  }
  return `${base}${suffix}`;
}

/** Whether a key is one of this folder's candidates, including ones whose folder part was cut to fit. */
function belongsToFolder(key: string, folder: string) {
  if (key === folder || key.startsWith(`${folder}@`)) return true;
  const at = key.lastIndexOf("@");
  const suffix = at < 0 ? null : /^(.+?)(?:-([0-9]+))?$/.exec(key.slice(at + 1));
  return !!suffix && candidateKey(folder, suffix[1], suffix[2] ? Number(suffix[2]) : 1) === key;
}

/** Where a skill is on its Mac, as the Mac names it in its key report: "<agent>/<folder>". */
export function cloudKeyLocation(source: string, folder: string) {
  return `${source.trim().toLowerCase()}/${folder}`;
}

/** A key a Mac used for one skill folder, and the SKILL.md name of the skill that was in it. */
export type ReportedCloudKey = { key: string; name: string };
/** Each Mac's own keys from its last pass, by device ID, then by `cloudKeyLocation`. */
export type ReportedCloudKeys = ReadonlyMap<string, Readonly<Record<string, ReportedCloudKey>>>;

/**
 * A skill's cloud key is the one its Mac reported using for that folder on its last pass, while the same skill
 * (by SKILL.md name) is still there: the Mac decides (it also remembers keys, which nothing here can work out).
 * Otherwise it's worked out the same way the Mac does: its folder name, unless that key holds a different skill. Then:
 * 1. A saved skill with the same SKILL.md name under this folder's keys is this skill (its folder name first).
 * 2. Otherwise, the skills in same-name folders on one Mac are told apart by SKILL.md name. The one named like
 *    its folder chooses first (else the one in the first agent alphabetically), and each takes the first key
 *    no other skill holds: the folder name, then "<folder>@<its first agent>", then "-2", "-3"…
 */
export function cloudSkillKeys<T extends KeyedInstallation>(installations: T[], records: CloudRecordName[] = [],
  reported: ReportedCloudKeys = new Map()): Map<T, string> {
  const keys = new Map<T, string>();
  const taken = new Map<string, string>();
  for (const record of records) if (record.name) taken.set(record.key, record.name);
  // A Mac's current copies take the keys it reported, unless another skill has since replaced the one that was
  // in the folder (the report is from the Mac's last finished pass). The rest are worked out around them.
  const claimed = new Map<string, string>();
  const fromMac = (skill: T) => {
    if (skill.isCurrent === false || !skill.deviceId || !skill.installationFolder) return undefined;
    const entry = reported.get(skill.deviceId)?.[cloudKeyLocation(skill.source, skill.installationFolder)];
    return entry && cloudNameKey(entry.name) === cloudNameKey(skill.name) ? entry.key : undefined;
  };
  for (const skill of installations) {
    const key = fromMac(skill);
    if (!key) continue;
    keys.set(skill, key);
    const name = cloudNameKey(skill.name) || cloudNameKey(skill.installationFolder || skill.name);
    taken.set(key, name);
    claimed.set(key, name);
  }
  const groups = new Map<string, T[]>();
  installations.forEach((skill, index) => {
    if (keys.has(skill)) return;
    const folder = cloudNameKey(skill.installationFolder || skill.name);
    const name = cloudNameKey(skill.name) || folder;
    keys.set(skill, folder);
    if (!folder) return;
    // A saved skill's key that a Mac reported for another skill is that one's (a rename not saved yet).
    const saved = records.filter(record => record.name === name && belongsToFolder(record.key, folder)
      && (claimed.get(record.key) ?? name) === name)
      .map(record => record.key).sort((a, b) => Number(b === folder) - Number(a === folder) || order(a, b))[0];
    if (saved) { keys.set(skill, saved); return; }
    // Only one Mac's current copies can collide; older rows and copies from nowhere are on their own.
    const id = skill.isCurrent === false || skill.deviceId == null ? `\u0001${index}` : `${skill.deviceId}\u0000${folder}`;
    groups.set(id, [...(groups.get(id) ?? []), skill]);
  });
  for (const group of groups.values()) {
    const folder = keys.get(group[0])!;
    const byName = new Map<string, T[]>();
    for (const skill of group) {
      const name = cloudNameKey(skill.name) || folder;
      byName.set(name, [...(byName.get(name) ?? []), skill]);
    }
    const firstAgent = (copies: T[]) => copies.map(copy => copy.source.toLowerCase()).sort()[0] ?? "";
    const clusters = [...byName.entries()].sort(([nameA, a], [nameB, b]) =>
      Number(nameB === folder) - Number(nameA === folder) || order(firstAgent(a), firstAgent(b)) || order(nameA, nameB));
    for (const [name, copies] of clusters) {
      let index = 0;
      let key = folder;
      for (;;) {
        key = candidateKey(folder, firstAgent(copies), index);
        const holder = taken.get(key);
        if (holder === undefined || holder === name) break;
        index += 1;
      }
      taken.set(key, name);
      for (const copy of copies) keys.set(copy, key);
    }
  }
  return keys;
}

/** Plain code-unit order, as the Mac sorts. */
function order(x: string, y: string) {
  return x < y ? -1 : x > y ? 1 : 0;
}
