-- Additive business delivery, preserving all identities, historical orders and balances.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE iam.tenant_memberships DROP CONSTRAINT tenant_memberships_role_check;
ALTER TABLE iam.tenant_memberships ADD CONSTRAINT tenant_memberships_role_check
  CHECK (role IN ('owner','admin','analyst','viewer','billing'));
CREATE SCHEMA hub_recharge;
CREATE TABLE hub_recharge.routes (
  environment text PRIMARY KEY CHECK (environment IN ('test','live')),
  source_id uuid,
  app_id text,
  channel_id text,
  activated_by text,
  activated_at timestamptz,
  CHECK ((source_id IS NULL AND app_id IS NULL AND channel_id IS NULL AND activated_at IS NULL)
    OR (source_id IS NOT NULL AND app_id IS NOT NULL AND channel_id IS NOT NULL AND activated_at IS NOT NULL))
);
INSERT INTO hub_recharge.routes(environment) VALUES ('test'),('live');
CREATE FUNCTION hub_recharge.protect_route() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.source_id IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'activated payment route is immutable; an explicit handover is required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_recharge_route_immutable BEFORE UPDATE OR DELETE ON hub_recharge.routes
  FOR EACH ROW EXECUTE FUNCTION hub_recharge.protect_route();
-- Covers old API replicas too. Activation takes FOR UPDATE on this same row,
-- then checks historical orders, so an in-flight legacy insert cannot slip past.
CREATE FUNCTION hub_recharge.fence_legacy_create() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  SELECT source_id INTO target FROM hub_recharge.routes
    WHERE environment=NEW.document->>'environment' FOR SHARE;
  IF target IS NOT NULL THEN RAISE EXCEPTION 'legacy_payment_writer_disabled' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_recharge_legacy_fence BEFORE INSERT ON mx_pay.orders
  FOR EACH ROW EXECUTE FUNCTION hub_recharge.fence_legacy_create();
CREATE TABLE hub_recharge.orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  environment text NOT NULL REFERENCES hub_recharge.routes(environment),
  source_id uuid NOT NULL,
  app_id text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  intent jsonb NOT NULL,
  payment_id uuid,
  payment jsonb,
  ledger_id uuid,
  credited_at timestamptz,
  invoice jsonb,
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,environment,request_key),
  UNIQUE(source_id,payment_id),
  CHECK (intent->>'id'=id::text AND intent->>'tenantId'=tenant_id::text AND intent->>'environment'=environment),
  CHECK ((intent->>'amountMinor')::bigint BETWEEN 500 AND 10000000 AND intent->>'currency'='CNY'),
  CHECK ((payment_id IS NULL)=(payment IS NULL)),
  CHECK (payment IS NULL OR payment->>'id'=payment_id::text),
  CHECK ((ledger_id IS NULL)=(credited_at IS NULL)),
  CHECK (ledger_id IS NULL OR payment->>'status'='paid')
);
CREATE INDEX hub_recharge_tenant_orders ON hub_recharge.orders(tenant_id,environment,created_at DESC,id DESC);
CREATE INDEX hub_recharge_finance_orders ON hub_recharge.orders(environment,created_at DESC,id DESC);
CREATE TABLE hub_recharge.inbox (
  source_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL UNIQUE REFERENCES hub_recharge.orders(id),
  payment_id uuid NOT NULL,
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  receipt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,event_id),
  UNIQUE(source_id,payment_id)
);
CREATE TABLE hub_recharge.test_credits (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES hub_recharge.orders(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 500 AND 10000000)
);
CREATE TABLE hub_recharge.audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES hub_recharge.orders(id),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,request_key)
);
CREATE TABLE hub_recharge.delivery_errors (
  environment text NOT NULL REFERENCES hub_recharge.routes(environment),
  event_id uuid NOT NULL,
  code text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,event_id)
);
CREATE FUNCTION hub_recharge.protect_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.tenant_id,NEW.environment,NEW.source_id,NEW.app_id,NEW.request_key,NEW.fingerprint,NEW.intent,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.environment,OLD.source_id,OLD.app_id,OLD.request_key,OLD.fingerprint,OLD.intent,OLD.created_at)
    OR (OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id)
    OR (OLD.ledger_id IS NOT NULL AND (NEW.ledger_id,NEW.credited_at,NEW.payment) IS DISTINCT FROM (OLD.ledger_id,OLD.credited_at,OLD.payment)) THEN
    RAISE EXCEPTION 'recharge identity or delivery is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_recharge_orders_protected BEFORE UPDATE OR DELETE ON hub_recharge.orders
  FOR EACH ROW EXECUTE FUNCTION hub_recharge.protect_order();
CREATE TRIGGER hub_recharge_inbox_immutable BEFORE UPDATE OR DELETE ON hub_recharge.inbox FOR EACH ROW EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_credit_immutable BEFORE UPDATE OR DELETE ON hub_recharge.test_credits FOR EACH ROW EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_audit_immutable BEFORE UPDATE OR DELETE ON hub_recharge.audit FOR EACH ROW EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_routes_no_truncate BEFORE TRUNCATE ON hub_recharge.routes FOR EACH STATEMENT EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_orders_no_truncate BEFORE TRUNCATE ON hub_recharge.orders FOR EACH STATEMENT EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_inbox_no_truncate BEFORE TRUNCATE ON hub_recharge.inbox FOR EACH STATEMENT EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_credit_no_truncate BEFORE TRUNCATE ON hub_recharge.test_credits FOR EACH STATEMENT EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_audit_no_truncate BEFORE TRUNCATE ON hub_recharge.audit FOR EACH STATEMENT EXECUTE FUNCTION mx_pay.immutable_record();
CREATE VIEW hub_recharge.order_documents AS
SELECT id,tenant_id,environment,created_at,
  CASE WHEN ledger_id IS NOT NULL THEN 'paid' WHEN payment->>'status' IN ('submitted','cancelled') THEN payment->>'status' ELSE 'pending' END AS status,
  invoice->>'status' AS invoice_status,
  intent || jsonb_build_object('backend','center','paymentId',payment_id,'paymentStatus',COALESCE(payment->>'status','unknown'),
    'deliveryStatus',CASE WHEN ledger_id IS NOT NULL THEN 'credited' WHEN payment->>'status'='paid' THEN 'awaiting_credit' ELSE 'awaiting_payment' END,
    'status',CASE WHEN ledger_id IS NOT NULL THEN 'paid' WHEN payment->>'status' IN ('submitted','cancelled') THEN payment->>'status' ELSE 'pending' END,
    'provider',COALESCE(payment->>'provider','unresolved'),'checkout',COALESCE(payment->'checkout','{}'::jsonb),
    'submission',payment->'submission','settlement',CASE WHEN payment->'settlement' IS NOT NULL AND payment->'settlement'<>'null'::jsonb THEN payment->'settlement'||jsonb_build_object('ledgerEntryId',ledger_id) ELSE NULL END,
    'invoice',invoice,'revision',revision,'creditedAt',credited_at) AS document
FROM hub_recharge.orders;
