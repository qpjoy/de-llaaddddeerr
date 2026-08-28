import { z } from 'zod'

export const ADVANCED_SEARCH_AGENT_KEY = 'advanced-search-dry-run'
export const ADVANCED_SEARCH_SCHEMA_VERSION = 1

export const ADVANCED_SEARCH_STAGE_TYPES = [
  'triage',
  'rewrite',
  'retrieve',
  'fuse',
  'grade',
  'geo',
  'answer',
] as const

export type AdvancedSearchStageType = typeof ADVANCED_SEARCH_STAGE_TYPES[number]

const PromptSchema = z.object({
  system: z.string().min(1).max(6_000),
  user: z.string().min(1).max(6_000),
}).strict()

const ModelParametersSchema = z.object({
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(64).max(4_096),
}).strict()

const StageStateSchema = z.enum(['active', 'trashed'])

const StageCommon = {
  state: StageStateSchema,
}

export const AdvancedSearchStageSchema = z.discriminatedUnion('type', [
  z.object({
    ...StageCommon,
    id: z.literal('triage'),
    type: z.literal('triage'),
    prompt: PromptSchema,
    model: ModelParametersSchema,
    options: z.object({}).strict(),
  }).strict(),
  z.object({
    ...StageCommon,
    id: z.literal('rewrite'),
    type: z.literal('rewrite'),
    prompt: PromptSchema,
    model: ModelParametersSchema,
    options: z.object({
      queryCount: z.number().int().min(1).max(3),
    }).strict(),
  }).strict(),
  z.object({
    ...StageCommon,
    id: z.literal('retrieve'),
    type: z.literal('retrieve'),
    options: z.object({
      topK: z.number().int().min(1).max(20),
      includeSemantic: z.boolean(),
      searchProfile: z.enum([
        'canonical.balanced.v1',
        'canonical.phrase.v1',
        'canonical.terms-all.v1',
        'canonical.zh-recall.v1',
        'canonical.title-prefix.v1',
      ]),
    }).strict(),
  }).strict(),
  z.object({
    ...StageCommon,
    id: z.literal('fuse'),
    type: z.literal('fuse'),
    options: z.object({
      rrfK: z.number().int().min(10).max(100),
      topK: z.number().int().min(1).max(20),
    }).strict(),
  }).strict(),
  z.object({
    ...StageCommon,
    id: z.literal('grade'),
    type: z.literal('grade'),
    prompt: PromptSchema,
    model: ModelParametersSchema,
    options: z.object({
      minRelevance: z.number().min(0).max(1),
      maxRetries: z.number().int().min(0).max(1),
    }).strict(),
  }).strict(),
  z.object({
    ...StageCommon,
    id: z.literal('geo'),
    type: z.literal('geo'),
    options: z.object({
      minConfidence: z.number().min(0).max(1),
    }).strict(),
  }).strict(),
  z.object({
    ...StageCommon,
    id: z.literal('answer'),
    type: z.literal('answer'),
    prompt: PromptSchema,
    model: ModelParametersSchema,
    options: z.object({
      requireCitations: z.boolean(),
    }).strict(),
  }).strict(),
])

export const AdvancedSearchDefinitionSchema = z.object({
  agentKey: z.literal(ADVANCED_SEARCH_AGENT_KEY),
  schemaVersion: z.literal(ADVANCED_SEARCH_SCHEMA_VERSION),
  dryRunOnly: z.literal(true),
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(1_000),
  stages: z.array(AdvancedSearchStageSchema).length(ADVANCED_SEARCH_STAGE_TYPES.length),
}).strict().superRefine((definition, context) => {
  const seen = new Set<AdvancedSearchStageType>()
  for (const [index, stage] of definition.stages.entries()) {
    if (stage.type !== ADVANCED_SEARCH_STAGE_TYPES[index]) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index, 'type'],
        message: `stage ${stage.type} must remain at canonical position ${index + 1}`,
      })
    }
    if (seen.has(stage.type)) {
      context.addIssue({
        code: 'custom',
        path: ['stages', index, 'type'],
        message: `stage ${stage.type} appears more than once`,
      })
    }
    seen.add(stage.type)
  }
  for (const type of ADVANCED_SEARCH_STAGE_TYPES) {
    if (!seen.has(type)) {
      context.addIssue({
        code: 'custom',
        path: ['stages'],
        message: `stage ${type} is missing; move it to the trash instead of deleting it`,
      })
    }
  }
})

export const AdvancedSearchFiltersSchema = z.object({
  platform: z.string().trim().min(1).max(80).nullable().default(null),
  datasetId: z.string().trim().min(1).max(160).nullable().default(null),
  objectType: z.string().trim().min(1).max(80).nullable().default(null),
  fromTime: z.iso.datetime({ offset: true }).nullable().default(null),
  toTime: z.iso.datetime({ offset: true }).nullable().default(null),
}).strict()

export const AdvancedSearchDryRunRequestSchema = z.object({
  dryRun: z.literal(true),
  query: z.string().trim().min(1).max(500),
  filters: AdvancedSearchFiltersSchema.default({
    platform: null,
    datasetId: null,
    objectType: null,
    fromTime: null,
    toTime: null,
  }),
  definition: AdvancedSearchDefinitionSchema,
}).strict()

