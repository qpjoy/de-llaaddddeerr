-- One explicitly acknowledged retry may replace one provider dispatch whose
-- outcome is unknown. Keep the relationship on the actual provider call so a
-- failed pre-dispatch attempt does not consume the acknowledgement.

ALTER TABLE external_platform.provider_calls
  ADD COLUMN IF NOT EXISTS retry_of_usage_request_id uuid
  REFERENCES usage_requests(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS external_platform_provider_calls_retry_of_idx
  ON external_platform.provider_calls (retry_of_usage_request_id)
  WHERE retry_of_usage_request_id IS NOT NULL;
