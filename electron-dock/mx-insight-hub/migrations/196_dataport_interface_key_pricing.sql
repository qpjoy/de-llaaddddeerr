-- A DataPort interface consumer spends the prepaid wallet using the published
-- price captured on its settled order. Ordinary tenant pricing stays in place
-- for every other consumer, including the IP subscription consumer.
ALTER TABLE billing.customer_charges DROP CONSTRAINT customer_charge_price_reference;
ALTER TABLE billing.customer_charges ADD CONSTRAINT customer_charge_price_reference CHECK (
  (price_book_id IS NOT NULL AND price_entry_id IS NOT NULL
    AND price_book_key IS NOT NULL AND price_book_version IS NOT NULL)
  OR (price_book_id IS NULL AND price_entry_id IS NULL
    AND price_book_key IS NULL AND price_book_version IS NULL
    AND coalesce(pricing_snapshot->>'priceSource' IN ('tenant_default', 'dataport_interface_prepaid'), false))
);

ALTER FUNCTION billing.customer_price_for_usage(uuid, uuid, text) RENAME TO tenant_customer_price_for_usage;

CREATE FUNCTION billing.customer_price_for_usage(
  p_tenant_id uuid, p_consumer_id uuid, p_meter_key text
) RETURNS TABLE (
  plan_version_id uuid, price_book_id uuid, price_entry_id uuid,
  enforcement_mode text, billing_unit text, price_book_key text,
  price_book_version integer, currency char(3), unit_price_minor bigint,
  multiplier_ppm bigint, quoted_minor bigint, pricing_snapshot jsonb
) LANGUAGE plpgsql AS $function$
DECLARE
  paid_order_id uuid;
BEGIN
  IF p_meter_key IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.consumers c WHERE c.id = p_consumer_id AND c.tenant_id = p_tenant_id
      AND c.business_id = 'commerce:interface:xiaohongshu:' || p_tenant_id::text
  ) THEN
    RETURN QUERY SELECT * FROM billing.tenant_customer_price_for_usage(p_tenant_id, p_consumer_id, p_meter_key);
    RETURN;
  END IF;
  IF p_meter_key NOT IN ('social.posts.search', 'social.comments.list') THEN
    RAISE EXCEPTION 'customer_price_unavailable' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtext('billing:tenant:' || p_tenant_id::text));
  SELECT o.id, (o.intent #>> '{product,unitPriceMinor}')::bigint, assignment.plan_version_id
    INTO paid_order_id, unit_price_minor, plan_version_id
    FROM hub_commerce.orders o
    JOIN public.consumer_plan_assignments assignment ON assignment.consumer_id = p_consumer_id
    WHERE o.tenant_id = p_tenant_id AND o.environment = 'live'
      AND o.intent->>'purpose' = 'interface_prepaid' AND o.intent->>'paymentMethod' = 'alipay'
      AND o.payment->>'status' = 'paid' AND o.delivered_at IS NOT NULL AND o.receipt IS NOT NULL
      AND o.intent #>> '{product,sku}' = 'xiaohongshu-api-prepaid'
      AND o.intent #>> '{product,platform}' = 'xiaohongshu'
      AND o.intent #>> '{product,currency}' = 'CNY'
    ORDER BY o.delivered_at DESC, o.id DESC LIMIT 1;
  IF NOT FOUND OR unit_price_minor IS NULL OR unit_price_minor <= 0 THEN
    RAISE EXCEPTION 'customer_price_unavailable' USING ERRCODE = 'P0001';
  END IF;

  enforcement_mode := 'enforced';
  billing_unit := 'request';
  currency := 'CNY';
  multiplier_ppm := 1000000;
  quoted_minor := unit_price_minor;
  pricing_snapshot := jsonb_build_object(
    'priceSource', 'dataport_interface_prepaid', 'orderId', paid_order_id,
    'meterKey', p_meter_key, 'billingUnit', billing_unit, 'currency', currency,
    'unitPriceMinor', unit_price_minor, 'multiplierPpm', multiplier_ppm, 'quotedMinor', quoted_minor
  );
  RETURN NEXT;
END;
$function$;
