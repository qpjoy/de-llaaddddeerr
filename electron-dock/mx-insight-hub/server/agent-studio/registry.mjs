import { z } from 'zod'
import { canonicalizeJson, sha256Json } from './contracts.mjs'

export const NODE_REGISTRY_VERSION = 'mx-insight-agent-studio-p1-v1'

const EmptyConfig = z.object({}).strict()
const SourceInputConfig = z.object({
  sourceRef: z.enum([
    'source://hub/public-opinion.province.v1',
    'source://planned/enterprise-registry.v1',
    'source://planned/news-feed.v1',
    'source://planned/search-results.v1',
  ]),
}).strict()
const MappingValidationConfig = z.object({
  requiredFields: z.array(z.enum([
    'externalId', 'title', 'body', 'author', 'eventTime', 'sourceUrl',
  ])).min(1).max(6).refine(
    (fields) => new Set(fields).size === fields.length,
    { message: 'requiredFields must not contain duplicates' },
  ),
}).strict()
const SourceRouteConfig = z.object({
  sourceKind: z.enum(['postgresql', 'file', 'sqlite-api']),
}).strict()
const MappingProposalConfig = z.object({
  sequenceKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  systemPrompt: z.string().trim().min(1).max(4_000),
  taskTemplate: z.string().trim().min(1).max(8_000),
  targetSchemaRef: z.literal('schema://hub/canonical-content.v1'),
  temperature: z.number().min(0).max(1),
  maxOutputTokens: z.number().int().min(1).max(8_000),
}).strict()
const RetrievalConfig = z.object({
  datasetRef: z.enum([
    'dataset://hub/canonical-content.v1',
    'dataset://public-opinion/current',
  ]),
  profileRef: z.enum([
    'search-profile://canonical.balanced.v1',
    'search-profile://canonical.strict.v1',
  ]),
  topK: z.number().int().min(1).max(50),
}).strict()
const StructuredAnswerConfig = z.object({
  sequenceKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  promptTemplate: z.string().trim().min(1).max(8_000),
  outputSchemaRef: z.literal('schema://hub/agent-output/grounded-answer.v1'),
  temperature: z.number().min(0).max(1),
  maxOutputTokens: z.number().int().min(1).max(8_000),
}).strict()

const manifest = (value) => Object.freeze({
  availability: 'compile-only',
  runtimeAvailable: false,
  availableFrom: 'P2',
  ...value,
})

