\set ON_ERROR_STOP on

-- Online indexes for per-Key and cross-capability plan quota checks. This file
-- must run outside a transaction because the production builds are concurrent.
-- A same-name invalid or manually drifted index is repaired, then the complete
-- key/order/predicate contract is verified before rollout may continue.
SET lock_timeout = '2s';
SET statement_timeout = '0';

CREATE TEMP TABLE api_key_quota_index_template
  (LIKE usage_requests INCLUDING DEFAULTS);

CREATE INDEX expected_api_key_platform_quota_idx
  ON api_key_quota_index_template (api_key_id, platform, reserved_at DESC)
  WHERE platform IS NOT NULL AND status IN ('reserved', 'committed', 'unknown');

CREATE INDEX expected_api_key_capability_quota_idx
  ON api_key_quota_index_template (api_key_id, capability, reserved_at DESC)
  WHERE capability IS NOT NULL AND status IN ('reserved', 'committed', 'unknown');

CREATE INDEX expected_consumer_plan_quota_idx
  ON api_key_quota_index_template (consumer_id, reserved_at DESC)
  WHERE status IN ('reserved', 'committed', 'unknown');

CREATE TEMP VIEW api_key_quota_index_contract AS
WITH expected(index_name, template_name, key_count) AS (
  VALUES
    ('usage_requests_api_key_platform_quota_idx', 'expected_api_key_platform_quota_idx', 3),
    ('usage_requests_api_key_capability_quota_idx', 'expected_api_key_capability_quota_idx', 3),
    ('usage_requests_consumer_plan_quota_idx', 'expected_consumer_plan_quota_idx', 2)
)
SELECT expected.index_name,
       coalesce(
         actual_index.indisvalid
         AND actual_index.indisready
         AND actual_index.indislive
         AND actual_method.amname = 'btree'
         AND actual_table_namespace.nspname = 'public'
         AND actual_table.relname = 'usage_requests'
         AND actual_index.indnkeyatts = expected.key_count
         AND actual_index.indoption = template_index.indoption
         AND pg_get_expr(actual_index.indpred, actual_index.indrelid, true)
             = pg_get_expr(template_index.indpred, template_index.indrelid, true)
         AND (
           SELECT bool_and(
             pg_get_indexdef(actual_class.oid, position, true)
               = pg_get_indexdef(template_class.oid, position, true)
           )
             FROM generate_series(1, expected.key_count) position
         ),
         false
       ) AS contract_ready
  FROM expected
  LEFT JOIN pg_namespace actual_namespace
    ON actual_namespace.nspname = 'public'
  LEFT JOIN pg_class actual_class
    ON actual_class.relnamespace = actual_namespace.oid
   AND actual_class.relname = expected.index_name
  LEFT JOIN pg_index actual_index
    ON actual_index.indexrelid = actual_class.oid
  LEFT JOIN pg_class actual_table
    ON actual_table.oid = actual_index.indrelid
  LEFT JOIN pg_namespace actual_table_namespace
    ON actual_table_namespace.oid = actual_table.relnamespace
  LEFT JOIN pg_am actual_method
    ON actual_method.oid = actual_class.relam
  LEFT JOIN pg_class template_class
    ON template_class.relnamespace = pg_my_temp_schema()
   AND template_class.relname = expected.template_name
  LEFT JOIN pg_index template_index
    ON template_index.indexrelid = template_class.oid;

SELECT contract_ready AS platform_index_ready
  FROM api_key_quota_index_contract
 WHERE index_name = 'usage_requests_api_key_platform_quota_idx' \gset

\if :platform_index_ready
  \echo 'usage_requests_api_key_platform_quota_idx is already valid'
\else
  DROP INDEX CONCURRENTLY IF EXISTS public.usage_requests_api_key_platform_quota_idx;
  CREATE INDEX CONCURRENTLY usage_requests_api_key_platform_quota_idx
    ON usage_requests (api_key_id, platform, reserved_at DESC)
    WHERE platform IS NOT NULL AND status IN ('reserved', 'committed', 'unknown');
\endif

SELECT contract_ready AS capability_index_ready
  FROM api_key_quota_index_contract
 WHERE index_name = 'usage_requests_api_key_capability_quota_idx' \gset

\if :capability_index_ready
  \echo 'usage_requests_api_key_capability_quota_idx is already valid'
\else
  DROP INDEX CONCURRENTLY IF EXISTS public.usage_requests_api_key_capability_quota_idx;
  CREATE INDEX CONCURRENTLY usage_requests_api_key_capability_quota_idx
    ON usage_requests (api_key_id, capability, reserved_at DESC)
    WHERE capability IS NOT NULL AND status IN ('reserved', 'committed', 'unknown');
\endif

SELECT contract_ready AS plan_index_ready
  FROM api_key_quota_index_contract
 WHERE index_name = 'usage_requests_consumer_plan_quota_idx' \gset

\if :plan_index_ready
  \echo 'usage_requests_consumer_plan_quota_idx is already valid'
\else
  DROP INDEX CONCURRENTLY IF EXISTS public.usage_requests_consumer_plan_quota_idx;
  CREATE INDEX CONCURRENTLY usage_requests_consumer_plan_quota_idx
    ON usage_requests (consumer_id, reserved_at DESC)
    WHERE status IN ('reserved', 'committed', 'unknown');
\endif

SELECT count(*) = 3 AND bool_and(contract_ready)
         AS api_key_quota_indexes_ready
  FROM api_key_quota_index_contract \gset

\if :api_key_quota_indexes_ready
  \echo 'API-key and plan quota indexes are ready'
\else
  \warn 'API-key and plan quota indexes did not become ready'
  \quit 1
\endif
