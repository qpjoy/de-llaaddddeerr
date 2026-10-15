-- Shared HTTP admission only. Preserve quota observations, probes and prices.
SET LOCAL lock_timeout = '5s';
ALTER TABLE control.facebook_rapid_quota
  ADD COLUMN waiters jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(waiters) = 'array' AND jsonb_array_length(waiters) <= 32);
