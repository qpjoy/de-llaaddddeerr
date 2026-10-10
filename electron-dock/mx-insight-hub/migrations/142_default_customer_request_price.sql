-- User-authorized default for existing and future unlisted business meters.
-- Immutable plan entries (including explicit free entries) still take priority.
-- Billing mode, multiplier, wallets and historical charges remain unchanged.
ALTER TABLE billing.tenant_billing_profiles ALTER COLUMN default_unit_price_minor SET DEFAULT 1;
UPDATE billing.tenant_billing_profiles
  SET default_unit_price_minor=1, revision=revision+1,
      updated_by='migration-142:default-request-price'
  WHERE default_unit_price_minor=0;
