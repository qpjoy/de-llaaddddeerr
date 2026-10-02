-- The Rig control plane's own state, moved out of the service's state directory.
--
-- Until now missions, policy settings, schedule slots and tutorial progress
-- were JSON files next to one process. That pinned the service to a single
-- replica and kept mission history out of reach of any report. They live here
-- now, in the same database as the test domain, so a report can read both and
-- a backup covers both.

-- One row per mission. `doc` is the mission record the runtime works on; the
-- other columns are what gets queried or coordinated on.
--
-- Exactly one process writes a running mission: the one in `holder`. Others
-- ask it to stop through `cancel_requested_at` instead of rewriting the row,
-- so two replicas never race over the same record. A holder that stops
-- writing its heartbeat is presumed gone, and its unfinished missions are
-- closed as blocked rather than left "running" forever.
CREATE TABLE IF NOT EXISTS rig_missions (
  id                   uuid PRIMARY KEY,
  owner                text NOT NULL,
  surface              text NOT NULL DEFAULT 'internal',
  mode                 text NOT NULL,
  status               text NOT NULL,
  doc                  jsonb NOT NULL,
  holder               text,
  heartbeat_at         timestamptz,
  cancel_requested_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rig_missions_surface_check CHECK (surface IN ('internal', 'desktop')),
  CONSTRAINT rig_missions_status_check CHECK (
    status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'blocked', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS rig_missions_owner_idx ON rig_missions (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS rig_missions_live_idx ON rig_missions (holder, heartbeat_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS rig_missions_created_idx ON rig_missions (created_at DESC);

-- Small singleton documents: policy settings and tutorial progress. `version`
-- is an optimistic-concurrency counter; a save that names a stale version is
-- refused instead of silently overwriting someone else's edit.
CREATE TABLE IF NOT EXISTS rig_state (
  key         text PRIMARY KEY,
  doc         jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rig_state_key_check CHECK (key ~ '^[a-z][a-z0-9-]{0,40}$')
);

-- Each scheduled slot fires once, whichever replica gets there first: the
-- primary key is the claim.
CREATE TABLE IF NOT EXISTS rig_schedule_fires (
  orchestration_key  text NOT NULL,
  fired_for          timestamptz NOT NULL,
  claimed_by         text,
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (orchestration_key, fired_for)
);
