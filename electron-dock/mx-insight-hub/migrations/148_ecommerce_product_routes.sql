-- Store explicit existing defaults; no supplier, billing or credential change.
CREATE TABLE control.ecommerce_product_routes (
  marketplace text PRIMARY KEY,
  adapter_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.ecommerce_product_route_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  marketplace text NOT NULL,
  revision integer NOT NULL,
  actor text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace, revision)
);
INSERT INTO control.ecommerce_product_routes(marketplace,adapter_id,reason) VALUES
  ('taobao','justone:taobao-tmall.product-search.v1','migration-148: preserve existing default'),
  ('tmall','justone:taobao-tmall.product-search.v1','migration-148: preserve existing default'),
  ('jd','justone:jd.product-search.v1','migration-148: preserve existing default'),
  ('xianyu','justone:xianyu.product-search.v1','migration-148: preserve existing default'),
  ('xiaohongshu_ec','justone:xiaohongshu-ec.product-search.v1','migration-148: preserve existing default'),
  ('douyin_ec','justone:douyin-ec.product-search.v1','migration-148: preserve existing default');
INSERT INTO control.ecommerce_product_route_events(marketplace,revision,actor,policy)
SELECT marketplace,revision,'migration-148',to_jsonb(route) FROM control.ecommerce_product_routes route;
