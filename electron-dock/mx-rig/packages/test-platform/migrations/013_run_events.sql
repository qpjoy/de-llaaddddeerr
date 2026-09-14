-- What happened while a run was still running.
--
-- Until now a run had exactly two visible moments: queued, and finished. The
-- ten minutes in between produced no information at all, which is why the run
-- page could only say "执行中，稍后刷新". See docs/25-live-runs-and-runner-onboarding.md.
--
-- This table is deliberately *not* a second source of truth. `summary.json`
-- still decides pass/fail; these rows only describe how the run got there, and
-- a runner that reports nothing here is still a fully conforming runner.

CREATE TABLE IF NOT EXISTS mxt_run_events (
  run_id   text        NOT NULL REFERENCES mxt_runs(id) ON DELETE CASCADE,
  -- Assigned by the server, never by the runner. A runner that numbered its own
  -- events would make network retries and process restarts a source of
  -- duplicate and out-of-order sequence numbers, and the SSE resume point
  -- (`Last-Event-ID`) is exactly this column.
  seq      integer     NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  kind     text        NOT NULL,
  payload  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, seq),
  CONSTRAINT mxt_run_events_kind_check CHECK (
    kind IN ('run.claimed','stage','case.started','case.finished','step','log','run.finished')
  )
);

-- The only access pattern: "everything after seq N for this run", which the
-- primary key already serves. The index below is for the retention sweep,
-- which deletes by age across all runs.
CREATE INDEX IF NOT EXISTS mxt_run_events_at_idx ON mxt_run_events (at);

COMMENT ON TABLE mxt_run_events IS
  'Live progress of a run. Capped per run in the application layer; retained with the artifacts.';
