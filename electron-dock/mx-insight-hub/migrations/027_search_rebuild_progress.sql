-- Make a full search rebuild resumable.
--
-- A rebuild of the content projection is hours of work: every canonical record
-- is re-segmented through a single-slot HanLP service before it is bulk
-- indexed. Until now a failure at any point threw all of it away -- the partial
-- index is not attached to a serving alias, so the next attempt deleted it and
-- started from the first row again. On a corpus of this size that turns one
-- transient tokenizer error into a rebuild that can never finish.
--
-- The fix is the pattern the Night-All backfill already uses: a durable cursor
-- written after each batch is durably indexed, never before. Resuming is safe
-- precisely because the target index serves no traffic until its first pass
-- completes, so a partial index is invisible rather than wrong.
--
-- Keyed by concrete index name, not by projection: a schema-version bump
-- produces a new index name and therefore a new cursor, so progress can never
-- be carried across incompatible mappings.

CREATE TABLE IF NOT EXISTS control.search_rebuild_progress (
  index_name text PRIMARY KEY,
  projection text NOT NULL,
  -- Every canonical record ordered before this id is durably in the index.
  last_record_id uuid,
  processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
  -- The catch-up pass rescans only what changed after the build pass began,
  -- instead of walking the whole corpus a second time.
  build_started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The catch-up pass selects by last_seen_at; without this it degrades to a
-- sequential scan per page.
CREATE INDEX IF NOT EXISTS canonical_records_last_seen_idx
  ON core.canonical_records (last_seen_at);
