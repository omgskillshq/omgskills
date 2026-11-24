-- The library skills a version shares real text with (30% or more), so a suggestion by name alone
-- is made only with that second sign, and offers those skills first.

ALTER TABLE content_match_results ADD COLUMN related_ids text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Results that shared text were computed before this column: compared again on the next run.
DELETE FROM content_match_results WHERE best_score >= 0.3;