const REGISTRY = Object.freeze([
  manifest({
    nodeType: 'core.input.query',
    nodeVersion: '1.0.0',
    displayName: 'Query Input',
    family: 'input-output',
    effect: 'none',
    determinism: 'deterministic',
    entry: true,
    terminal: false,
    inputPorts: [],
    outputPorts: [{ key: 'query', type: 'text/query', required: true }],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'core.input.source',
    nodeVersion: '1.0.0',
    displayName: 'Governed Source Input',
    family: 'input-output',
    effect: 'none',
    determinism: 'deterministic',
    entry: true,
    terminal: false,
    inputPorts: [],
    outputPorts: [{ key: 'source', type: 'source/ref', required: true }],
    configSchema: SourceInputConfig,
    configSpec: {
      additionalProperties: false,
      fields: [{
        key: 'sourceRef',
        type: 'enum',
        values: SourceInputConfig.shape.sourceRef.options,
      }],
    },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'core.text.normalize',
    nodeVersion: '1.0.0',
    displayName: 'Normalize Text',
    family: 'transform',
    effect: 'none',
    determinism: 'deterministic',
    entry: false,
    terminal: false,
    inputPorts: [{ key: 'query', type: 'text/query', required: true }],
    outputPorts: [{ key: 'query', type: 'text/query', required: true }],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'core.route.intent',
    nodeVersion: '1.0.0',
    displayName: 'Intent Route',
    family: 'route',
    effect: 'none',
    determinism: 'deterministic',
    entry: false,
    terminal: false,
    inputPorts: [{ key: 'query', type: 'text/query', required: true }],
    outputPorts: [
      { key: 'knowledge', type: 'text/query', required: false },
      { key: 'clarify', type: 'text/query', required: false },
    ],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'core.route.source',
    nodeVersion: '1.0.0',
    displayName: 'Source Contract Route',
    family: 'route',
    effect: 'none',
    determinism: 'deterministic',
    entry: false,
    terminal: false,
    inputPorts: [{ key: 'source', type: 'source/ref', required: true }],
    outputPorts: [
      { key: 'postgresql', type: 'source/ref', required: false },
      { key: 'file', type: 'source/ref', required: false },
      { key: 'sqliteApi', type: 'source/ref', required: false },
    ],
    configSchema: SourceRouteConfig,
    configSpec: {
      additionalProperties: false,
      fields: [{
        key: 'sourceKind',
        type: 'enum',
        values: ['postgresql', 'file', 'sqlite-api'],
      }],
    },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'hub.retrieval.hybrid',
    nodeVersion: '1.0.0',
    displayName: 'Hub Hybrid Retrieval',
    family: 'read-only-tool',
    effect: 'read',
    determinism: 'external',
    entry: false,
    terminal: false,
    inputPorts: [{ key: 'query', type: 'text/query', required: true }],
    outputPorts: [{ key: 'evidence', type: 'evidence/set', required: true }],
    configSchema: RetrievalConfig,
    configSpec: {
      additionalProperties: false,
      fields: [
        { key: 'datasetRef', type: 'enum', values: RetrievalConfig.shape.datasetRef.options },
        { key: 'profileRef', type: 'enum', values: RetrievalConfig.shape.profileRef.options },
        { key: 'topK', type: 'integer', minimum: 1, maximum: 50 },
      ],
    },
    budgetClass: 'tool',
  }),
  manifest({
    nodeType: 'hub.source.describe',
    nodeVersion: '1.0.0',
    displayName: 'Describe Governed Source',
    family: 'read-only-tool',
    effect: 'read',
    determinism: 'external',
    entry: false,
    terminal: false,
    inputPorts: [{ key: 'source', type: 'source/ref', required: true }],
    outputPorts: [{ key: 'contract', type: 'source/contract', required: true }],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'tool',
  }),
  manifest({
    nodeType: 'hub.schema.profile',
    nodeVersion: '1.0.0',
    displayName: 'Profile Source Schema',
    family: 'read-only-tool',
    effect: 'read',
    determinism: 'external',
    entry: false,
    terminal: false,
    inputPorts: [
      { key: 'source', type: 'source/ref', required: false },
      { key: 'contract', type: 'source/contract', required: false },
    ],
    outputPorts: [{ key: 'profile', type: 'schema/profile', required: true }],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'tool',
  }),
  manifest({
    nodeType: 'hub.mapping.validate',
    nodeVersion: '1.0.0',
    displayName: 'Validate Mapping Contract',
    family: 'transform',
    effect: 'none',
    determinism: 'deterministic',
    entry: false,
    terminal: false,
    inputPorts: [
      { key: 'profile', type: 'schema/profile', required: true },
      { key: 'proposal', type: 'mapping/proposal', required: true },
    ],
    outputPorts: [{ key: 'validated', type: 'mapping/proposal-validated', required: true }],
    configSchema: MappingValidationConfig,
    configSpec: {
      additionalProperties: false,
      fields: [{
        key: 'requiredFields',
        type: 'enum[]',
        values: ['externalId', 'title', 'body', 'author', 'eventTime', 'sourceUrl'],
        minimumItems: 1,
        maximumItems: 6,
      }],
    },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'llm.mapping.propose',
    nodeVersion: '1.0.0',
    displayName: 'LLM Mapping Proposal',
    family: 'structured-llm',
    effect: 'none',
    determinism: 'model',
    entry: false,
    terminal: false,
    inputPorts: [{ key: 'profile', type: 'schema/profile', required: true }],
    outputPorts: [{ key: 'proposal', type: 'mapping/proposal', required: true }],
    configSchema: MappingProposalConfig,
    configSpec: {
      additionalProperties: false,
      fields: [
        { key: 'sequenceKey', type: 'key' },
        { key: 'systemPrompt', type: 'text', maximumLength: 4_000 },
        { key: 'taskTemplate', type: 'text', maximumLength: 8_000 },
        { key: 'targetSchemaRef', type: 'enum', values: ['schema://hub/canonical-content.v1'] },
        { key: 'temperature', type: 'number', minimum: 0, maximum: 1 },
        { key: 'maxOutputTokens', type: 'integer', minimum: 1, maximum: 8_000 },
      ],
    },
    budgetClass: 'model',
  }),
  manifest({
    nodeType: 'core.review.mapping-required',
    nodeVersion: '1.0.0',
    displayName: 'Human Mapping Review Boundary',
    family: 'human-review-boundary',
    effect: 'none',
    determinism: 'external',
    entry: false,
    terminal: false,
    approvalClass: 'human-required',
    inputPorts: [{ key: 'validated', type: 'mapping/proposal-validated', required: true }],
    outputPorts: [{ key: 'candidate', type: 'mapping/proposal-reviewed', required: true }],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'llm.structured.answer',
    nodeVersion: '1.0.0',
    displayName: 'Structured Grounded Answer',
    family: 'structured-llm',
    effect: 'none',
    determinism: 'model',
    entry: false,
    terminal: false,
    inputPorts: [
      { key: 'query', type: 'text/query', required: true },
      { key: 'evidence', type: 'evidence/set', required: true },
    ],
    outputPorts: [{ key: 'answer', type: 'grounded-answer', required: true }],
    configSchema: StructuredAnswerConfig,
    configSpec: {
      additionalProperties: false,
      fields: [
        { key: 'sequenceKey', type: 'key' },
        { key: 'promptTemplate', type: 'text', maximumLength: 8_000 },
        { key: 'outputSchemaRef', type: 'enum', values: ['schema://hub/agent-output/grounded-answer.v1'] },
        { key: 'temperature', type: 'number', minimum: 0, maximum: 1 },
        { key: 'maxOutputTokens', type: 'integer', minimum: 1, maximum: 8_000 },
      ],
    },
    budgetClass: 'model',
  }),
  manifest({
    nodeType: 'core.output.grounded',
    nodeVersion: '1.0.0',
    displayName: 'Grounded Answer Output',
    family: 'input-output',
    effect: 'none',
    determinism: 'deterministic',
    entry: false,
    terminal: true,
    inputPorts: [{ key: 'answer', type: 'grounded-answer', required: true }],
    outputPorts: [],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'core.output.clarification',
    nodeVersion: '1.0.0',
    displayName: 'Clarification Output',
    family: 'input-output',
    effect: 'none',
    determinism: 'deterministic',
    entry: false,
    terminal: true,
    inputPorts: [{ key: 'query', type: 'text/query', required: true }],
    outputPorts: [],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'node',
  }),
  manifest({
    nodeType: 'core.output.mapping',
    nodeVersion: '1.0.0',
    displayName: 'Mapping Validation Output',
    family: 'input-output',
    effect: 'none',
    determinism: 'deterministic',
    entry: false,
    terminal: true,
    inputPorts: [{ key: 'mappingProposal', type: 'mapping/proposal-reviewed', required: true }],
    outputPorts: [],
    configSchema: EmptyConfig,
    configSpec: { additionalProperties: false, fields: [] },
    budgetClass: 'node',
  }),
])

