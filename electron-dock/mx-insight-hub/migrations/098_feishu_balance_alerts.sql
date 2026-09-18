-- Feishu delivery for supplier balance incidents (2026-09-18). This reverses the
-- earlier "Hub never sends Feishu" rule: the standalone /tmp/fee_monitor script
-- is superseded, so exactly one sender remains. Cooldown state lives here rather
-- than in that script's state.json, so it survives restarts and is shared by
-- every replica.
ALTER TABLE notifications.incidents ADD COLUMN notified_at timestamptz;
-- Severity at the last confirmed delivery. A warning that later becomes critical
-- must reach the group immediately instead of waiting out the reminder window.
ALTER TABLE notifications.incidents ADD COLUMN notified_severity text;
-- A short lease keeps two replicas from sending the same reminder twice. It is
-- taken before the HTTP request and cleared afterwards, success or failure.
ALTER TABLE notifications.incidents ADD COLUMN notify_lease_until timestamptz;

ALTER TABLE notifications.events DROP CONSTRAINT events_kind_check;
ALTER TABLE notifications.events ADD CONSTRAINT events_kind_check
  CHECK (kind IN ('observed','acknowledged','closed','balance_observed',
                  'balance_recovered','notified','notify_failed'));

-- Delivery scanning only ever looks at non-closed incidents.
CREATE INDEX notifications_incidents_delivery_idx
  ON notifications.incidents(code, notified_at) WHERE status <> 'closed';

COMMENT ON COLUMN notifications.incidents.notified_at IS
  'Last confirmed Feishu delivery; only a bot reply of code 0 sets it.';
