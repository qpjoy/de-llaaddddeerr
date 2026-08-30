import type { Pool, PoolClient } from 'pg'
import { AppError } from '../core/errors.mjs'
import {
  ADVANCED_SEARCH_AGENT_KEY,
  AdvancedSearchDefinitionSchema,
  AdvancedSearchSaveRequestSchema,
  type AdvancedSearchDefinition,
} from '../../agent-market/advanced-search/schemas.ts'
import {
  freshAdvancedSearchDefinition,
} from '../../agent-market/advanced-search/manifest.ts'
import {
  AgentMarketCatalogAgentCreateSchema,
  AgentMarketCatalogAgentKeySchema,
  AgentMarketCatalogAgentUpdateSchema,
  AgentMarketTagsSchema,
  AgentMarketCategoryCreateSchema,
  AgentMarketCategoryDeleteSchema,
  AgentMarketCategoryKeySchema,
  AgentMarketCategoryUpdateSchema,
  builtinAgentMarketCatalog,
  catalogLifecycle,
  executionStatus,
  type AgentMarketCatalog,
  type AgentMarketCatalogAgent,
  type AgentMarketCategory,
} from './catalog.ts'

type AgentMarketRow = {
  agent_key: string
  revision: string | number
  schema_version: number
  definition: unknown
  updated_by: string
  updated_at: Date | string
}

type AgentMarketCategoryRow = {
  category_key: string
  display_name: string
  description: string
  sort_order: number
  system_owned: boolean
  revision: string | number
  created_by: string
  updated_by: string
  created_at: Date | string
  updated_at: Date | string
}

type AgentMarketCatalogRow = {
  agent_key: string
  category_key: string
  display_name: string
  description: string
  tags: unknown
  executor_key: string | null
  enabled: boolean
  sort_order: number
  system_owned: boolean
  revision: string | number
  created_by: string
  updated_by: string
  created_at: Date | string
  updated_at: Date | string
}

export type AgentMarketSnapshot = {
  agentKey: string
  revision: number
  source: 'builtin' | 'database'
  definition: AdvancedSearchDefinition
  updatedBy: string | null
  updatedAt: string | null
}

function asIso(value: Date | string | null): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseStoredDefinition(value: unknown): AdvancedSearchDefinition {
  const parsed = AdvancedSearchDefinitionSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppError(
      500,
      'agent_market_definition_invalid',
      'The stored Agent Market definition does not match its code-owned schema',
    )
  }
  return parsed.data
}

export function builtinAdvancedSearchSnapshot(): AgentMarketSnapshot {
  return {
    agentKey: ADVANCED_SEARCH_AGENT_KEY,
    revision: 0,
    source: 'builtin',
    definition: freshAdvancedSearchDefinition(),
    updatedBy: null,
    updatedAt: null,
  }
}

function databaseSnapshot(row: AgentMarketRow): AgentMarketSnapshot {
  return {
    agentKey: row.agent_key,
    revision: Number(row.revision),
    source: 'database',
    definition: parseStoredDefinition(row.definition),
    updatedBy: row.updated_by,
    updatedAt: asIso(row.updated_at),
  }
}

function databaseCategory(row: AgentMarketCategoryRow, agentCount = 0): AgentMarketCategory {
  return {
    categoryKey: row.category_key,
    name: row.display_name,
    displayName: row.display_name,
    description: row.description,
    sortOrder: Number(row.sort_order),
    systemOwned: row.system_owned,
    builtin: row.system_owned,
    revision: Number(row.revision),
    source: 'database',
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    agentCount,
  }
}

function databaseCatalogAgent(row: AgentMarketCatalogRow): AgentMarketCatalogAgent {
  const status = executionStatus(row.enabled, row.executor_key)
  const tags = AgentMarketTagsSchema.safeParse(row.tags)
  if (!tags.success) {
    throw new AppError(
      500,
      'agent_market_catalog_invalid',
      'The stored Agent Market catalog metadata does not match its code-owned schema',
    )
  }
  return {
    agentKey: row.agent_key,
    categoryKey: row.category_key,
    name: row.display_name,
    summary: row.description,
    tags: tags.data,
    displayName: row.display_name,
    description: row.description,
    executorKey: row.executor_key,
    enabled: row.enabled,
    runnable: status === 'ready',
    executionStatus: status,
    lifecycle: catalogLifecycle(row.enabled, row.executor_key),
    kind: row.system_owned ? 'builtin' : 'custom',
    builtin: row.system_owned,
    dryRunOnly: row.executor_key != null,
    lastRun: null,
    sortOrder: Number(row.sort_order),
    systemOwned: row.system_owned,
    revision: Number(row.revision),
    source: 'database',
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  }
}

