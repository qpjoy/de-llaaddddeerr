-- Hub business commerce only. No Launcher, network, Pay or existing grant writes.
CREATE SCHEMA IF NOT EXISTS hub_commerce;
CREATE TABLE hub_commerce.products (
  sku text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hub_commerce.products(sku,document) VALUES ('ip-risk-baidu-annual-100k',
  '{"sku":"ip-risk-baidu-annual-100k","name":"IP 风险画像 · 年度版","description":"IP 归属地、运营商、应用场景和分类风险标签；百度 v2 渠道。","product":"ip_risk","channel":"baidu-v2","status":"published","amountMinor":3399900,"currency":"CNY","months":12,"quota":100000}')
ON CONFLICT DO NOTHING;

CREATE TABLE hub_commerce.orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  consumer_id uuid NOT NULL REFERENCES consumers(id),
  environment text NOT NULL CHECK (environment IN ('test','live')),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  source_id uuid NOT NULL,
  app_id text NOT NULL,
  intent jsonb NOT NULL,
  payment_id uuid,
  payment jsonb,
  delivered_at timestamptz,
  receipt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,environment,request_key),
  UNIQUE(source_id,payment_id)
);
CREATE INDEX commerce_orders_tenant_created ON hub_commerce.orders(tenant_id,created_at DESC,id);
CREATE FUNCTION hub_commerce.protect_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'commerce_order_immutable'; END IF;
  IF (OLD.id,OLD.tenant_id,OLD.consumer_id,OLD.environment,OLD.request_key,OLD.fingerprint,OLD.source_id,OLD.app_id,OLD.intent,OLD.created_at)
     IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.consumer_id,NEW.environment,NEW.request_key,NEW.fingerprint,NEW.source_id,NEW.app_id,NEW.intent,NEW.created_at)
     OR (OLD.payment_id IS NOT NULL AND OLD.payment_id IS DISTINCT FROM NEW.payment_id)
     OR (OLD.delivered_at IS NOT NULL AND (OLD.delivered_at,OLD.receipt,OLD.payment) IS DISTINCT FROM (NEW.delivered_at,NEW.receipt,NEW.payment))
  THEN RAISE EXCEPTION 'commerce_order_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_immutable BEFORE UPDATE OR DELETE ON hub_commerce.orders
