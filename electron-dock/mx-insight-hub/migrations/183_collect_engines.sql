-- Generic collection engines (docs/architecture/spider_man/07-collect-engines.md).
--
-- A new schema next to self_hosted (migration 165). The WeChat engine keeps
-- its own tables and code until it is moved over deliberately; nothing here
-- alters or locks an existing table.
--
-- Concurrency model:
-- * One engine row per real upstream resource, with `capacity` execution
--   slots. Each slot is a row; claims take a free slot with FOR UPDATE SKIP
--   LOCKED, so executors on any process or node never wait on each other, and
--   a partial unique index refuses two running jobs on one slot.
-- * Results live in job_results, written once, so polling and queue scans
--   never read or rewrite large payloads.
-- * An unknown outcome keeps its slot occupied and quarantined until an
--   operator confirms the upstream run has ended; nothing times it out.
--
-- No engine is seeded: operators create engines in the console, disabled.
SET LOCAL lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS collect;

CREATE TABLE collect.engines (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  slot_ref text CHECK (slot_ref ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  base_url text,
  credential_provider text CHECK (credential_provider ~ '^[a-z][a-z0-9._-]{0,63}$'),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 64),
  queue_limit integer NOT NULL CHECK (queue_limit BETWEEN 1 AND 20000),
  consumer_open_limit integer NOT NULL CHECK (consumer_open_limit BETWEEN 1 AND 5000),
  queue_wait_ms bigint NOT NULL CHECK (queue_wait_ms BETWEEN 60000 AND 86400000),
  run_timeout_ms integer NOT NULL CHECK (run_timeout_ms BETWEEN 5000 AND 21600000),
  enabled boolean NOT NULL DEFAULT false,
  billing_enabled boolean NOT NULL DEFAULT false,
  quarantine_reason text,
  quarantined_at timestamptz,
  cooldown_until timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  update_reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((quarantine_reason IS NULL) = (quarantined_at IS NULL))
);

CREATE TABLE collect.engine_slots (
  engine_id text NOT NULL REFERENCES collect.engines(id) ON DELETE CASCADE,
  slot_no integer NOT NULL CHECK (slot_no BETWEEN 1 AND 64),
  job_id uuid,
  quarantine_reason text,
  quarantined_at timestamptz,
  PRIMARY KEY (engine_id, slot_no),
  CHECK ((quarantine_reason IS NULL) = (quarantined_at IS NULL)),
  CHECK (quarantine_reason IS NULL OR job_id IS NOT NULL)
);

-- Which engine serves a capability. route_key splits one capability across
-- engines (for example one app market per engine); '' when there is none.
CREATE TABLE collect.routes (
  capability text NOT NULL CHECK (capability ~ '^collect\.[a-z0-9._-]{3,96}$'),
  route_key text NOT NULL DEFAULT '' CHECK (route_key ~ '^[a-z0-9_-]{0,32}$'),
  engine_id text NOT NULL REFERENCES collect.engines(id) ON DELETE CASCADE,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capability, route_key)
);
CREATE INDEX routes_engine_idx ON collect.routes (engine_id);

CREATE TABLE collect.batches (
  id uuid PRIMARY KEY,
  capability text NOT NULL,
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint char(64) NOT NULL,
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consumer_id, idempotency_key)
);

CREATE TABLE collect.jobs (
  id uuid PRIMARY KEY,
  engine_id text NOT NULL REFERENCES collect.engines(id),
  capability text NOT NULL,
  route_key text NOT NULL DEFAULT '',
  batch_id uuid REFERENCES collect.batches(id) ON DELETE CASCADE,
  item_index integer,
  client_ref text,
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  idempotency_key text,
  fingerprint char(64) NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'expired')),
  -- dispatching: this executor is talking to the upstream now (lease-bound).
  -- waiting: the upstream accepted the run; any executor may check it when due.
  phase text CHECK (phase IN ('dispatching', 'waiting')),
  data_status text CHECK (data_status IN ('success', 'no_data', 'partial', 'unknown')),
  slot_no integer,
  owner text,
  lease_until timestamptz,
  next_check_at timestamptz,
  checks integer NOT NULL DEFAULT 0,
  upstream_ref text,
  upstream_state jsonb,
  billing text NOT NULL DEFAULT 'none' CHECK (billing IN ('none', 'reserved', 'charged', 'not_charged', 'pending_review')),
  usage_request_id uuid,
  engine_revision integer,
  base_url text,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  run_deadline_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  http_status integer,
  error jsonb,
  cost jsonb,
  late_evidence jsonb,
  CHECK ((batch_id IS NULL) = (idempotency_key IS NOT NULL)),
  CHECK ((batch_id IS NULL) = (item_index IS NULL)),
  CHECK ((status = 'running') = (phase IS NOT NULL)),
  CHECK (status <> 'running' OR (slot_no IS NOT NULL AND owner IS NOT NULL AND lease_until IS NOT NULL AND run_deadline_at IS NOT NULL)),
  CHECK (phase IS DISTINCT FROM 'waiting' OR next_check_at IS NOT NULL)
);

CREATE UNIQUE INDEX jobs_consumer_idempotency_idx ON collect.jobs (consumer_id, idempotency_key) WHERE batch_id IS NULL;
CREATE UNIQUE INDEX jobs_batch_item_idx ON collect.jobs (batch_id, item_index) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_running_slot_idx ON collect.jobs (engine_id, slot_no) WHERE status = 'running';
CREATE INDEX jobs_queue_idx ON collect.jobs (engine_id, queued_at, item_index, id) WHERE status = 'queued';
CREATE INDEX jobs_queue_deadline_idx ON collect.jobs (deadline_at) WHERE status = 'queued';
CREATE INDEX jobs_waiting_due_idx ON collect.jobs (next_check_at) WHERE phase = 'waiting';
CREATE INDEX jobs_dispatch_lease_idx ON collect.jobs (lease_until) WHERE phase = 'dispatching';
CREATE INDEX jobs_open_consumer_idx ON collect.jobs (engine_id, consumer_id) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_consumer_recent_idx ON collect.jobs (consumer_id, queued_at DESC);
CREATE INDEX jobs_engine_recent_idx ON collect.jobs (engine_id, queued_at DESC);
CREATE INDEX jobs_engine_finished_idx ON collect.jobs (engine_id, finished_at DESC) WHERE finished_at IS NOT NULL;
CREATE INDEX jobs_batch_idx ON collect.jobs (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE collect.job_results (
  job_id uuid PRIMARY KEY REFERENCES collect.jobs(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  sha256 char(64) NOT NULL,
  item_count integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collect.engine_events (
  id bigserial PRIMARY KEY,
  engine_id text NOT NULL REFERENCES collect.engines(id) ON DELETE CASCADE,
  action text NOT NULL,
  revision integer NOT NULL,
  slot_no integer,
  job_id uuid,
  actor text NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_events_recent_idx ON collect.engine_events (engine_id, created_at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA collect FROM PUBLIC;
