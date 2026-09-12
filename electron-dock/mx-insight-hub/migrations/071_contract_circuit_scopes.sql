-- Contract failures are counted per marketplace, not per provider.
--
-- A response the Hub cannot normalize is a gap in our own contract, not an
-- upstream outage: the vendor answered, and answered for one marketplace. Until
-- now those failures shared the provider-wide breaker, so one unparseable
-- marketplace suspended live dispatch for every other marketplace of the same
-- provider -- which then quietly degraded healthy traffic to days-old stored
-- snapshots.
--
-- Upstream failures (authentication, capacity, balance, transport) keep using
-- the provider-wide breaker in external_platform.provider_state, because those
-- really are provider-wide conditions.
CREATE TABLE IF NOT EXISTS external_platform.provider_contract_circuits (
  provider_key text NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  scope text NOT NULL
    CHECK (scope ~ '^[a-z][a-z0-9._-]{0,63}$'),
  consecutive_failures integer NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  circuit_open_until timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, scope)
);

COMMENT ON TABLE external_platform.provider_contract_circuits IS
  'Per-marketplace breaker for responses the Hub could not normalize; upstream faults stay in provider_state.';
