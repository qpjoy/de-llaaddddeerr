-- Persist the operator's logical rule choice separately from the concrete
-- approved version. One logical rule can have multiple input-format/schema
-- versions (for example CSV and JSONL) without presenting those versions as
-- separate choices in the source UI.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM catalog.file_format_rules
     WHERE rule_key = 'rule-twitter-canyie'
       AND ROW(dataset_id, platform, object_type)
           IS DISTINCT FROM ROW('external.twitter.canyie.v1', 'twitter', 'post')
  ) THEN
    RAISE EXCEPTION 'rule-twitter-canyie already exists with a different scope';
  END IF;
END
$$;

INSERT INTO catalog.file_format_rules
  (id, rule_key, display_name, dataset_id, platform, object_type)
VALUES (
  'ca7e0000-0000-4000-8000-000000000001',
  'rule-twitter-canyie',
  'Twitter / Canyie archive',
  'external.twitter.canyie.v1',
  'twitter',
  'post'
)
ON CONFLICT (rule_key) DO NOTHING;

ALTER TABLE catalog.source_mappings
  ADD COLUMN IF NOT EXISTS selected_rule_key text
    REFERENCES catalog.file_format_rules(rule_key);

CREATE INDEX IF NOT EXISTS source_mappings_selected_rule_key_idx
  ON catalog.source_mappings (selected_rule_key)
  WHERE selected_rule_key IS NOT NULL;

ALTER TABLE catalog.source_mappings
  DROP CONSTRAINT IF EXISTS source_mappings_file_structure_check;

ALTER TABLE catalog.source_mappings
  ADD CONSTRAINT source_mappings_file_structure_check CHECK (
    (
      schema_fingerprint IS NULL
      AND file_structure IS NULL
      AND format_rule_version_id IS NULL
      AND selected_rule_key IS NULL
    )
    OR (
      schema_fingerprint IS NOT NULL
      AND file_structure IS NOT NULL
      AND jsonb_typeof(file_structure) = 'object'
    )
  );

COMMENT ON COLUMN catalog.source_mappings.selected_rule_key IS
  'Operator-selected logical file rule. Approval resolves it to an exact immutable format-rule version.';
