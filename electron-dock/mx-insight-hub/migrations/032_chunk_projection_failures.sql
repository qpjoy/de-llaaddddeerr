-- Durable quarantine for chunk projection poisons.
--
-- A malformed tokenizer response or permanently rejected document must not
-- occupy the first projection page forever. Keep the failure budget beside the
-- authoritative chunk revision; a content/revision update clears it in the
-- materializer and makes the corrected row eligible again.

ALTER TABLE core.record_chunks
  ADD COLUMN IF NOT EXISTS projection_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS projection_last_error text,
  ADD COLUMN IF NOT EXISTS projection_failed_at timestamptz;

-- The alias cutover is a durable phase boundary for resumable A/B rebuilds.
-- Marking it before the Elasticsearch alias request is safe: recovery only
-- trusts the marker when this exact physical index is also serving the alias.
ALTER TABLE control.search_rebuild_progress
  ADD COLUMN IF NOT EXISTS aliases_switched_at timestamptz;
