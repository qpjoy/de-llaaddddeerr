-- Additive commercial rules. Old orders and issued terms keep their snapshots.
ALTER TABLE hub_commerce.subscriptions ADD COLUMN daily_limit integer CHECK (daily_limit BETWEEN 1 AND 10000000);
CREATE TABLE hub_commerce.subscription_selection (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  subscription_id uuid REFERENCES hub_commerce.subscriptions(id),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_usage_daily ON hub_commerce.usage(subscription_id,created_at)
  WHERE state IN ('held','consumed');

-- New tiers are editable drafts; no existing listing, sale or entitlement is rewritten.
INSERT INTO hub_commerce.products(sku,document)
SELECT sku,jsonb_build_object('sku',sku,'name',name,'description',description,
  'product','ip_risk','channel','product','entitlementScope','tenant','status','draft',
  'harborListed',false,'amountMinor',price,'currency','CNY','months',12,'quota',quota,
  'dailyLimit',daily_limit,'activationMode','immediate')
FROM (VALUES
  ('ip-risk-basic-annual','IP 风险画像 · 基础版','适合日常查询与小规模接入',399900,36000,100),
  ('ip-risk-pro-annual','IP 风险画像 · 专业版','适合持续研判与业务集成',1499900,180000,500),
  ('ip-risk-enterprise-annual','IP 风险画像 · 企业版','适合高频查询与规模化应用',3499900,720000,NULL::integer)
) AS tiers(sku,name,description,price,quota,daily_limit)
ON CONFLICT DO NOTHING;

-- Reads and reservation use this same ordering and Asia/Shanghai calendar day.
CREATE FUNCTION hub_commerce.subscription_candidates(p_tenant uuid,p_consumer uuid,p_channel text)
RETURNS TABLE(id uuid,daily_used bigint,daily_held bigint,preferred boolean,available boolean)
LANGUAGE sql STABLE AS $$
  SELECT s.id,d.used,d.held,coalesce(sel.subscription_id=s.id,false),
    s.used+s.held<s.quota AND (s.daily_limit IS NULL OR d.used+d.held<s.daily_limit)
  FROM hub_commerce.subscriptions s
  LEFT JOIN hub_commerce.subscription_selection sel ON sel.tenant_id=s.tenant_id AND s.channel='product'
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE u.state='consumed') AS used,count(*) FILTER (WHERE u.state='held') AS held
    FROM hub_commerce.usage u WHERE u.subscription_id=s.id AND u.state IN ('held','consumed')
      AND u.created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      AND u.created_at < (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai'
  ) d
  WHERE s.tenant_id=p_tenant AND s.channel=p_channel
    AND s.consumer_id IS NOT DISTINCT FROM p_consumer AND s.starts_at<=now() AND s.ends_at>now()
  ORDER BY coalesce(sel.subscription_id=s.id,false) DESC,s.ends_at,s.starts_at,s.id
$$;

CREATE OR REPLACE FUNCTION hub_commerce.reserve_ip_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_id uuid; scope_consumer uuid; scope_channel text;
BEGIN
  IF NEW.billing_meter_key IS NULL OR NEW.billing_meter_key NOT IN ('ip.risk.subscription.v2','ip.risk.subscription.product') THEN RETURN NEW; END IF;
  IF NEW.status <> 'reserved' OR NEW.units_reserved <> 1 THEN RAISE EXCEPTION 'commerce_invalid_reservation'; END IF;
  scope_channel := CASE WHEN NEW.billing_meter_key='ip.risk.subscription.product' THEN 'product' ELSE 'baidu-v2' END;
  scope_consumer := CASE WHEN scope_channel='product' THEN NULL ELSE NEW.consumer_id END;
  -- Serialize selection with payment delivery and preference writes across replicas.
  PERFORM pg_advisory_xact_lock(hashtext('commerce-subscription:'||coalesce(scope_consumer,NEW.tenant_id)::text||':'||scope_channel));
  SELECT c.id INTO selected_id FROM hub_commerce.subscription_candidates(NEW.tenant_id,scope_consumer,scope_channel) c WHERE c.available LIMIT 1;
  IF selected_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM hub_commerce.subscription_candidates(NEW.tenant_id,scope_consumer,scope_channel)) THEN
      RAISE EXCEPTION 'commerce_subscription_required' USING ERRCODE='P0001';
    ELSIF EXISTS (SELECT 1 FROM hub_commerce.subscriptions s WHERE s.tenant_id=NEW.tenant_id AND s.channel=scope_channel
      AND s.consumer_id IS NOT DISTINCT FROM scope_consumer AND s.starts_at<=now() AND s.ends_at>now() AND s.used+s.held<s.quota) THEN
      RAISE EXCEPTION 'commerce_daily_limit_exhausted' USING ERRCODE='P0001';
    ELSE RAISE EXCEPTION 'commerce_quota_exhausted' USING ERRCODE='P0001'; END IF;
  END IF;
  -- A settlement may only release availability. This row lock also fences it.
  UPDATE hub_commerce.subscriptions SET held=held+1 WHERE id=selected_id;
  INSERT INTO hub_commerce.usage(request_id,subscription_id,state) VALUES(NEW.id,selected_id,'held');
  RETURN NEW;
END $$;
