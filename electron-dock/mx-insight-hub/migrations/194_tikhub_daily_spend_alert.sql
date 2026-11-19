-- Reuse scheduled account reads. No business-request trigger or ledger scan.
ALTER TABLE external_platform.balance_monitors
  ADD COLUMN daily_spend_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN daily_spend_threshold numeric(24,12) NOT NULL DEFAULT 30 CHECK (daily_spend_threshold > 0),
  ADD COLUMN daily_spend_day_start_hour integer NOT NULL DEFAULT 0 CHECK (daily_spend_day_start_hour IN (0,10)),
  ADD COLUMN daily_spend_state jsonb;
UPDATE external_platform.balance_monitors SET daily_spend_enabled=true WHERE provider_key='tikhub';

ALTER TABLE notifications.events DROP CONSTRAINT events_kind_check;
ALTER TABLE notifications.events ADD CONSTRAINT events_kind_check
  CHECK (kind IN ('observed','acknowledged','closed','balance_observed',
    'balance_recovered','notified','notify_failed','probe_failed','probe_recovered',
    'notify_merged','daily_spend_observed','daily_spend_reset'));

-- Monitoring evidence has bounded retention; immutable paid-call evidence does
-- not use these rows. Retained incident evidence carries its own amount/time.
ALTER TABLE notifications.events DROP CONSTRAINT events_balance_observation_id_fkey;
ALTER TABLE notifications.events ADD CONSTRAINT events_balance_observation_id_fkey
  FOREIGN KEY (balance_observation_id) REFERENCES external_platform.balance_observations(id) ON DELETE SET NULL;
CREATE INDEX balance_observations_retention_idx ON external_platform.balance_observations(observed_at,id);
CREATE INDEX notifications_events_balance_observation_idx ON notifications.events(balance_observation_id)
  WHERE balance_observation_id IS NOT NULL;
CREATE INDEX notifications_incidents_retention_idx ON notifications.incidents(code,status,updated_at,id);
CREATE INDEX notifications_monitor_events_retention_idx ON notifications.events(occurred_at,id)
  WHERE actor IN ('monitor:balance','monitor:daily-spend','notifier:feishu');
COMMENT ON COLUMN external_platform.balance_monitors.daily_spend_state IS
  'Bounded current-day cash-decrease estimate plus one boundary snapshot; never a billed-spend ledger.';
