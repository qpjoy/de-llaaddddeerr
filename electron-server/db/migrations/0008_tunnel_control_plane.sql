-- Tunnel control plane.
-- D is the source of truth; Oversea nodes are reconcile targets.

CREATE TABLE tunnel_nodes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL UNIQUE,
  public_host            text NOT NULL,
  runner_url             text,
  runner_token           text,
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'online', 'offline', 'error')),
  server_ports           text,
  subscription_base_url  text,
  desired_revision       bigint NOT NULL DEFAULT 1,
  applied_revision       bigint,
  metadata               jsonb,
  last_seen_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tunnel_nodes_status_idx ON tunnel_nodes(status);

CREATE TABLE tunnel_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  routing_mode  text NOT NULL DEFAULT 'cn-direct' CHECK (routing_mode IN ('cn-direct', 'global')),
  runtime_mode  text NOT NULL DEFAULT 'system-tun' CHECK (runtime_mode IN ('system-tun', 'app-global', 'app-rule')),
  enabled       boolean NOT NULL DEFAULT true,
  is_default    boolean NOT NULL DEFAULT false,
  rules         jsonb,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tunnel_policies_one_default_idx
  ON tunnel_policies (is_default)
  WHERE is_default = true;

CREATE TABLE tunnel_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id             uuid REFERENCES tunnel_nodes(id) ON DELETE SET NULL,
  policy_id           uuid REFERENCES tunnel_policies(id) ON DELETE SET NULL,
  username            text NOT NULL,
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disabled', 'revoked')),
  auth_token          text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  subscription_token  text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  down_rate           text,
  up_rate             text,
  desired_revision    bigint NOT NULL DEFAULT 1,
  applied_revision    bigint,
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, username),
  UNIQUE (subscription_token)
);
CREATE INDEX tunnel_accounts_user_idx ON tunnel_accounts(user_id, status);
CREATE INDEX tunnel_accounts_node_idx ON tunnel_accounts(node_id, status);

INSERT INTO tunnel_policies (name, routing_mode, runtime_mode, enabled, is_default, rules)
VALUES (
  'default-cn-direct',
  'cn-direct',
  'system-tun',
  true,
  true,
  '{"description":"CN/direct, foreign traffic through Oversea Hysteria2."}'::jsonb
)
ON CONFLICT (name) DO NOTHING;
