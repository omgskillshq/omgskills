import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { GithubImportError, readGithubSkillFiles } from "./github-skill-import.js";
import { publishedCatalogTracks } from "./published-catalog.js";
import { callScanner, MAX_ATTEMPTS, ScannerCallError, validScanners, type ScanDriverConfig } from "./scan-driver.js";
import { STANDARD_SKILL_PACKAGE_LIMITS, validateSkillManifest } from "./skill-package.js";
import { SHARE_LABELS } from "./skill-scan.js";
import type { ScanRequestFile, ScanResponse, ScannerInfo, ScannerResult } from "../../../scanner/src/protocol.js";

/*
 * Scans public catalog skills in the background, curated ones first: topic collections, then (when
 * turned on) creator picks. Each run: re-read the catalog's curated lists if a new catalog was
 * published, then take skills that some current scanner (our rules, the AI review) has no result
 * for, read their files from GitHub at the commit the catalog pins, and scan them. Results go in
 * skill_scans by content hash, like private skills. A skill the AI review or the rules flag also
 * gets the second look (Opus); what that also flags waits for a person.
 */

export type PublicScanScope = "topics" | "creators";

export type CatalogTarget = {
  catalogSkillId: string;
  repoSlug: string;
  rootPath: string;
  commitSha: string;
  treeSha: string;
  priority: number;
};

export type PublicScanDeps = {
  config: ScanDriverConfig;
  fetch?: typeof fetch;
  now?: () => number;
  /** Names the catalog build (and scope), cheaply: only a new one is read in full. */
  catalogKey(): Promise<string>;
  /** That build's curated skills. Reads the full catalog (about 88 MB). */
  loadTargets(key: string): Promise<CatalogTarget[]>;
  /** A skill's files at its pinned commit. */
  readFiles(target: CatalogTarget, deadline: number): Promise<ScanRequestFile[]>;
};

export type PublicScanRunResult = {
  synced: number | null; removed: number; scanned: number; retried: number; held: number; stoppedBy?: string;
  errors: Record<string, number>;
  /** The scanner versions this run used; the report counts only results from these. */
  versions: PublicScanVersions;
};

export type PublicScanVersions = { rules: ScannerInfo[]; review: ScannerInfo | null; look: ScannerInfo | null };

/** A background function may run 15 minutes; a run stops taking skills well before that. */
export const PUBLIC_RUN_LIMIT_MS = 12 * 60_000;
/** Longer than the Worker's own 45 s limit on one AI review. */
const REVIEW_TIMEOUT_MS = 60_000;
/** Longer than the Worker's own 120 s limit on one second look. */
const SECOND_LOOK_TIMEOUT_MS = 150_000;
const SCAN_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const GITHUB_TIMEOUT_MS = 60_000;
/** A skill takes at most about five minutes; the lease outlasts that. */
const LEASE = "8 minutes";
/** One at a time, so a skill's lease always outlasts its scan. */
const BATCH = 1;
/** Out of tries (GitHub or the scanner down for an hour or more): one more try every 6 hours, never stuck. */
const REVIVE_AFTER = "6 hours";
/** A catalog build that couldn't be read is tried again after this, not every run. */
const CATALOG_RETRY = "6 hours";
const ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?::[^\s]{1,400})?$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function publicScanScopeFromEnv(env: Record<string, string | undefined> = process.env): PublicScanScope[] {
  const raw = (env.PUBLIC_SCAN_SCOPE ?? "topics").split(",").map((part) => part.trim()).filter(Boolean);
  if (raw.includes("off")) return [];
  return (["topics", "creators"] as const).filter((scope) => raw.includes(scope));
}

