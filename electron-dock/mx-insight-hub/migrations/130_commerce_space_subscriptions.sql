-- Product subscriptions belong to a space. Existing orders and consumer terms stay immutable.
ALTER TABLE hub_commerce.orders ALTER COLUMN consumer_id DROP NOT NULL;
ALTER TABLE hub_commerce.subscriptions ALTER COLUMN consumer_id DROP NOT NULL;
ALTER TABLE hub_commerce.subscriptions DROP CONSTRAINT subscriptions_channel_check;
ALTER TABLE hub_commerce.subscriptions ADD CHECK (
  (channel='baidu-v2' AND consumer_id IS NOT NULL) OR (channel='product' AND consumer_id IS NULL)
);
CREATE INDEX commerce_subscription_space ON hub_commerce.subscriptions(tenant_id,channel,starts_at,ends_at);
CREATE TABLE hub_commerce.product_delivery (
  product text PRIMARY KEY CHECK(product='ip_risk'),
  channel text NOT NULL CHECK(channel IN ('legacy-v1','baidu-v2')),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hub_commerce.product_delivery(product,channel) VALUES('ip_risk','legacy-v1');
UPDATE hub_commerce.products SET revision=revision+1,
  document=jsonb_set(document || '{"channel":"product","entitlementScope":"tenant"}'::jsonb,'{description}',
    to_jsonb(CASE WHEN document->>'description'='IP 归属地、运营商、应用场景和分类风险标签；百度 v2 渠道。'
      THEN '识别可疑 IP，了解访问来源，让业务风控更有依据。' ELSE document->>'description' END)),updated_at=now()
WHERE document->>'product'='ip_risk';
CREATE OR REPLACE FUNCTION hub_commerce.reserve_ip_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected hub_commerce.subscriptions%ROWTYPE;
BEGIN
  IF NEW.billing_meter_key IS NULL OR NEW.billing_meter_key NOT IN ('ip.risk.subscription.v2','ip.risk.subscription.product') THEN RETURN NEW; END IF;
  IF NEW.status <> 'reserved' OR NEW.units_reserved <> 1 THEN RAISE EXCEPTION 'commerce_invalid_reservation'; END IF;
  SELECT * INTO selected FROM hub_commerce.subscriptions
    WHERE tenant_id=NEW.tenant_id AND starts_at<=now() AND ends_at>now()
      AND ((NEW.billing_meter_key='ip.risk.subscription.v2' AND consumer_id=NEW.consumer_id AND channel='baidu-v2')
        OR (NEW.billing_meter_key='ip.risk.subscription.product' AND consumer_id IS NULL AND channel='product'))
    ORDER BY starts_at,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'commerce_subscription_required' USING ERRCODE='P0001'; END IF;
  IF selected.used+selected.held>=selected.quota THEN RAISE EXCEPTION 'commerce_quota_exhausted' USING ERRCODE='P0001'; END IF;
  UPDATE hub_commerce.subscriptions SET held=held+1 WHERE id=selected.id;
  INSERT INTO hub_commerce.usage(request_id,subscription_id,state) VALUES(NEW.id,selected.id,'held');
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hub_commerce.settle_ip_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation hub_commerce.usage%ROWTYPE;
BEGIN
  IF NEW.billing_meter_key IS NULL OR NEW.billing_meter_key NOT IN ('ip.risk.subscription.v2','ip.risk.subscription.product') OR NEW.status NOT IN ('committed','released') THEN RETURN NEW; END IF;
  SELECT * INTO reservation FROM hub_commerce.usage WHERE request_id=NEW.id FOR UPDATE;
  IF NOT FOUND OR reservation.state<>'held' THEN RETURN NEW; END IF;
  IF NEW.status='committed' AND NEW.units_actual<>1 THEN RAISE EXCEPTION 'commerce_invalid_settlement'; END IF;
  UPDATE hub_commerce.subscriptions SET held=held-1,used=used+CASE WHEN NEW.status='committed' THEN 1 ELSE 0 END WHERE id=reservation.subscription_id;
  UPDATE hub_commerce.usage SET state=CASE WHEN NEW.status='committed' THEN 'consumed' ELSE 'released' END WHERE request_id=NEW.id;
  RETURN NEW;
END $$;
DROP TRIGGER usage_requests_reserve_customer_charge ON usage_requests;
CREATE TRIGGER usage_requests_reserve_customer_charge AFTER INSERT ON usage_requests
FOR EACH ROW WHEN (NEW.billing_meter_key IS NULL OR NEW.billing_meter_key NOT IN ('ip.risk.subscription.v2','ip.risk.subscription.product'))
EXECUTE FUNCTION billing.reserve_customer_charge();
