-- User-approved reconfiguration of the three DataPort annual tiers, including
-- existing orders and subscriptions. Historical prices, payments, periods and
-- usage remain unchanged; the legacy annual SKU and free trial are excluded.
-- runMigrations executes this entire file in one transaction. These locks fence
-- purchases/settlement while the order guard is temporarily disabled below.
LOCK TABLE hub_commerce.products, hub_commerce.orders, hub_commerce.subscriptions
  IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE dataport_annual_pricing_20261105 (
  sku text PRIMARY KEY, amount_minor integer, quota integer, daily_limit integer
) ON COMMIT DROP;
INSERT INTO dataport_annual_pricing_20261105 VALUES
  ('ip-risk-basic-annual',       499900,  20000, 10000),
  ('ip-risk-pro-annual',       1699900, 100000, 20000),
  ('ip-risk-enterprise-annual',3699900, 500000, NULL);

DO $$ BEGIN
  IF (SELECT count(*) FROM dataport_annual_pricing_20261105 t
      JOIN hub_commerce.products p USING(sku)
      WHERE p.document->>'product'='ip_risk' AND p.document->>'channel'='product'
        AND p.document->>'currency'='CNY' AND coalesce(p.document->>'kind','paid')='paid') <> 3
  THEN RAISE EXCEPTION 'DataPort annual catalog differs from the expected three paid SKUs'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='hub_commerce.orders'::regclass
      AND tgname='commerce_order_immutable' AND tgenabled='O')
  THEN RAISE EXCEPTION 'DataPort order guard must be enabled before repricing'; END IF;
END $$;

-- A reduced quota can already be below used + in-flight queries. Preserve those
-- counters and allow only their existing footprint; subscription_candidates
-- still rejects all new reservations once used + held reaches the new quota.
ALTER TABLE hub_commerce.subscriptions ADD COLUMN repricing_usage_ceiling integer
  NOT NULL DEFAULT 0 CHECK (repricing_usage_ceiling >= 0);
-- PostgreSQL-generated names depend on earlier multi-column checks. Locate
-- this exact old invariant so the independent period check stays intact.
DO $$ DECLARE quota_check text; BEGIN
  SELECT conname INTO STRICT quota_check FROM pg_constraint
  WHERE conrelid='hub_commerce.subscriptions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid)='CHECK (((held + used) <= quota))';
  EXECUTE format('ALTER TABLE hub_commerce.subscriptions DROP CONSTRAINT %I',quota_check);
END $$;
ALTER TABLE hub_commerce.subscriptions ADD CONSTRAINT subscriptions_usage_ceiling_check
  CHECK (held + used <= greatest(quota, repricing_usage_ceiling));
COMMENT ON COLUMN hub_commerce.subscriptions.repricing_usage_ceiling IS
  'Existing used+held ceiling retained by the 2026-11 DataPort quota adjustment; never additional query allowance.';

WITH before AS MATERIALIZED (
  SELECT p.sku,p.document,jsonb_build_object('amountMinor',t.amount_minor,
    'months',12,'quota',t.quota,'dailyLimit',t.daily_limit) AS patch
  FROM hub_commerce.products p JOIN dataport_annual_pricing_20261105 t USING(sku)
), changed AS (
  UPDATE hub_commerce.products p SET document=b.document||b.patch,
    revision=p.revision+1,updated_at=now()
  FROM before b WHERE p.sku=b.sku AND p.document IS DISTINCT FROM b.document||b.patch
  RETURNING p.sku,p.revision,p.document,b.document AS before_document
)
INSERT INTO hub_commerce.audit(actor,action,document)
SELECT 'migration:179','product.saved',jsonb_build_object('sku',sku,'revision',revision,
  'before',before_document,'after',document) FROM changed;

-- Deliberately limited exception for this user-authorized quota amendment.
-- The transaction's table lock blocks other writers, and the exact guard is
-- re-enabled before commit. Any failure rolls back the guard and all changes.
ALTER TABLE hub_commerce.orders DISABLE TRIGGER commerce_order_immutable;
WITH before AS MATERIALIZED (
  SELECT o.id,o.tenant_id,o.intent->'product' AS product,
    jsonb_build_object('quota',t.quota,'dailyLimit',t.daily_limit) AS patch
  FROM hub_commerce.orders o JOIN dataport_annual_pricing_20261105 t
    ON t.sku=o.intent->'product'->>'sku'
  WHERE o.intent->'product'->>'product'='ip_risk'
    AND o.intent->'product'->>'channel'='product'
    AND coalesce(o.intent->'product'->>'kind','paid')='paid'
), changed AS (
  UPDATE hub_commerce.orders o SET intent=jsonb_set(o.intent,'{product}',b.product||b.patch)
  FROM before b WHERE o.id=b.id AND b.product IS DISTINCT FROM b.product||b.patch
  RETURNING o.id,o.tenant_id,b.product AS before_product,o.intent->'product' AS after_product
)
INSERT INTO hub_commerce.audit(actor,action,document)
SELECT 'migration:179','order.entitlement.adjusted',jsonb_build_object('orderId',id,
  'tenantId',tenant_id,'before',before_product,'after',after_product) FROM changed;
ALTER TABLE hub_commerce.orders ENABLE TRIGGER commerce_order_immutable;

WITH before AS MATERIALIZED (
  SELECT s.id,s.order_id,s.tenant_id,s.quota,s.daily_limit,s.used,s.held,s.repricing_usage_ceiling,
    t.quota AS new_quota,t.daily_limit AS new_daily_limit
  FROM hub_commerce.subscriptions s JOIN hub_commerce.orders o ON o.id=s.order_id
  JOIN dataport_annual_pricing_20261105 t ON t.sku=o.intent->'product'->>'sku'
  WHERE s.channel='product' AND o.intent->'product'->>'product'='ip_risk'
    AND coalesce(o.intent->'product'->>'kind','paid')='paid'
), changed AS (
  UPDATE hub_commerce.subscriptions s SET quota=b.new_quota,daily_limit=b.new_daily_limit,
    repricing_usage_ceiling=CASE WHEN b.used+b.held>b.new_quota
      THEN greatest(b.repricing_usage_ceiling,b.used+b.held) ELSE b.repricing_usage_ceiling END
  FROM before b WHERE s.id=b.id AND (s.quota,s.daily_limit) IS DISTINCT FROM (b.new_quota,b.new_daily_limit)
  RETURNING s.id,s.order_id,s.tenant_id,
    jsonb_build_object('quota',b.quota,'dailyLimit',b.daily_limit,'used',b.used,'held',b.held,
      'usageCeiling',b.repricing_usage_ceiling) AS before_terms,
    jsonb_build_object('quota',s.quota,'dailyLimit',s.daily_limit,'used',s.used,'held',s.held,
      'usageCeiling',s.repricing_usage_ceiling) AS after_terms
)
INSERT INTO hub_commerce.audit(actor,action,document)
SELECT 'migration:179','subscription.entitlement.adjusted',jsonb_build_object('subscriptionId',id,
  'orderId',order_id,'tenantId',tenant_id,'before',before_terms,'after',after_terms) FROM changed;
