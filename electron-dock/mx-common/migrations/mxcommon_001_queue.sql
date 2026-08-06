-- mx-common durable job queue.
--
-- Lives in the product's own PostgreSQL database so that enqueueing a job and
-- the business write that justifies it commit in the SAME transaction. That is
-- the property an external broker cannot give: with Redis/BullMQ the process can
-- die between "row committed" and "job enqueued", silently losing the follow-up
-- work. Here, if the row is there, the job is there.
--
-- Crash recovery is lease-based rather than connection-based. A worker claims a
-- job by stamping `lease_expires_at`; if its pod is killed mid-job (deploy,
-- OOM, node reboot) the lease simply expires and the next `reclaim` sweep
-- returns the job to `pending`. Nothing needs to notice the crash.

CREATE SCHEMA IF NOT EXISTS mxq;

CREATE TABLE IF NOT EXISTS mxq.jobs (
  id bigserial PRIMARY KEY,
  queue text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'dead')),
  priority integer NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  -- Delayed execution and retry backoff share one column; a retry is just a job
  -- scheduled slightly further into the future.
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  locked_by text,
  last_error text,
  -- Application-supplied idempotency key. A partial unique index (below) makes
  -- re-enqueueing the same logical work a no-op while it is still outstanding,
  -- but permits the same key again once the previous run finished.
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- The claim query's access path: ready work in one queue, best priority first.
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON mxq.jobs (queue, priority, run_at, id)
  WHERE status = 'pending';

-- The reclaim sweep's access path: running jobs whose lease has lapsed.
CREATE INDEX IF NOT EXISTS jobs_lease_idx
  ON mxq.jobs (lease_expires_at)
  WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_idx
  ON mxq.jobs (queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS jobs_dead_idx
  ON mxq.jobs (queue, updated_at DESC)
  WHERE status = 'dead';

-- Durable cursors for incremental pulls (backfills, connector checkpoints).
-- Separate from the queue: a cursor is long-lived state that outlives any
-- individual job, and losing it would silently restart a backfill from zero.
CREATE TABLE IF NOT EXISTS mxq.cursors (
  id text PRIMARY KEY,
  position jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'paused', 'failed')),
  processed_count bigint NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
