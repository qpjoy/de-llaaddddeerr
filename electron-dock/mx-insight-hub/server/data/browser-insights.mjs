// These are descriptive statistics over current stored observations, not Agent
// predictions or historical interaction growth. A missing metric stays null.
export function accountSummarySql(where, tags) {
  const metric = (key) => `CASE WHEN r.object_type NOT IN ('user','account','profile')
    AND (r.stable_fields#>>'{metrics,${key}}') ~ '^[0-9]{1,18}(\\.[0-9]{1,4})?$'
    THEN (r.stable_fields#>>'{metrics,${key}}')::numeric END AS ${key}`
  return `WITH matches AS MATERIALIZED (
    SELECT r.id, r.event_time, r.object_type, r.content_type, ${tags} AS tags,
      ${['likes', 'comments', 'shares', 'favorites', 'views'].map(metric).join(',')}
    FROM core.canonical_records r WHERE ${where}
  ) SELECT NULL::int AS total, '[]'::jsonb AS items, jsonb_build_object(
    'records', count(*), 'contents', count(*) FILTER (WHERE object_type NOT IN ('user','account','profile')),
    'firstPublishedAt', min(event_time) FILTER (WHERE object_type NOT IN ('user','account','profile')),
    'lastPublishedAt', max(event_time) FILTER (WHERE object_type NOT IN ('user','account','profile')),
    'datedRecords', count(event_time) FILTER (WHERE object_type NOT IN ('user','account','profile')),
    'metrics', jsonb_build_object(${['likes', 'comments', 'shares', 'favorites', 'views'].map((key) => `'${key}', jsonb_build_object('value',sum(${key}),'coverage',count(${key}))`).join(',')}),
    'tags', (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
      SELECT t.value #>> '{}' AS tag, count(DISTINCT m.id)::int AS records
      FROM matches m CROSS JOIN LATERAL jsonb_array_elements(m.tags) t(value)
      WHERE jsonb_typeof(t.value) = 'string' AND length(t.value #>> '{}') BETWEEN 1 AND 200
        AND m.object_type NOT IN ('user','account','profile')
      GROUP BY t.value ORDER BY records DESC, tag LIMIT 20
    ) e),
    'types', (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
      SELECT object_type AS "objectType", content_type AS "contentType", count(*)::int AS records
      FROM matches GROUP BY object_type, content_type ORDER BY records DESC, object_type, content_type LIMIT 30
    ) e),
    'timeline', (SELECT COALESCE(jsonb_agg(e ORDER BY month), '[]'::jsonb) FROM (
      SELECT to_char(event_time AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month, count(*)::int AS records
      FROM matches WHERE event_time IS NOT NULL AND object_type NOT IN ('user','account','profile')
      GROUP BY month ORDER BY month DESC LIMIT 24
    ) e),
    'method', 'stored-content-descriptive-v1'
  ) AS account_summary FROM matches`
}