const registryByKey = new Map(REGISTRY.map((item) => [`${item.nodeType}@${item.nodeVersion}`, item]))

function publicManifest(item) {
  return canonicalizeJson({
    nodeType: item.nodeType,
    nodeVersion: item.nodeVersion,
    displayName: item.displayName,
    family: item.family,
    effect: item.effect,
    determinism: item.determinism,
    entry: item.entry,
    terminal: item.terminal,
    inputPorts: item.inputPorts,
    outputPorts: item.outputPorts,
    configSpec: item.configSpec,
    availability: item.availability,
    runtimeAvailable: item.runtimeAvailable,
    availableFrom: item.availableFrom,
    ...(item.approvalClass ? { approvalClass: item.approvalClass } : {}),
  })
}

export function listNodeTypes() {
  return {
    registryVersion: NODE_REGISTRY_VERSION,
    items: REGISTRY.map((item) => ({
      ...publicManifest(item),
      manifestHash: sha256Json(publicManifest(item)),
    })),
    execution: {
      status: 'unavailable',
      reason: 'P1 provides authoring and static compilation only',
      availableFrom: 'P2',
    },
  }
}

export function resolveNodeType(nodeType, nodeVersion) {
  return registryByKey.get(`${nodeType}@${nodeVersion}`) || null
}

export function nodeManifestDependency(item) {
  const value = publicManifest(item)
  return {
    nodeType: item.nodeType,
    nodeVersion: item.nodeVersion,
    manifestHash: sha256Json(value),
  }
}
