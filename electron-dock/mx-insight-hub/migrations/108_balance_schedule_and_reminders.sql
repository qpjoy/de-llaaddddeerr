-- Balance probes use fixed :00/:30 Beijing slots. Keep due slots and in-flight
-- leases intact; only bring a future hourly slot forward when necessary.
CREATE OR REPLACE FUNCTION external_platform.next_balance_check(at_time timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE STRICT AS $$
  SELECT (date_trunc('hour', at_time AT TIME ZONE 'Asia/Shanghai')
    + CASE WHEN extract(minute FROM at_time AT TIME ZONE 'Asia/Shanghai') < 30
        THEN interval '30 minutes' ELSE interval '1 hour' END)
    AT TIME ZONE 'Asia/Shanghai'
$$;

UPDATE external_platform.balance_monitors
SET next_check_at = external_platform.next_balance_check(now())
WHERE next_check_at > external_platform.next_balance_check(now());

-- Reminder cooldowns are independent of probe slots. Existing installations
-- retain their one-hour delivery policy until an administrator changes it.
ALTER TABLE external_platform.balance_monitors
  ADD COLUMN feishu_reminder_minutes integer NOT NULL DEFAULT 60
    CHECK (feishu_reminder_minutes BETWEEN 1 AND 1440);

COMMENT ON COLUMN external_platform.balance_monitors.feishu_webhook IS
  'Secret-bearing bot hook. Only explicit Admin Token reauthentication may reveal it; never log or copy into observations/audit records.';
