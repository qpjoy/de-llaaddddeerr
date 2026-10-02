-- A dedicated database is required. Never install the standalone schema in Hub/Launcher.
DO $$ BEGIN
  IF to_regclass('public.tenants') IS NOT NULL OR to_regclass('public.mx_platform_records') IS NOT NULL
     OR to_regclass('mx_pay.orders') IS NOT NULL THEN
    RAISE EXCEPTION 'mx-pay requires a dedicated database, not Hub or Launcher storage';
  END IF;
END $$;
CREATE SCHEMA pay;
CREATE TABLE pay.settings (
  id text PRIMARY KEY CHECK (id = 'manual_alipay'),
  document jsonb NOT NULL
);
CREATE TABLE pay.orders (
  id uuid PRIMARY KEY,
  app_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  business_order_id text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  status text GENERATED ALWAYS AS (document->>'status') STORED NOT NULL
    CHECK (status IN ('pending','submitted','paid','cancelled')),
  provider text GENERATED ALWAYS AS (document->>'provider') STORED NOT NULL,
  merchant_account_id text GENERATED ALWAYS AS (document->>'merchantAccountId') STORED NOT NULL,
  trade_no text GENERATED ALWAYS AS (document->'settlement'->>'tradeNo') STORED,
  amount_minor bigint GENERATED ALWAYS AS ((document->>'amountMinor')::bigint) STORED NOT NULL
    CHECK (amount_minor BETWEEN 500 AND 10000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, environment, request_key),
  UNIQUE (app_id, environment, business_order_id),
  CHECK (document->>'id' = id::text AND document->>'appId' = app_id
    AND document->>'environment' = environment AND document->>'businessOrderId' = business_order_id),
  CHECK (document->>'currency' = 'CNY'),
  CHECK ((environment='test' AND provider='mock') OR (environment='live' AND provider='manual_alipay')),
  CHECK ((status='paid') = (trade_no IS NOT NULL))
);
-- A receipt cannot fund two applications, even with different business/customer IDs.
CREATE UNIQUE INDEX pay_receipt_once ON pay.orders(environment,provider,merchant_account_id,trade_no)
  WHERE trade_no IS NOT NULL;
CREATE INDEX pay_app_orders ON pay.orders(app_id,environment,created_at DESC,id DESC);
CREATE INDEX pay_app_status ON pay.orders(app_id,environment,status,created_at DESC,id DESC);
CREATE TABLE pay.audit (
  id uuid PRIMARY KEY,
  order_id uuid REFERENCES pay.orders(id),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id,request_key)
);
CREATE INDEX pay_order_audit ON pay.audit(order_id,created_at,id);
-- Durable delivery: read pending events, commit consumer inbox/business work, then ack.
-- No sequence watermark: concurrent transactions can commit out of sequence.
CREATE TABLE pay.outbox (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES pay.orders(id),
  app_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledgement jsonb,
  CHECK ((acknowledged_at IS NULL) = (acknowledgement IS NULL))
);
CREATE INDEX pay_pending_events ON pay.outbox(app_id,environment,created_at,id)
  WHERE acknowledged_at IS NULL;
CREATE FUNCTION pay.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payment evidence is append-only'; END $$;
CREATE TRIGGER pay_audit_immutable BEFORE UPDATE OR DELETE ON pay.audit
  FOR EACH ROW EXECUTE FUNCTION pay.immutable_record();
CREATE FUNCTION pay.protect_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payment orders cannot be deleted'; END IF;
  IF (NEW.id,NEW.app_id,NEW.environment,NEW.business_order_id,NEW.request_key,NEW.fingerprint,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.app_id,OLD.environment,OLD.business_order_id,OLD.request_key,OLD.fingerprint,OLD.created_at)
    OR (NEW.document - ARRAY['status','revision','submission','settlement','rejection','updatedAt'])
    IS DISTINCT FROM (OLD.document - ARRAY['status','revision','submission','settlement','rejection','updatedAt']) THEN
    RAISE EXCEPTION 'payment identity is immutable';
  END IF;
  IF OLD.status IN ('paid','cancelled') AND NEW.document IS DISTINCT FROM OLD.document THEN
    RAISE EXCEPTION 'terminal payment cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_orders_protected BEFORE UPDATE OR DELETE ON pay.orders
  FOR EACH ROW EXECUTE FUNCTION pay.protect_order();
CREATE FUNCTION pay.protect_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payment events cannot be deleted'; END IF;
  IF (NEW.id,NEW.order_id,NEW.app_id,NEW.environment,NEW.document,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.app_id,OLD.environment,OLD.document,OLD.created_at)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'payment event evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_outbox_protected BEFORE UPDATE OR DELETE ON pay.outbox
  FOR EACH ROW EXECUTE FUNCTION pay.protect_outbox();
