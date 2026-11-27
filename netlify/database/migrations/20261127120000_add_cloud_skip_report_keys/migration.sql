-- Each Mac's own cloud save key for every skill folder it has, with the SKILL.md name of the skill in it, sent
-- with its skip report after a pass: { "<agent>/<folder>": { "key": "<key>", "name": "<name>" } }. The web uses
-- these instead of working the keys out again, so a key the Mac remembers (from a same-name skill since
-- removed) can't make the two disagree. NULL from older Macs.

ALTER TABLE cloud_skip_reports ADD COLUMN cloud_keys jsonb;
ALTER TABLE cloud_skip_reports ADD CONSTRAINT cloud_skip_reports_cloud_keys_check
  CHECK (cloud_keys IS NULL OR jsonb_typeof(cloud_keys) = 'object');
