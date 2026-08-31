-- Agent Studio P1 control plane: portfolio, CAS drafts and immutable compiled
-- artifacts. This migration deliberately creates no run, evaluation, release
-- or deployment tables; P1 compiles declarations but cannot execute them.

CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS agent_center;

CREATE TABLE IF NOT EXISTS control.agent_studio_agents (
  agent_key text PRIMARY KEY
    CHECK (agent_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 2000),
  owner text NOT NULL CHECK (length(btrim(owner)) BETWEEN 1 AND 160),
  project_kind text NOT NULL DEFAULT 'custom'
    CHECK (project_kind IN ('custom', 'template-derived', 'migration')),
  data_scope text NOT NULL DEFAULT 'Hub governed data'
    CHECK (length(btrim(data_scope)) BETWEEN 1 AND 240),
  risk_class text NOT NULL DEFAULT 'low'
    CHECK (risk_class IN ('low', 'medium', 'high')),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(tags) = 'array'
    AND jsonb_array_length(tags) <= 12
    AND NOT jsonb_path_exists(
      tags,
      '$[*] ? (@.type() != "string" || @ == "" || @ like_regex "^.{41,}$")'
    )
  ),
  lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle = 'draft'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control.agent_studio_drafts (
  draft_id uuid PRIMARY KEY,
  agent_key text NOT NULL
    REFERENCES control.agent_studio_agents(agent_key) ON DELETE RESTRICT,
  current_revision bigint NOT NULL CHECK (current_revision >= 1),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition) = 'object'
    AND definition ->> 'contractVersion' = 'mx-insight.agent-draft.v1'
  ),
  definition_hash char(64) NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_key, draft_id)
);

CREATE INDEX IF NOT EXISTS agent_studio_drafts_agent_idx
  ON control.agent_studio_drafts (agent_key, updated_at DESC, draft_id);

CREATE TABLE IF NOT EXISTS agent_center.agent_studio_draft_versions (
  draft_id uuid NOT NULL
    REFERENCES control.agent_studio_drafts(draft_id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision >= 1),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition) = 'object'
    AND definition ->> 'contractVersion' = 'mx-insight.agent-draft.v1'
  ),
  definition_hash char(64) NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, revision)
);

