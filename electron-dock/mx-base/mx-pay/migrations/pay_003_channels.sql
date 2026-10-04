-- Additive upgrade: never edit historical migration checksums.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
-- pay_001 names the multi-column provider/environment check orders_check1.
-- Preserve orders_check2: paid status iff a settlement trade number exists.
ALTER TABLE pay.orders DROP CONSTRAINT orders_check1;
ALTER TABLE pay.orders ADD CONSTRAINT pay_provider_environment CHECK (
  (environment='test' AND provider IN ('mock','alipay')) OR
  (environment='live' AND provider IN ('manual_alipay','alipay'))
);
ALTER TABLE pay.orders ADD CONSTRAINT pay_alipay_identity CHECK (provider <> 'alipay' OR COALESCE((
  document->'checkout'->>'channelId' IS NOT NULL AND
  document->'checkout'->>'sellerId' = merchant_account_id AND
  document->'checkout'->>'alipayAppId' IS NOT NULL AND status IN ('pending','paid')
),false));
-- Automatic and manual verification are two paths into the same Alipay receipt domain.
-- Operators must use the real seller ID for a shared account, never independent aliases.
CREATE UNIQUE INDEX pay_alipay_receipt_once ON pay.orders(environment,merchant_account_id,trade_no)
  WHERE provider IN ('manual_alipay','alipay') AND trade_no IS NOT NULL;
CREATE TABLE pay.channel_bindings (
  id text PRIMARY KEY,
  identity jsonb NOT NULL
);
CREATE TRIGGER pay_channel_identity_immutable BEFORE UPDATE OR DELETE ON pay.channel_bindings
  FOR EACH ROW EXECUTE FUNCTION pay.immutable_record();
-- A verified observation and its local financial effect commit together. Raw PII is not stored.
CREATE TABLE pay.channel_observations (
  id uuid PRIMARY KEY,
  channel_id text NOT NULL REFERENCES pay.channel_bindings(id),
  fingerprint text NOT NULL,
  order_id uuid REFERENCES pay.orders(id),
  app_id text,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  outcome text NOT NULL CHECK (outcome IN ('paid','duplicate','pending','review')),
  reason text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, fingerprint)
);
CREATE INDEX pay_channel_reviews ON pay.channel_observations(app_id,environment,created_at DESC,id DESC) WHERE outcome='review';
CREATE TRIGGER pay_channel_observation_immutable BEFORE UPDATE OR DELETE ON pay.channel_observations
  FOR EACH ROW EXECUTE FUNCTION pay.immutable_record();
-- Short distributed query lease; no DB transaction/connection spans network calls.
CREATE TABLE pay.channel_queries (
  order_id uuid PRIMARY KEY REFERENCES pay.orders(id),
  lease_id uuid NOT NULL,
  available_at timestamptz NOT NULL
);
