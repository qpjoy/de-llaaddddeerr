-- Run explicitly with psql outside a transaction before enabling upstream-ID
-- diagnostics on a large production ledger. Does not change request data.
\set ON_ERROR_STOP on
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS provider_calls_upstream_request_diagnostic_idx
  ON external_platform.provider_calls (upstream_request_id, usage_request_id)
  WHERE upstream_request_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS connector_calls_upstream_request_diagnostic_idx
  ON serving.connector_calls (upstream_request_id, usage_request_id)
  WHERE upstream_request_id IS NOT NULL;
