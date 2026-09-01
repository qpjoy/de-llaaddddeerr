import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import {
  AgentDraftDefinitionSchema,
  AgentKeySchema,
  ArtifactIdSchema,
  CompileRequestSchema,
  DraftCreateSchema,
  DraftIdSchema,
  DraftUpdateSchema,
  ProjectCreateSchema,
  ProjectUpdateSchema,
  definitionHash,
  parseInput,
} from './contracts.mjs'
import {
  AGENT_STUDIO_COMPILER_VERSION,
  compileAgentDraft,
} from './compiler.mjs'
import { NODE_REGISTRY_VERSION } from './registry.mjs'
import { templateDefinition } from './templates.mjs'

const PROJECT_SELECT = `
  SELECT a.agent_key, a.display_name, a.summary, a.owner, a.project_kind,
         a.data_scope, a.risk_class, a.tags, a.archived, a.lifecycle, a.revision,
         a.created_by, a.updated_by, a.created_at, a.updated_at,
         d.draft_id, d.current_revision AS draft_revision,
         d.updated_at AS draft_updated_at,
         artifact.artifact_id, artifact.artifact_hash,
         artifact.diagnostics AS artifact_diagnostics,
         artifact.created_at AS artifact_created_at
    FROM control.agent_studio_agents a
    LEFT JOIN LATERAL (
      SELECT current_draft.draft_id, current_draft.current_revision,
             current_draft.updated_at
        FROM control.agent_studio_drafts current_draft
       WHERE current_draft.agent_key = a.agent_key
       ORDER BY current_draft.updated_at DESC, current_draft.draft_id
       LIMIT 1
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT compiled.artifact_id, compiled.artifact_hash,
             compiled.diagnostics, compiled.created_at
        FROM control.agent_compiled_artifacts compiled
       WHERE compiled.agent_key = a.agent_key
         AND compiled.draft_id = d.draft_id
         AND compiled.draft_revision = d.current_revision
       ORDER BY compiled.draft_revision DESC, compiled.created_at DESC,
                compiled.artifact_id
       LIMIT 1
    ) artifact ON true`

const P1_EXECUTION = Object.freeze({
  runnable: false,
  status: 'unavailable',
  phase: 'P1',
  reason: 'P1 supports authoring and static compilation only',
  sandbox: 'unavailable',
  evaluation: 'unavailable',
  release: 'unavailable',
  deployment: 'unavailable',
  availableFrom: 'P2',
})

function executionState() {
  return { ...P1_EXECUTION }
}

function asIso(value) {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function asJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function storedDefinition(value) {
  const parsed = AgentDraftDefinitionSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppError(
      500,
      'agent_studio_definition_invalid',
      'The stored Agent Studio definition does not match its code-owned contract',
    )
  }
  return parsed.data
}

function projectKey(value) {
  return parseInput(
    AgentKeySchema,
    value,
    'invalid_agent_studio_agent_key',
    'The Agent Studio project key is invalid',
  )
}

function draftKey(value) {
  return parseInput(
    DraftIdSchema,
    value,
    'invalid_agent_studio_draft_id',
    'The Agent Studio draft ID is invalid',
  )
}

function artifactKey(value) {
  return parseInput(
    ArtifactIdSchema,
    value,
    'invalid_agent_studio_artifact_id',
    'The Agent Studio artifact ID is invalid',
  )
}

function actor(value) {
  const normalized = String(value || 'admin-token').trim()
  if (!normalized || normalized.length > 160) {
    throw new AppError(400, 'invalid_agent_studio_actor', 'updatedBy must be between 1 and 160 characters')
  }
  return normalized
}

function diagnosticsCount(value) {
  return asJsonArray(value).filter((item) => item?.severity !== 'info').length
}

