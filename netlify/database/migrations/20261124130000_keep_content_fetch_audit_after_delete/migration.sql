-- Deleting a saved skill sets the content-fetch audit rows' source and release to NULL (the foreign
-- key is ON DELETE SET NULL), but the shape check required both on every content_fetch row, so any
-- skill whose saved copy was ever read could not be deleted. A fetch of since-deleted content keeps
-- its time and who fetched it, with both links cleared together.

ALTER TABLE analytics_events DROP CONSTRAINT analytics_events_content_fetch_shape_check;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_content_fetch_shape_check
  CHECK (
    event_name <> 'content_fetch'
    OR (source_id IS NOT NULL AND release_id IS NOT NULL)
    OR (source_id IS NULL AND release_id IS NULL)
  );
