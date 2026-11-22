-- An offline application has no Pay intent. Keep all existing paid and
-- trial source requirements, and allow only the new bank application shape.
ALTER TABLE hub_commerce.orders DROP CONSTRAINT commerce_order_source;
ALTER TABLE hub_commerce.orders ADD CONSTRAINT commerce_order_source CHECK (
  (source_id IS NOT NULL AND app_id IS NOT NULL
    AND intent->>'purpose' IS DISTINCT FROM 'trial'
    AND intent->>'paymentMethod' IS DISTINCT FROM 'bank')
  OR (source_id IS NULL AND app_id IS NULL AND environment='live'
    AND consumer_id IS NULL AND payment_id IS NULL AND payment IS NULL
    AND coalesce(intent->>'purpose'='trial'
      AND intent->'product'->'amountMinor'='0'::jsonb
      AND intent->'product'->>'kind'='trial'
      AND intent->'product'->>'product'='ip_risk',false))
  OR (source_id IS NULL AND app_id IS NULL AND environment='live'
    AND consumer_id IS NULL AND payment_id IS NULL AND payment IS NULL
    AND delivered_at IS NULL AND receipt IS NULL
    AND coalesce(intent->>'purpose'='interface_prepaid'
      AND intent->>'paymentMethod'='bank'
      AND char_length(btrim(intent->>'company')) BETWEEN 2 AND 100
      AND (intent->'product'->>'amountMinor')::bigint BETWEEN 1000 AND 10000000,false))
);
