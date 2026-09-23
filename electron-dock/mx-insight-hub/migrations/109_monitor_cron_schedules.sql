-- Per-provider application-owned schedules. No system crontab or identity changes.
ALTER TABLE external_platform.balance_monitors
  ADD COLUMN balance_schedule jsonb NOT NULL DEFAULT '{"mode":"cron","expression":"*/30 * * * *"}',
  ADD COLUMN feishu_schedule jsonb NOT NULL DEFAULT '{"mode":"cron","expression":"0 * * * *"}';

-- Preserve existing rolling reminder intervals during upgrade. Operators can
-- explicitly switch to aligned Cron/daily schedules in the console.
UPDATE external_platform.balance_monitors
SET feishu_schedule = jsonb_build_object('mode','interval','minutes',feishu_reminder_minutes);

ALTER TABLE external_platform.balance_monitors
  ADD CONSTRAINT balance_schedule_shape CHECK (jsonb_typeof(balance_schedule)='object' AND COALESCE(balance_schedule->>'mode' IN ('cron','interval'),false)),
  ADD CONSTRAINT feishu_schedule_shape CHECK (jsonb_typeof(feishu_schedule)='object' AND COALESCE(feishu_schedule->>'mode' IN ('cron','interval'),false));

ALTER TABLE notifications.incidents ADD COLUMN next_reminder_at timestamptz;
UPDATE notifications.incidents i
SET next_reminder_at = i.notified_at + make_interval(mins => m.feishu_reminder_minutes)
FROM external_platform.balance_monitors m
WHERE i.source=m.provider_key AND i.notified_at IS NOT NULL
  AND i.code IN ('supplier_balance_low','supplier_balance_unreadable') AND i.status <> 'closed';

CREATE INDEX incidents_next_reminder_idx ON notifications.incidents(next_reminder_at)
WHERE status <> 'closed' AND code IN ('supplier_balance_low','supplier_balance_unreadable');
