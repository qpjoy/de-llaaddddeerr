-- Structured, bounded diagnostics only. No arbitrary upstream body or message.
ALTER TABLE serving.connector_calls ADD COLUMN IF NOT EXISTS failure_evidence jsonb;
-- Enforce new writes without scanning the historical call ledger at deploy.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'serving.connector_calls'::regclass AND conname = 'connector_failure_evidence_bounded') THEN
    ALTER TABLE serving.connector_calls ADD CONSTRAINT connector_failure_evidence_bounded
      CHECK (failure_evidence IS NULL OR
        (jsonb_typeof(failure_evidence) = 'object' AND octet_length(failure_evidence::text) <= 16384)) NOT VALID;
  END IF;
END $$;
COMMENT ON COLUMN serving.connector_calls.failure_evidence IS
  'Admin-only projected Night-All failure chain; excludes raw bodies, messages, URLs, credentials and request parameters. Historical rows remain NULL.';
