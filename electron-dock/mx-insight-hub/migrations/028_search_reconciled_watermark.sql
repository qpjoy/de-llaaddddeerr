-- Stop paying a full-corpus re-segmentation on every projector restart.
--
-- The startup reconciliation replays PostgreSQL truth into an already-serving
-- index on every start. That closes a real crash window -- a previous process
-- can die after the atomic alias switch but before its catch-up pass -- and it
-- was nearly free when the corpus was small. At ~880k canonical records, each
-- of which is re-segmented through a single-slot HanLP service, it costs hours,
-- and it is charged on every ordinary deployment.
--
-- The window is narrow; the payment was not proportional to it. This watermark
-- makes it so: a clean pass records how far truth was replayed, and the next
-- start replays only what changed after that. The guarantee is unchanged --
-- an unclean exit never updates the watermark, so the following start replays
-- from the last known-good point rather than from an assumption.
--
-- Deliberately on the same row as the rebuild cursor and keyed the same way, by
-- concrete index name: a schema bump produces a new index and therefore no
-- watermark, which correctly forces the full pass.

ALTER TABLE control.search_rebuild_progress
  ADD COLUMN IF NOT EXISTS reconciled_through timestamptz;

COMMENT ON COLUMN control.search_rebuild_progress.reconciled_through IS
  'Canonical truth up to this instant is durably projected into index_name. '
  'NULL means unknown -- the next startup reconciliation must replay everything.';
