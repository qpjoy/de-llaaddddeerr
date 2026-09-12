-- Consumer-scoped history pagination over successfully delivered search batches.
CREATE INDEX IF NOT EXISTS usage_requests_ecommerce_stored_idx
  ON usage_requests (consumer_id, created_at DESC, id DESC)
  WHERE platform = 'ecommerce' AND status = 'committed' AND response_status = 200
    AND response_body->>'contractVersion' = 'mx-insight-hub.ecommerce-products.v1';