type CatalogRecord = { id?: unknown; repo_slug?: unknown; skill_md_path?: unknown; repo_commit_sha?: unknown; skill_tree_sha?: unknown };
type Collection = { type?: unknown; skillIds?: unknown; featuredSkillIds?: unknown };

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** Turns the published catalog into scan targets: curated ids that have a pinned commit and content hash. */
export function curatedTargets(collections: Collection[], skills: CatalogRecord[], scopes: PublicScanScope[]): CatalogTarget[] {
  const priority = new Map<string, number>();
  for (const collection of collections) {
    const level = collection.type === "author" ? 1 : 0;
    if (!scopes.includes(level === 0 ? "topics" : "creators")) continue;
    for (const id of [...ids(collection.skillIds), ...ids(collection.featuredSkillIds)]) {
      priority.set(id, Math.min(priority.get(id) ?? level, level));
    }
  }
  const targets: CatalogTarget[] = [];
  for (const skill of skills) {
    if (typeof skill.id !== "string" || !priority.has(skill.id) || !ID.test(skill.id)) continue;
    const { repo_slug: repo, skill_md_path: mdPath, repo_commit_sha: commit, skill_tree_sha: tree } = skill;
    if (typeof repo !== "string" || !REPO.test(repo) || typeof mdPath !== "string" || !/(^|\/)SKILL\.md$/.test(mdPath)
      || typeof commit !== "string" || !SHA.test(commit) || typeof tree !== "string" || !SHA.test(tree)) continue;
    targets.push({
      catalogSkillId: skill.id, repoSlug: repo, rootPath: mdPath.slice(0, -"SKILL.md".length).replace(/\/$/, ""),
      commitSha: commit, treeSha: tree, priority: priority.get(skill.id)!
    });
  }
  return targets;
}

async function fetchJson(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`catalog ${response.status}`);
  return response.json();
}

type Manifest = { generatedAt?: unknown; skills?: unknown; collections?: unknown };

/** Reads the curated lists from the published catalog; the full skills list only for a new build. */
export function catalogTargetLoader(scopes: PublicScanScope[], fetcher: typeof fetch = fetch): Pick<PublicScanDeps, "catalogKey" | "loadTargets"> {
  const track = publishedCatalogTracks[0];
  const manifest = async () => {
    const value = await fetchJson(fetcher, track.manifestUrl, 15_000) as Manifest;
    if (typeof value.generatedAt !== "string") throw new Error("catalog manifest has no date");
    return value;
  };
  const keyOf = (value: Manifest) => `${value.generatedAt}|${scopes.join(",")}`;
  // Assets are listed as { path: "skills-<hash>.json" }.
  const asset = (reference: unknown) => {
    const name = (reference as { path?: unknown } | null)?.path;
    if (typeof name !== "string" || !/^[\w.-]+\.json$/.test(name)) throw new Error("catalog asset missing");
    return new URL(name, track.manifestUrl).toString();
  };
  return {
    async catalogKey() { return keyOf(await manifest()); },
    async loadTargets(key) {
      const value = await manifest();
      // A newer build since the key was read: say so, and the next run reads that one.
      if (keyOf(value) !== key) throw new Error("catalog changed while reading");
      const collections = await fetchJson(fetcher, asset(value.collections), 30_000) as { collections?: unknown };
      const skills = await fetchJson(fetcher, asset(value.skills), 180_000);
      if (!Array.isArray(collections.collections) || !Array.isArray(skills)) throw new Error("catalog asset has the wrong shape");
      return curatedTargets(collections.collections as Collection[], skills as CatalogRecord[], scopes);
    }
  };
}

/** Files from GitHub at the pinned commit, checked against the catalog's content hash. */
export function githubFileReader(token: string | undefined, fetcher?: typeof fetch): PublicScanDeps["readFiles"] {
  return async (target, deadline) => {
    const [owner, repo] = target.repoSlug.split("/");
    const read = await readGithubSkillFiles({ owner, repo, kind: "repo", rest: [] }, {
      token, fetcher, deadline, pinned: { commitSha: target.commitSha, folder: target.rootPath }
    });
    return read.files.map((file) => ({
      path: file.path, mode: file.mode, blobSha: file.blobSha, byteSize: file.data.byteLength,
      contentBase64: Buffer.from(file.data).toString("base64")
    }));
  };
}