FOR EACH ROW EXECUTE FUNCTION hub_commerce.protect_order();
CREATE TABLE hub_commerce.subscriptions (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES hub_commerce.orders(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  consumer_id uuid NOT NULL REFERENCES consumers(id),
  channel text NOT NULL CHECK (channel='baidu-v2'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  quota integer NOT NULL CHECK (quota > 0),
  held integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  CHECK (held + used <= quota)
);
CREATE INDEX commerce_subscription_scope ON hub_commerce.subscriptions(consumer_id,channel,starts_at,ends_at);
CREATE TABLE hub_commerce.inbox (
  source_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL UNIQUE REFERENCES hub_commerce.orders(id),
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  receipt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,event_id)
);
CREATE TABLE hub_commerce.audit (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION hub_commerce.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'commerce_evidence_immutable'; END $$;
CREATE TRIGGER commerce_inbox_immutable BEFORE UPDATE OR DELETE ON hub_commerce.inbox
FOR EACH ROW EXECUTE FUNCTION hub_commerce.immutable();
CREATE TRIGGER commerce_audit_immutable BEFORE UPDATE OR DELETE ON hub_commerce.audit
FOR EACH ROW EXECUTE FUNCTION hub_commerce.immutable();

CREATE TABLE hub_commerce.usage (
  request_id uuid PRIMARY KEY REFERENCES usage_requests(id),
  subscription_id uuid NOT NULL REFERENCES hub_commerce.subscriptions(id),
  state text NOT NULL CHECK (state IN ('held','consumed','released')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_usage_subscription ON hub_commerce.usage(subscription_id,state);
CREATE FUNCTION hub_commerce.reserve_ip_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected hub_commerce.subscriptions%ROWTYPE;
BEGIN
  IF NEW.billing_meter_key IS DISTINCT FROM 'ip.risk.subscription.v2' THEN RETURN NEW; END IF;
  IF NEW.status <> 'reserved' OR NEW.units_reserved <> 1 THEN RAISE EXCEPTION 'commerce_invalid_reservation'; END IF;
  -- One shared allowance for every Key. Row lock serializes the last unit.
  SELECT * INTO selected FROM hub_commerce.subscriptions
    WHERE tenant_id=NEW.tenant_id AND consumer_id=NEW.consumer_id AND channel='baidu-v2'
      AND starts_at<=now() AND ends_at>now()
    ORDER BY starts_at,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_subscription_required' USING ERRCODE='P0001'; END IF;
  IF selected.used+selected.held>=selected.quota THEN RAISE EXCEPTION 'commerce_quota_exhausted' USING ERRCODE='P0001'; END IF;
  UPDATE hub_commerce.subscriptions SET held=held+1 WHERE id=selected.id;
  INSERT INTO hub_commerce.usage(request_id,subscription_id,state) VALUES(NEW.id,selected.id,'held');
  RETURN NEW;
END $$;
CREATE TRIGGER usage_requests_reserve_commerce AFTER INSERT ON usage_requests
FOR EACH ROW EXECUTE FUNCTION hub_commerce.reserve_ip_subscription();

CREATE FUNCTION hub_commerce.settle_ip_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation hub_commerce.usage%ROWTYPE;
BEGIN
  IF NEW.billing_meter_key IS DISTINCT FROM 'ip.risk.subscription.v2' OR NEW.status NOT IN ('committed','released') THEN RETURN NEW; END IF;
  SELECT * INTO reservation FROM hub_commerce.usage WHERE request_id=NEW.id FOR UPDATE;
  IF NOT FOUND OR reservation.state<>'held' THEN RETURN NEW; END IF;
  IF NEW.status='committed' AND NEW.units_actual<>1 THEN RAISE EXCEPTION 'commerce_invalid_settlement'; END IF;
  UPDATE hub_commerce.subscriptions SET held=held-1,used=used+CASE WHEN NEW.status='committed' THEN 1 ELSE 0 END
    WHERE id=reservation.subscription_id;
  UPDATE hub_commerce.usage SET state=CASE WHEN NEW.status='committed' THEN 'consumed' ELSE 'released' END WHERE request_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_requests_settle_commerce AFTER UPDATE OF status ON usage_requests
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION hub_commerce.settle_ip_subscription();
-- Subscription requests have already been purchased; never charge the wallet too.
-- Every previous meter retains the original billing function unchanged.
DROP TRIGGER usage_requests_reserve_customer_charge ON usage_requests;
CREATE TRIGGER usage_requests_reserve_customer_charge AFTER INSERT ON usage_requests
FOR EACH ROW WHEN (NEW.billing_meter_key IS DISTINCT FROM 'ip.risk.subscription.v2')
EXECUTE FUNCTION billing.reserve_customer_charge();

CREATE TABLE hub_commerce.ip_channel (
  id text PRIMARY KEY CHECK (id='baidu-v2'),
  revision integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  daily_limit integer NOT NULL DEFAULT 1200 CHECK (daily_limit BETWEEN 1 AND 1200),
  spacing_ms integer NOT NULL DEFAULT 2000 CHECK (spacing_ms BETWEEN 2000 AND 300000),
  tokens numeric NOT NULL DEFAULT 10 CHECK (tokens BETWEEN 0 AND 10),
  refill_at timestamptz NOT NULL DEFAULT now(),
  day date,
  calls integer NOT NULL DEFAULT 0,
  next_at timestamptz,
  cooldown_until timestamptz,
  last_status text,
  last_observed_at timestamptz
);
INSERT INTO hub_commerce.ip_channel(id) VALUES('baidu-v2') ON CONFLICT DO NOTHING;
INSERT INTO external_platform.provider_state(provider_key) VALUES('baidu-ip') ON CONFLICT DO NOTHING;
CREATE TABLE hub_commerce.ip_upstream_calls (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES usage_requests(id),
  endpoint text NOT NULL CHECK(endpoint IN ('base','overall')),
  status integer,
  body bytea,
  outcome text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX commerce_ip_calls_request ON hub_commerce.ip_upstream_calls(request_id);
