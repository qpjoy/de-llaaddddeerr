-- Billing-day hints only schedule demand-triggered recovery checks. They never
-- reset observed quota, edit grants/prices, or generate background provider calls.
ALTER TABLE control.platform_search_policies
  ADD COLUMN billing_cycle_day integer NOT NULL DEFAULT 27 CHECK (billing_cycle_day BETWEEN 1 AND 31),
  ADD COLUMN billing_probe_interval_hours integer NOT NULL DEFAULT 6 CHECK (billing_probe_interval_hours BETWEEN 1 AND 24);
