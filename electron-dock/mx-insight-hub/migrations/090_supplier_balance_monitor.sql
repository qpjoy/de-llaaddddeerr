-- Read-only supplier account probes, independent of customer billing/dispatch.
CREATE FUNCTION external_platform.next_balance_check(at_time timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE STRICT AS $$
  SELECT min(slot AT TIME ZONE 'Asia/Shanghai')
  FROM (VALUES
    (date_trunc('day', at_time AT TIME ZONE 'Asia/Shanghai') + interval '10 hours'),
    (date_trunc('day', at_time AT TIME ZONE 'Asia/Shanghai') + interval '22 hours'),
    (date_trunc('day', at_time AT TIME ZONE 'Asia/Shanghai') + interval '1 day 10 hours')
  ) AS slots(slot)
  WHERE slot AT TIME ZONE 'Asia/Shanghai' > at_time
$$;

CREATE TABLE external_platform.balance_monitors (
  provider_key text PRIMARY KEY,
  currency text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  warning_threshold numeric(24,12) NOT NULL CHECK (warning_threshold > 0),
  critical_threshold numeric(24,12) NOT NULL CHECK (critical_threshold >= 0 AND critical_threshold < warning_threshold),
  revision integer NOT NULL DEFAULT 0,
  next_check_at timestamptz NOT NULL DEFAULT external_platform.next_balance_check(now()),
  lease_token uuid,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_balance numeric(24,12),
  credential_scope text,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO external_platform.balance_monitors(provider_key,currency,warning_threshold,critical_threshold)
VALUES ('justone','CNY',30,20), ('tikhub','USD',5,3);

CREATE TABLE external_platform.balance_observations (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL REFERENCES external_platform.balance_monitors(provider_key),
  credential_scope text NOT NULL,
  currency text NOT NULL,
  balance numeric(24,12),
  error_code text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX balance_observations_provider_time_idx
  ON external_platform.balance_observations(provider_key,observed_at DESC);
CREATE TABLE external_platform.balance_monitor_settings_events (
  id bigserial PRIMARY KEY,
  provider_key text NOT NULL,
  revision integer NOT NULL,
  settings jsonb NOT NULL,
  actor text NOT NULL DEFAULT 'admin-token',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notifications.incidents ADD COLUMN recovered_at timestamptz;
ALTER TABLE notifications.events DROP CONSTRAINT events_kind_check;
ALTER TABLE notifications.events ADD CONSTRAINT events_kind_check
  CHECK (kind IN ('observed','acknowledged','closed','balance_observed','balance_recovered'));
ALTER TABLE notifications.events ADD COLUMN balance_observation_id uuid
  REFERENCES external_platform.balance_observations(id);
ALTER TABLE notifications.events ADD COLUMN evidence jsonb;
