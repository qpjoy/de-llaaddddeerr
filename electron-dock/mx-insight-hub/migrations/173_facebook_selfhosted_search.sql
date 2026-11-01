-- Facebook content search may use the self-hosted Night-All-A collector. The
-- saved mode is unchanged; only an administrator save selects 'selfhosted'.
SET LOCAL lock_timeout = '5s';
ALTER TABLE control.platform_search_policies
  DROP CONSTRAINT platform_search_policies_mode_check,
  ADD CONSTRAINT platform_search_policies_mode_check
    CHECK (mode IN ('existing', 'auto', 'rapidapi', 'justone', 'paused', 'selfhosted')),
  -- Cluster-wide limits for requests reaching Night-All-A: tasks in flight at
  -- once, and task starts per minute spaced evenly (60 s / value apart).
  ADD COLUMN selfhosted_max_concurrency integer NOT NULL DEFAULT 2
    CHECK (selfhosted_max_concurrency BETWEEN 1 AND 8),
  ADD COLUMN selfhosted_requests_per_minute integer NOT NULL DEFAULT 12
    CHECK (selfhosted_requests_per_minute BETWEEN 1 AND 120);
-- One row serializes every Hub process and replica. Leases expire on their own
-- after the run budget; waiters past their deadline are dropped on next read.
CREATE TABLE control.facebook_selfhosted_admission (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  leases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(leases) = 'array'),
  waiters jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(waiters) = 'array'),
  last_dispatch_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO control.facebook_selfhosted_admission(singleton) VALUES (true) ON CONFLICT DO NOTHING;
REVOKE ALL ON control.facebook_selfhosted_admission FROM PUBLIC;
