-- Additive payment tables only. No identity/grant/price/balance backfill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
CREATE SCHEMA IF NOT EXISTS mx_pay;

CREATE TABLE mx_pay.settings (
  id text PRIMARY KEY CHECK (id = 'manual_alipay'),
  document jsonb NOT NULL
);
CREATE TABLE mx_pay.orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  environment text GENERATED ALWAYS AS (document->>'environment') STORED NOT NULL CHECK (environment IN ('live','test')),
  provider text GENERATED ALWAYS AS (document->>'provider') STORED NOT NULL,
  merchant_account_id text GENERATED ALWAYS AS (document->>'merchantAccountId') STORED NOT NULL,
  status text GENERATED ALWAYS AS (document->>'status') STORED NOT NULL CHECK (status IN ('pending','submitted','paid','cancelled')),
  invoice_status text GENERATED ALWAYS AS (document->'invoice'->>'status') STORED,
  amount_minor bigint GENERATED ALWAYS AS ((document->>'amountMinor')::bigint) STORED NOT NULL CHECK (amount_minor BETWEEN 500 AND 10000000),
  trade_no text GENERATED ALWAYS AS (document->'settlement'->>'tradeNo') STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, environment, request_key),
  CHECK (document->>'id' = id::text AND document->>'tenantId' = tenant_id::text),
  CHECK (document->>'currency' = 'CNY'),
  CHECK ((environment='test' AND provider='mock') OR (environment='live' AND provider='manual_alipay')),
  CHECK ((status='paid') = (trade_no IS NOT NULL))
);
CREATE UNIQUE INDEX mx_pay_receipt_once ON mx_pay.orders(environment,provider,merchant_account_id,trade_no) WHERE trade_no IS NOT NULL;
CREATE INDEX mx_pay_tenant_orders ON mx_pay.orders(tenant_id,environment,created_at DESC,id DESC);
CREATE INDEX mx_pay_finance_orders ON mx_pay.orders(environment,status,created_at DESC,id DESC);
CREATE INDEX mx_pay_invoice_queue ON mx_pay.orders(environment,invoice_status,created_at DESC,id DESC) WHERE invoice_status IS NOT NULL;

CREATE TABLE mx_pay.events (
  id uuid PRIMARY KEY,
  order_id uuid REFERENCES mx_pay.orders(id),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id,request_key)
);
CREATE INDEX mx_pay_order_events ON mx_pay.events(order_id,created_at DESC,id DESC);
-- A simulated payment has its own journal and can never fund a live API call.
CREATE TABLE mx_pay.test_credits (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES mx_pay.orders(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 500 AND 10000000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION mx_pay.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'mx_pay records are append-only'; END $$;
CREATE TRIGGER mx_pay_events_immutable BEFORE UPDATE OR DELETE ON mx_pay.events FOR EACH ROW EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER mx_pay_test_credits_immutable BEFORE UPDATE OR DELETE ON mx_pay.test_credits FOR EACH ROW EXECUTE FUNCTION mx_pay.immutable_record();
CREATE FUNCTION mx_pay.protect_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment orders cannot be deleted'; END IF;
  IF (NEW.id, NEW.tenant_id, NEW.request_key, NEW.fingerprint, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.request_key, OLD.fingerprint, OLD.created_at)
    OR (NEW.document - ARRAY['status','revision','submission','settlement','invoice','rejection','updatedAt']) IS DISTINCT FROM
       (OLD.document - ARRAY['status','revision','submission','settlement','invoice','rejection','updatedAt']) THEN
    RAISE EXCEPTION 'payment order identity is immutable';
  END IF;
  IF OLD.document->>'status' IN ('paid','cancelled') AND
    (NEW.document - ARRAY['invoice','revision','updatedAt']) IS DISTINCT FROM (OLD.document - ARRAY['invoice','revision','updatedAt']) THEN
    RAISE EXCEPTION 'settled payment cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mx_pay_orders_protected BEFORE UPDATE OR DELETE ON mx_pay.orders FOR EACH ROW EXECUTE FUNCTION mx_pay.protect_order();
