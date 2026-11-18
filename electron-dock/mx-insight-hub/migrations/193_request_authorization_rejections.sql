-- Pre-reservation refusals are separate from usage, billing and supplier
-- ledgers. A client-supplied request ID can occur in multiple independent
-- attempts/owners; the server event UUID is the immutable row identity.
CREATE TABLE IF NOT EXISTS control.request_authorization_rejections (
  event_id uuid PRIMARY KEY,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$'),
  request_id_source text NOT NULL CHECK (request_id_source IN ('server','client')),
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN (
    'twitter','facebook','instagram','bilibili','douyin','kuaishou','weibo',
    'xiaohongshu','youtube','zhihu','tiktok','linkedin','threads','reddit',
    'telegram','wechat_search','tieba')),
  scope_mode text NOT NULL CHECK (scope_mode IN ('snapshot','legacy_dynamic')),
  route_path text CHECK (route_path IN (
    '/api/v1/data/search','/api/v2/data/search','/api/v1/search','/api/v1/data/telegram/search',
    '/api/v1/night-all/search/raw','/api/v1/night-all/search/crawl','/api/v1/night-all/search/user-info',
    '/api/v1/night-all/search/post-detail','/api/v1/night-all/search/post-comments')),
  error_code text NOT NULL CHECK (error_code='platform_not_granted'),
  http_status integer NOT NULL CHECK (http_status=403),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS request_authorization_rejections_lookup_idx
  ON control.request_authorization_rejections(request_id, occurred_at DESC, event_id);
