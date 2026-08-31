import { canonicalizeJson } from './contracts.mjs'

const STARTER_DEFINITION = {
  contractVersion: 'mx-insight.agent-draft.v1',
  entryNodeId: 'input',
  terminalNodeIds: ['answer', 'clarify'],
  nodes: [
    { nodeId: 'input', nodeType: 'core.input.query', nodeVersion: '1.0.0', config: {} },
    { nodeId: 'normalize', nodeType: 'core.text.normalize', nodeVersion: '1.0.0', config: {} },
    { nodeId: 'route', nodeType: 'core.route.intent', nodeVersion: '1.0.0', config: {} },
    {
      nodeId: 'retrieve',
      nodeType: 'hub.retrieval.hybrid',
      nodeVersion: '1.0.0',
      config: {
        datasetRef: 'dataset://hub/canonical-content.v1',
        profileRef: 'search-profile://canonical.balanced.v1',
        topK: 12,
      },
    },
    {
      nodeId: 'compose',
      nodeType: 'llm.structured.answer',
      nodeVersion: '1.0.0',
      config: {
        sequenceKey: 'agent-studio-default',
        promptTemplate: 'Answer the query only from the authorized evidence and preserve citations.',
        outputSchemaRef: 'schema://hub/agent-output/grounded-answer.v1',
        temperature: 0.2,
        maxOutputTokens: 2_000,
      },
    },
    { nodeId: 'answer', nodeType: 'core.output.grounded', nodeVersion: '1.0.0', config: {} },
    { nodeId: 'clarify', nodeType: 'core.output.clarification', nodeVersion: '1.0.0', config: {} },
  ],
  edges: [
    { from: { nodeId: 'input', port: 'query' }, to: { nodeId: 'normalize', port: 'query' } },
    { from: { nodeId: 'normalize', port: 'query' }, to: { nodeId: 'route', port: 'query' } },
    { from: { nodeId: 'route', port: 'knowledge' }, to: { nodeId: 'retrieve', port: 'query' } },
    { from: { nodeId: 'route', port: 'knowledge' }, to: { nodeId: 'compose', port: 'query' } },
    { from: { nodeId: 'retrieve', port: 'evidence' }, to: { nodeId: 'compose', port: 'evidence' } },
    { from: { nodeId: 'compose', port: 'answer' }, to: { nodeId: 'answer', port: 'answer' } },
    { from: { nodeId: 'route', port: 'clarify' }, to: { nodeId: 'clarify', port: 'query' } },
  ],
  budgets: {
    deadlineMs: 60_000,
    maxNodeAttempts: 24,
    maxModelCalls: 4,
    maxToolCalls: 8,
    maxLoopIterations: 0,
    maxFanOut: 4,
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxRetries: 2,
  },
  ui: {
    positions: {
      input: { x: 0, y: 140 },
      normalize: { x: 220, y: 140 },
      route: { x: 440, y: 140 },
      retrieve: { x: 680, y: 60 },
      compose: { x: 920, y: 60 },
      answer: { x: 1160, y: 60 },
      clarify: { x: 680, y: 260 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    groups: [],
    annotations: [],
  },
}

const PUBLIC_OPINION_MAPPING_DEFINITION = {
  contractVersion: 'mx-insight.agent-draft.v1',
  entryNodeId: 'source',
  terminalNodeIds: ['mapping_output'],
  nodes: [
    {
      nodeId: 'source',
      nodeType: 'core.input.source',
      nodeVersion: '1.0.0',
      config: { sourceRef: 'source://hub/public-opinion.province.v1' },
    },
    {
      nodeId: 'source_route',
      nodeType: 'core.route.source',
      nodeVersion: '1.0.0',
      config: { sourceKind: 'postgresql' },
    },
    {
      nodeId: 'schema_profile',
      nodeType: 'hub.schema.profile',
      nodeVersion: '1.0.0',
      config: {},
    },
    {
      nodeId: 'mapping_proposal',
      nodeType: 'llm.mapping.propose',
      nodeVersion: '1.0.0',
      config: {
        sequenceKey: 'public-opinion-mapping-default',
        systemPrompt: 'Propose a field mapping only. Never import, mutate, publish, or execute source-side code.',
        taskTemplate: 'Map the profiled nationwide public-opinion source columns to the governed canonical content schema. Preserve provenance and report every ambiguous field.',
        targetSchemaRef: 'schema://hub/canonical-content.v1',
        temperature: 0.1,
        maxOutputTokens: 2_000,
      },
    },
    {
      nodeId: 'mapping_validation',
      nodeType: 'hub.mapping.validate',
      nodeVersion: '1.0.0',
      config: {
        requiredFields: ['externalId', 'title', 'body', 'eventTime', 'sourceUrl'],
      },
    },
    {
      nodeId: 'human_review',
      nodeType: 'core.review.mapping-required',
      nodeVersion: '1.0.0',
      config: {},
    },
    {
      nodeId: 'mapping_output',
      nodeType: 'core.output.mapping',
      nodeVersion: '1.0.0',
      config: {},
    },
  ],
  edges: [
    { from: { nodeId: 'source', port: 'source' }, to: { nodeId: 'source_route', port: 'source' } },
    { from: { nodeId: 'source_route', port: 'postgresql' }, to: { nodeId: 'schema_profile', port: 'source' } },
    { from: { nodeId: 'schema_profile', port: 'profile' }, to: { nodeId: 'mapping_proposal', port: 'profile' } },
    { from: { nodeId: 'schema_profile', port: 'profile' }, to: { nodeId: 'mapping_validation', port: 'profile' } },
    { from: { nodeId: 'mapping_proposal', port: 'proposal' }, to: { nodeId: 'mapping_validation', port: 'proposal' } },
    { from: { nodeId: 'mapping_validation', port: 'validated' }, to: { nodeId: 'human_review', port: 'validated' } },
    { from: { nodeId: 'human_review', port: 'candidate' }, to: { nodeId: 'mapping_output', port: 'mappingProposal' } },
  ],
  budgets: {
    deadlineMs: 60_000,
    maxNodeAttempts: 16,
    maxModelCalls: 2,
    maxToolCalls: 4,
    maxLoopIterations: 0,
    maxFanOut: 4,
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxRetries: 1,
  },
  ui: {
    positions: {
      source: { x: 0, y: 120 },
      source_route: { x: 220, y: 120 },
      schema_profile: { x: 440, y: 120 },
      mapping_proposal: { x: 680, y: 40 },
      mapping_validation: { x: 920, y: 120 },
      human_review: { x: 1160, y: 120 },
      mapping_output: { x: 1400, y: 120 },
    },
    viewport: { x: 0, y: 0, zoom: 0.85 },
    groups: [],
    annotations: [{
      annotationId: 'compile_only',
      nodeId: 'human_review',
      text: 'P1 ends at a reviewed mapping proposal. Import, release and deployment are unavailable.',
    }],
  },
}

const TEMPLATES = Object.freeze([
  {
    templateKey: 'public-opinion-mapping',
    displayName: '全国舆情字段映射',
    description: 'A compile-only source-routing, schema-profiling and reviewed mapping-proposal graph. It performs no import or publish operation.',
    availability: 'authoring-only',
    runtimeAvailable: false,
    definition: canonicalizeJson(PUBLIC_OPINION_MAPPING_DEFINITION),
  },
  {
    templateKey: 'starter-governed-agent',
    displayName: 'Governed Agent Starter',
    description: 'A compile-only P1 graph with input, deterministic transform, route, read-only retrieval, structured LLM and typed terminal nodes.',
    availability: 'authoring-only',
    runtimeAvailable: false,
    definition: canonicalizeJson(STARTER_DEFINITION),
  },
])

export function listTemplates() {
  return TEMPLATES.map((item) => structuredClone(item))
}

export function templateDefinition(templateKey) {
  const template = TEMPLATES.find((item) => item.templateKey === templateKey)
  return template ? structuredClone(template.definition) : null
}
