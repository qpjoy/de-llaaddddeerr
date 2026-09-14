-- MX Test Framework · initial schema
-- Applied by @qpjoy/mx-common runMigrations (advisory lock + immutable checksum).
-- Design: specs/02-domain-model.md
--
-- Deliberately small: no evidence table (artifacts are files on a PVC, indexed
-- as JSON on the run) and no gate/verdict tables (this platform does not gate
-- releases). Seven tables is the whole model.

-- ---------------------------------------------------------------------------
-- Applications, suites, case catalog
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mxt_apps (
  id            text PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  repo_url      text,
  surfaces      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["web","electron"]
  catalog_glob  text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mxt_suites (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES mxt_apps(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  display_name  text NOT NULL,
  engine        text NOT NULL,                        -- cypress | playwright | playwright-electron
  surface       text NOT NULL,                        -- web | electron
  -- server: k8s Job on the Internal cluster. local: someone's Windows/macOS box.
  runner_kind   text NOT NULL DEFAULT 'server',
  runner_image  text,                                 -- overrides the default image for server runs
  requirements  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"os":["windows","macos"]}
  command       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["pnpm","e2e:run:mock"]
  retry_policy  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"maxAttempts":2}
  secret_refs   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- names only; values live in the secret store
  writes_data   boolean NOT NULL DEFAULT false,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, slug)
);

-- Case ids are unique per app, not globally: compass keeps its existing LP-FE-*
-- ids unchanged while new apps follow <APP>-<SURFACE>-<DOMAIN>-<NNN>.
CREATE TABLE IF NOT EXISTS mxt_cases (
  app_id          text NOT NULL REFERENCES mxt_apps(id) ON DELETE CASCADE,
  case_id         text NOT NULL,
  title           text NOT NULL,
  priority        text NOT NULL DEFAULT 'unprioritized',
  tags            jsonb NOT NULL DEFAULT '[]'::jsonb,
  tracks          jsonb NOT NULL DEFAULT '["functional"]'::jsonb,
  spec_path       text,
  suite_slug      text,
  requirement_ref text,
  catalog_file    text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- Soft delete. Runs from months ago still reference removed cases; their
  -- reports must keep resolving instead of breaking.
  retired_at      timestamptz,
  PRIMARY KEY (app_id, case_id)
);

