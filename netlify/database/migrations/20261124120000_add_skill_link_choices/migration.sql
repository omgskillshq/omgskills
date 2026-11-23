-- Which library skill a person says their copy is, when several library skills share its content
-- (forks). Keyed by the content index key (a SKILL.md fingerprint, or a name and description hash),
-- so one choice covers every copy with that content. A null catalog_skill_id means "my own skill".

CREATE TABLE skill_link_choices (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_key text NOT NULL,
  catalog_skill_id text,
  chosen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, match_key),
  CONSTRAINT skill_link_choices_match_key_check CHECK (match_key ~ '^(sha:[0-9a-f]{40}|nd:[0-9a-f]{64})$'),
  CONSTRAINT skill_link_choices_catalog_skill_id_check CHECK (catalog_skill_id IS NULL OR char_length(catalog_skill_id) BETWEEN 1 AND 500)
);
