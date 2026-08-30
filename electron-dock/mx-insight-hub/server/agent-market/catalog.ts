import { z } from 'zod'
import { ADVANCED_SEARCH_AGENT_KEY } from '../../agent-market/advanced-search/schemas.ts'

export const ADVANCED_SEARCH_CATALOG_AGENT_KEY = 'advanced-search'
export const KNOWLEDGE_QA_CATALOG_AGENT_KEY = 'knowledge-qa'
export const ADVANCED_SEARCH_EXECUTOR_KEY = ADVANCED_SEARCH_AGENT_KEY
const RESERVED_CATALOG_KEYS = new Set(['catalog', 'categories', 'agents'])

export const AgentMarketCategoryKeySchema = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .refine((value) => !RESERVED_CATALOG_KEYS.has(value), { message: 'key is reserved by the Agent Market API' })
export const AgentMarketCatalogAgentKeySchema = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
  .refine((value) => !RESERVED_CATALOG_KEYS.has(value), { message: 'key is reserved by the Agent Market API' })

const DisplayNameSchema = z.string().trim().min(1).max(120)
const DescriptionSchema = z.string().trim().max(1_000)
const SortOrderSchema = z.number().int().min(-10_000).max(10_000)
const ExpectedRevisionSchema = z.number().int().min(0)
export const AgentMarketTagsSchema = z.array(z.string().trim().min(1).max(40)).max(12).refine(
  (tags) => new Set(tags).size === tags.length,
  { message: 'tags must not contain duplicates' },
)

// An executor key is a server-owned adapter name, never a URL, package name or
// user-provided module path. Extending this list requires shipping code first.
export const AgentMarketExecutorKeySchema = z.literal(ADVANCED_SEARCH_EXECUTOR_KEY)

export const AgentMarketCategoryCreateSchema = z.object({
  categoryKey: AgentMarketCategoryKeySchema,
  name: DisplayNameSchema,
  description: DescriptionSchema.default(''),
  sortOrder: SortOrderSchema.default(0),
}).strict()

export const AgentMarketCategoryUpdateSchema = z.object({
  expectedRevision: ExpectedRevisionSchema,
  name: DisplayNameSchema.optional(),
  description: DescriptionSchema.optional(),
  sortOrder: SortOrderSchema.optional(),
}).strict().refine(
  (value) => value.name !== undefined
    || value.description !== undefined
    || value.sortOrder !== undefined,
  { message: 'at least one category field must be updated' },
)

export const AgentMarketCategoryDeleteSchema = z.object({
  expectedRevision: ExpectedRevisionSchema,
}).strict()

export const AgentMarketCatalogAgentCreateSchema = z.object({
  agentKey: AgentMarketCatalogAgentKeySchema,
  categoryKey: AgentMarketCategoryKeySchema,
  name: DisplayNameSchema,
  summary: DescriptionSchema.default(''),
  tags: AgentMarketTagsSchema.default([]),
  lifecycle: z.literal('draft').default('draft'),
  sortOrder: SortOrderSchema.default(0),
}).strict()

export const AgentMarketCatalogAgentUpdateSchema = z.object({
  expectedRevision: ExpectedRevisionSchema,
  categoryKey: AgentMarketCategoryKeySchema.optional(),
  name: DisplayNameSchema.optional(),
  summary: DescriptionSchema.optional(),
  tags: AgentMarketTagsSchema.optional(),
  lifecycle: z.enum(['published', 'draft', 'disabled']).optional(),
  sortOrder: SortOrderSchema.optional(),
}).strict().refine(
  (value) => value.categoryKey !== undefined
    || value.name !== undefined
    || value.summary !== undefined
    || value.tags !== undefined
    || value.lifecycle !== undefined
    || value.sortOrder !== undefined,
  { message: 'at least one Agent field must be updated' },
)

export type AgentMarketCategory = {
  categoryKey: string
  name: string
  displayName: string
  description: string
  sortOrder: number
  systemOwned: boolean
  builtin: boolean
  revision: number
  source: 'builtin' | 'database'
  createdBy: string | null
  updatedBy: string | null
  createdAt: string | null
  updatedAt: string | null
  agentCount: number
}

