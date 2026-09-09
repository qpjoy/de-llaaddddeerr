-- Concurrency-safe procurement reservations for bounded multi-call workflows.
-- A reservation is not a provider call: provider_calls continues to contain
-- one row per real dispatch. The reservation only holds reviewed monthly cost
-- and subsidy headroom until the workflow either dispatches or releases it.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE IF NOT EXISTS external_platform.provider_cost_reservations (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  usage_request_id uuid NOT NULL REFERENCES usage_requests(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base_cost_minor bigint NOT NULL CHECK (base_cost_minor >= 0),
  reserved_cost_minor bigint NOT NULL CHECK (reserved_cost_minor > 0),
  reserved_subsidy_minor bigint NOT NULL CHECK (reserved_subsidy_minor >= 0),
  monthly_budget_minor bigint NOT NULL CHECK (monthly_budget_minor >= 0),
  monthly_subsidy_budget_minor bigint NOT NULL
    CHECK (monthly_subsidy_budget_minor >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK (
    (status = 'active' AND released_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS external_platform_provider_cost_reservations_active_usage_idx
  ON external_platform.provider_cost_reservations (usage_request_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS external_platform_provider_cost_reservations_budget_idx
  ON external_platform.provider_cost_reservations (provider_key, status, created_at DESC);

COMMENT ON TABLE external_platform.provider_cost_reservations IS
  'Short-lived cost/subsidy holds for known multi-dispatch workflows; never provider-call evidence.';
