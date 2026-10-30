-- Preserve legacy reservations and receipts. Old remaining is a conservative
-- local allowance, not an original supplier observation. Do not relabel it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE control.facebook_rapid_quota
  ADD COLUMN supplier_remaining integer CHECK (supplier_remaining >= 0),
  ADD COLUMN supplier_limit integer CHECK (supplier_limit > 0),
  ADD COLUMN supplier_observed_at timestamptz,
  ADD COLUMN manual_check_until timestamptz;
-- The audit retains historical counters; new code never gates on used or the
-- retired monthly/billing-day settings. No quota refill or automatic probe.
UPDATE control.facebook_rapid_quota SET reason='quota_unknown',blocked_until=NULL
WHERE remaining=0 AND reason IS DISTINCT FROM 'rate_limited'
  AND lease_token IS NULL;
CREATE TABLE control.facebook_rapid_check_events (
  id uuid PRIMARY KEY,
  reason text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  quota_observed_at timestamptz NOT NULL
);