CREATE TABLE IF NOT EXISTS control.agent_compiled_artifacts (
  artifact_id uuid PRIMARY KEY,
  agent_key text NOT NULL
    REFERENCES control.agent_studio_agents(agent_key) ON DELETE RESTRICT,
  draft_id uuid NOT NULL
    REFERENCES control.agent_studio_drafts(draft_id) ON DELETE RESTRICT,
  draft_revision bigint NOT NULL CHECK (draft_revision >= 1),
  compiler_version text NOT NULL
    CHECK (compiler_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  node_registry_version text NOT NULL
    CHECK (node_registry_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  normalized_plan jsonb NOT NULL CHECK (jsonb_typeof(normalized_plan) = 'object'),
  dependency_manifest jsonb NOT NULL CHECK (jsonb_typeof(dependency_manifest) = 'object'),
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diagnostics) = 'array'),
  artifact_hash char(64) NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_key, draft_id)
    REFERENCES control.agent_studio_drafts(agent_key, draft_id) ON DELETE RESTRICT,
  FOREIGN KEY (draft_id, draft_revision)
    REFERENCES agent_center.agent_studio_draft_versions(draft_id, revision) ON DELETE RESTRICT,
  UNIQUE (draft_id, draft_revision, artifact_hash),
  UNIQUE (agent_key, draft_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS agent_compiled_artifacts_draft_idx
  ON control.agent_compiled_artifacts
    (agent_key, draft_id, draft_revision DESC, created_at DESC);

CREATE OR REPLACE FUNCTION agent_center.reject_agent_studio_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS agent_studio_draft_versions_immutable
  ON agent_center.agent_studio_draft_versions;
CREATE TRIGGER agent_studio_draft_versions_immutable
BEFORE UPDATE OR DELETE ON agent_center.agent_studio_draft_versions
FOR EACH ROW EXECUTE FUNCTION agent_center.reject_agent_studio_immutable_mutation();

DROP TRIGGER IF EXISTS agent_compiled_artifacts_immutable
  ON control.agent_compiled_artifacts;
CREATE TRIGGER agent_compiled_artifacts_immutable
BEFORE UPDATE OR DELETE ON control.agent_compiled_artifacts
FOR EACH ROW EXECUTE FUNCTION agent_center.reject_agent_studio_immutable_mutation();

-- Truthful P1 portfolio fixtures. These rows are authoring inputs only: no
-- artifact, run, evaluation, release, deployment, health or metric is seeded.
INSERT INTO control.agent_studio_agents (
  agent_key, display_name, summary, owner, project_kind, data_scope,
  risk_class, tags, created_by, updated_by
)
VALUES
  (
    'public-opinion-mapping', '全国舆情多源接入与字段映射',
    '受治理 SourceRef 到 canonical content 的结构画像、映射建议、确定性校验与人工复核草稿；P1 不导入、不发布。',
    'data-platform', 'template-derived', '全国舆情省级 PostgreSQL 来源（只读结构与映射建议）',
    'medium', '["public-opinion", "mapping", "lineage"]'::jsonb,
    'migration-046', 'migration-046'
  ),
  (
    'enterprise-registry-intelligence', '企业登记数据映射',
    '面向规划中企业登记来源的字段映射草稿；connector、运行、入库与发布均未启用。',
    'data-platform', 'template-derived', '规划中的企业登记来源契约',
    'medium', '["enterprise", "mapping", "planned-source"]'::jsonb,
    'migration-046', 'migration-046'
  ),
  (
    'news-normalization', '新闻内容标准化',
    '面向规划中新闻文件来源的结构识别与映射草稿；没有伪造的导入或运行状态。',
    'data-platform', 'template-derived', '规划中的新闻文件来源契约',
    'low', '["news", "normalization", "planned-source"]'::jsonb,
    'migration-046', 'migration-046'
  ),
  (
    'search-result-normalization', '搜索结果标准化',
    '面向规划中搜索结果 SQLite API 来源的映射草稿；P1 仅可编辑和编译。',
    'data-platform', 'template-derived', '规划中的搜索结果来源契约',
    'low', '["search", "normalization", "planned-source"]'::jsonb,
    'migration-046', 'migration-046'
  )
ON CONFLICT (agent_key) DO NOTHING;

WITH base AS (
  SELECT $definition$
  {
    "budgets":{"deadlineMs":60000,"maxFanOut":4,"maxInputTokens":32000,"maxLoopIterations":0,"maxModelCalls":2,"maxNodeAttempts":16,"maxOutputTokens":4000,"maxRetries":1,"maxToolCalls":4},
    "contractVersion":"mx-insight.agent-draft.v1",
    "edges":[
      {"from":{"nodeId":"source","port":"source"},"to":{"nodeId":"source_route","port":"source"}},
      {"from":{"nodeId":"source_route","port":"postgresql"},"to":{"nodeId":"schema_profile","port":"source"}},
      {"from":{"nodeId":"schema_profile","port":"profile"},"to":{"nodeId":"mapping_proposal","port":"profile"}},
      {"from":{"nodeId":"schema_profile","port":"profile"},"to":{"nodeId":"mapping_validation","port":"profile"}},
      {"from":{"nodeId":"mapping_proposal","port":"proposal"},"to":{"nodeId":"mapping_validation","port":"proposal"}},
      {"from":{"nodeId":"mapping_validation","port":"validated"},"to":{"nodeId":"human_review","port":"validated"}},
      {"from":{"nodeId":"human_review","port":"candidate"},"to":{"nodeId":"mapping_output","port":"mappingProposal"}}
    ],
    "entryNodeId":"source",
    "nodes":[
      {"config":{"sourceRef":"source://hub/public-opinion.province.v1"},"nodeId":"source","nodeType":"core.input.source","nodeVersion":"1.0.0"},
      {"config":{"sourceKind":"postgresql"},"nodeId":"source_route","nodeType":"core.route.source","nodeVersion":"1.0.0"},
      {"config":{},"nodeId":"schema_profile","nodeType":"hub.schema.profile","nodeVersion":"1.0.0"},
      {"config":{"maxOutputTokens":2000,"sequenceKey":"public-opinion-mapping-default","systemPrompt":"Propose a field mapping only. Never import, mutate, publish, or execute source-side code.","targetSchemaRef":"schema://hub/canonical-content.v1","taskTemplate":"Map the profiled nationwide public-opinion source columns to the governed canonical content schema. Preserve provenance and report every ambiguous field.","temperature":0.1},"nodeId":"mapping_proposal","nodeType":"llm.mapping.propose","nodeVersion":"1.0.0"},
      {"config":{"requiredFields":["externalId","title","body","eventTime","sourceUrl"]},"nodeId":"mapping_validation","nodeType":"hub.mapping.validate","nodeVersion":"1.0.0"},
      {"config":{},"nodeId":"human_review","nodeType":"core.review.mapping-required","nodeVersion":"1.0.0"},
      {"config":{},"nodeId":"mapping_output","nodeType":"core.output.mapping","nodeVersion":"1.0.0"}
    ],
    "terminalNodeIds":["mapping_output"],
    "ui":{"annotations":[{"annotationId":"compile_only","nodeId":"human_review","text":"P1 ends at a reviewed mapping proposal. Import, release and deployment are unavailable."}],"groups":[],"positions":{"human_review":{"x":1160,"y":120},"mapping_output":{"x":1400,"y":120},"mapping_proposal":{"x":680,"y":40},"mapping_validation":{"x":920,"y":120},"schema_profile":{"x":440,"y":120},"source":{"x":0,"y":120},"source_route":{"x":220,"y":120}},"viewport":{"x":0,"y":0,"zoom":0.85}}
  }
  $definition$::jsonb AS definition
), seed_drafts AS (
  SELECT
    '00000000-0000-4000-8000-000000000461'::uuid AS draft_id,
    'public-opinion-mapping'::text AS agent_key,
    definition,
    '943925cedd6d86d75065aa4321c9e6fd7fcbd5a37b8fde7ff47be82da50f0973'::text AS definition_hash
  FROM base
  UNION ALL
  SELECT
    '00000000-0000-4000-8000-000000000462'::uuid,
    'enterprise-registry-intelligence',
    jsonb_set(
      jsonb_set(
        jsonb_set(definition, '{nodes,0,config,sourceRef}', to_jsonb('source://planned/enterprise-registry.v1'::text)),
        '{nodes,3,config,sequenceKey}', to_jsonb('enterprise-registry-mapping-draft'::text)
      ),
      '{nodes,3,config,taskTemplate}',
      to_jsonb('Propose a reviewed mapping from the planned enterprise registry source into canonical content. Preserve registry identifiers and report every ambiguous field.'::text)
    ),
    '14794796d96e4a529cccca8a6c6d36995b9079972f6421d172b1e05aebbc56e3'
  FROM base
  UNION ALL
  SELECT
    '00000000-0000-4000-8000-000000000463'::uuid,
    'news-normalization',
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(definition, '{nodes,0,config,sourceRef}', to_jsonb('source://planned/news-feed.v1'::text)),
            '{nodes,1,config,sourceKind}', to_jsonb('file'::text)
          ),
          '{edges,1,from,port}', to_jsonb('file'::text)
        ),
        '{nodes,3,config,sequenceKey}', to_jsonb('news-normalization-draft'::text)
      ),
      '{nodes,3,config,taskTemplate}',
      to_jsonb('Propose a reviewed mapping from the planned news feed source into canonical content. Preserve publisher, byline, event time, source URL and ambiguity.'::text)
    ),
    'aa3456ce092bebf35ad85c52009a69bd8e528e2a5dce8078f4a564af99aae4a9'
  FROM base
  UNION ALL
  SELECT
    '00000000-0000-4000-8000-000000000464'::uuid,
    'search-result-normalization',
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(definition, '{nodes,0,config,sourceRef}', to_jsonb('source://planned/search-results.v1'::text)),
            '{nodes,1,config,sourceKind}', to_jsonb('sqlite-api'::text)
          ),
          '{edges,1,from,port}', to_jsonb('sqliteApi'::text)
        ),
        '{nodes,3,config,sequenceKey}', to_jsonb('search-result-normalization-draft'::text)
      ),
      '{nodes,3,config,taskTemplate}',
      to_jsonb('Propose a reviewed mapping from the planned search result source into canonical content. Preserve engine, rank, query context, source URL and ambiguity.'::text)
    ),
    '8f67b1ab0bd67f7c51bafd2e51c93a008b3472e6bb0a5b220b6fcfa980af61ba'
  FROM base
)
INSERT INTO control.agent_studio_drafts (
  draft_id, agent_key, current_revision, definition, definition_hash,
  created_by, updated_by
)
SELECT draft_id, agent_key, 1, definition, definition_hash,
       'migration-046', 'migration-046'
FROM seed_drafts
ON CONFLICT (draft_id) DO NOTHING;

INSERT INTO agent_center.agent_studio_draft_versions (
  draft_id, revision, definition, definition_hash, updated_by, created_at
)
SELECT draft_id, current_revision, definition, definition_hash, updated_by, created_at
FROM control.agent_studio_drafts
WHERE draft_id IN (
  '00000000-0000-4000-8000-000000000461'::uuid,
  '00000000-0000-4000-8000-000000000462'::uuid,
  '00000000-0000-4000-8000-000000000463'::uuid,
  '00000000-0000-4000-8000-000000000464'::uuid
)
ON CONFLICT (draft_id, revision) DO NOTHING;

COMMENT ON TABLE control.agent_studio_agents IS
  'Agent Studio P1 portfolio identities. Every item remains a non-runnable draft.';

COMMENT ON TABLE control.agent_studio_drafts IS
  'Current mutable authoring definitions protected by expected-revision CAS.';

COMMENT ON TABLE agent_center.agent_studio_draft_versions IS
  'Append-only snapshots of every Agent Studio draft revision.';

COMMENT ON TABLE control.agent_compiled_artifacts IS
  'Immutable P1 static compile artifacts. They grant no run, release or deployment capability.';
