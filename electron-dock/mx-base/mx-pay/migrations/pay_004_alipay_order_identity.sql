-- Existing trades keep their original identity; never backfill/rename remote orders.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE pay.orders ADD CONSTRAINT pay_alipay_order_identity CHECK (
  provider <> 'alipay' OR NOT (document->'checkout' ? 'outTradeNo') OR COALESCE(
    document->'checkout'->>'outTradeNo' = 'MXP' || replace(id::text, '-', ''), false
  )
);
-- The existing protect_order trigger also makes checkout.outTradeNo immutable.
-- Resolve MXP + UUID hex to the existing primary key, then compare the exact stored
-- channel order number. No JSON scan, duplicate identity column or alias acceptance.