CREATE INDEX IF NOT EXISTS mxt_cases_app_priority_idx
  ON mxt_cases (app_id, priority) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- Runners
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mxt_runners (
  id               text PRIMARY KEY,
  name             text NOT NULL UNIQUE,
  kind             text NOT NULL,                     -- server | local
  os               text NOT NULL,
  arch             text,
  capabilities     jsonb NOT NULL DEFAULT '{}'::jsonb, -- {engines:[], surfaces:[], concurrency:n}
  -- Who owns this machine (mx-launcher principal). Also drives authorization:
  -- a person can only claim work for apps they may run.
  owner_principal  text,
  -- Never store the token; only what is needed to verify a presented one.
  token_sha256     char(64) NOT NULL,
  status           text NOT NULL DEFAULT 'offline',   -- idle | busy | offline | disabled
  last_seen_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tasks: what to run and when
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mxt_tasks (
  id                   text PRIMARY KEY,
  app_id               text NOT NULL REFERENCES mxt_apps(id) ON DELETE CASCADE,
  suite_id             text NOT NULL REFERENCES mxt_suites(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  profile              text NOT NULL DEFAULT 'mock',       -- mock | real
  track                text NOT NULL DEFAULT 'functional', -- functional | demo
  target_url           text,
  -- manual: only when someone presses run. once: at run_at. cron: repeatedly.
  schedule_kind        text NOT NULL DEFAULT 'manual',
  cron_expr            text,
  run_at               timestamptz,
  timezone             text NOT NULL DEFAULT 'Asia/Shanghai',
  -- Local-runner tasks queue until a machine comes online; after this long with
  -- no claim the run expires. Expired is not a failure.
  claim_window_minutes integer NOT NULL DEFAULT 720,
  enabled              boolean NOT NULL DEFAULT true,
  next_run_at          timestamptz,
  last_run_id          text,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mxt_tasks_schedule_check CHECK (
    schedule_kind IN ('manual','once','cron')
    AND (schedule_kind <> 'cron' OR cron_expr IS NOT NULL)
    AND (schedule_kind <> 'once' OR run_at IS NOT NULL)
  )
);

-- The scheduler scans exactly this predicate once a minute.
CREATE INDEX IF NOT EXISTS mxt_tasks_due_idx
  ON mxt_tasks (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mxt_runs (
  id             text PRIMARY KEY,
  app_id         text NOT NULL REFERENCES mxt_apps(id) ON DELETE CASCADE,
  suite_id       text REFERENCES mxt_suites(id) ON DELETE SET NULL,
  task_id        text REFERENCES mxt_tasks(id) ON DELETE SET NULL,
  profile        text NOT NULL,
  track          text NOT NULL,
  engine         text NOT NULL,
  status         text NOT NULL DEFAULT 'queued',
  trigger        text NOT NULL DEFAULT 'manual',      -- manual | schedule | api
  -- Sanitized on ingest: no credentials, query string or fragment.
  target_url     text,
  source_ref     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {gitSha, branch, version}
  runner_id      text REFERENCES mxt_runners(id) ON DELETE SET NULL,
  -- Index into <MXT_ARTIFACTS_DIR>/runs/<id>/, not bytes. `expired` flips to
  -- true when cleanup removes the directory; the run row itself survives so the
  -- report says "expired" instead of 404.
  artifacts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals         jsonb NOT NULL DEFAULT '{}'::jsonb,
  catalog        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- drift summary, see specs/03
  queued_at      timestamptz NOT NULL DEFAULT now(),
  -- How long a local-runner run waits for a machine before expiring.
  claim_deadline timestamptz,
  -- How long the holding runner may go silent before the run is reclaimed as
  -- `timeout`. Refreshed by heartbeat, cleared on completion.
  lease_until    timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  duration_ms    integer,
  blocked_reason text,
  created_by     text,
  CONSTRAINT mxt_runs_status_check CHECK (
    status IN ('queued','pending-runner','running','passed','failed','flaky',
               'blocked','timeout','expired','cancelled')
  )
);

CREATE INDEX IF NOT EXISTS mxt_runs_app_suite_started_idx
  ON mxt_runs (app_id, suite_id, started_at DESC);
CREATE INDEX IF NOT EXISTS mxt_runs_dispatchable_idx
  ON mxt_runs (status, queued_at) WHERE status IN ('queued','pending-runner');
CREATE INDEX IF NOT EXISTS mxt_runs_task_idx ON mxt_runs (task_id, queued_at DESC);

-- Per-case results. This table -- not summary.json -- is the source for every
-- trend, pass-rate and flaky query.
CREATE TABLE IF NOT EXISTS mxt_run_cases (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL REFERENCES mxt_runs(id) ON DELETE CASCADE,
  app_id      text NOT NULL,
  -- No FK: a run may report a case id that is not (or no longer) in the
  -- catalog. Those surface as `unmapped` rather than failing ingest.
  case_id     text NOT NULL,
  status      text NOT NULL,
  attempts    smallint NOT NULL DEFAULT 1,
  duration_ms integer,
  error_text  text,
  spec_path   text,
  title       text,
  UNIQUE (run_id, app_id, case_id),
  CONSTRAINT mxt_run_cases_status_check CHECK (
    status IN ('passed','failed','skipped','flaky','notRun')
  )
);

CREATE INDEX IF NOT EXISTS mxt_run_cases_case_history_idx
  ON mxt_run_cases (app_id, case_id, id DESC);
CREATE INDEX IF NOT EXISTS mxt_run_cases_run_status_idx
  ON mxt_run_cases (run_id, status);

-- User-visible steps. offset_ms is what lets the report jump straight to the
-- failing moment in the recording instead of replaying it from the start.
CREATE TABLE IF NOT EXISTS mxt_steps (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL REFERENCES mxt_runs(id) ON DELETE CASCADE,
  case_id     text,
  seq         integer NOT NULL,
  label       text NOT NULL,
  status      text NOT NULL DEFAULT 'passed',
  offset_ms   integer,
  duration_ms integer
);

CREATE INDEX IF NOT EXISTS mxt_steps_run_case_idx ON mxt_steps (run_id, case_id, seq);
