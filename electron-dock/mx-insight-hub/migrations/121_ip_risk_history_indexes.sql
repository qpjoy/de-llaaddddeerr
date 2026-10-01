-- Read-only IP history reuses existing immutable deliveries and batch envelopes.
-- No new grants, prices, dispatch state, or identity/network changes.
CREATE INDEX IF NOT EXISTS usage_requests_ip_history_idx
  ON public.usage_requests (tenant_id, consumer_id, api_key_id, created_at DESC, id DESC)
  WHERE platform = 'ip_risk';
CREATE INDEX IF NOT EXISTS ipsearch_batches_key_history_idx
  ON external_platform.ipsearch_batches (tenant_id, consumer_id, api_key_id, created_at DESC, id DESC);
