-- Consumer-owned schema. Never install in the authoritative payment database.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
  IF to_regclass('pay.orders') IS NOT NULL OR to_regclass('public.mx_platform_records') IS NOT NULL THEN
    RAISE EXCEPTION 'Payment reporting requires consumer-owned storage, not payment or Launcher storage';
  END IF;
END $$;
CREATE SCHEMA pay_reporting;
CREATE TABLE pay_reporting.streams (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  environment text NOT NULL CHECK(environment IN ('test','live')),
  source_id uuid,
  checkpoint jsonb,
  version bigint NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  observed_at timestamptz,
  caught_up_at timestamptz,
  high_water_cursor text,
  last_error text,
  failures integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,app_id,environment)
);
CREATE TABLE pay_reporting.orders (
  stream_id text NOT NULL REFERENCES pay_reporting.streams(id),
  payment_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>=0),
  document jsonb NOT NULL,
  status text GENERATED ALWAYS AS (document->>'status') STORED NOT NULL,
  business_order_id text GENERATED ALWAYS AS (document->>'businessOrderId') STORED NOT NULL,
  customer_ref text GENERATED ALWAYS AS (document->>'customerRef') STORED NOT NULL,
  currency text GENERATED ALWAYS AS (document->>'currency') STORED NOT NULL,
  amount_minor bigint GENERATED ALWAYS AS ((document->>'amountMinor')::bigint) STORED NOT NULL,
  received_minor bigint GENERATED ALWAYS AS ((document->>'receivedAmountMinor')::bigint) STORED,
  fee_minor bigint GENERATED ALWAYS AS ((document->>'feeMinor')::bigint) STORED,
  paid_at timestamptz,
  PRIMARY KEY(stream_id,payment_id),
  UNIQUE(stream_id,business_order_id)
);
CREATE INDEX pay_reporting_paid ON pay_reporting.orders(stream_id,paid_at) WHERE status='paid';
