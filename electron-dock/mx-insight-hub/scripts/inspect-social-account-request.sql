-- Read-only: why one /api/v1/data/social/crawl delivery stopped short — Hub's
-- own bounds (deadline, page/call limits, admission) or the supplier page
-- (no continuation cursor, a cursor Hub's parser does not read, timeline end) —
-- or why its Twitter account lookup failed (sections 7-8).
--
-- Run on the operator host, from electron-dock/mx-insight-hub:
--   kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
--     psql -X -U mx_common -d mx_insight_hub -v request_id=<Hub request UUID> \
--     < scripts/inspect-social-account-request.sql
--
-- One read-only transaction with a statement timeout. Supplier responses are
-- reduced to structure counts and short cursor hashes: no post text, tokens,
-- credentials or request headers are selected.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';

\echo '== 1. The request and what Hub delivered'
SELECT u.platform, u.acquisition_request->>'path' AS path, u.status, u.response_status,
       coalesce(u.error_code, u.response_body #>> '{error,code}') AS error_code,
       u.reserved_at, round(extract(epoch FROM u.completed_at - u.reserved_at) * 1000) AS duration_ms,
       round(extract(epoch FROM u.lease_expires_at - u.reserved_at) * 1000) AS deadline_budget_ms,
       u.response_body #>> '{data,status}' AS delivery_status,
       jsonb_array_length(coalesce(u.response_body #> '{data,items}', '[]')) AS items,
       u.response_body #>> '{data,page,hasMore}' AS has_more,
       u.response_body #>> '{data,page,nextCursor}' IS NOT NULL AS has_next_cursor,
       u.response_body #>> '{data,meta,providerCalls}' AS provider_calls
  FROM usage_requests u WHERE u.id = :'request_id';

\echo '== 2. Request parameters (body keys; identity and paging values only)'
SELECT (SELECT string_agg(key, ',' ORDER BY key) FROM jsonb_object_keys(u.acquisition_request->'body') key) AS body_keys,
       (SELECT jsonb_object_agg(key, value) FROM jsonb_each(u.acquisition_request->'body')
         WHERE key ~* '^(platform|action|activity_?types?|user_?ids?|uids?|usernames?|user_names?|urls?|page_?size|count|limit|target_?count|page)$') AS paging_and_identity,
       u.acquisition_request #> '{body,cursor}' IS NOT NULL OR u.acquisition_request #> '{body,params,cursor}' IS NOT NULL AS continued_from_cursor
  FROM usage_requests u WHERE u.id = :'request_id';

\echo '== 3. Hub warnings (the reason in parentheses is the bound that stopped the fill)'
SELECT w ->> 'code' AS code, w ->> 'message' AS message
  FROM usage_requests u, jsonb_array_elements(coalesce(u.response_body #> '{data,warnings}', '[]')) w
 WHERE u.id = :'request_id';

\echo '== 4. Delivered account profile counters (posts on the account vs posts delivered)'
SELECT key, value
  FROM usage_requests u,
       jsonb_each(CASE WHEN jsonb_typeof((u.response_body #>> '{data,raw_info}')::jsonb -> 0) = 'object'
                       THEN (u.response_body #>> '{data,raw_info}')::jsonb -> 0 END)
 WHERE u.id = :'request_id' AND (key ~* 'count|posts|statuses' OR key IN ('user_id', 'user_name', 'username'));

\echo '== 5. Supplier calls (offset_ms = dispatch time after the request started)'
SELECT c.call_ordinal, c.call_role, c.provider_key, c.endpoint_key, c.outcome, c.http_status, c.error_code,
       c.billed, c.item_count, c.latency_ms,
       round(extract(epoch FROM c.started_at - u.reserved_at) * 1000) AS offset_ms
  FROM external_platform.provider_calls c JOIN usage_requests u ON u.id = c.usage_request_id
 WHERE c.usage_request_id = :'request_id' ORDER BY c.call_ordinal;

\echo '== 6. Saved supplier page structure per call'
\echo '   bottom_seen_by_hub = 0 while bottom_anywhere > 0: the page had a continuation Hub did not read'
\echo '   bottom_anywhere = 0: the supplier gave no continuation; terminate = true: Twitter ended the timeline'
-- strict: lax .** can visit a value twice through automatic array unwrapping.
WITH pages AS (
  SELECT c.call_ordinal, c.endpoint_key, r.body_size, r.json_parsed, r.parsed_payload AS p
    FROM external_platform.provider_calls c
    LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = c.id
   WHERE c.usage_request_id = :'request_id'
)
SELECT call_ordinal, endpoint_key, body_size, json_parsed,
       (SELECT string_agg(key, ',' ORDER BY key) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p) = 'object' THEN p END) key) AS top_keys,
       (SELECT string_agg(t || ' x' || n, ', ' ORDER BY t) FROM (
          SELECT v #>> '{}' AS t, count(*) AS n
            FROM jsonb_path_query(p, 'strict $.** ? (@.type like_regex "^Timeline").type') v GROUP BY 1) s) AS timeline_types,
       jsonb_array_length(jsonb_path_query_array(p, 'strict $.** ? (exists(@.tweet_results.result))')) AS tweet_results,
       jsonb_array_length(jsonb_path_query_array(p, 'strict $.** ? (@.cursorType == "Bottom" || @.cursorType == "ShowMore")')) AS bottom_anywhere,
       jsonb_array_length(jsonb_path_query_array(p, 'strict $.** ? (@.entries.type() == "array").entries[*] ? (@.content.cursorType == "Bottom" || @.content.cursorType == "ShowMore")')) AS bottom_seen_by_hub,
       jsonb_array_length(jsonb_path_query_array(p, 'strict $.** ? (@.type == "TimelineReplaceEntry" && @.entry.content.cursorType == "Bottom")')) AS bottom_in_replace_entry,
       left(md5(jsonb_path_query_first(p, 'strict $.** ? (@.cursorType == "Bottom" && @.value.type() == "string").value') #>> '{}'), 8) AS bottom_cursor_md5,
       jsonb_path_exists(p, 'strict $.** ? (@.type == "TimelineTerminateTimeline")') AS terminate
  FROM pages ORDER BY call_ordinal;


\echo '== 7. Account lookup response (userExists = false with empty data: the supplier says no such handle)'
SELECT c.call_ordinal, c.outcome, c.error_code, r.body_size,
       (SELECT string_agg(key, ',' ORDER BY key) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(r.parsed_payload) = 'object' THEN r.parsed_payload END) key) AS top_keys,
       r.parsed_payload -> 'userExists' AS user_exists,
       (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(r.parsed_payload -> 'data') = 'object' THEN r.parsed_payload -> 'data' END)) AS data_keys,
       (SELECT string_agg(DISTINCT v #>> '{}', ',') FROM jsonb_path_query(r.parsed_payload, 'strict $.** ? (@.__typename like_regex "^User").__typename') v) AS user_typenames,
       (SELECT string_agg(DISTINCT v #>> '{}', ',') FROM jsonb_path_query(r.parsed_payload, 'strict $.** ? (@.__typename == "UserUnavailable" && @.reason.type() == "string").reason') v) AS unavailable_reason
  FROM external_platform.provider_calls c
  LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = c.id
 WHERE c.usage_request_id = :'request_id' AND c.endpoint_key = 'twitter-aio.user-info'
 ORDER BY c.call_ordinal;

\echo '== 8. The same account requested by this Key in the last 14 days (did the lookup ever succeed?)'
WITH target AS (
  SELECT api_key_id, platform,
         lower(coalesce(acquisition_request #> '{body,usernames}', acquisition_request #> '{body,userIds}',
                        acquisition_request #> '{body,urls}')::text) AS identity
    FROM usage_requests WHERE id = :'request_id'
)
SELECT u.id, u.reserved_at, u.acquisition_request->>'path' AS path, u.response_status,
       coalesce(u.error_code, u.response_body #>> '{error,code}') AS code,
       jsonb_array_length(coalesce(u.response_body #> '{data,items}', '[]')) AS items
  FROM usage_requests u, target t
 WHERE u.api_key_id = t.api_key_id AND u.platform = t.platform
   AND u.created_at >= now() - interval '14 days'
   AND u.acquisition_request->>'path' IN ('/api/v1/data/social/crawl', '/api/v1/data/social/user-info')
   AND lower(coalesce(u.acquisition_request #> '{body,usernames}', u.acquisition_request #> '{body,userIds}',
                      u.acquisition_request #> '{body,urls}')::text) = t.identity
 ORDER BY u.reserved_at DESC LIMIT 20;

ROLLBACK;
