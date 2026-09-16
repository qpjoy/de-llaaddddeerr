-- Separate the operator's one-time history budget from the daily increment budget.
-- Migration only creates structures; it never captures or starts a history run.
SET LOCAL lock_timeout = '2s';
ALTER TABLE retrieval.runs
  ADD COLUMN snapshot_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN target_count bigint,
  ADD COLUMN token_budget bigint CHECK (token_budget BETWEEN 0 AND 1000000000),
  ADD COLUMN reserved_tokens bigint NOT NULL DEFAULT 0;

-- A narrow manifest captures one MVCC statement snapshot, including revisions.
-- UUID ordering alone cannot exclude records inserted after the start of a run.
CREATE TABLE retrieval.run_items (
  run_id uuid NOT NULL REFERENCES retrieval.runs(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  source_revision bigint NOT NULL,
  projection_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','superseded')),
  finished_at timestamptz,
  PRIMARY KEY (run_id,record_id)
);
CREATE INDEX retrieval_run_items_pending_idx ON retrieval.run_items(run_id,record_id) WHERE status='pending';
CREATE INDEX retrieval_run_items_record_idx ON retrieval.run_items(record_id,projection_revision) WHERE status='pending';

CREATE OR REPLACE FUNCTION retrieval.enqueue_canonical_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.aggregate_type <> 'canonical_record' THEN RETURN NEW; END IF;
  INSERT INTO retrieval.jobs AS j(record_id,requested_revision,retire)
  VALUES(NEW.aggregate_id,NEW.projection_revision,NEW.event_type='delete')
  ON CONFLICT(record_id) DO UPDATE SET
    requested_revision=greatest(j.requested_revision,EXCLUDED.requested_revision),
    version=j.version+1, priority=10, retire=EXCLUDED.retire,
    status=CASE WHEN j.status='running' THEN 'running' ELSE 'pending' END,
    run_at=now(), attempts=CASE WHEN j.status='running' THEN j.attempts ELSE 0 END,
    last_error_code=NULL,updated_at=now()
  WHERE EXCLUDED.requested_revision>j.requested_revision;
  -- A later revision belongs to daily incremental processing. Do not hold the
  -- historical run open waiting for a moving record, or charge its new text to it.
  UPDATE retrieval.run_items SET status='superseded',finished_at=now()
    WHERE record_id=NEW.aggregate_id AND projection_revision<NEW.projection_revision AND status='pending';
  RETURN NEW;
END $$;