function projectSnapshot(row) {
  const tags = asJsonArray(row.tags)
  return {
    agentKey: row.agent_key,
    name: row.display_name,
    displayName: row.display_name,
    summary: row.summary,
    kind: row.project_kind,
    owner: row.owner,
    dataScope: row.data_scope,
    riskClass: row.risk_class,
    tags,
    archived: Boolean(row.archived),
    lifecycle: row.lifecycle,
    revision: Number(row.revision),
    draft: row.draft_id
      ? {
          draftId: row.draft_id,
          revision: Number(row.draft_revision),
          saved: true,
          updatedAt: asIso(row.draft_updated_at),
        }
      : null,
    artifact: row.artifact_id
      ? {
          artifactId: row.artifact_id,
          artifactHash: row.artifact_hash,
          status: diagnosticsCount(row.artifact_diagnostics) > 0 ? 'warnings' : 'valid',
          diagnosticCount: diagnosticsCount(row.artifact_diagnostics),
          compiledAt: asIso(row.artifact_created_at),
        }
      : null,
    evaluation: null,
    release: null,
    deployment: null,
    compatibilityNote: 'P1 is compile-only; Sandbox, Eval, Release and Deployment are unavailable.',
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    execution: executionState(),
  }
}

function draftSnapshot(row) {
  return {
    agentKey: row.agent_key,
    draftId: row.draft_id,
    revision: Number(row.current_revision),
    definition: storedDefinition(row.definition),
    definitionHash: row.definition_hash,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    execution: executionState(),
  }
}

function artifactSnapshot(row) {
  return {
    artifactId: row.artifact_id,
    agentKey: row.agent_key,
    draftId: row.draft_id,
    draftRevision: Number(row.draft_revision),
    compilerVersion: row.compiler_version,
    nodeRegistryVersion: row.node_registry_version,
    normalizedPlan: row.normalized_plan,
    dependencyManifest: row.dependency_manifest,
    diagnostics: asJsonArray(row.diagnostics),
    artifactHash: row.artifact_hash,
    status: diagnosticsCount(row.diagnostics) > 0 ? 'warnings' : 'valid',
    compiledAt: asIso(row.created_at),
    createdBy: row.created_by,
    execution: executionState(),
  }
}

function studioStoreError(error) {
  if (error instanceof AppError) return error
  if (error?.code === '42P01' || error?.code === '3F000') {
    return new AppError(
      503,
      'agent_studio_store_unavailable',
      'Agent Studio persistence requires PostgreSQL migration 046',
    )
  }
  return error
}

async function rollback(client) {
  await client.query('ROLLBACK').catch(() => {})
}

async function advisoryLock(client, key) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`agent-studio:${key}`],
  )
}

export class AgentStudioStore {
  constructor(pool, { idFactory = randomUUID, compiler = compileAgentDraft } = {}) {
    this.pool = pool
    this.idFactory = idFactory
    this.compiler = compiler
  }

  async listProjects() {
    try {
      const result = await this.pool.query(
        `${PROJECT_SELECT}
          ORDER BY a.updated_at DESC, a.agent_key`,
      )
      return result.rows.map(projectSnapshot)
    } catch (error) {
      throw studioStoreError(error)
    }
  }

  async getProject(agentKey) {
    const key = projectKey(agentKey)
    try {
      const [projectResult, draftsResult] = await Promise.all([
        this.pool.query(`${PROJECT_SELECT} WHERE a.agent_key = $1`, [key]),
        this.pool.query(
          `SELECT agent_key, draft_id, current_revision, definition_hash,
                  created_by, updated_by, created_at, updated_at
             FROM control.agent_studio_drafts
            WHERE agent_key = $1
            ORDER BY updated_at DESC, draft_id`,
          [key],
        ),
      ])
      if (!projectResult.rows[0]) {
        throw new AppError(404, 'agent_studio_project_not_found', 'The Agent Studio project was not found')
      }
      return {
        ...projectSnapshot(projectResult.rows[0]),
        drafts: draftsResult.rows.map((row) => ({
          draftId: row.draft_id,
          revision: Number(row.current_revision),
          definitionHash: row.definition_hash,
          saved: true,
          createdBy: row.created_by,
          updatedBy: row.updated_by,
          createdAt: asIso(row.created_at),
          updatedAt: asIso(row.updated_at),
        })),
      }
    } catch (error) {
      throw studioStoreError(error)
    }
  }

