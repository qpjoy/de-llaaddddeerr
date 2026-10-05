-- Permit a one-yuan payment without rewriting historical orders or receipts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE pay.orders DROP CONSTRAINT orders_amount_minor_check;
ALTER TABLE pay.orders ADD CONSTRAINT orders_amount_minor_check CHECK (amount_minor BETWEEN 100 AND 10000000);
