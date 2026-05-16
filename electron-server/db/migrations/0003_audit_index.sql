-- Phase 6: tighten audit log access patterns. The 0001 file already
-- created the table + two basic indexes; this adds a (created_at) index
-- so the "latest N events" query the admin UI uses is fast.

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
  ON audit_logs (created_at DESC);

-- And a partial index for the unsync'd-events flavor of query if we add
-- replication later.
CREATE INDEX IF NOT EXISTS audit_logs_action_idx
  ON audit_logs (action, created_at DESC);
