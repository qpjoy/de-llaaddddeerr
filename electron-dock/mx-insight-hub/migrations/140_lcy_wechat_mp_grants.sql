-- 2026-10-10: explicitly requested LCY-delta WeChat MP access repair.
-- Pin the original identity, never select by mutable name or rotate its secret.
-- Search serves MP articles; Channels, video search and demo remain ungranted.
-- Procurement/customer prices, operation activation and wallets are independent.
DO $grants$
DECLARE
  tenant constant uuid := '277bf8a4-5ed5-414d-b429-d72fcd7d36b6';
  consumer constant uuid := 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190';
  key_id constant uuid := 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83';
  selected_key api_keys%ROWTYPE;
  baseline api_key_platform_entitlements%ROWTYPE;
  previous_scopes jsonb;
  next_scopes jsonb;
  capability_name text;
  added_grants integer := 0;
  inserted_count integer;
  operations constant text[] := ARRAY[
    'native.wechat.mp.article-detail',
    'native.wechat.mp.article-detail-h5',
    'native.wechat.mp.article-stats-h5',
    'native.wechat.mp.article-stats',
    'native.wechat.mp.article-comments',
    'native.wechat.mp.comment-replies',
    'native.wechat.mp.related-articles',
    'native.wechat.mp.article-ad',
    'native.wechat.mp.account-profile',
    'native.wechat.mp.account-articles',
    'native.wechat.mp.account-services',
    'native.wechat.search.search'
  ];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tenant-access:' || tenant::text));
  IF NOT EXISTS (SELECT 1 FROM consumers WHERE id=consumer AND tenant_id=tenant) THEN
    RAISE NOTICE 'LCY WeChat grants skipped: original consumer absent';
    RETURN;
  END IF;
  PERFORM 1 FROM tenants WHERE id=tenant AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LCY WeChat grants refused: tenant inactive'; END IF;
  PERFORM 1 FROM consumers WHERE id=consumer AND tenant_id=tenant AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LCY WeChat grants refused: consumer inactive'; END IF;
  -- Also serialize against edits of sibling Keys and consumer-scoped issuance.
  PERFORM 1 FROM api_keys WHERE consumer_id=consumer ORDER BY id FOR UPDATE;
  SELECT * INTO selected_key FROM api_keys
    WHERE id=key_id AND consumer_id=consumer AND tenant_id=tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'LCY WeChat grants refused: original Key missing'; END IF;
  IF selected_key.status <> 'active' OR selected_key.environment <> 'live'
     OR selected_key.scope_mode <> 'snapshot' OR selected_key.expires_at <= now() THEN
    RAISE EXCEPTION 'LCY WeChat grants refused: original Key unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM api_keys WHERE consumer_id=consumer AND id<>key_id
      AND status='active' AND scope_mode='legacy_dynamic') THEN
    RAISE EXCEPTION 'LCY WeChat grants refused: sibling dynamic Key could inherit access';
  END IF;
  -- social was already granted to this original Key (migration 131).
  -- Do not invent platform access or looser quotas if that prerequisite changed.
  PERFORM pg_advisory_xact_lock(hashtext(consumer::text || ':authorization:platform:social'));
  SELECT e.* INTO baseline FROM api_key_platform_entitlements e
    JOIN platform_grants g ON g.consumer_id=consumer AND g.platform=e.platform
    WHERE e.api_key_id=key_id AND e.platform='social';
  IF NOT FOUND THEN RAISE EXCEPTION 'LCY WeChat grants require existing effective social access'; END IF;
  previous_scopes := jsonb_build_object(
    'scopeMode',selected_key.scope_mode,'webSearchOrder',selected_key.web_search_order,
    'platforms',(SELECT coalesce(jsonb_agg(platform ORDER BY platform),'[]') FROM api_key_platform_entitlements WHERE api_key_id=key_id),
    'capabilities',(SELECT coalesce(jsonb_agg(capability ORDER BY capability),'[]') FROM api_key_capability_entitlements WHERE api_key_id=key_id));
  FOREACH capability_name IN ARRAY operations LOOP
    PERFORM pg_advisory_xact_lock(hashtext(consumer::text || ':authorization:capability:' || capability_name));
    INSERT INTO capability_grants(consumer_id,capability)
      VALUES(consumer,capability_name) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    added_grants := added_grants + inserted_count;
    INSERT INTO consumer_capability_policies(tenant_id,consumer_id,capability,max_requests,window_seconds)
      VALUES(tenant,consumer,capability_name,baseline.max_requests,baseline.window_seconds)
      ON CONFLICT DO NOTHING;
    INSERT INTO api_key_capability_entitlements(api_key_id,capability,max_requests,window_seconds)
      SELECT key_id,capability_name,least(max_requests,baseline.max_requests),greatest(window_seconds,baseline.window_seconds)
        FROM consumer_capability_policies WHERE consumer_id=consumer AND capability=capability_name
      ON CONFLICT DO NOTHING;
  END LOOP;
  next_scopes := jsonb_build_object(
    'scopeMode',selected_key.scope_mode,'webSearchOrder',selected_key.web_search_order,
    'platforms',(SELECT coalesce(jsonb_agg(platform ORDER BY platform),'[]') FROM api_key_platform_entitlements WHERE api_key_id=key_id),
    'capabilities',(SELECT coalesce(jsonb_agg(capability ORDER BY capability),'[]') FROM api_key_capability_entitlements WHERE api_key_id=key_id));
  IF next_scopes IS DISTINCT FROM previous_scopes OR added_grants > 0 THEN
    INSERT INTO api_key_scope_events(api_key_id,actor,previous_scopes,next_scopes)
      VALUES(key_id,'migration-140:user-authorized-wechat-mp',previous_scopes,next_scopes);
  END IF;
  RAISE NOTICE 'LCY-delta original Key granted 11 WeChat MP operations plus article search; prices and runtime controls unchanged';
END
$grants$;
