-- Run-scoped runner credentials.
--
-- A dispatched Kubernetes Job has no registered runner to authenticate as, and
-- handing it the long-lived runner token would give a container running
-- third-party test code the ability to claim other work. Instead each run
-- carries its own credential: it can only touch that run, and it dies with it.
-- See specs/adr/0005-federated-identity-and-runner-tokens.md.

ALTER TABLE mxt_runs
  ADD COLUMN IF NOT EXISTS run_token_sha256 char(64);

CREATE INDEX IF NOT EXISTS mxt_runs_run_token_idx
  ON mxt_runs (run_token_sha256) WHERE run_token_sha256 IS NOT NULL;
