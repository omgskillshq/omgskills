-- Where a skill added on the web from GitHub came from: its repo, folder, commit and the repo's stars when
-- added. The skill then keeps its creator, GitHub link and stars instead of showing as unknown.

ALTER TABLE cloud_saved_skills ADD COLUMN github_source jsonb;
ALTER TABLE cloud_saved_skills ADD CONSTRAINT cloud_saved_skills_github_source_check
  CHECK (github_source IS NULL OR jsonb_typeof(github_source) = 'object');
