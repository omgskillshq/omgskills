-- "None of these": the library skills a person was shown and said their copy is none of. The copy
-- stays unlinked and isn't asked about again until another library skill turns up for it.

ALTER TABLE skill_link_choices ADD COLUMN none_of text[];
ALTER TABLE skill_link_choices ADD CONSTRAINT skill_link_choices_none_of_check
  CHECK (none_of IS NULL OR (catalog_skill_id IS NULL AND cardinality(none_of) BETWEEN 1 AND 500));