async function sync(pool: Pool, deps: PublicScanDeps): Promise<{ synced: number | null; removed: number }> {
  const key = await deps.catalogKey();
  const state = await pool.query<{ current: boolean; wait: boolean }>(
    `SELECT catalog_generated_at = $1 AS current,
       tried_catalog = $1 AND tried_at > now() - interval '${CATALOG_RETRY}' AS wait
     FROM public_scan_sync WHERE id = 1`,
    [key]
  );
  if (state.rows[0]?.current) return { synced: null, removed: 0 };
  // A build that failed (or ran out of memory) recently isn't read again every run.
  if (state.rows[0]?.wait) throw new Error("catalog build failed recently; trying again later");
  await pool.query(
    `INSERT INTO public_scan_sync (id, tried_catalog, tried_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET tried_catalog = EXCLUDED.tried_catalog, tried_at = now()`,
    [key]
  );
  const t = await deps.loadTargets(key);
  // An empty list would drop every target; that's a broken catalog, not a decision.
  if (t.length === 0) throw new Error("catalog lists no curated skills");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO public_scan_targets (catalog_skill_id, repo_slug, root_path, commit_sha, tree_sha, priority, catalog_seen_at)
        SELECT * , now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[])
        ON CONFLICT (catalog_skill_id) DO UPDATE SET
          repo_slug = EXCLUDED.repo_slug, root_path = EXCLUDED.root_path, commit_sha = EXCLUDED.commit_sha,
          tree_sha = EXCLUDED.tree_sha, priority = EXCLUDED.priority, catalog_seen_at = now(),
          -- New content starts over; unchanged content keeps its place and its tries.
          attempts = CASE WHEN public_scan_targets.tree_sha = EXCLUDED.tree_sha THEN public_scan_targets.attempts ELSE 0 END,
          last_error = CASE WHEN public_scan_targets.tree_sha = EXCLUDED.tree_sha THEN public_scan_targets.last_error END,
          gave_up = public_scan_targets.gave_up AND public_scan_targets.tree_sha = EXCLUDED.tree_sha,
          not_before = CASE WHEN public_scan_targets.tree_sha = EXCLUDED.tree_sha THEN public_scan_targets.not_before ELSE now() END
      `,
      [t.map((x) => x.catalogSkillId), t.map((x) => x.repoSlug), t.map((x) => x.rootPath), t.map((x) => x.commitSha),
        t.map((x) => x.treeSha), t.map((x) => x.priority)]
    );
    // Skills no longer curated stop being scanned. Their results stay (they're by content, and paid
    // for): a skill that comes back, or a private copy, finds them.
    const removed = await client.query(
      "DELETE FROM public_scan_targets WHERE NOT (catalog_skill_id = ANY($1::text[]))",
      [t.map((x) => x.catalogSkillId)]
    );
    await client.query("UPDATE public_scan_sync SET catalog_generated_at = $1, synced_at = now() WHERE id = 1", [key]);
    await client.query("COMMIT");
    return { synced: t.length, removed: removed.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Leased = CatalogTarget & {
  attempts: number; leaseToken: string; needRules: boolean; needReview: boolean; reviewed: boolean; flagged: boolean; looked: boolean;
};

/** AI review labels that send a skill for the second look. */
export const FLAGGED_LABELS = ["ai_suspicious", "ai_malicious", "ai_refused"];

/** Has this content no usable result from one of these scanners? */
const MISSING = (scanners: string, versions: string) => `EXISTS (
  SELECT 1 FROM unnest(${scanners}::text[], ${versions}::text[]) AS s(scanner, version)
  WHERE NOT EXISTS (
    SELECT 1 FROM skill_scans scan
    WHERE scan.tree_sha = target.tree_sha AND scan.scanner = s.scanner AND scan.scanner_version = s.version
      AND scan.status <> 'failed'
  )
)`;

/** Has the current AI review a complete result? Only then can a second look change the badge. */
const REVIEWED = `EXISTS (
  SELECT 1 FROM skill_scans scan
  WHERE scan.tree_sha = target.tree_sha AND scan.scanner = $6[1] AND scan.scanner_version = $7[1] AND scan.status = 'complete'
)`;
/** Did the current AI review or rules flag this content? */
const FLAGGED = `EXISTS (
  SELECT 1 FROM skill_scans scan, jsonb_array_elements(scan.findings) f
  WHERE scan.tree_sha = target.tree_sha AND scan.status <> 'failed' AND (
    (scan.scanner = $6[1] AND scan.scanner_version = $7[1] AND f->>'label' = ANY($10::text[]))
    OR ((scan.scanner, scan.scanner_version) IN (SELECT * FROM unnest($4::text[], $5::text[])) AND f->>'severity' IN ('high', 'medium')
      AND NOT f->>'label' = ANY($11::text[]))
  )
)`;
/** Has the current second look a usable result? Never, when it isn't set up. */
const LOOKED = `($8::text IS NOT NULL AND EXISTS (
  SELECT 1 FROM skill_scans scan
  WHERE scan.tree_sha = target.tree_sha AND scan.scanner = $8 AND scan.scanner_version = $9 AND scan.status <> 'failed'
))`;

/**
 * Targets missing a usable result from a current scanner, or flagged and waiting for the second look:
 * collections first, then the longest waiting. Says which are missing, so a new rules version never
 * pays for another AI review.
 */
async function lease(pool: Pool, rules: ScannerInfo[], review: ScannerInfo, look: ScannerInfo | null, limit: number): Promise<Leased[]> {
  const result = await pool.query<Leased>(
    `
      WITH due AS (
        SELECT target.catalog_skill_id FROM public_scan_targets target
        WHERE target.not_before <= now() AND (target.lease_until IS NULL OR target.lease_until < now())
          AND NOT target.gave_up
          AND (target.attempts < $3 OR target.not_before <= now() - interval '${REVIVE_AFTER}')
          AND (${MISSING("$4", "$5")} OR ${MISSING("$6", "$7")} OR ($8::text IS NOT NULL AND ${REVIEWED} AND ${FLAGGED} AND NOT ${LOOKED}))
        ORDER BY target.priority, target.not_before
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public_scan_targets target
      SET lease_token = $1, lease_until = now() + interval '${LEASE}', attempts = target.attempts + 1
      FROM due WHERE target.catalog_skill_id = due.catalog_skill_id
      RETURNING target.catalog_skill_id AS "catalogSkillId", target.repo_slug AS "repoSlug", target.root_path AS "rootPath",
        target.commit_sha AS "commitSha", target.tree_sha AS "treeSha", target.priority, target.attempts,
        target.lease_token AS "leaseToken", ${MISSING("$4", "$5")} AS "needRules", ${MISSING("$6", "$7")} AS "needReview",
        ${REVIEWED} AS reviewed, ${FLAGGED} AS flagged, ${LOOKED} AS looked
    `,
    [randomUUID(), limit, MAX_ATTEMPTS, rules.map((s) => s.scanner), rules.map((s) => s.version), [review.scanner], [review.version],
      look?.scanner ?? null, look?.version ?? null, FLAGGED_LABELS, [...SHARE_LABELS]]
  );
  return result.rows.sort((a, b) => a.priority - b.priority);
}

/** Stores results while this run holds the target. A failure is stored only once the tries run out. */
async function store(pool: Pool, target: Leased, results: ScannerResult[]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const held = await client.query(
      "SELECT 1 FROM public_scan_targets WHERE catalog_skill_id = $1 AND lease_token = $2 AND tree_sha = $3 FOR UPDATE",
      [target.catalogSkillId, target.leaseToken, target.treeSha]
    );
    if (!held.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    const lastTry = target.attempts >= MAX_ATTEMPTS;
    for (const result of results) {
      if (result.status === "failed" && !lastTry) continue;
      await client.query(
        `
          INSERT INTO skill_scans (tree_sha, scanner, scanner_version, status, findings, files_scanned, files_skipped, started_at, finished_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
          ON CONFLICT (tree_sha, scanner, scanner_version) DO UPDATE SET
            status = EXCLUDED.status, findings = EXCLUDED.findings, files_scanned = EXCLUDED.files_scanned,
            files_skipped = EXCLUDED.files_skipped, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at
          WHERE skill_scans.status = 'failed' OR (skill_scans.status = 'partial' AND EXCLUDED.status = 'complete')
        `,
        [target.treeSha, result.scanner, result.version, result.status, JSON.stringify(result.findings),
          result.filesScanned, result.filesSkipped, result.startedAt, result.finishedAt]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Backs off 2, 4, 8… minutes; out of tries, one more every 6 hours (see the lease). */
async function retryLater(pool: Pool, target: Leased, code: string) {
  await pool.query(
    `UPDATE public_scan_targets SET lease_token = NULL, lease_until = NULL, last_error = $3,
       not_before = now() + make_interval(mins => power(2, LEAST(attempts, 8))::int)
     WHERE catalog_skill_id = $1 AND lease_token = $2`,
    [target.catalogSkillId, target.leaseToken, code]
  );
}

/** Can't be scanned as pinned: waits for the catalog to pin new content. Nothing is stored as a result. */
async function giveUp(pool: Pool, target: Leased, code: string) {
  await pool.query(
    `UPDATE public_scan_targets SET lease_token = NULL, lease_until = NULL, last_error = $3, gave_up = true
     WHERE catalog_skill_id = $1 AND lease_token = $2`,
    [target.catalogSkillId, target.leaseToken, code]
  );
}

async function done(pool: Pool, target: Leased) {
  await pool.query(
    "UPDATE public_scan_targets SET lease_token = NULL, lease_until = NULL, attempts = 0, last_error = NULL WHERE catalog_skill_id = $1 AND lease_token = $2",
    [target.catalogSkillId, target.leaseToken]
  );
}

/** GitHub refusals that won't change until the catalog pins a new commit. */
const UNREADABLE = new Set(["too_large", "unsupported_file", "no_skill", "several_skills", "not_found", "folder_not_found"]);

/** A result that sends the skill for the second look: an AI review that flags it, or a rule hit. */
function flags(result: ScannerResult, review: ScannerInfo): boolean {
  if (result.status === "failed") return false;
  if (result.scanner === review.scanner) return result.findings.some((f) => FLAGGED_LABELS.includes(f.label));
  // Sharing advice (an email address, a home folder) is for private skills, not a reason for a second look.
  return result.findings.some((f) => (f.severity === "high" || f.severity === "medium") && !(SHARE_LABELS as readonly string[]).includes(f.label));
}

/** One background run. Does nothing until the scanner and its AI review are set up. */
export async function runPublicScanQueue(pool: Pool, deps: PublicScanDeps, runLimitMs = PUBLIC_RUN_LIMIT_MS): Promise<PublicScanRunResult> {
  const now = () => deps.now?.() ?? Date.now();
  const started = now();
  const result: PublicScanRunResult = {
    synced: null, removed: 0, scanned: 0, retried: 0, held: 0, errors: {}, versions: { rules: [], review: null, look: null }
  };
  const count = (code: string) => { result.errors[code] = (result.errors[code] ?? 0) + 1; };

  const listed = await callScanner<{ scanners?: unknown; review?: ScannerInfo | null; secondLook?: ScannerInfo | null }>(
    deps, "GET", "/scanners", LIST_TIMEOUT_MS
  );
  const rules = validScanners(listed);
  const review = listed.review ? validScanners({ scanners: [listed.review] })[0] : null;
  // Without it, flagged skills simply wait "under review".
  const look = listed.secondLook ? validScanners({ scanners: [listed.secondLook] })[0] : null;
  result.versions = { rules, review, look };
  // Public skills get both or neither, so a missing review is never read as a finished scan.
  if (!review) {
    result.stoppedBy = "review_not_configured";
    return result;
  }

  try {
    Object.assign(result, await sync(pool, deps));
  } catch (error) {
    // The skills already listed still get scanned; the next run tries the catalog again.
    count("catalog_unavailable");
    console.warn("public scan: catalog sync failed", { error: error instanceof Error ? error.message : String(error) });
  }

  const perSkill = GITHUB_TIMEOUT_MS + SCAN_TIMEOUT_MS + REVIEW_TIMEOUT_MS + (look ? SECOND_LOOK_TIMEOUT_MS : 0);
  while (runLimitMs - (now() - started) >= perSkill && !result.stoppedBy) {
    const targets = await lease(pool, rules, review, look, BATCH);
    if (targets.length === 0) break;
    for (const target of targets) {
      if (result.stoppedBy || runLimitMs - (now() - started) < perSkill) {
        // Not this run: give the try back.
        await pool.query(
          "UPDATE public_scan_targets SET lease_token = NULL, lease_until = NULL, attempts = attempts - 1 WHERE catalog_skill_id = $1 AND lease_token = $2",
          [target.catalogSkillId, target.leaseToken]
        );
        continue;
      }
      try {
        let files: ScanRequestFile[];
        try {
          files = await deps.readFiles(target, now() + GITHUB_TIMEOUT_MS);
        } catch (error) {
          if (error instanceof GithubImportError && UNREADABLE.has(error.code)) {
            // Can't be read as a skill (too big, a symlink, gone): held, and never counted clean.
            await giveUp(pool, target, error.code);
            result.held += 1;
            count(error.code);
            continue;
          }
          throw new ScannerCallError(error instanceof GithubImportError ? error.code : "github_unavailable", true);
        }
        let treeSha: string;
        try {
          treeSha = validateSkillManifest(
            files.map(({ path, mode, blobSha, byteSize }) => ({ path, mode, blobSha, byteSize })), STANDARD_SKILL_PACKAGE_LIMITS
          ).treeSha;
        } catch {
          // Over the scanner's limits, or not a valid package: held like any skill that can't be read.
          await giveUp(pool, target, "unsupported_file");
          result.held += 1;
          count("unsupported_file");
          continue;
        }
        if (treeSha !== target.treeSha) {
          // Not what the catalog pinned: wait for the catalog to catch up rather than scan something else.
          await giveUp(pool, target, "tree_mismatch");
          count("tree_mismatch");
          continue;
        }
        const body = { treeSha: target.treeSha, files };
        // Only what's missing: a new rules version doesn't pay for the AI review again.
        const responses: ScanResponse[] = [];
        if (target.needRules) responses.push(await callScanner<ScanResponse>(deps, "POST", "/scan", SCAN_TIMEOUT_MS, body));
        if (target.needReview) responses.push(await callScanner<ScanResponse>(deps, "POST", "/review", REVIEW_TIMEOUT_MS, body));
        const check = (response: ScanResponse) => {
          if (response.treeSha !== target.treeSha || !Array.isArray(response.results)) throw new ScannerCallError("bad_response", true);
          return response.results;
        };
        const results = responses.flatMap(check);
        if (!(await store(pool, target, results))) continue;
        // Flagged now or before, and no second look yet: Opus reads the same files. The review is stored
        // first, so a second look that times out never costs the review again.
        // Only after a complete review: without one the badge stays "not reviewed" whatever Opus says.
        const reviewed = target.reviewed || results.some((r) => r.scanner === review.scanner && r.status === "complete");
        if (look && reviewed && !target.looked && (target.flagged || results.some((r) => flags(r, review)))) {
          const second = check(await callScanner<ScanResponse>(deps, "POST", "/second-look", SECOND_LOOK_TIMEOUT_MS, body));
          if (!(await store(pool, target, second))) continue;
          results.push(...second);
        }
        if (results.some((r) => r.status === "failed")) {
          // Out of tries, the failure is stored and tried again every 6 hours.
          await retryLater(pool, target, "scanner_failed");
          result.retried += 1;
          count("scanner_failed");
        } else {
          await done(pool, target);
          result.scanned += 1;
        }
      } catch (error) {
        const code = error instanceof ScannerCallError ? error.code : "internal";
        count(code);
        if (error instanceof ScannerCallError && error.stopRun) result.stoppedBy = code;
        if (error instanceof ScannerCallError && !error.retry) await giveUp(pool, target, code);
        else await retryLater(pool, target, code);
        result.retried += 1;
      }
    }
  }
  return result;
}

export type PublicScanReportRow = {
  id: string;
  verdict: string | null;
  checks: string[];
  notes: string[];
  rules: string[];
  aiStatus: string | null;
  rulesStatus: string | null;
  lastError: string | null;
  held: boolean;
  scannedAt: string | null;
  /** The second look's verdict, when it has a complete one. */
  secondLook: string | null;
  secondLookStatus: string | null;
  /** What a public badge would say. Only "no_issues" may ever be shown as a pass. */
  badge: PublicScanBadge;
};

export type PublicScanBadge = "no_issues" | "under_review" | "not_reviewed";

/**
 * "No issues found" needs complete rules and a complete AI review, and, when either flagged the
 * skill, a complete second look that didn't. Flagged and not yet cleared is "under review"; too big,
 * unreadable or not scanned yet is "not reviewed". Never shown as safe.
 */
export function publicScanBadge(row: Pick<PublicScanReportRow, "held" | "verdict" | "rules" | "aiStatus" | "rulesStatus" | "secondLook" | "secondLookStatus">): PublicScanBadge {
  if (row.held || row.aiStatus !== "complete" || row.rulesStatus !== "complete" || !row.verdict) return "not_reviewed";
  const flagged = ["suspicious", "malicious", "refused"].includes(row.verdict) || row.rules.length > 0;
  if (!flagged) return "no_issues";
  return row.secondLookStatus === "complete" && (row.secondLook === "clear" || row.secondLook === "caution") ? "no_issues" : "under_review";
}

/**
 * What the curated public skills' scans found, for people reviewing them: verdicts and the names of
 * checks and rules, never file contents. Public skills only.
 */
export async function publicScanReport(pool: Pool, versions: PublicScanVersions): Promise<{ generatedAt: string; counts: Record<string, number>; skills: PublicScanReportRow[] }> {
  const result = await pool.query<Omit<PublicScanReportRow, "badge">>(
    `
      SELECT target.catalog_skill_id AS id,
        CASE WHEN ai.status = 'complete' THEN COALESCE(
          (SELECT substr(f->>'label', 4) FROM jsonb_array_elements(ai.findings) f WHERE f->>'rule' IN ('ai-review/verdict', 'ai-review/refused') LIMIT 1),
          'clear') END AS verdict,
        COALESCE(ARRAY(SELECT f->>'label' FROM jsonb_array_elements(ai.findings) f
          WHERE f->>'rule' NOT IN ('ai-review/verdict', 'ai-review/refused') AND f->>'severity' <> 'info' ORDER BY 1), '{}') AS checks,
        COALESCE(ARRAY(SELECT f->>'label' FROM jsonb_array_elements(ai.findings) f
          WHERE f->>'rule' NOT IN ('ai-review/verdict', 'ai-review/refused') AND f->>'severity' = 'info' ORDER BY 1), '{}') AS notes,
        COALESCE(ARRAY(SELECT DISTINCT f->>'label' FROM jsonb_array_elements(rules.findings) f
          WHERE f->>'severity' IN ('high', 'medium') AND NOT f->>'label' = ANY($7::text[]) ORDER BY 1), '{}') AS rules,
        ai.status AS "aiStatus", rules.status AS "rulesStatus", target.last_error AS "lastError", target.gave_up AS held,
        to_char(GREATEST(ai.finished_at, rules.finished_at, look.finished_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "scannedAt",
        CASE WHEN look.status = 'complete' THEN COALESCE(
          (SELECT substr(f->>'label', 4) FROM jsonb_array_elements(look.findings) f
            WHERE f->>'rule' IN ('ai-second-look/verdict', 'ai-second-look/refused') LIMIT 1),
          'clear') END AS "secondLook",
        look.status AS "secondLookStatus"
      FROM public_scan_targets target
      LEFT JOIN LATERAL (SELECT status, findings, finished_at FROM skill_scans
        WHERE tree_sha = target.tree_sha AND scanner = $1 AND scanner_version = $2 ORDER BY finished_at DESC LIMIT 1) ai ON true
      LEFT JOIN LATERAL (SELECT status, findings, finished_at FROM skill_scans
        WHERE (scanner, scanner_version) IN (SELECT * FROM unnest($3::text[], $4::text[])) AND tree_sha = target.tree_sha
        ORDER BY finished_at DESC LIMIT 1) rules ON true
      LEFT JOIN LATERAL (SELECT status, findings, finished_at FROM skill_scans
        WHERE tree_sha = target.tree_sha AND scanner = $5 AND scanner_version = $6 ORDER BY finished_at DESC LIMIT 1) look ON true
      ORDER BY target.priority, target.catalog_skill_id
    `,
    // Only the versions the queue runs now: an older review never stands in for the current one.
    [versions.review?.scanner ?? null, versions.review?.version ?? null, versions.rules.map((s) => s.scanner), versions.rules.map((s) => s.version),
      versions.look?.scanner ?? null, versions.look?.version ?? null, [...SHARE_LABELS]]
  );
  const counts: Record<string, number> = {};
  const skills = result.rows.map((row) => ({ ...row, badge: publicScanBadge(row) }));
  for (const row of skills) {
    for (const key of [row.held ? "held" : row.verdict ?? "not_yet", `badge_${row.badge}`]) counts[key] = (counts[key] ?? 0) + 1;
  }
  return { generatedAt: new Date().toISOString(), counts, skills };
}
