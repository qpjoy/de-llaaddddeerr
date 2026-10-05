-- Lower only the recharge minimum. Keep wallet identities, immutable evidence,
-- currencies and all existing balance/delivery constraints unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE hub_recharge.orders DROP CONSTRAINT orders_intent_check;
ALTER TABLE hub_recharge.orders ADD CONSTRAINT orders_intent_check
  CHECK ((intent->>'amountMinor')::bigint BETWEEN 100 AND 10000000 AND intent->>'currency'='CNY');
ALTER TABLE hub_recharge.test_credits DROP CONSTRAINT test_credits_amount_minor_check;
ALTER TABLE hub_recharge.test_credits ADD CONSTRAINT test_credits_amount_minor_check CHECK (amount_minor BETWEEN 100 AND 10000000);
ALTER TABLE mx_pay.orders DROP CONSTRAINT orders_amount_minor_check;
ALTER TABLE mx_pay.orders ADD CONSTRAINT orders_amount_minor_check CHECK (amount_minor BETWEEN 100 AND 10000000);
ALTER TABLE mx_pay.test_credits DROP CONSTRAINT test_credits_amount_minor_check;
ALTER TABLE mx_pay.test_credits ADD CONSTRAINT test_credits_amount_minor_check CHECK (amount_minor BETWEEN 100 AND 10000000);
