-- How an exempt LCY Key meets supplier concurrency and RPM. 'bypass' is the
-- behavior every existing row already has; only an explicit administrator save
-- can select 'priority', and only for the original LCY identity.
ALTER TABLE api_keys
  ADD COLUMN hub_supplier_admission text NOT NULL DEFAULT 'bypass'
    CHECK (hub_supplier_admission IN ('bypass', 'priority')),
  ADD CONSTRAINT api_key_hub_supplier_admission_identity CHECK (
    hub_supplier_admission = 'bypass' OR (
      id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
      AND tenant_id = '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
      AND consumer_id = 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
    )
  );

-- Audit rows written before this migration recorded only the exemption.
ALTER TABLE control.api_key_hub_limit_events
  ADD COLUMN previous_supplier_admission text
    CHECK (previous_supplier_admission IN ('bypass', 'priority')),
  ADD COLUMN next_supplier_admission text
    CHECK (next_supplier_admission IN ('bypass', 'priority'));
