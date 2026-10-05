-- One explicit personal account per verified human. Existing SSO accounts are
-- adopted on use, never replaced or automatically reactivated.
CREATE TABLE IF NOT EXISTS iam.personal_accounts (
  member_id uuid PRIMARY KEY REFERENCES iam.members(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_recharge_pending_invoices_idx
  ON hub_recharge.orders(environment) WHERE invoice->>'status'='requested';
CREATE INDEX IF NOT EXISTS hub_recharge_return_trade_idx
  ON hub_recharge.orders((payment #>> '{checkout,outTradeNo}'));
CREATE INDEX IF NOT EXISTS identity_personal_tenant_events_idx
  ON iam.identity_events(member_id) WHERE event_type='sso.personal-tenant-created';
