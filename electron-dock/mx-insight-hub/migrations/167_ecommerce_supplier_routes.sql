-- Unified product search: per-marketplace supplier mode. Existing rows keep
-- their saved primary and become 'fixed', which is exactly today's behaviour.
ALTER TABLE control.ecommerce_product_routes
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS fallback_adapter_id text NULL;
ALTER TABLE control.ecommerce_product_routes DROP CONSTRAINT IF EXISTS ecommerce_product_routes_mode_check;
ALTER TABLE control.ecommerce_product_routes ADD CONSTRAINT ecommerce_product_routes_mode_check CHECK (
  (mode = 'fixed' AND fallback_adapter_id IS NULL)
  OR (mode = 'priority' AND fallback_adapter_id IS NOT NULL AND fallback_adapter_id <> adapter_id));
