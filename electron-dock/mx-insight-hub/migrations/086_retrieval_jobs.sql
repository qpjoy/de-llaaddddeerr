-- Fail promptly rather than wait behind a long-running chunk writer during deploy.
SET LOCAL lock_timeout = '2s';
-- Optional retrieval work is durable and coalesced per canonical record. The
-- source transaction only queues an ID; no model, HanLP or ES call runs here.
CREATE SCHEMA IF NOT EXISTS retrieval;
ALTER TABLE core.record_chunks ADD COLUMN projection_schema integer NOT NULL DEFAULT 1;
CREATE TABLE retrieval.settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  max_concurrency integer NOT NULL DEFAULT 2 CHECK (max_concurrency BETWEEN 1 AND 16),
  daily_token_budget bigint NOT NULL DEFAULT 1000000 CHECK (daily_token_budget BETWEEN 1000 AND 1000000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO retrieval.settings(id) VALUES(true);
CREATE TABLE retrieval.jobs (
  record_id uuid PRIMARY KEY,
  requested_revision bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  completed_version bigint NOT NULL DEFAULT 0,
  backfill_run_id uuid,
  backfill_version bigint,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','dead')),
  priority integer NOT NULL DEFAULT 10,
  retire boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_jobs_claim_idx ON retrieval.jobs(retire DESC,priority,run_at,record_id) WHERE status='pending';
CREATE INDEX retrieval_jobs_lease_idx ON retrieval.jobs(lease_until) WHERE status='running';
CREATE TABLE retrieval.runs (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'scanning' CHECK(status IN ('scanning','draining','completed','cancelled')),
  cursor_id uuid,
  seeded bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX retrieval_one_active_run_idx ON retrieval.runs((true)) WHERE status IN ('scanning','draining');
CREATE TABLE retrieval.daily_usage (
  day date PRIMARY KEY,
  reserved_tokens bigint NOT NULL DEFAULT 0
);
CREATE TABLE retrieval.search_snapshots (
  id uuid PRIMARY KEY,
  query jsonb NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX retrieval_snapshots_expiry_idx ON retrieval.search_snapshots(expires_at);
CREATE TABLE retrieval.request_slots (
  kind text NOT NULL,
  slot integer NOT NULL,
  token uuid,
  lease_until timestamptz,
  PRIMARY KEY(kind,slot)
);
INSERT INTO retrieval.request_slots(kind,slot) SELECT 'search',generate_series(1,16);
INSERT INTO retrieval.request_slots(kind,slot) SELECT 'answer',generate_series(1,2);

CREATE FUNCTION retrieval.enqueue_canonical_projection() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_retrieval AFTER INSERT ON outbox.projection_events
FOR EACH ROW EXECUTE FUNCTION retrieval.enqueue_canonical_projection();

CREATE INDEX retrieval_jobs_run_idx ON retrieval.jobs(backfill_run_id) WHERE backfill_run_id IS NOT NULL AND completed_version<backfill_version;

CREATE INDEX retrieval_jobs_retire_idx ON retrieval.jobs(run_at) WHERE retire AND status='pending';
CREATE TABLE retrieval.workers (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_jobs_dead_idx ON retrieval.jobs(updated_at DESC) WHERE status='dead';
