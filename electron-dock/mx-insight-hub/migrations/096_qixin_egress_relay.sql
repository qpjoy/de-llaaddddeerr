-- Relay enterprise calls through the Domestic edge so the upstream sees a fixed
-- public egress IP for its per-AppKey allowlist.
--
-- Deliberately NOT control.external_platform_proxy_bindings: that table selects
-- a forward proxy for an undici dispatcher and is constrained to tikhub. This
-- one rewrites where a request is sent and the edge relays it. TikHub's binding,
-- store, route and panel are untouched by this migration.
CREATE TABLE IF NOT EXISTS control.external_platform_egress_relays (
  provider_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  relay_base text,
  revision bigint NOT NULL DEFAULT 1,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Enabled without a base, or a base left behind after disabling, would both
  -- be silently wrong at request time.
  CONSTRAINT external_platform_egress_relays_base_required
    CHECK (enabled = (relay_base IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control.external_platform_egress_relay_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_key text NOT NULL,
  revision bigint NOT NULL,
  enabled boolean NOT NULL,
  relay_base text,
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seeded disabled: applying this migration must not change how any request is
-- routed. An operator enables it from the platform page once the edge is up and
-- the upstream allowlist has the edge's public egress IP.
INSERT INTO control.external_platform_egress_relays(provider_key, enabled, relay_base, reason)
VALUES ('qixin', false, NULL, 'migration-096 seed; direct until an operator enables the relay')
ON CONFLICT DO NOTHING;
