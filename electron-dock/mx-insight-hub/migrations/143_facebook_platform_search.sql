-- Facebook Hub-owned routing; credentials and other platform routes are preserved.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
CREATE TABLE IF NOT EXISTS control.platform_search_policies (
  platform text PRIMARY KEY,
  catalog_key text NOT NULL,
  mode text NOT NULL DEFAULT 'existing' CHECK(mode IN ('existing','auto','rapidapi','justone','paused')),
  monthly_limit integer NOT NULL DEFAULT 1000 CHECK(monthly_limit BETWEEN 1 AND 1000000),
  probe_interval_hours integer NOT NULL DEFAULT 72 CHECK(probe_interval_hours BETWEEN 24 AND 744),
  revision integer NOT NULL DEFAULT 1,
  reason text NOT NULL DEFAULT 'migration-143', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS control.platform_search_policy_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform text NOT NULL, revision integer NOT NULL, actor text NOT NULL,
  policy jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(platform,revision)
);
CREATE TABLE IF NOT EXISTS control.facebook_rapid_quota (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  used integer NOT NULL DEFAULT 0 CHECK(used >= 0), remaining integer CHECK(remaining >= 0),
  reset_at timestamptz, blocked_until timestamptz, reason text,
  lease_token uuid, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO control.facebook_rapid_quota(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO control.platform_search_policies(platform,catalog_key,mode)
VALUES
('douyin','source-catalog-0001','existing'),
('kuaishou','source-catalog-0002','existing'),
('xiaohongshu','source-catalog-0004','existing'),
('weibo','source-catalog-0005','existing'),
('bilibili','source-catalog-0006','existing'),
('zhihu','source-catalog-0007','existing'),
('wechat_mp','source-catalog-0025','existing'),
('wechat_search','source-catalog-0026','existing'),
('tiktok','source-catalog-0085','existing'),
('twitter','source-catalog-0086','existing'),
('instagram','source-catalog-0087','existing'),
('facebook','source-catalog-0088','auto'),
('youtube','source-catalog-0089','existing'),
('reddit','source-catalog-0090','existing'),
('linkedin','source-catalog-0091','existing'),
('telegram','source-catalog-0160','existing')
ON CONFLICT DO NOTHING;
INSERT INTO control.platform_search_policy_events(platform,revision,actor,policy)
SELECT platform,revision,'migration-143',to_jsonb(p) FROM control.platform_search_policies p ON CONFLICT DO NOTHING;
ALTER TABLE control.external_platform_provider_price_book_entries DROP CONSTRAINT provider_price_unit_guard;
ALTER TABLE control.external_platform_provider_price_book_entries ADD CONSTRAINT provider_price_unit_guard CHECK (
  unit_cost_minor BETWEEN 1 AND 9007199254740991 OR (unit_cost_minor=0 AND (
    (provider_key='qixin' AND endpoint_key IN ('enterprise.36.99','enterprise.22.62','enterprise.2.3','enterprise.60.2','enterprise.33.11'))
    OR (provider_key='rapidapi' AND endpoint_key='facebook-scraper3.search'))));
CREATE OR REPLACE FUNCTION control.enforce_external_platform_active_price_book()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.control_source = 'database'
     AND NEW.desired_state IN ('active', 'canary')
     AND NOT EXISTS (
       SELECT 1
         FROM control.external_platform_operation_releases release
         JOIN control.external_platform_provider_price_books price
           ON price.provider_key = release.provider_key
          AND price.version = release.price_book_version
        WHERE release.provider_key = NEW.provider_key
          AND release.operation_key = NEW.operation_key
          AND release.release_revision = NEW.release_revision
          AND release.status = 'released'
          AND price.source = 'database'
          AND price.status = 'reviewed'
          AND NOT EXISTS (
            SELECT 1
              FROM unnest(release.endpoint_keys) endpoint_key
             WHERE NOT EXISTS (
               SELECT 1
                 FROM control.external_platform_provider_price_book_entries entry
                WHERE entry.provider_key = price.provider_key
                  AND entry.price_book_version = price.version
                  AND entry.endpoint_key = endpoint_key
                  AND (entry.unit_cost_minor > 0 OR (entry.unit_cost_minor = 0 AND (entry.provider_key = 'qixin' OR (entry.provider_key = 'rapidapi' AND entry.endpoint_key = 'facebook-scraper3.search'))))
             )
          )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'database active/canary policy requires a reviewed positive price book';
  END IF;
  RETURN NEW;
END
$function$;

-- Included calls have zero marginal cost; the subscription fee is not a per-call
-- price. The separate quota guard stops overages; unknown reset probes remain
-- billing-unknown evidence. Never replace any operator-authored operation.
DO $seed$
DECLARE price_version bigint;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM control.external_platform_operation_policies WHERE provider_key='rapidapi' AND operation_key='social.facebook.search') THEN
  SELECT coalesce(max(version),0)+1 INTO price_version FROM control.external_platform_provider_price_books WHERE provider_key='rapidapi';
  INSERT INTO control.external_platform_provider_price_books(provider_key,version,source,status,currency,pricing_as_of,
    monthly_budget_minor,monthly_subsidy_budget_minor,reviewed_by,reviewed_at)
  VALUES('rapidapi',price_version,'database','reviewed','USD',now(),0,0,'migration-143:user-included-quota',now());
  INSERT INTO control.external_platform_provider_price_book_entries(provider_key,price_book_version,endpoint_key,unit_cost_minor)
  VALUES('rapidapi',price_version,'facebook-scraper3.search',0);
  INSERT INTO control.external_platform_operation_releases(provider_key,operation_key,release_revision,contract_version,endpoint_keys,price_book_version,status)
  VALUES('rapidapi','social.facebook.search',1,'mx-insight-hub.facebook-search.v1',ARRAY['facebook-scraper3.search'],price_version,'released');
  INSERT INTO control.external_platform_operation_policies(provider_key,operation_key,release_revision,control_source,desired_state,revision,updated_by)
  VALUES('rapidapi','social.facebook.search',1,'database','active',1,'migration-143');
  INSERT INTO control.external_platform_operation_policy_events(event_id,provider_key,operation_key,previous_revision,revision,previous_state,desired_state,canary_consumer_ids,actor,reason)
  VALUES(gen_random_uuid(),'rapidapi','social.facebook.search',NULL,1,NULL,'active','{}'::uuid[],'migration-143','User requested Hub Facebook cutover with an included-call quota and automatic fallback');
 END IF;
END $seed$;
