-- Hub-owned queue for self-hosted collection engines
-- (docs/architecture/spider_man/03-self-hosted-engines.md).
--
-- One real engine executes at most one job. The engine row records the job it
-- is occupied by, and a partial unique index refuses a second running job no
-- matter how many API processes, replicas or nodes submit work. An unknown
-- outcome keeps the engine quarantined until an operator confirms the previous
-- run has ended; no lease or timeout releases it.
--
-- New schema only: no existing table is altered or locked.
--
-- billing_enabled defaults to false: jobs are forwarded without touching the
-- usage ledger, so they never contend with a caller's paid requests for the
-- per-consumer reservation locks or usage_requests writes.
SET LOCAL lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS self_hosted;

CREATE TABLE self_hosted.engines (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
  base_url text NOT NULL,
  enabled boolean NOT NULL,
  billing_enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL CHECK (revision >= 0),
  active_job_id uuid,
  quarantine_reason text,
  quarantined_at timestamptz,
  cooldown_until timestamptz,
  updated_by text NOT NULL,
  update_reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((quarantine_reason IS NULL) = (quarantined_at IS NULL))
);

-- Admin and the executor are hostNetwork today, so loopback is the host.
INSERT INTO self_hosted.engines (id, base_url, enabled, revision, updated_by, update_reason)
VALUES ('night-all.wechat-mp', 'http://127.0.0.1:13141', true, 0, 'migration', '部署默认：宿主机 Night-All 13141');

CREATE TABLE self_hosted.batches (
  id uuid PRIMARY KEY,
  engine_id text NOT NULL REFERENCES self_hosted.engines(id),
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint char(64) NOT NULL,
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consumer_id, idempotency_key)
);

CREATE TABLE self_hosted.jobs (
  id uuid PRIMARY KEY,
  engine_id text NOT NULL REFERENCES self_hosted.engines(id),
  batch_id uuid REFERENCES self_hosted.batches(id),
  item_index integer,
  client_ref text,
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  idempotency_key text,
  fingerprint char(64) NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'expired')),
  source_mode text CHECK (source_mode IN ('live', 'fresh_cache', 'stored_fallback')),
  billing text NOT NULL DEFAULT 'none' CHECK (billing IN ('none', 'reserved', 'charged', 'not_charged', 'pending_review')),
  usage_request_id uuid,
  owner text,
  engine_revision integer,
  base_url text,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  http_status integer,
  result jsonb,
  error jsonb,
  late_evidence jsonb,
  CHECK ((batch_id IS NULL) = (idempotency_key IS NOT NULL)),
  CHECK ((batch_id IS NULL) = (item_index IS NULL))
);

CREATE UNIQUE INDEX jobs_consumer_idempotency_idx ON self_hosted.jobs (consumer_id, idempotency_key) WHERE batch_id IS NULL;
CREATE UNIQUE INDEX jobs_batch_item_idx ON self_hosted.jobs (batch_id, item_index) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_one_running_idx ON self_hosted.jobs (engine_id) WHERE status = 'running';
CREATE INDEX jobs_queue_idx ON self_hosted.jobs (engine_id, queued_at, item_index, id) WHERE status = 'queued';
CREATE INDEX jobs_open_consumer_idx ON self_hosted.jobs (engine_id, consumer_id) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_consumer_recent_idx ON self_hosted.jobs (consumer_id, queued_at DESC);
CREATE INDEX jobs_recent_idx ON self_hosted.jobs (engine_id, queued_at DESC);
CREATE INDEX jobs_live_duration_idx ON self_hosted.jobs (engine_id, finished_at DESC)
  WHERE status = 'succeeded' AND source_mode = 'live';

CREATE TABLE self_hosted.engine_events (
  id bigserial PRIMARY KEY,
  engine_id text NOT NULL REFERENCES self_hosted.engines(id),
  action text NOT NULL,
  revision integer NOT NULL,
  job_id uuid,
  actor text NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_events_recent_idx ON self_hosted.engine_events (engine_id, created_at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA self_hosted FROM PUBLIC;
