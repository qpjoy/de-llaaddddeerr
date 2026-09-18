-- Two gaps in supplier balance alerting (2026-09-18).
--
-- 1. A failed probe recorded an error code and nothing else, so a monitor that
--    could no longer read a balance went quiet instead of saying so. It now
--    opens its own incident, which the Feishu notifier delivers like any other.
-- 2. Recovery closed the incident silently. The group that was told about the
--    problem is now told when it clears. When a provider's balance and probe
--    recoveries land in the same pass, only the balance message is sent and the
--    probe recovery is recorded as `notify_merged` -- marked delivered so it
--    cannot resurface on a later pass as a second message.
ALTER TABLE notifications.incidents ADD COLUMN recovery_notified_at timestamptz;

ALTER TABLE notifications.events DROP CONSTRAINT events_kind_check;
ALTER TABLE notifications.events ADD CONSTRAINT events_kind_check
  CHECK (kind IN ('observed','acknowledged','closed','balance_observed',
                  'balance_recovered','notified','notify_failed',
                  'probe_failed','probe_recovered','notify_merged'));

COMMENT ON COLUMN notifications.incidents.recovery_notified_at IS
  'Recovery delivery. Only an incident that was announced is announced as recovered.';