  async createProject(input, { updatedBy } = {}) {
    const data = parseInput(
      ProjectCreateSchema,
      input,
      'invalid_agent_studio_project',
      'The Agent Studio project is invalid',
    )
    const author = actor(updatedBy)
    const definition = data.templateKey ? templateDefinition(data.templateKey) : null
    if (data.templateKey && !definition) {
      throw new AppError(400, 'agent_studio_template_not_found', 'The Agent Studio template was not found')
    }
    const draftId = definition ? this.idFactory() : null
    const hash = definition ? definitionHash(definition) : null
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await advisoryLock(client, `project:${data.agentKey}`)
      await client.query(
        `INSERT INTO control.agent_studio_agents (
           agent_key, display_name, summary, owner, project_kind, data_scope,
           risk_class, tags, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)`,
        [
          data.agentKey,
          data.displayName,
          data.summary,
          data.owner || author,
          definition ? 'template-derived' : 'custom',
          data.dataScope,
          data.riskClass,
          JSON.stringify(data.tags),
          author,
        ],
      )
      if (definition) {
        await client.query(
          `INSERT INTO control.agent_studio_drafts (
             draft_id, agent_key, current_revision, definition, definition_hash,
             created_by, updated_by
           ) VALUES ($1, $2, 1, $3::jsonb, $4, $5, $5)`,
          [draftId, data.agentKey, JSON.stringify(definition), hash, author],
        )
        await client.query(
          `INSERT INTO agent_center.agent_studio_draft_versions (
             draft_id, revision, definition, definition_hash, updated_by
           ) VALUES ($1, 1, $2::jsonb, $3, $4)`,
          [draftId, JSON.stringify(definition), hash, author],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await rollback(client)
      if (error?.code === '23505') {
        throw new AppError(409, 'agent_studio_project_exists', 'The Agent Studio project already exists')
      }
      throw studioStoreError(error)
    } finally {
      client.release()
    }
    const project = await this.getProject(data.agentKey)
    return {
      project,
      draft: draftId ? await this.getDraft(data.agentKey, draftId) : null,
    }
  }

  async updateProject(agentKey, input, { updatedBy } = {}) {
    const key = projectKey(agentKey)
    const data = parseInput(
      ProjectUpdateSchema,
      input,
      'invalid_agent_studio_project_update',
      'The Agent Studio project update is invalid',
    )
    const author = actor(updatedBy)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await advisoryLock(client, `project:${key}`)
      const current = await client.query(
        `SELECT revision
           FROM control.agent_studio_agents
          WHERE agent_key = $1
          FOR UPDATE`,
        [key],
      )
      if (!current.rows[0]) {
        throw new AppError(404, 'agent_studio_project_not_found', 'The Agent Studio project was not found')
      }
      const currentRevision = Number(current.rows[0].revision)
      if (currentRevision !== data.expectedRevision) {
        throw new AppError(
          409,
          'agent_studio_project_revision_conflict',
          'The Agent Studio project changed since it was loaded',
          { expectedRevision: data.expectedRevision, currentRevision },
        )
      }
      await client.query(
        `UPDATE control.agent_studio_agents
            SET display_name = COALESCE($3, display_name),
                summary = COALESCE($4, summary),
                owner = COALESCE($5, owner),
                data_scope = COALESCE($6, data_scope),
                risk_class = COALESCE($7, risk_class),
                tags = COALESCE($8::jsonb, tags),
                archived = COALESCE($9, archived),
                revision = revision + 1,
                updated_by = $10,
                updated_at = now()
          WHERE agent_key = $1 AND revision = $2`,
        [
          key,
          currentRevision,
          data.displayName ?? null,
          data.summary ?? null,
          data.owner ?? null,
          data.dataScope ?? null,
          data.riskClass ?? null,
          data.tags === undefined ? null : JSON.stringify(data.tags),
          data.archived ?? null,
          author,
        ],
      )
      await client.query('COMMIT')
    } catch (error) {
      await rollback(client)
      throw studioStoreError(error)
    } finally {
      client.release()
    }
    return this.getProject(key)
  }