function catalogRelationMissing(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  return code === '42P01' || code === '3F000'
}

function catalogWriteError(error: unknown): unknown {
  if (!catalogRelationMissing(error)) return error
  return new AppError(
    503,
    'agent_market_store_unavailable',
    'Managing Agent Market items requires migration 045 and PostgreSQL',
  )
}

function validationIssues(error: { issues: Array<{ path: PropertyKey[], message: string }> }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

function invalidCatalogInput(
  code: string,
  message: string,
  error: { issues: Array<{ path: PropertyKey[], message: string }> },
): never {
  throw new AppError(400, code, message, { issues: validationIssues(error) })
}

function categoryKey(value: string): string {
  const parsed = AgentMarketCategoryKeySchema.safeParse(value)
  if (!parsed.success) {
    invalidCatalogInput('invalid_agent_market_category', 'The Agent Market category key is invalid', parsed.error)
  }
  return parsed.data
}

function catalogAgentKey(value: string): string {
  const parsed = AgentMarketCatalogAgentKeySchema.safeParse(value)
  if (!parsed.success) {
    invalidCatalogInput('invalid_agent_market_catalog_agent', 'The Agent Market Agent key is invalid', parsed.error)
  }
  return parsed.data
}

async function lockCatalogKey(
  client: PoolClient,
  kind: 'category' | 'agent',
  key: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`agent-market-${kind}:${key}`],
  )
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => {})
}

export class AgentMarketStore {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async getAgent(agentKey: string): Promise<AgentMarketSnapshot> {
    if (agentKey !== ADVANCED_SEARCH_AGENT_KEY) {
      throw new AppError(404, 'agent_market_not_found', 'The Agent Market item was not found')
    }
    const result = await this.pool.query<AgentMarketRow>(
      `SELECT agent_key, revision, schema_version, definition, updated_by, updated_at
         FROM control.agent_market_agents
        WHERE agent_key = $1`,
      [agentKey],
    )
    return result.rows[0] ? databaseSnapshot(result.rows[0]) : builtinAdvancedSearchSnapshot()
  }

  async listAgents(): Promise<Array<AgentMarketSnapshot & {
    activeStages: number
    trashedStages: number
  }>> {
    const snapshot = await this.getAgent(ADVANCED_SEARCH_AGENT_KEY)
    return [{
      ...snapshot,
      activeStages: snapshot.definition.stages.filter((stage) => stage.state === 'active').length,
      trashedStages: snapshot.definition.stages.filter((stage) => stage.state === 'trashed').length,
    }]
  }

