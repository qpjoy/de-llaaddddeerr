-- Supplier balance probes move from 10:00/22:00 to every hour (2026-09-18).
-- Wall-clock hour boundaries in Asia/Shanghai, independent of server timezone;
-- still fixed slots, not a rolling interval, so the existing lease, grace window
-- and "consume the slot before network I/O" guarantees are unchanged.
CREATE OR REPLACE FUNCTION external_platform.next_balance_check(at_time timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE STRICT AS $$
  SELECT (date_trunc('hour', at_time AT TIME ZONE 'Asia/Shanghai') + interval '1 hour')
    AT TIME ZONE 'Asia/Shanghai'
$$;

-- Align JustOne with the standalone fee_monitor line (strictly below 5 CNY) and
-- keep Hub's second tier at the 5/3 shape TikHub already uses. Scoped to rows
-- still holding the seeded 30/20 default so an operator's own policy survives.
UPDATE external_platform.balance_monitors
SET warning_threshold = 5, critical_threshold = 3, updated_at = now()
WHERE provider_key = 'justone' AND warning_threshold = 30 AND critical_threshold = 20;

-- Rows still aiming at a 10:00/22:00 slot would wait up to 12 hours for the
-- first hourly check; pull those onto the hourly grid. A slot already due or
-- missed is left alone for the existing five-minute grace/skip logic.
UPDATE external_platform.balance_monitors
SET next_check_at = external_platform.next_balance_check(now())
WHERE next_check_at > external_platform.next_balance_check(now());