export const AdvancedSearchSaveRequestSchema = z.object({
  expectedRevision: z.number().int().min(0),
  definition: AdvancedSearchDefinitionSchema,
}).strict()

export const TriageOutputSchema = z.object({
  route: z.enum(['knowledge_search', 'structured_filter', 'clarify'])
    .describe('The explicit branch selected for this run.'),
  normalizedQuestion: z.string().min(1).max(500)
    .describe('The question after whitespace and intent normalization.'),
  filters: AdvancedSearchFiltersSchema,
  branchReason: z.string().min(1).max(500)
    .describe('A short observable routing reason, not hidden chain-of-thought.'),
}).strict()

export const RewriteOutputSchema = z.object({
  rewrittenQuery: z.string().min(1).max(500)
    .describe('The primary corpus-facing search query.'),
  alternateQueries: z.array(z.string().min(1).max(500)).max(2)
    .describe('At most two bounded alternatives used only by the corrective retry.'),
  keywords: z.array(z.string().min(1).max(80)).max(12),
  preservedConstraints: z.array(z.string().min(1).max(160)).max(12),
}).strict()

export const SearchEvidenceSchema = z.object({
  id: z.string().min(1).max(200),
  recordId: z.string().min(1).max(200).nullable(),
  title: z.string().max(500).nullable(),
  snippet: z.string().max(1_200),
  platform: z.string().max(80).nullable(),
  datasetId: z.string().max(160).nullable(),
  objectType: z.string().max(80).nullable(),
  url: z.string().max(2_048).nullable(),
  eventTime: z.string().max(64).nullable(),
  sources: z.array(z.enum(['elasticsearch', 'postgres', 'semantic'])).min(1).max(3),
  matchEvidence: z.array(z.string().max(120)).max(16),
  locationHints: z.array(z.string().min(1).max(80)).max(8),
  rrfScore: z.number().nonnegative(),
}).strict()

export const RetrievalOutputSchema = z.object({
  query: z.string().min(1).max(500),
  backends: z.array(z.object({
    source: z.enum(['elasticsearch', 'postgres', 'semantic']),
    mode: z.string().min(1).max(80),
    returned: z.number().int().nonnegative(),
    degraded: z.string().max(500).nullable(),
  }).strict()).max(3),
  candidates: z.array(SearchEvidenceSchema).max(60),
}).strict()

export const FuseOutputSchema = z.object({
  strategy: z.literal('rrf'),
  k: z.number().int().min(10).max(100),
  inputCandidates: z.number().int().nonnegative(),
  deduplicatedCandidates: z.number().int().nonnegative(),
  evidence: z.array(SearchEvidenceSchema).max(20),
}).strict()

export const GradeOutputSchema = z.object({
  verdict: z.enum(['useful', 'partial', 'insufficient']),
  scores: z.array(z.object({
    evidenceId: z.string().min(1).max(200),
    relevance: z.number().min(0).max(1),
    reason: z.string().min(1).max(300),
  }).strict()).max(20),
  missingFacts: z.array(z.string().min(1).max(300)).max(8),
  branchReason: z.string().min(1).max(500),
}).strict()

export const GeoOutputSchema = z.object({
  locations: z.array(z.object({
    evidenceId: z.string().min(1).max(200),
    provinceCode: z.string().regex(/^CN-[A-Z]{2}$/),
    provinceName: z.string().min(1).max(40),
    confidence: z.number().min(0).max(1),
    matchedText: z.string().min(1).max(80),
    method: z.literal('china-province-taxonomy'),
  }).strict()).max(40),
  unknownEvidenceIds: z.array(z.string().min(1).max(200)).max(20),
}).strict()

export const AnswerOutputSchema = z.object({
  answer: z.string().min(1).max(8_000),
  citations: z.array(z.object({
    evidenceId: z.string().min(1).max(200),
    claim: z.string().min(1).max(500),
  }).strict()).max(20),
  confidence: z.number().min(0).max(1),
  limitations: z.array(z.string().min(1).max(500)).max(8),
  refused: z.boolean(),
}).strict()

export const StageOutputSchemas = {
  triage: TriageOutputSchema,
  rewrite: RewriteOutputSchema,
  retrieve: RetrievalOutputSchema,
  fuse: FuseOutputSchema,
  grade: GradeOutputSchema,
  geo: GeoOutputSchema,
  answer: AnswerOutputSchema,
} as const

export function outputSchemaForStage(type: AdvancedSearchStageType): z.ZodType {
  return StageOutputSchemas[type]
}

export type AdvancedSearchDefinition = z.infer<typeof AdvancedSearchDefinitionSchema>
export type AdvancedSearchStage = z.infer<typeof AdvancedSearchStageSchema>
export type AdvancedSearchDryRunRequest = z.infer<typeof AdvancedSearchDryRunRequestSchema>
export type SearchEvidence = z.infer<typeof SearchEvidenceSchema>
export type TriageOutput = z.infer<typeof TriageOutputSchema>
export type RewriteOutput = z.infer<typeof RewriteOutputSchema>
export type RetrievalOutput = z.infer<typeof RetrievalOutputSchema>
export type FuseOutput = z.infer<typeof FuseOutputSchema>
export type GradeOutput = z.infer<typeof GradeOutputSchema>
export type GeoOutput = z.infer<typeof GeoOutputSchema>
export type AnswerOutput = z.infer<typeof AnswerOutputSchema>