  async listCatalog(): Promise<AgentMarketCatalog> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const categoryResult = await client.query<AgentMarketCategoryRow>(
        `SELECT category_key, display_name, description, sort_order, system_owned,
                revision, created_by, updated_by, created_at, updated_at
           FROM control.agent_market_categories
          ORDER BY sort_order, display_name, category_key`,
      )
      const agentResult = await client.query<AgentMarketCatalogRow>(
        `SELECT agent_key, category_key, display_name, description, tags, executor_key,
                enabled, sort_order, system_owned, revision,
                created_by, updated_by, created_at, updated_at
           FROM control.agent_market_catalog
          ORDER BY sort_order, display_name, agent_key`,
      )
      await client.query('COMMIT')
      if (categoryResult.rows.length === 0 && agentResult.rows.length === 0) {
        return builtinAgentMarketCatalog()
      }
      const counts = new Map<string, number>()
      for (const row of agentResult.rows) {
        counts.set(row.category_key, (counts.get(row.category_key) || 0) + 1)
      }
      return {
        source: 'database',
        categories: categoryResult.rows.map((row) => databaseCategory(row, counts.get(row.category_key) || 0)),
        agents: agentResult.rows.map(databaseCatalogAgent),
      }
    } catch (error) {
      await rollback(client)
      // Rolling deployments may briefly run new server code before migration
      // 045. Reads keep the truthful built-in directory; writes remain closed.
      if (catalogRelationMissing(error)) return builtinAgentMarketCatalog()
      throw error
    } finally {
      client.release()
    }
  }

  async createCategory(
    input: unknown,
    { updatedBy }: { updatedBy: string },
  ): Promise<AgentMarketCategory> {
    const parsed = AgentMarketCategoryCreateSchema.safeParse(input)
    if (!parsed.success) {
      invalidCatalogInput('invalid_agent_market_category', 'The Agent Market category is invalid', parsed.error)
    }
    const value = parsed.data
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockCatalogKey(client, 'category', value.categoryKey)
      const existing = await client.query(
        'SELECT 1 FROM control.agent_market_categories WHERE category_key = $1',
        [value.categoryKey],
      )
      if (existing.rows[0]) {
        throw new AppError(409, 'agent_market_category_exists', 'The Agent Market category already exists')
      }
      const saved = await client.query<AgentMarketCategoryRow>(
        `INSERT INTO control.agent_market_categories
           (category_key, display_name, description, sort_order, system_owned,
            revision, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, false, 1, $5, $5, now(), now())
         RETURNING category_key, display_name, description, sort_order, system_owned,
                   revision, created_by, updated_by, created_at, updated_at`,
        [value.categoryKey, value.name, value.description, value.sortOrder, updatedBy],
      )
      await client.query('COMMIT')
      return databaseCategory(saved.rows[0])
    } catch (error) {
      await rollback(client)
      throw catalogWriteError(error)
    } finally {
      client.release()
    }
  }

  async updateCategory(
    rawCategoryKey: string,
    input: unknown,
    { updatedBy }: { updatedBy: string },
  ): Promise<AgentMarketCategory> {
    const key = categoryKey(rawCategoryKey)
    const parsed = AgentMarketCategoryUpdateSchema.safeParse(input)
    if (!parsed.success) {
      invalidCatalogInput('invalid_agent_market_category', 'The Agent Market category update is invalid', parsed.error)
    }
    const value = parsed.data
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockCatalogKey(client, 'category', key)
      const current = await client.query<AgentMarketCategoryRow>(
        `SELECT category_key, display_name, description, sort_order, system_owned,
                revision, created_by, updated_by, created_at, updated_at
           FROM control.agent_market_categories
          WHERE category_key = $1
          FOR UPDATE`,
        [key],
      )
      const row = current.rows[0]
      if (!row) throw new AppError(404, 'agent_market_category_not_found', 'The Agent Market category was not found')
      const revision = Number(row.revision)
      if (revision !== value.expectedRevision) {
        throw new AppError(409, 'agent_market_category_revision_conflict', 'The Agent Market category changed; reload and retry', {
          currentRevision: revision,
        })
      }
      const saved = await client.query<AgentMarketCategoryRow>(
        `UPDATE control.agent_market_categories
            SET display_name = $2,
                description = $3,
                sort_order = $4,
                revision = revision + 1,
                updated_by = $5,
                updated_at = now()
          WHERE category_key = $1
        RETURNING category_key, display_name, description, sort_order, system_owned,
                  revision, created_by, updated_by, created_at, updated_at`,
        [
          key,
          value.name ?? row.display_name,
          value.description ?? row.description,
          value.sortOrder ?? Number(row.sort_order),
          updatedBy,
        ],
      )
      const count = await client.query<{ count: string | number }>(
        'SELECT count(*)::bigint AS count FROM control.agent_market_catalog WHERE category_key = $1',
        [key],
      )
      await client.query('COMMIT')
      return databaseCategory(saved.rows[0], Number(count.rows[0]?.count || 0))
    } catch (error) {
      await rollback(client)
      throw catalogWriteError(error)
    } finally {
      client.release()
    }
  }

  async deleteCategory(rawCategoryKey: string, input: unknown): Promise<AgentMarketCategory> {
    const key = categoryKey(rawCategoryKey)
    const parsed = AgentMarketCategoryDeleteSchema.safeParse(input)
    if (!parsed.success) {
      invalidCatalogInput('invalid_agent_market_category', 'The Agent Market category delete request is invalid', parsed.error)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockCatalogKey(client, 'category', key)
      const current = await client.query<AgentMarketCategoryRow>(
        `SELECT category_key, display_name, description, sort_order, system_owned,
                revision, created_by, updated_by, created_at, updated_at
           FROM control.agent_market_categories
          WHERE category_key = $1
          FOR UPDATE`,
        [key],
      )
      const row = current.rows[0]
      if (!row) throw new AppError(404, 'agent_market_category_not_found', 'The Agent Market category was not found')
      const revision = Number(row.revision)
      if (revision !== parsed.data.expectedRevision) {
        throw new AppError(409, 'agent_market_category_revision_conflict', 'The Agent Market category changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (row.system_owned) {
        throw new AppError(409, 'agent_market_category_protected', 'Built-in Agent Market categories cannot be deleted')
      }
      const references = await client.query<{ agent_key: string }>(
        `SELECT agent_key
           FROM control.agent_market_catalog
          WHERE category_key = $1
          ORDER BY agent_key
          FOR SHARE`,
        [key],
      )
      if (references.rows.length > 0) {
        throw new AppError(409, 'agent_market_category_in_use', 'Move every Agent out of the category before deleting it', {
          agentKeys: references.rows.map((entry) => entry.agent_key),
        })
      }
      await client.query(
        'DELETE FROM control.agent_market_categories WHERE category_key = $1',
        [key],
      )
      await client.query('COMMIT')
      return databaseCategory(row)
    } catch (error) {
      await rollback(client)
      throw catalogWriteError(error)
    } finally {
      client.release()
    }
  }

  async createCatalogAgent(
    input: unknown,
    { updatedBy }: { updatedBy: string },
  ): Promise<AgentMarketCatalogAgent> {
    const parsed = AgentMarketCatalogAgentCreateSchema.safeParse(input)
    if (!parsed.success) {
      invalidCatalogInput('invalid_agent_market_catalog_agent', 'The Agent Market Agent is invalid', parsed.error)
    }
    const value = parsed.data
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockCatalogKey(client, 'agent', value.agentKey)
      const existing = await client.query(
        'SELECT 1 FROM control.agent_market_catalog WHERE agent_key = $1',
        [value.agentKey],
      )
      if (existing.rows[0]) {
        throw new AppError(409, 'agent_market_catalog_agent_exists', 'The Agent Market Agent already exists')
      }
      const category = await client.query(
        'SELECT 1 FROM control.agent_market_categories WHERE category_key = $1 FOR SHARE',
        [value.categoryKey],
      )
      if (!category.rows[0]) {
        throw new AppError(400, 'agent_market_category_not_found', 'The selected Agent Market category was not found')
      }
      const saved = await client.query<AgentMarketCatalogRow>(
        `INSERT INTO control.agent_market_catalog
           (agent_key, category_key, display_name, description, tags, executor_key,
            enabled, sort_order, system_owned, revision,
            created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, true, $6, false, 1, $7, $7, now(), now())
         RETURNING agent_key, category_key, display_name, description, tags, executor_key,
                   enabled, sort_order, system_owned, revision,
                   created_by, updated_by, created_at, updated_at`,
        [
          value.agentKey,
          value.categoryKey,
          value.name,
          value.summary,
          JSON.stringify(value.tags),
          value.sortOrder,
          updatedBy,
        ],
      )
      await client.query('COMMIT')
      return databaseCatalogAgent(saved.rows[0])
    } catch (error) {
      await rollback(client)
      throw catalogWriteError(error)
    } finally {
      client.release()
    }
  }

  async updateCatalogAgent(
    rawAgentKey: string,
    input: unknown,
    { updatedBy }: { updatedBy: string },
  ): Promise<AgentMarketCatalogAgent> {
    const key = catalogAgentKey(rawAgentKey)
    const parsed = AgentMarketCatalogAgentUpdateSchema.safeParse(input)
    if (!parsed.success) {
      invalidCatalogInput('invalid_agent_market_catalog_agent', 'The Agent Market Agent update is invalid', parsed.error)
    }
    const value = parsed.data
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockCatalogKey(client, 'agent', key)
      const current = await client.query<AgentMarketCatalogRow>(
        `SELECT agent_key, category_key, display_name, description, tags, executor_key,
                enabled, sort_order, system_owned, revision,
                created_by, updated_by, created_at, updated_at
           FROM control.agent_market_catalog
          WHERE agent_key = $1
          FOR UPDATE`,
        [key],
      )
      const row = current.rows[0]
      if (!row) throw new AppError(404, 'agent_market_catalog_agent_not_found', 'The Agent Market Agent was not found')
      const revision = Number(row.revision)
      if (revision !== value.expectedRevision) {
        throw new AppError(409, 'agent_market_catalog_agent_revision_conflict', 'The Agent Market Agent changed; reload and retry', {
          currentRevision: revision,
        })
      }
      const nextCategoryKey = value.categoryKey ?? row.category_key
      if (nextCategoryKey !== row.category_key) {
        const category = await client.query(
          'SELECT 1 FROM control.agent_market_categories WHERE category_key = $1 FOR SHARE',
          [nextCategoryKey],
        )
        if (!category.rows[0]) {
          throw new AppError(400, 'agent_market_category_not_found', 'The selected Agent Market category was not found')
        }
      }
      let nextEnabled = row.enabled
      if (value.lifecycle === 'disabled') nextEnabled = false
      if (value.lifecycle === 'draft') {
        if (row.executor_key != null) {
          throw new AppError(409, 'agent_market_lifecycle_invalid', 'An Agent with an executor is published when enabled')
        }
        nextEnabled = true
      }
      if (value.lifecycle === 'published') {
        if (executionStatus(true, row.executor_key) !== 'ready') {
          throw new AppError(409, 'agent_market_executor_unavailable', 'An Agent cannot be published until a server-owned executor is configured')
        }
        nextEnabled = true
      }
      const saved = await client.query<AgentMarketCatalogRow>(
        `UPDATE control.agent_market_catalog
            SET category_key = $2,
                display_name = $3,
                description = $4,
                tags = $5::jsonb,
                executor_key = $6,
                enabled = $7,
                sort_order = $8,
                revision = revision + 1,
                updated_by = $9,
                updated_at = now()
          WHERE agent_key = $1
        RETURNING agent_key, category_key, display_name, description, tags, executor_key,
                  enabled, sort_order, system_owned, revision,
                  created_by, updated_by, created_at, updated_at`,
        [
          key,
          nextCategoryKey,
          value.name ?? row.display_name,
          value.summary ?? row.description,
          JSON.stringify(value.tags ?? AgentMarketTagsSchema.parse(row.tags)),
          row.executor_key,
          nextEnabled,
          value.sortOrder ?? Number(row.sort_order),
          updatedBy,
        ],
      )
      await client.query('COMMIT')
      return databaseCatalogAgent(saved.rows[0])
    } catch (error) {
      await rollback(client)
      throw catalogWriteError(error)
    } finally {
      client.release()
    }
  }

  async saveAgent(
    agentKey: string,
    input: unknown,
    { updatedBy }: { updatedBy: string },
  ): Promise<AgentMarketSnapshot> {
    if (agentKey !== ADVANCED_SEARCH_AGENT_KEY) {
      throw new AppError(404, 'agent_market_not_found', 'The Agent Market item was not found')
    }
    const parsed = AdvancedSearchSaveRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new AppError(400, 'invalid_agent_market_definition', 'The Agent Market definition is invalid', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    const { definition, expectedRevision } = parsed.data
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Lock the logical key even before its first row exists. A plain SELECT
      // FOR UPDATE cannot serialize two concurrent revision-0 inserts.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [agentKey])
      const current = await client.query<Pick<AgentMarketRow, 'revision'>>(
        `SELECT revision
           FROM control.agent_market_agents
          WHERE agent_key = $1
          FOR UPDATE`,
        [agentKey],
      )
      const currentRevision = current.rows[0] ? Number(current.rows[0].revision) : 0
      if (currentRevision !== expectedRevision) {
        throw new AppError(409, 'agent_market_revision_conflict', 'The Agent Market draft changed; reload before saving', {
          expectedRevision,
          currentRevision,
        })
      }
      const nextRevision = currentRevision + 1
      const values = [
        agentKey,
        nextRevision,
        definition.schemaVersion,
        JSON.stringify(definition),
        updatedBy,
      ]
      const saved = await client.query<AgentMarketRow>(
        `INSERT INTO control.agent_market_agents
           (agent_key, revision, schema_version, definition, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (agent_key) DO UPDATE
           SET revision = EXCLUDED.revision,
               schema_version = EXCLUDED.schema_version,
               definition = EXCLUDED.definition,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
         RETURNING agent_key, revision, schema_version, definition, updated_by, updated_at`,
        values,
      )
      await client.query(
        `INSERT INTO agent_center.agent_market_versions
           (agent_key, revision, schema_version, definition, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        values,
      )
      await client.query('COMMIT')
      return databaseSnapshot(saved.rows[0])
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }
}