export type AgentMarketCatalogAgent = {
  agentKey: string
  categoryKey: string
  name: string
  summary: string
  tags: string[]
  displayName: string
  description: string
  executorKey: string | null
  enabled: boolean
  runnable: boolean
  executionStatus: 'ready' | 'disabled' | 'executor-not-configured' | 'executor-unavailable'
  lifecycle: 'published' | 'draft' | 'disabled'
  kind: 'builtin' | 'custom'
  builtin: boolean
  dryRunOnly: boolean
  lastRun: null
  sortOrder: number
  systemOwned: boolean
  revision: number
  source: 'builtin' | 'database'
  createdBy: string | null
  updatedBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type AgentMarketCatalog = {
  source: 'builtin' | 'database'
  categories: AgentMarketCategory[]
  agents: AgentMarketCatalogAgent[]
}

export function executorAvailable(executorKey: string | null): boolean {
  return executorKey === ADVANCED_SEARCH_EXECUTOR_KEY
}

export function executionStatus(
  enabled: boolean,
  executorKey: string | null,
): AgentMarketCatalogAgent['executionStatus'] {
  if (!enabled) return 'disabled'
  if (executorKey == null) return 'executor-not-configured'
  return executorAvailable(executorKey) ? 'ready' : 'executor-unavailable'
}

export function catalogLifecycle(
  enabled: boolean,
  executorKey: string | null,
): AgentMarketCatalogAgent['lifecycle'] {
  if (!enabled) return 'disabled'
  return executorAvailable(executorKey) ? 'published' : 'draft'
}

export function builtinAgentMarketCatalog(): AgentMarketCatalog {
  const categories: AgentMarketCategory[] = [
    {
      categoryKey: 'knowledge-qa',
      name: '知识问答',
      displayName: '知识问答',
      description: '基于可治理知识与证据的问答 Agent。',
      sortOrder: 10,
      systemOwned: true,
      builtin: true,
      revision: 0,
      source: 'builtin',
      createdBy: null,
      updatedBy: null,
      createdAt: null,
      updatedAt: null,
      agentCount: 1,
    },
    {
      categoryKey: 'demo',
      name: 'Demo Agent',
      displayName: 'Demo Agent',
      description: '用于学习、测试和展示受控 Agent 执行流程。',
      sortOrder: 20,
      systemOwned: true,
      builtin: true,
      revision: 0,
      source: 'builtin',
      createdBy: null,
      updatedBy: null,
      createdAt: null,
      updatedAt: null,
      agentCount: 1,
    },
  ]
  const agentBase = {
    enabled: true,
    sortOrder: 10,
    systemOwned: true,
    revision: 0,
    source: 'builtin' as const,
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  }
  const agents: AgentMarketCatalogAgent[] = [
    {
      ...agentBase,
      agentKey: ADVANCED_SEARCH_CATALOG_AGENT_KEY,
      categoryKey: 'demo',
      name: '进阶搜索 Agent · Dry Run',
      summary: '展示分流、改写、混合召回、RRF、纠错、地理工具、引用与 Trace。',
      tags: ['RAG', 'Hybrid Search', 'RRF'],
      displayName: '进阶搜索 Agent · Dry Run',
      description: '展示分流、改写、混合召回、RRF、纠错、地理工具、引用与 Trace。',
      executorKey: ADVANCED_SEARCH_EXECUTOR_KEY,
      runnable: true,
      executionStatus: 'ready',
      lifecycle: 'published',
      kind: 'builtin',
      builtin: true,
      dryRunOnly: true,
      lastRun: null,
    },
    {
      ...agentBase,
      agentKey: KNOWLEDGE_QA_CATALOG_AGENT_KEY,
      categoryKey: 'knowledge-qa',
      name: '知识问答 Agent',
      summary: '可管理的知识问答目录项；当前尚未配置执行器。',
      tags: ['Knowledge QA'],
      displayName: '知识问答 Agent',
      description: '可管理的知识问答目录项；当前尚未配置执行器。',
      executorKey: null,
      runnable: false,
      executionStatus: 'executor-not-configured',
      lifecycle: 'draft',
      kind: 'builtin',
      builtin: true,
      dryRunOnly: false,
      lastRun: null,
    },
  ]
  return { source: 'builtin', categories, agents }
}
