-- 试验规程（Procedure）: tests the crew writes and the machine replays.
--
-- One row per procedure. `doc` holds the current revision, its history, the
-- most recent replays and any open repair proposals; the columns are what
-- gets listed or filtered on. Every change goes through `version`, so two
-- reviewers approving different proposals cannot both win.
CREATE TABLE IF NOT EXISTS rig_procedures (
  id          text PRIMARY KEY,
  app         text,
  case_id     text,
  status      text NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rig_procedures_status_check CHECK (status IN ('draft', 'active', 'retired'))
);

CREATE INDEX IF NOT EXISTS rig_procedures_app_idx ON rig_procedures (app, case_id);
CREATE INDEX IF NOT EXISTS rig_procedures_updated_idx ON rig_procedures (updated_at DESC);
