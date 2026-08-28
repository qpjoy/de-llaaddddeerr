-- Versioned Agent Market definitions live in the Hub Internal control plane.
--
-- This migration does not schedule work and does not seed a production run.
-- The built-in search demo remains readable at revision 0 until an Admin Token
-- explicitly saves a draft. Dry runs never write either table.

CREATE SCHEMA IF NOT EXISTS agent_center;

CREATE TABLE IF NOT EXISTS control.agent_market_agents (
  agent_key text PRIMARY KEY
    CHECK (agent_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  definition jsonb NOT NULL
    CHECK (jsonb_typeof(definition) = 'object'),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (definition ->> 'agentKey' = agent_key),
  CHECK ((definition ->> 'dryRunOnly')::boolean IS TRUE)
);

CREATE TABLE IF NOT EXISTS agent_center.agent_market_versions (
  agent_key text NOT NULL
    REFERENCES control.agent_market_agents(agent_key) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  definition jsonb NOT NULL
    CHECK (jsonb_typeof(definition) = 'object'),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_key, revision),
  CHECK (definition ->> 'agentKey' = agent_key),
  CHECK ((definition ->> 'dryRunOnly')::boolean IS TRUE)
);

CREATE INDEX IF NOT EXISTS agent_market_versions_created_idx
  ON agent_center.agent_market_versions (agent_key, created_at DESC, revision DESC);

COMMENT ON TABLE control.agent_market_agents IS
  'Current Internal Agent Market definitions. Runtime data tools remain server-owned and allowlisted.';

COMMENT ON TABLE agent_center.agent_market_versions IS
  'Append-only definition snapshots for prompt, parameter, schema-version and trash-state provenance.';

