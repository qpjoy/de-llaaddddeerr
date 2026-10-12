-- Free claims are Hub business facts, never fabricated Pay settlements.
ALTER TABLE hub_commerce.orders ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE hub_commerce.orders ALTER COLUMN app_id DROP NOT NULL;
ALTER TABLE hub_commerce.orders ADD CONSTRAINT commerce_order_source CHECK (
  (source_id IS NOT NULL AND app_id IS NOT NULL AND intent->>'purpose' IS DISTINCT FROM 'trial') OR
  (source_id IS NULL AND app_id IS NULL AND environment='live' AND consumer_id IS NULL
    AND payment_id IS NULL AND payment IS NULL
    AND coalesce(intent->>'purpose'='trial' AND intent->'product'->'amountMinor'='0'::jsonb
      AND intent->'product'->>'kind'='trial' AND intent->'product'->>'product'='ip_risk',false))
);
-- Changing a SKU or retry key must never grant another trial of the same service.
CREATE UNIQUE INDEX commerce_trial_once_per_space ON hub_commerce.orders(tenant_id,(intent->'product'->>'product'))
  WHERE intent->>'purpose'='trial';

-- Publish only the untouched drafts from 145. Retain operator-edited products,
-- the legacy offer, and every sold order/issued subscription snapshot.
WITH published AS (
  UPDATE hub_commerce.products SET document=document||'{"status":"published","harborListed":true}'::jsonb,
    revision=revision+1,updated_at=now()
  WHERE sku IN ('ip-risk-basic-annual','ip-risk-pro-annual','ip-risk-enterprise-annual')
    AND revision=1 AND document->>'status'='draft' AND document->'harborListed'='false'::jsonb
  RETURNING sku,revision,document
)
INSERT INTO hub_commerce.audit(actor,action,document)
SELECT 'migration:146','product.published',jsonb_build_object('sku',sku,'revision',revision,'after',document) FROM published;

WITH added AS (
  INSERT INTO hub_commerce.products(sku,document) VALUES ('ip-risk-trial-10',
    '{"sku":"ip-risk-trial-10","name":"IP 风险画像 · 试用版","description":"免费体验，每个空间限领一次，共 10 次查询。","product":"ip_risk","channel":"product","entitlementScope":"tenant","status":"published","harborListed":true,"kind":"trial","amountMinor":0,"currency":"CNY","months":12,"trialDays":7,"quota":10,"dailyLimit":null,"activationMode":"immediate"}')
  ON CONFLICT DO NOTHING RETURNING sku,revision,document
)
INSERT INTO hub_commerce.audit(actor,action,document)
SELECT 'migration:146','product.created',jsonb_build_object('sku',sku,'revision',revision,'after',document) FROM added;
