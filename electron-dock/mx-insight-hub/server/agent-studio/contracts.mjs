import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../core/errors.mjs'

export const AGENT_STUDIO_DRAFT_CONTRACT = 'mx-insight.agent-draft.v1'
export const AGENT_STUDIO_ARTIFACT_CONTRACT = 'mx-insight.agent-artifact.v1'

export const AgentKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u)
export const DraftIdSchema = z.string().uuid()
export const ArtifactIdSchema = z.string().uuid()
export const NodeIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)
const NodeTypeSchema = z.string().regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u)
const SemanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u)

const GraphEndpointSchema = z.object({
  nodeId: NodeIdSchema,
  port: z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/u),
}).strict()

const GraphNodeSchema = z.object({
  nodeId: NodeIdSchema,
  nodeType: NodeTypeSchema,
  nodeVersion: SemanticVersionSchema,
  config: z.record(z.string().max(80), z.unknown()).default({}),
}).strict()

const GraphEdgeSchema = z.object({
  from: GraphEndpointSchema,
  to: GraphEndpointSchema,
}).strict()

const BudgetOverridesSchema = z.object({
  deadlineMs: z.number().int().positive().optional(),
  maxNodeAttempts: z.number().int().positive().optional(),
  maxModelCalls: z.number().int().nonnegative().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  maxLoopIterations: z.number().int().nonnegative().optional(),
  maxFanOut: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
}).strict()

const PositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict()

const UiSchema = z.object({
  positions: z.record(NodeIdSchema, PositionSchema).default({}),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().min(0.1).max(4),
  }).strict().optional(),
  groups: z.array(z.object({
    groupId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    label: z.string().trim().min(1).max(120),
    nodeIds: z.array(NodeIdSchema).max(64),
  }).strict()).max(32).default([]),
  annotations: z.array(z.object({
    annotationId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    nodeId: NodeIdSchema.optional(),
    text: z.string().trim().min(1).max(500),
  }).strict()).max(64).default([]),
}).strict()

export const AgentDraftDefinitionSchema = z.object({
  contractVersion: z.literal(AGENT_STUDIO_DRAFT_CONTRACT),
  entryNodeId: NodeIdSchema,
  terminalNodeIds: z.array(NodeIdSchema).min(1).max(16),
  nodes: z.array(GraphNodeSchema).min(1).max(64),
  edges: z.array(GraphEdgeSchema).max(128),
  budgets: BudgetOverridesSchema.optional(),
  ui: UiSchema.optional(),
}).strict()

export const ProjectCreateSchema = z.object({
  agentKey: AgentKeySchema,
  displayName: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(2_000).default(''),
  owner: z.string().trim().min(1).max(160).optional(),
  dataScope: z.string().trim().min(1).max(240).default('Hub governed data'),
  riskClass: z.enum(['low', 'medium', 'high']).default('low'),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  templateKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u).optional(),
}).strict().refine(
  (value) => new Set(value.tags).size === value.tags.length,
  { message: 'tags must not contain duplicates', path: ['tags'] },
)

export const ProjectUpdateSchema = z.object({
  expectedRevision: z.number().int().min(1),
  displayName: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(2_000).optional(),
  owner: z.string().trim().min(1).max(160).optional(),
  dataScope: z.string().trim().min(1).max(240).optional(),
  riskClass: z.enum(['low', 'medium', 'high']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  archived: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const mutableFields = [
    'displayName', 'summary', 'owner', 'dataScope', 'riskClass', 'tags', 'archived',
  ]
  if (!mutableFields.some((field) => value[field] !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'At least one project metadata field is required',
      path: [],
    })
  }
  if (value.tags && new Set(value.tags).size !== value.tags.length) {
    context.addIssue({
      code: 'custom',
      message: 'tags must not contain duplicates',
      path: ['tags'],
    })
  }
})

export const DraftCreateSchema = z.union([
  z.object({ definition: AgentDraftDefinitionSchema }).strict(),
  z.object({ templateKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u) }).strict(),
])

export const DraftUpdateSchema = z.object({
  expectedRevision: z.number().int().min(1),
  definition: AgentDraftDefinitionSchema,
}).strict()

export const CompileRequestSchema = z.object({
  expectedRevision: z.number().int().min(1),
}).strict()

export function validationIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

export function parseInput(schema, input, code, message) {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new AppError(400, code, message, { issues: validationIssues(parsed.error) })
  }
  return parsed.data
}

export function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]))
  }
  return value
}

export function stableJson(value) {
  return JSON.stringify(canonicalizeJson(value))
}

export function sha256Json(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function definitionHash(definition) {
  return sha256Json(definition)
}
