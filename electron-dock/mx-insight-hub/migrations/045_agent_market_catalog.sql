-- Real, manageable Agent Market directory. Definitions and run adapters remain
-- code-owned; these records describe what operators can see and manage.

CREATE SCHEMA IF NOT EXISTS control;

CREATE TABLE IF NOT EXISTS control.agent_market_categories (
  category_key text PRIMARY KEY
    CHECK (
      category_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      AND category_key NOT IN ('catalog', 'categories', 'agents')
    ),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN -10000 AND 10000),
  system_owned boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 160),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control.agent_market_catalog (
  agent_key text PRIMARY KEY
    CHECK (
      agent_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      AND agent_key NOT IN ('catalog', 'categories', 'agents')
    ),
  category_key text NOT NULL
    REFERENCES control.agent_market_categories(category_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(tags) = 'array'
    AND jsonb_array_length(tags) <= 12
    AND NOT jsonb_path_exists(
      tags,
      '$[*] ? (@.type() != "string" || @ == "" || @ like_regex "^.{41,}$")'
    )
  ),
  -- Executor keys are adapter identifiers, never URLs or import paths. This
  -- check expands only in a migration that ships the corresponding server code.
  executor_key text CHECK (
    executor_key IS NULL OR executor_key IN ('advanced-search-dry-run')
  ),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN -10000 AND 10000),
  system_owned boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 160),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_market_catalog_executor_owner_check
    CHECK (executor_key IS NULL OR system_owned)
);

CREATE INDEX IF NOT EXISTS agent_market_catalog_category_idx
  ON control.agent_market_catalog (category_key, sort_order, display_name, agent_key);

-- The dry-run endpoint resolves one catalog item from one code-owned adapter.
-- Keeping this one-to-one prevents an ambiguous enabled/disabled result.
CREATE UNIQUE INDEX IF NOT EXISTS agent_market_catalog_executor_unique_idx
  ON control.agent_market_catalog (executor_key)
  WHERE executor_key IS NOT NULL;

INSERT INTO control.agent_market_categories
  (category_key, display_name, description, sort_order, system_owned,
   revision, created_by, updated_by)
VALUES
  ('knowledge-qa', '知识问答', '基于可治理知识与证据的问答 Agent。', 10, true,
   1, 'migration:045-agent-market-catalog', 'migration:045-agent-market-catalog'),
  ('demo', 'Demo Agent', '用于学习、测试和展示受控 Agent 执行流程。', 20, true,
   1, 'migration:045-agent-market-catalog', 'migration:045-agent-market-catalog')
ON CONFLICT (category_key) DO NOTHING;

INSERT INTO control.agent_market_catalog
  (agent_key, category_key, display_name, description, tags, executor_key, enabled,
   sort_order, system_owned, revision, created_by, updated_by)
VALUES
  ('advanced-search', 'demo', '进阶搜索 Agent · Dry Run',
   '展示分流、改写、混合召回、RRF、纠错、地理工具、引用与 Trace。',
   '["RAG", "Hybrid Search", "RRF"]'::jsonb,
   'advanced-search-dry-run', true, 10, true, 1,
   'migration:045-agent-market-catalog', 'migration:045-agent-market-catalog'),
  ('knowledge-qa', 'knowledge-qa', '知识问答 Agent',
   '可管理的知识问答目录项；当前尚未配置执行器。',
   '["Knowledge QA"]'::jsonb,
   NULL, true, 10, true, 1,
   'migration:045-agent-market-catalog', 'migration:045-agent-market-catalog')
ON CONFLICT (agent_key) DO NOTHING;

COMMENT ON TABLE control.agent_market_categories IS
  'Operator-managed Agent Market categories. system_owned rows cannot be deleted through the Hub API.';

COMMENT ON TABLE control.agent_market_catalog IS
  'Truthful Agent directory metadata. Runnable state is derived from enabled plus a code-owned executor; no synthetic run metrics are stored.';
