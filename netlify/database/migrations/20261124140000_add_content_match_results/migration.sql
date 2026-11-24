-- Which library skill a SKILL.md version is, by comparing its text with same-named library skills
-- (computed in the background, per content, so page loads only read it). Keyed by the SKILL.md
-- fingerprint, so one result serves every copy with that content. catalog_key: the catalog build it
-- was computed against; a new build recomputes it.

CREATE TABLE content_match_results (
  skill_md_sha text PRIMARY KEY,
  catalog_key text NOT NULL,
  catalog_skill_id text,
  best_score real,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_match_results_sha_check CHECK (skill_md_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT content_match_results_catalog_skill_id_check CHECK (catalog_skill_id IS NULL OR char_length(catalog_skill_id) BETWEEN 1 AND 500)
);

-- A choice can now also be for a name alone (a suggestion by name).
ALTER TABLE skill_link_choices DROP CONSTRAINT skill_link_choices_match_key_check;
ALTER TABLE skill_link_choices ADD CONSTRAINT skill_link_choices_match_key_check
  CHECK (match_key ~ '^(sha:[0-9a-f]{40}|nd:[0-9a-f]{64}|n:[0-9a-f]{64})$');
