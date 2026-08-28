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

type AgentMarketRow = {
  agent_key: string
  revision: string | number
  schema_version: number
  definition: unknown
  updated_by: string
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
