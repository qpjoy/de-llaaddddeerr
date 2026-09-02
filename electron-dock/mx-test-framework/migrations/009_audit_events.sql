-- Append-only record of who changed what.
--
-- ADR-0007 removed the command allowlist on the grounds that it was
-- inconsistent — it constrained `command` while `runnerImage` accepted any
-- image — and said the real trust boundary is "admin role + sandboxed
-- container + audit". This table is the third of those three, which until now
-- did not exist.
--
-- What it has to answer: *who changed the command to that, and when, and what
-- was it before*. Anything that does not help answer a question of that shape
-- does not belong here — an audit log that records everything is one nobody
-- reads.
--
-- There is deliberately no UPDATE or DELETE path in the API. A log that can be
-- edited is not evidence of anything.

CREATE TABLE IF NOT EXISTS mxt_audit_events (
  id             text PRIMARY KEY,
  -- Who. Kept as a denormalised name as well as an id, because the point of an
  -- audit trail is to stay readable after the account is gone.
  actor_id       text,
  actor_name     text,
  action         text NOT NULL,          -- suite.create, member.role_change, ...
  resource_type  text NOT NULL,          -- suite | app | task | member | channel | package | runner
  resource_id    text,
  app_id         text,
  -- Before and after, already scrubbed of credentials by server/audit.mjs.
  -- NULL `before` means creation; NULL `after` means deletion.
  before         jsonb,
  after          jsonb,
  source_ip      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mxt_audit_events_resource_idx
  ON mxt_audit_events (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mxt_audit_events_app_idx
  ON mxt_audit_events (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mxt_audit_events_created_idx
  ON mxt_audit_events (created_at DESC);
