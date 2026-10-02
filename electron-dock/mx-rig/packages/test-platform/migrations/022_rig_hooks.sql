-- 钩子（Hooks）: what Rig did on its own when something happened.
--
-- One row per (rule, subject) — a subject is the run (or procedure replay)
-- the rule reacted to. The primary key is the claim: however many replicas
-- notice the same failed run, exactly one row exists, so exactly one Agent
-- mission is started for it.
CREATE TABLE IF NOT EXISTS rig_hook_fires (
  rule_id     text NOT NULL,
  subject_id  text NOT NULL,
  status      text NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, subject_id),
  CONSTRAINT rig_hook_fires_status_check CHECK (
    status IN ('pending', 'running', 'done', 'skipped', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS rig_hook_fires_pending_idx ON rig_hook_fires (created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS rig_hook_fires_recent_idx ON rig_hook_fires (created_at DESC);
CREATE INDEX IF NOT EXISTS rig_hook_fires_rule_idx ON rig_hook_fires (rule_id, created_at DESC);
