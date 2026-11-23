-- Public catalog skills to scan, curated ones first. One row per catalog skill, at the commit the
-- catalog pins it to. A new commit in the catalog changes the row, and the scan follows; results are
-- stored in skill_scans by content hash, the same as private skills. Nothing here is shown publicly yet.
CREATE TABLE public_scan_targets (
  catalog_skill_id text PRIMARY KEY,
  repo_slug text NOT NULL,
  root_path text NOT NULL,
  commit_sha text NOT NULL,
  tree_sha text NOT NULL,
  -- 0 = topic collections, 1 = creator picks; lower goes first.
  priority integer NOT NULL,
  catalog_seen_at timestamptz NOT NULL DEFAULT now(),
  not_before timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  CONSTRAINT public_scan_targets_id_check CHECK (char_length(catalog_skill_id) BETWEEN 3 AND 512),
  CONSTRAINT public_scan_targets_repo_check CHECK (repo_slug ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  CONSTRAINT public_scan_targets_commit_check CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT public_scan_targets_tree_sha_check CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT public_scan_targets_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX public_scan_targets_due_idx ON public_scan_targets(priority, not_before);
CREATE INDEX public_scan_targets_tree_sha_idx ON public_scan_targets(tree_sha);

-- Which catalog build the targets were last synced from, so a run only re-reads the catalog when it changes.
CREATE TABLE public_scan_sync (
  id integer PRIMARY KEY CHECK (id = 1),
  catalog_generated_at text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