  async createDraft(agentKey, input, { updatedBy } = {}) {
    const key = projectKey(agentKey)
    const data = parseInput(
      DraftCreateSchema,
      input,
      'invalid_agent_studio_draft',
      'The Agent Studio draft is invalid',
    )
    const author = actor(updatedBy)
    const definition = 'definition' in data
      ? data.definition
      : templateDefinition(data.templateKey)
    if (!definition) {
      throw new AppError(400, 'agent_studio_template_not_found', 'The Agent Studio template was not found')
    }
    const draftId = this.idFactory()
    const hash = definitionHash(definition)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await advisoryLock(client, `project:${key}`)
      const project = await client.query(
        'SELECT agent_key FROM control.agent_studio_agents WHERE agent_key = $1 FOR UPDATE',
        [key],
      )
      if (!project.rows[0]) {
        throw new AppError(404, 'agent_studio_project_not_found', 'The Agent Studio project was not found')
      }
      await client.query(
        `INSERT INTO control.agent_studio_drafts (
           draft_id, agent_key, current_revision, definition, definition_hash,
           created_by, updated_by
         ) VALUES ($1, $2, 1, $3::jsonb, $4, $5, $5)`,
        [draftId, key, JSON.stringify(definition), hash, author],
      )
      await client.query(
        `INSERT INTO agent_center.agent_studio_draft_versions (
           draft_id, revision, definition, definition_hash, updated_by
         ) VALUES ($1, 1, $2::jsonb, $3, $4)`,
        [draftId, JSON.stringify(definition), hash, author],
      )
      await client.query(
        `UPDATE control.agent_studio_agents
            SET revision = revision + 1, updated_by = $2, updated_at = now()
          WHERE agent_key = $1`,
        [key, author],
      )
      await client.query('COMMIT')
    } catch (error) {
      await rollback(client)
      throw studioStoreError(error)
    } finally {
      client.release()
    }
    return this.getDraft(key, draftId)
  }

  async getDraft(agentKey, draftId) {
    const key = projectKey(agentKey)
    const id = draftKey(draftId)
    try {
      const result = await this.pool.query(
        `SELECT agent_key, draft_id, current_revision, definition,
                definition_hash, created_by, updated_by, created_at, updated_at
           FROM control.agent_studio_drafts
          WHERE agent_key = $1 AND draft_id = $2`,
        [key, id],
      )
      if (!result.rows[0]) {
        throw new AppError(404, 'agent_studio_draft_not_found', 'The Agent Studio draft was not found')
      }
      return draftSnapshot(result.rows[0])
    } catch (error) {
      throw studioStoreError(error)
    }
  }

  async updateDraft(agentKey, draftId, input, { updatedBy } = {}) {
    const key = projectKey(agentKey)
    const id = draftKey(draftId)
    const data = parseInput(
      DraftUpdateSchema,
      input,
      'invalid_agent_studio_draft',
      'The Agent Studio draft update is invalid',
    )
    const author = actor(updatedBy)
    const hash = definitionHash(data.definition)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await advisoryLock(client, `draft:${id}`)
      const current = await client.query(
        `SELECT current_revision
           FROM control.agent_studio_drafts
          WHERE agent_key = $1 AND draft_id = $2
          FOR UPDATE`,
        [key, id],
      )
      if (!current.rows[0]) {
        throw new AppError(404, 'agent_studio_draft_not_found', 'The Agent Studio draft was not found')
      }
      const currentRevision = Number(current.rows[0].current_revision)
      if (currentRevision !== data.expectedRevision) {
        throw new AppError(
          409,
          'agent_studio_revision_conflict',
          'The Agent Studio draft changed since it was loaded',
          { expectedRevision: data.expectedRevision, currentRevision },
        )
      }
      const nextRevision = currentRevision + 1
      await client.query(
        `UPDATE control.agent_studio_drafts
            SET current_revision = $3, definition = $4::jsonb,
                definition_hash = $5, updated_by = $6, updated_at = now()
          WHERE agent_key = $1 AND draft_id = $2`,
        [key, id, nextRevision, JSON.stringify(data.definition), hash, author],
      )
      await client.query(
        `INSERT INTO agent_center.agent_studio_draft_versions (
           draft_id, revision, definition, definition_hash, updated_by
         ) VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [id, nextRevision, JSON.stringify(data.definition), hash, author],
      )
      await client.query(
        `UPDATE control.agent_studio_agents
            SET revision = revision + 1, updated_by = $2, updated_at = now()
          WHERE agent_key = $1`,
        [key, author],
      )
      await client.query('COMMIT')
    } catch (error) {
      await rollback(client)
      throw studioStoreError(error)
    } finally {
      client.release()
    }
    return this.getDraft(key, id)
  }

  async compileDraft(agentKey, draftId, input, { updatedBy } = {}) {
    const key = projectKey(agentKey)
    const id = draftKey(draftId)
    const data = parseInput(
      CompileRequestSchema,
      input,
      'invalid_agent_studio_compile_request',
      'The Agent Studio compile request is invalid',
    )
    const author = actor(updatedBy)
    const client = await this.pool.connect()
    let compiled
    let artifact
    let reused = false
    try {
      await client.query('BEGIN')
      const current = await client.query(
        `SELECT current_revision, definition
           FROM control.agent_studio_drafts
          WHERE agent_key = $1 AND draft_id = $2
          FOR SHARE`,
        [key, id],
      )
      if (!current.rows[0]) {
        throw new AppError(404, 'agent_studio_draft_not_found', 'The Agent Studio draft was not found')
      }
      const currentRevision = Number(current.rows[0].current_revision)
      if (currentRevision !== data.expectedRevision) {
        throw new AppError(
          409,
          'agent_studio_revision_conflict',
          'The Agent Studio draft changed before compilation',
          { expectedRevision: data.expectedRevision, currentRevision },
        )
      }
      compiled = this.compiler(storedDefinition(current.rows[0].definition))
      if (!compiled.valid) {
        throw new AppError(
          422,
          'agent_studio_compile_failed',
          'The Agent Studio graph did not pass static compilation',
          { diagnostics: compiled.diagnostics, assurance: compiled.assurance },
        )
      }
      const artifactId = this.idFactory()
      const inserted = await client.query(
        `INSERT INTO control.agent_compiled_artifacts (
           artifact_id, agent_key, draft_id, draft_revision,
           compiler_version, node_registry_version, normalized_plan,
           dependency_manifest, diagnostics, artifact_hash, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
                   $9::jsonb, $10, $11)
         ON CONFLICT (draft_id, draft_revision, artifact_hash) DO NOTHING
         RETURNING artifact_id, agent_key, draft_id, draft_revision,
                   compiler_version, node_registry_version, normalized_plan,
                   dependency_manifest, diagnostics, artifact_hash, created_by,
                   created_at`,
        [
          artifactId,
          key,
          id,
          currentRevision,
          AGENT_STUDIO_COMPILER_VERSION,
          NODE_REGISTRY_VERSION,
          JSON.stringify(compiled.normalizedPlan),
          JSON.stringify(compiled.dependencyManifest),
          JSON.stringify(compiled.diagnostics),
          compiled.artifactHash,
          author,
        ],
      )
      if (inserted.rows[0]) {
        artifact = inserted.rows[0]
      } else {
        reused = true
        const existing = await client.query(
          `SELECT artifact_id, agent_key, draft_id, draft_revision,
                  compiler_version, node_registry_version, normalized_plan,
                  dependency_manifest, diagnostics, artifact_hash, created_by,
                  created_at
             FROM control.agent_compiled_artifacts
            WHERE draft_id = $1 AND draft_revision = $2 AND artifact_hash = $3`,
          [id, currentRevision, compiled.artifactHash],
        )
        artifact = existing.rows[0]
      }
      await client.query('COMMIT')
    } catch (error) {
      await rollback(client)
      throw studioStoreError(error)
    } finally {
      client.release()
    }
    const snapshot = artifactSnapshot(artifact)
    return {
      ...snapshot,
      summary: compiled.summary,
      reused,
    }
  }

  async getArtifact(agentKey, artifactId, draftId = null) {
    const key = projectKey(agentKey)
    const id = artifactKey(artifactId)
    const draft = draftId == null ? null : draftKey(draftId)
    try {
      const result = await this.pool.query(
        `SELECT artifact_id, agent_key, draft_id, draft_revision,
                compiler_version, node_registry_version, normalized_plan,
                dependency_manifest, diagnostics, artifact_hash, created_by,
                created_at
           FROM control.agent_compiled_artifacts
          WHERE agent_key = $1 AND artifact_id = $2
            AND ($3::uuid IS NULL OR draft_id = $3)`,
        [key, id, draft],
      )
      if (!result.rows[0]) {
        throw new AppError(404, 'agent_studio_artifact_not_found', 'The Agent Studio artifact was not found')
      }
      return artifactSnapshot(result.rows[0])
    } catch (error) {
      throw studioStoreError(error)
    }
  }
}

export function agentStudioExecutionState() {
  return executionState()
}
