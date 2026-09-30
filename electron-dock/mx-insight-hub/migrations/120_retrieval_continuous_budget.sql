SET LOCAL lock_timeout = '2s';
-- Explicit opt-in only. Existing daily budgets and enable/pause flags stay
-- unchanged. 0 means token metering without a daily stop, with worker guards.
ALTER TABLE retrieval.settings DROP CONSTRAINT settings_daily_token_budget_check;
ALTER TABLE retrieval.settings ADD CONSTRAINT settings_daily_token_budget_check
  CHECK (daily_token_budget=0 OR daily_token_budget BETWEEN 1000 AND 1000000000);
