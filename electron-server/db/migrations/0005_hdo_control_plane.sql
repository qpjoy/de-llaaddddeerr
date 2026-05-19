-- Home-Domestic-Oversea control plane.
-- Append-only migration: do not rewrite earlier marketplace/auth/game tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE hdo_control_state (
  id          integer PRIMARY KEY CHECK (id = 1),
  generation  bigint NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO hdo_control_state (id, generation)
VALUES (1, 1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE hdo_nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('domestic', 'home', 'oversea')),
  public_host   text,
  overlay_ip    inet,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'online', 'offline', 'error')),
  metadata      jsonb,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hdo_nodes_kind_idx ON hdo_nodes(kind);
CREATE INDEX hdo_nodes_status_idx ON hdo_nodes(status);

CREATE TABLE hdo_devices (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL,
  platform      text,
  public_key    text,
  overlay_ip    inet,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'online', 'offline', 'error')),
  metadata      jsonb,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hdo_devices_user_idx ON hdo_devices(user_id, updated_at DESC);

CREATE TABLE hdo_services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  node_id      uuid REFERENCES hdo_nodes(id) ON DELETE SET NULL,
  target_host  text NOT NULL,
  target_port  integer NOT NULL CHECK (target_port > 0 AND target_port <= 65535),
  protocol     text NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp', 'http', 'https')),
  domains      text[] NOT NULL DEFAULT ARRAY[]::text[],
  enabled      boolean NOT NULL DEFAULT true,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hdo_services_node_idx ON hdo_services(node_id);
CREATE INDEX hdo_services_enabled_idx ON hdo_services(enabled);

CREATE TABLE hdo_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  mode        text NOT NULL CHECK (mode IN ('home-only', 'home-foreign', 'domestic-global')),
  enabled     boolean NOT NULL DEFAULT true,
  rules       jsonb,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hdo_rate_limits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('user', 'device', 'profile', 'node')),
  subject_id    text NOT NULL,
  down_rate     text,
  down_ceil     text,
  up_rate       text,
  up_ceil       text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);

CREATE TABLE hdo_subscription_artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     text NOT NULL REFERENCES hdo_devices(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('manifest', 'mihomo-yaml', 'wg-profile')),
  generation    bigint NOT NULL,
  checksum      text NOT NULL,
  content       text NOT NULL,
  content_type  text NOT NULL,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, kind)
);
CREATE INDEX hdo_subscription_artifacts_device_idx
  ON hdo_subscription_artifacts(device_id, updated_at DESC);
