import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '../core/errors.mjs'
import { publicStoredSearchItem } from '../data/stored-search.mjs'
import { CHINA_PROVINCES, normalizeChinaProvince } from '../data/china-provinces.mjs'
import {
  ADVANCED_SEARCH_AGENT_KEY,
  ADVANCED_SEARCH_STAGE_TYPES,
  AdvancedSearchDryRunRequestSchema,
  AnswerOutputSchema,
  FuseOutputSchema,
  GeoOutputSchema,
  GradeOutputSchema,
  RetrievalOutputSchema,
  RewriteOutputSchema,
  TriageOutputSchema,
  type AdvancedSearchDryRunRequest,
  type AdvancedSearchStage,
  type AdvancedSearchStageType,
  type AnswerOutput,
  type FuseOutput,
  type GeoOutput,
  type GradeOutput,
  type RetrievalOutput,
  type RewriteOutput,
  type SearchEvidence,
  type TriageOutput,
} from '../../agent-market/advanced-search/schemas.ts'
import {
  ADVANCED_SEARCH_STAGE_META,
  jsonSchemaForStage,
} from '../../agent-market/advanced-search/manifest.ts'

const MAX_EVIDENCE_PROMPT_ITEMS = 10
const MAX_EVIDENCE_PROMPT_TEXT = 700
const MAX_RUN_MS = 120_000
const MAX_CONCURRENT_DRY_RUNS = 2
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/

let activeDryRuns = 0

type SearchResult = {
  mode?: string
  items?: Array<Record<string, unknown>>
  searchExecution?: Record<string, unknown>
  degraded?: string | null
}

type SearchQueries = {
  searchContent: (query: string, options: Record<string, unknown>) => Promise<SearchResult>
  semanticSearch?: (
    query: string,
    options: Record<string, unknown>,
  ) => Promise<SearchResult>
}

type SearchRuntime = {
  client?: unknown
  queries?: SearchQueries
  postgresQueries?: SearchQueries
}

type AgentRuntime = {
  available?: boolean
  embeddings?: { available?: boolean }
  complete?: (
    messages: Array<{ role: string, content: string }>,
    options: { temperature: number, maxTokens: number, signal: AbortSignal },
  ) => Promise<Record<string, any>>
  embed?: (texts: string[], options?: { signal?: AbortSignal }) => Promise<unknown>
}

type CandidateList = {
  source: 'elasticsearch' | 'postgres' | 'semantic'
  items: SearchEvidence[]
}

type ModelTrace = {
  provider: string | null
  model: string | null
  temperature: number
  maxTokens: number
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  attempts: Array<Record<string, unknown>>
  fallback: boolean
  errorCode: string | null
  responseValidation: {
    valid: boolean
    issues: Array<{ path: string, message: string }>
  } | null
}

type StageExecution<T> = {
  output: T
  status?: 'succeeded' | 'degraded'
  note?: string | null
  messages?: Array<{ role: string, content: string }>
  model?: ModelTrace | null
  toolCalls?: Array<Record<string, unknown>>
}

export type AgentMarketStageTrace = {
  stageId: string
  type: AdvancedSearchStageType
  title: string
  attempt: number
  status: 'succeeded' | 'degraded' | 'skipped' | 'failed'
  startedAt: string
  durationMs: number
  input: unknown
  messages: Array<{ role: string, content: string }>
  parameters: Record<string, unknown>
  toolCalls: Array<Record<string, unknown>>
  output: unknown
  validation: {
    schemaName: string
    valid: boolean
    issues: Array<{ path: string, message: string }>
  }
  model: ModelTrace | null
  note: string | null
}

type RunContext = {
  request: AdvancedSearchDryRunRequest
  signal: AbortSignal
  originalQuery: string
  route: TriageOutput['route']
  routeReason: string
  normalizedQuestion: string
  filters: AdvancedSearchDryRunRequest['filters']
  activeQuery: string
  alternateQueries: string[]
  missingFacts: string[]
  candidateLists: CandidateList[]
  evidence: SearchEvidence[]
  grade: GradeOutput | null
  geo: GeoOutput
  final: AnswerOutput | null
  retryCount: number
  traces: AgentMarketStageTrace[]
}

type ModelStage = Extract<AdvancedSearchStage, { type: 'triage' | 'rewrite' | 'grade' | 'answer' }>

function validationIssues(error: z.ZodError): Array<{ path: string, message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

function invalidRequest(error: z.ZodError): AppError {
  return new AppError(400, 'invalid_agent_market_dry_run', 'The Agent Market dry-run request is invalid', {
    issues: validationIssues(error),
  })
}

function boundedString(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

function jsonForPrompt(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  return boundedString(text, 14_000)
}

function renderedVariables(context: RunContext): Record<string, string> {
  return {
    query: context.originalQuery,
    normalizedQuestion: context.normalizedQuestion,
    filters: jsonForPrompt(context.filters),
    missingFacts: jsonForPrompt(context.missingFacts),
    evidence: jsonForPrompt(context.evidence.slice(0, MAX_EVIDENCE_PROMPT_ITEMS).map((item) => ({
      ...item,
      snippet: boundedString(item.snippet, MAX_EVIDENCE_PROMPT_TEXT),
    }))),
    geo: jsonForPrompt(context.geo),
  }
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => (
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : ''
  ))
}

function extractJsonObject(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) {
    throw new AppError(502, 'agent_invalid_response', 'Model returned an empty response')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new AppError(502, 'agent_invalid_response', 'Model response contained no JSON object')
  }
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new AppError(502, 'agent_invalid_response', 'Model response was not valid JSON')
  }
}

function usageNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error && typeof error.code === 'string') {
    return SAFE_ERROR_CODE.test(error.code) ? error.code : 'agent_stage_failed'
  }
  return 'agent_stage_failed'
}

function safeStageFailureNote(error: unknown): string {
  return `阶段执行失败 (${errorCode(error)})。详细错误仅保留在服务端日志。`
}

function safeBackendMode(source: CandidateList['source'], value: unknown): string {
  const allowed = new Set(['elasticsearch', 'postgres', 'hybrid', 'lexical-only'])
  return typeof value === 'string' && allowed.has(value) ? value : `${source}-degraded`
}

function safeBackendDegradation(
  source: CandidateList['source'],
  mode: string,
  value: unknown,
): string | null {
  if (value == null) return null
  if (source === 'semantic' && mode === 'lexical-only') {
    return 'Embedding provider unavailable; vector recall was skipped.'
  }
  return `${source} returned degraded read results; internal details are not exposed.`
}

function runWithinDeadline<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new AppError(504, 'agent_market_timeout', 'The Agent Market dry run exceeded its deadline'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new AppError(504, 'agent_market_timeout', 'The Agent Market dry run exceeded its deadline'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    run().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function runStructuredModel<T>(
  stage: ModelStage,
  type: AdvancedSearchStageType,
  schema: z.ZodType<T>,
  context: RunContext,
  agent: AgentRuntime | null,
  fallback: () => T,
): Promise<StageExecution<T>> {
  const variables = renderedVariables(context)
  const messages = [
    {
      role: 'system',
      content: renderTemplate(stage.prompt.system, variables),
    },
    {
      role: 'system',
      content: [
        'Runtime contract: return one JSON object matching this JSON Schema.',
        'Do not emit markdown or hidden reasoning.',
        JSON.stringify(jsonSchemaForStage(type)),
      ].join('\n'),
    },
    {
      role: 'user',
      content: renderTemplate(stage.prompt.user, variables),
    },
  ]

  if (!agent?.available || typeof agent.complete !== 'function') {
    return {
      output: fallback(),
      status: 'degraded',
      note: '未配置可用模型；使用确定性 fallback，Prompt 改动不会触发模型。',
      messages,
      model: {
        provider: null,
        model: null,
        temperature: stage.model.temperature,
        maxTokens: stage.model.maxTokens,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        attempts: [],
        fallback: true,
        errorCode: 'agent_not_configured',
        responseValidation: null,
      },
    }
  }

  let observed: Pick<ModelTrace, 'provider' | 'model' | 'latencyMs' | 'inputTokens' | 'outputTokens' | 'attempts'> = {
    provider: null,
    model: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    attempts: [],
  }
  let responseValidation: ModelTrace['responseValidation'] = null
  try {
    const result = await agent.complete(messages, {
      temperature: stage.model.temperature,
      maxTokens: stage.model.maxTokens,
      signal: context.signal,
    })
    observed = {
      provider: typeof result.provider === 'string' ? result.provider : null,
      model: typeof result.model === 'string' ? result.model : null,
      latencyMs: usageNumber(result.latencyMs),
      inputTokens: usageNumber(result.payload?.usage?.prompt_tokens),
      outputTokens: usageNumber(result.payload?.usage?.completion_tokens),
      attempts: Array.isArray(result.attempts) ? result.attempts : [],
    }
    let raw: unknown
    try {
      raw = extractJsonObject(result.payload?.choices?.[0]?.message?.content)
    } catch (error) {
      responseValidation = {
        valid: false,
        issues: [{ path: '', message: error instanceof Error ? error.message : 'Model response was not valid JSON' }],
      }
      throw error
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      responseValidation = { valid: false, issues: validationIssues(parsed.error) }
      throw new AppError(502, 'agent_schema_validation_failed', 'Model output did not match the stage schema', {
        issues: validationIssues(parsed.error),
      })
    }
    responseValidation = { valid: true, issues: [] }
    return {
      output: parsed.data,
      messages,
      model: {
        ...observed,
        temperature: stage.model.temperature,
        maxTokens: stage.model.maxTokens,
        fallback: false,
        errorCode: null,
        responseValidation,
      },
    }
  } catch (error) {
    if (context.signal.aborted) {
      throw new AppError(504, 'agent_market_timeout', 'The Agent Market dry run exceeded its deadline')
    }
    return {
      output: fallback(),
      status: 'degraded',
      note: '模型调用或 Schema 校验失败；本阶段使用确定性 fallback。',
      messages,
      model: {
        ...observed,
        temperature: stage.model.temperature,
        maxTokens: stage.model.maxTokens,
        fallback: true,
        errorCode: errorCode(error),
        responseValidation,
      },
    }
  }
}

function parseFilterTime(value: string | null, field: string): string | null {
  if (value == null) return null
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) {
    throw new AppError(400, 'invalid_agent_market_filter', field + ' must be an ISO date-time')
  }
  return time.toISOString()
}

function normalizedFilters(
  filters: AdvancedSearchDryRunRequest['filters'],
): AdvancedSearchDryRunRequest['filters'] {
  const normalized = {
    ...filters,
    fromTime: parseFilterTime(filters.fromTime, 'fromTime'),
    toTime: parseFilterTime(filters.toTime, 'toTime'),
  }
  if (
    normalized.fromTime
    && normalized.toTime
    && new Date(normalized.fromTime).getTime() > new Date(normalized.toTime).getTime()
  ) {
    throw new AppError(400, 'invalid_agent_market_filter', 'fromTime must not be later than toTime')
  }
  return normalized
}

function mergeTriageFilters(
  proposed: TriageOutput['filters'],
  explicit: AdvancedSearchDryRunRequest['filters'],
): AdvancedSearchDryRunRequest['filters'] {
  return {
    platform: explicit.platform ?? proposed.platform,
    datasetId: explicit.datasetId ?? proposed.datasetId,
    objectType: explicit.objectType ?? proposed.objectType,
    fromTime: explicit.fromTime ?? proposed.fromTime,
    toTime: explicit.toTime ?? proposed.toTime,
  }
}

function traceInput(type: AdvancedSearchStageType, context: RunContext): unknown {
  if (type === 'triage') return { query: context.originalQuery, filters: context.filters }
  if (type === 'rewrite') {
    return {
      query: context.originalQuery,
      normalizedQuestion: context.normalizedQuestion,
      missingFacts: context.missingFacts,
    }
  }
  if (type === 'retrieve') return { query: context.activeQuery, filters: context.filters }
  if (type === 'fuse') {
    return {
      candidateLists: context.candidateLists.map((list) => ({
        source: list.source,
        count: list.items.length,
      })),
    }
  }
  if (type === 'grade') return { query: context.originalQuery, evidence: context.evidence }
  if (type === 'geo') return { evidence: context.evidence }
  return { query: context.originalQuery, evidence: context.evidence, geo: context.geo }
}

function traceParameters(stage: AdvancedSearchStage): Record<string, unknown> {
  return {
    ...(stage.type === 'triage' || stage.type === 'rewrite' || stage.type === 'grade' || stage.type === 'answer'
      ? {
          temperature: stage.model.temperature,
          maxTokens: stage.model.maxTokens,
        }
      : {}),
    ...stage.options,
  }
}

function skippedTrace(
  stage: AdvancedSearchStage,
  context: RunContext,
  attempt: number,
  note: string,
): AgentMarketStageTrace {
  return {
    stageId: stage.id,
    type: stage.type,
    title: ADVANCED_SEARCH_STAGE_META[stage.type].label,
    attempt,
    status: 'skipped',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    input: traceInput(stage.type, context),
    messages: [],
    parameters: traceParameters(stage),
    toolCalls: [],
    output: null,
    validation: {
      schemaName: ADVANCED_SEARCH_STAGE_META[stage.type].schemaName,
      valid: true,
      issues: [],
    },
    model: null,
    note,
  }
}

async function executeStage<T>(
  stage: AdvancedSearchStage,
  context: RunContext,
  attempt: number,
  schema: z.ZodType<T>,
  run: () => Promise<StageExecution<T>>,
): Promise<T | null> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const input = traceInput(stage.type, context)
  try {
    const execution = await run()
    const parsed = schema.safeParse(execution.output)
    if (!parsed.success) {
      context.traces.push({
        stageId: stage.id,
        type: stage.type,
        title: ADVANCED_SEARCH_STAGE_META[stage.type].label,
        attempt,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        input,
        messages: execution.messages || [],
        parameters: traceParameters(stage),
        toolCalls: execution.toolCalls || [],
        output: null,
        validation: {
          schemaName: ADVANCED_SEARCH_STAGE_META[stage.type].schemaName,
          valid: false,
          issues: validationIssues(parsed.error),
        },
        model: execution.model || null,
        note: '阶段输出没有通过代码拥有的 Zod Schema。',
      })
      return null
    }
    context.traces.push({
      stageId: stage.id,
      type: stage.type,
      title: ADVANCED_SEARCH_STAGE_META[stage.type].label,
      attempt,
      status: execution.status || 'succeeded',
      startedAt,
      durationMs: Date.now() - started,
      input,
      messages: execution.messages || [],
      parameters: traceParameters(stage),
      toolCalls: execution.toolCalls || [],
      output: parsed.data,
      validation: {
        schemaName: ADVANCED_SEARCH_STAGE_META[stage.type].schemaName,
        valid: true,
        issues: [],
      },
      model: execution.model || null,
      note: execution.note || null,
    })
    return parsed.data
  } catch (error) {
    if (context.signal.aborted) throw error
    context.traces.push({
      stageId: stage.id,
      type: stage.type,
      title: ADVANCED_SEARCH_STAGE_META[stage.type].label,
      attempt,
      status: 'failed',
      startedAt,
      durationMs: Date.now() - started,
      input,
      messages: [],
      parameters: traceParameters(stage),
      toolCalls: [],
      output: null,
      validation: {
        schemaName: ADVANCED_SEARCH_STAGE_META[stage.type].schemaName,
        valid: false,
        issues: [],
      },
      model: null,
      note: safeStageFailureNote(error),
    })
    return null
  }
}

function evidenceFromCanonical(
  row: Record<string, any>,
  source: 'elasticsearch' | 'postgres',
): SearchEvidence | null {
  try {
    const safe = publicStoredSearchItem(row, {
      includeCandidateMetadata: Boolean(row.publication),
    }) as Record<string, any>
    const id = String(safe.id || row.id || '')
    if (!id) return null
    const locationHints = [
      safe.location?.provinceCode,
      safe.location?.label,
      row.admin1Code,
      row.publication?.displayAdmin1,
      row.publication?.locationLabel,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    return {
      id,
      recordId: id,
      title: typeof safe.title === 'string' ? boundedString(safe.title, 500) : null,
      snippet: boundedString(safe.text || '', 1_200),
      platform: typeof safe.platform === 'string' ? safe.platform : null,
      datasetId: typeof safe.datasetId === 'string' ? safe.datasetId : null,
      objectType: typeof safe.objectType === 'string' ? safe.objectType : null,
      url: typeof safe.url === 'string' ? boundedString(safe.url, 2_048) : null,
      eventTime: typeof safe.eventTime === 'string' ? safe.eventTime : null,
      sources: [source],
      matchEvidence: Array.isArray(row.matchEvidence)
        ? row.matchEvidence.filter((value: unknown): value is string => typeof value === 'string').slice(0, 16)
        : [],
      locationHints: [...new Set(locationHints)].slice(0, 8),
      rrfScore: 0,
    }
  } catch {
    return null
  }
}

function evidenceFromSemantic(row: Record<string, any>): SearchEvidence | null {
  const recordId = String(row.recordId || row.id || '')
  if (!recordId) return null
  return {
    id: recordId,
    recordId,
    title: typeof row.title === 'string' ? boundedString(row.title, 500) : null,
    snippet: boundedString(row.content || '', 1_200),
    platform: typeof row.platform === 'string' ? row.platform : null,
    datasetId: typeof row.datasetId === 'string' ? row.datasetId : null,
    objectType: null,
    url: typeof row.url === 'string' ? boundedString(row.url, 2_048) : null,
    eventTime: typeof row.eventTime === 'string' ? row.eventTime : null,
    sources: ['semantic'],
    matchEvidence: Array.isArray(row.retrievers)
      ? row.retrievers.filter((value: unknown): value is string => typeof value === 'string').slice(0, 16)
      : [],
    locationHints: [],
    rrfScore: 0,
  }
}

function searchOptions(
  stage: Extract<AdvancedSearchStage, { type: 'retrieve' }>,
  context: RunContext,
): Record<string, unknown> {
  return {
    platform: context.filters.platform,
    datasetId: context.filters.datasetId,
    objectType: context.filters.objectType,
    fromTime: context.filters.fromTime,
    toTime: context.filters.toTime,
    size: stage.options.topK,
    trackTotalHits: false,
    oneShot: true,
    searchProfile: stage.options.searchProfile,
  }
}

async function retrieve(
  stage: Extract<AdvancedSearchStage, { type: 'retrieve' }>,
  context: RunContext,
  search: SearchRuntime | null,
  agent: AgentRuntime | null,
): Promise<StageExecution<RetrievalOutput>> {
  if (!search?.queries?.searchContent) {
    throw new AppError(503, 'agent_market_search_unavailable', 'Agent Market search requires the Hub canonical search layer')
  }
  const query = context.activeQuery || context.originalQuery
  const options = searchOptions(stage, context)
  const calls: Array<{
    source: 'elasticsearch' | 'postgres' | 'semantic'
    run: () => Promise<SearchResult>
  }> = [{
    source: search.client ? 'elasticsearch' : 'postgres',
    run: () => search.queries!.searchContent(query, options),
  }]
  if (search.client && search.postgresQueries?.searchContent) {
    calls.push({
      source: 'postgres',
      run: () => search.postgresQueries!.searchContent(query, options),
    })
  }
  if (stage.options.includeSemantic && search.client && search.queries.semanticSearch) {
    calls.push({
      source: 'semantic',
      run: () => search.queries!.semanticSearch!(query, {
        platform: context.filters.platform,
        datasetId: context.filters.datasetId,
        size: stage.options.topK,
        embed: agent?.embeddings?.available && typeof agent.embed === 'function'
          ? (texts: string[]) => agent.embed!(texts, { signal: context.signal })
          : null,
      }),
    })
  }

  const settled = await Promise.all(calls.map(async (call) => {
    try {
      return { call, result: await runWithinDeadline(context.signal, call.run), error: null }
    } catch (error) {
      return {
        call,
        result: null,
        error: `${call.source} read failed (${errorCode(error)}); internal details are not exposed.`,
      }
    }
  }))
  const candidateListsBySource = new Map<CandidateList['source'], CandidateList>()
  const backends: RetrievalOutput['backends'] = []
  for (const entry of settled) {
    if (!entry.result) {
      backends.push({
        source: entry.call.source,
        mode: 'unavailable',
        returned: 0,
        degraded: entry.error,
      })
      continue
    }
    const actualSource = entry.call.source === 'elasticsearch' && entry.result.mode === 'postgres'
      ? 'postgres'
      : entry.call.source
    const items = (entry.result.items || []).flatMap((row) => {
      const evidence = actualSource === 'semantic'
        ? evidenceFromSemantic(row)
        : evidenceFromCanonical(row, actualSource)
      return evidence ? [evidence] : []
    })
    // The normal search reader already degrades ES failures to PostgreSQL. In
    // that case the explicit PG comparison returns the same ranked list; keep
    // one PG vote so RRF does not artificially double its score.
    if (!candidateListsBySource.has(actualSource)) {
      candidateListsBySource.set(actualSource, { source: actualSource, items })
    }
    const mode = safeBackendMode(actualSource, entry.result.mode)
    backends.push({
      source: entry.call.source,
      mode,
      returned: items.length,
      degraded: safeBackendDegradation(actualSource, mode, entry.result.degraded),
    })
  }
  const candidateLists = [...candidateListsBySource.values()]
  context.candidateLists = candidateLists
  const candidates = candidateLists.flatMap((list) => list.items).slice(0, 60)
  const failures = backends.filter((backend) => backend.degraded || backend.mode === 'unavailable')
  return {
    output: RetrievalOutputSchema.parse({ query, backends, candidates }),
    status: failures.length > 0 ? 'degraded' : 'succeeded',
    note: failures.length > 0
      ? '一个或多个只读召回后端不可用；结果保留明确降级信息。'
      : null,
    toolCalls: [{
      toolId: 'canonical.search',
      sideEffect: 'none',
      input: { query, filters: context.filters, ...stage.options },
      outputSummary: backends,
    }],
  }
}

function fuse(
  stage: Extract<AdvancedSearchStage, { type: 'fuse' }>,
  context: RunContext,
): StageExecution<FuseOutput> {
  const byId = new Map<string, SearchEvidence>()
  let inputCandidates = 0
  for (const list of context.candidateLists) {
    for (const [rank, candidate] of list.items.entries()) {
      inputCandidates += 1
      const key = candidate.recordId || candidate.id
      const previous = byId.get(key)
      const score = 1 / (stage.options.rrfK + rank + 1)
      if (!previous) {
        byId.set(key, {
          ...candidate,
          sources: [...candidate.sources],
          matchEvidence: [...candidate.matchEvidence],
          locationHints: [...candidate.locationHints],
          rrfScore: score,
        })
        continue
      }
      byId.set(key, {
        ...previous,
        title: previous.title || candidate.title,
        snippet: previous.snippet || candidate.snippet,
        url: previous.url || candidate.url,
        eventTime: previous.eventTime || candidate.eventTime,
        sources: [...new Set([...previous.sources, ...candidate.sources])],
        matchEvidence: [...new Set([...previous.matchEvidence, ...candidate.matchEvidence])].slice(0, 16),
        locationHints: [...new Set([...previous.locationHints, ...candidate.locationHints])].slice(0, 8),
        rrfScore: previous.rrfScore + score,
      })
    }
  }
  const evidence = [...byId.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore)
    .slice(0, stage.options.topK)
    .map((item) => ({ ...item, rrfScore: Math.round(item.rrfScore * 100_000) / 100_000 }))
  context.evidence = evidence
  return {
    output: FuseOutputSchema.parse({
      strategy: 'rrf',
      k: stage.options.rrfK,
      inputCandidates,
      deduplicatedCandidates: byId.size,
      evidence,
    }),
    toolCalls: [{
      toolId: 'evidence.rrf',
      sideEffect: 'none',
      input: {
        k: stage.options.rrfK,
        lists: context.candidateLists.map((list) => ({ source: list.source, count: list.items.length })),
      },
      outputSummary: { inputCandidates, deduplicatedCandidates: byId.size, returned: evidence.length },
    }],
  }
}

function triageFallback(context: RunContext): TriageOutput {
  return {
    route: 'knowledge_search',
    normalizedQuestion: context.originalQuery.replace(/\s+/g, ' ').trim(),
    filters: context.filters,
    branchReason: 'Dry-run 默认把非空问题送入当前 Hub 语料检索。',
  }
}

function rewriteFallback(
  stage: Extract<AdvancedSearchStage, { type: 'rewrite' }>,
  context: RunContext,
): RewriteOutput {
  const retry = context.retryCount > 0
  const suffix = retry && context.missingFacts.length > 0
    ? ' ' + context.missingFacts.join(' ')
    : ''
  const query = boundedString(context.originalQuery + suffix, 500).trim()
  return {
    rewrittenQuery: query,
    alternateQueries: [],
    keywords: [...new Set(query.split(/[\s,，。；;、]+/u).filter(Boolean))].slice(0, 12),
    preservedConstraints: [],
  }
}

function gradeFallback(context: RunContext): GradeOutput {
  if (context.evidence.length === 0) {
    return {
      verdict: 'insufficient',
      scores: [],
      missingFacts: ['当前 PG / ES 召回没有返回可引用资料'],
      branchReason: '没有证据，不能进入有依据的答案生成。',
    }
  }
  return {
    verdict: 'useful',
    scores: context.evidence.map((item) => ({
      evidenceId: item.id,
      relevance: 0.5,
      reason: '模型不可用：仅按 RRF 顺序直通；0.5 是未校准的门禁值，不代表相关性概率。',
    })),
    missingFacts: [],
    branchReason: '模型不可用时保留 RRF 排名；本阶段没有做语义相关性判断。',
  }
}

function sanitizeGrade(
  output: GradeOutput,
  context: RunContext,
): GradeOutput {
  const allowed = new Set(context.evidence.map((item) => item.id))
  const scores = output.scores.filter((score) => allowed.has(score.evidenceId))
  if (context.evidence.length > 0 && scores.length === 0) {
    return gradeFallback(context)
  }
  const unique = new Map(scores.map((score) => [score.evidenceId, score]))
  return {
    ...output,
    scores: [...unique.values()],
  }
}

function applyGrade(
  stage: Extract<AdvancedSearchStage, { type: 'grade' }>,
  output: GradeOutput,
  context: RunContext,
): GradeOutput {
  const sanitized = sanitizeGrade(output, context)
  const scoreById = new Map(sanitized.scores.map((score) => [score.evidenceId, score.relevance]))
  context.evidence = context.evidence
    .filter((item) => (scoreById.get(item.id) ?? 0) >= stage.options.minRelevance)
    .sort((left, right) => (
      (scoreById.get(right.id) ?? 0) - (scoreById.get(left.id) ?? 0)
      || right.rrfScore - left.rrfScore
    ))
  const verdict = context.evidence.length === 0 ? 'insufficient' : sanitized.verdict
  const result = GradeOutputSchema.parse({
    ...sanitized,
    verdict,
    missingFacts: verdict === 'insufficient' && sanitized.missingFacts.length === 0
      ? ['没有资料达到当前最低相关度']
      : sanitized.missingFacts,
  })
  context.grade = result
  context.missingFacts = result.missingFacts
  return result
}

function resolveGeo(
  stage: Extract<AdvancedSearchStage, { type: 'geo' }>,
  context: RunContext,
): StageExecution<GeoOutput> {
  const locations: GeoOutput['locations'] = []
  const unknownEvidenceIds: string[] = []
  for (const evidence of context.evidence) {
    const matches = new Map<string, { text: string, confidence: number }>()
    for (const hint of evidence.locationHints) {
      const normalized = normalizeChinaProvince(hint)
      if (normalized) matches.set(normalized.code, { text: hint, confidence: 1 })
    }
    const text = [evidence.title || '', evidence.snippet].join('\n')
    for (const province of CHINA_PROVINCES) {
      const matchedText = [province.officialName, province.name].find((name) => text.includes(name))
      if (matchedText && !matches.has(province.code)) {
        matches.set(province.code, { text: matchedText, confidence: 0.9 })
      }
    }
    for (const [code, match] of matches) {
      if (match.confidence < stage.options.minConfidence) continue
      const province = normalizeChinaProvince(code)
      if (!province) continue
      locations.push({
        evidenceId: evidence.id,
        provinceCode: province.code,
        provinceName: province.name,
        confidence: match.confidence,
        matchedText: match.text,
        method: 'china-province-taxonomy',
      })
    }
    if (!locations.some((location) => location.evidenceId === evidence.id)) {
      unknownEvidenceIds.push(evidence.id)
    }
  }
  const output = GeoOutputSchema.parse({ locations, unknownEvidenceIds })
  context.geo = output
  return {
    output,
    toolCalls: [{
      toolId: 'geo.cn-admin1',
      sideEffect: 'none',
      input: {
        evidenceIds: context.evidence.map((item) => item.id),
        minConfidence: stage.options.minConfidence,
      },
      outputSummary: {
        resolved: locations.length,
        unknown: unknownEvidenceIds.length,
      },
    }],
  }
}

function answerFallback(context: RunContext): AnswerOutput {
  if (context.evidence.length === 0) {
    return {
      answer: '当前只读语料不足，无法给出有证据支持的回答。',
      citations: [],
      confidence: 0,
      limitations: [
        '本次运行只读取当前 PostgreSQL / Elasticsearch 数据，不调用联网搜索。',
        '没有可引用资料时系统会拒答。',
      ],
      refused: true,
    }
  }
  const selected = context.evidence.slice(0, 3)
  return {
    answer: '当前只读检索返回 ' + context.evidence.length + ' 条可用证据。优先资料：'
      + selected.map((item) => item.title || item.snippet.slice(0, 80)).join('；') + '。',
    citations: selected.map((item) => ({
      evidenceId: item.id,
      claim: item.title || boundedString(item.snippet, 160),
    })),
    confidence: 0.55,
    limitations: ['这是模型不可用时的确定性摘要，未做生成式综合。'],
    refused: false,
  }
}

function clarificationAnswer(context: RunContext): AnswerOutput {
  return {
    answer: '当前问题缺少足够的检索约束，请补充对象、时间范围、地区或希望比较的指标后再运行。',
    citations: [],
    confidence: 0,
    limitations: [boundedString(context.routeReason || '意图分流要求先澄清问题。', 500)],
    refused: true,
  }
}

function sanitizeAnswer(
  stage: Extract<AdvancedSearchStage, { type: 'answer' }>,
  output: AnswerOutput,
  context: RunContext,
): AnswerOutput {
  const allowed = new Set(context.evidence.map((item) => item.id))
  const citations = output.citations.filter((citation) => allowed.has(citation.evidenceId))
  if (
    !output.refused
    && stage.options.requireCitations
    && context.evidence.length > 0
    && citations.length === 0
  ) {
    return answerFallback(context)
  }
  return AnswerOutputSchema.parse({
    ...output,
    citations,
    refused: context.evidence.length === 0 ? true : output.refused,
  })
}

function stageMap(
  request: AdvancedSearchDryRunRequest,
): Map<AdvancedSearchStageType, AdvancedSearchStage> {
  return new Map(request.definition.stages.map((stage) => [stage.type, stage]))
}

function shouldSkipForBranch(type: AdvancedSearchStageType, context: RunContext): boolean {
  return context.route === 'clarify'
    && ['rewrite', 'retrieve', 'fuse', 'grade', 'geo'].includes(type)
}

async function runTriage(
  stage: Extract<AdvancedSearchStage, { type: 'triage' }>,
  context: RunContext,
  agent: AgentRuntime | null,
): Promise<void> {
  const output = await executeStage(stage, context, 0, TriageOutputSchema, () => (
    runStructuredModel(stage, 'triage', TriageOutputSchema, context, agent, () => triageFallback(context))
  ))
  if (!output) return
  context.route = output.route
  context.routeReason = output.branchReason
  context.normalizedQuestion = output.normalizedQuestion
  context.filters = normalizedFilters(mergeTriageFilters(output.filters, context.request.filters))
}

async function runRewrite(
  stage: Extract<AdvancedSearchStage, { type: 'rewrite' }>,
  context: RunContext,
  agent: AgentRuntime | null,
  attempt: number,
): Promise<void> {
  const output = await executeStage(stage, context, attempt, RewriteOutputSchema, () => (
    runStructuredModel(stage, 'rewrite', RewriteOutputSchema, context, agent, () => rewriteFallback(stage, context))
  ))
  if (!output) return
  context.activeQuery = output.rewrittenQuery
  context.alternateQueries = output.alternateQueries.slice(0, Math.max(0, stage.options.queryCount - 1))
}

async function runRetrieve(
  stage: Extract<AdvancedSearchStage, { type: 'retrieve' }>,
  context: RunContext,
  search: SearchRuntime | null,
  agent: AgentRuntime | null,
  attempt: number,
): Promise<void> {
  const output = await executeStage(stage, context, attempt, RetrievalOutputSchema, () => (
    retrieve(stage, context, search, agent)
  ))
  if (!output) context.candidateLists = []
}

async function runFuse(
  stage: Extract<AdvancedSearchStage, { type: 'fuse' }>,
  context: RunContext,
  attempt: number,
): Promise<void> {
  const output = await executeStage(stage, context, attempt, FuseOutputSchema, async () => fuse(stage, context))
  if (!output) context.evidence = []
}

async function runGrade(
  stage: Extract<AdvancedSearchStage, { type: 'grade' }>,
  context: RunContext,
  agent: AgentRuntime | null,
  attempt: number,
): Promise<void> {
  const execution = await executeStage(stage, context, attempt, GradeOutputSchema, async () => {
    const model = await runStructuredModel(
      stage,
      'grade',
      GradeOutputSchema,
      context,
      agent,
      () => gradeFallback(context),
    )
    const output = applyGrade(stage, model.output, context)
    return { ...model, output }
  })
  if (!execution) {
    context.grade = gradeFallback(context)
    context.missingFacts = context.grade.missingFacts
  }
}

async function runGeo(
  stage: Extract<AdvancedSearchStage, { type: 'geo' }>,
  context: RunContext,
): Promise<void> {
  const output = await executeStage(stage, context, 0, GeoOutputSchema, async () => resolveGeo(stage, context))
  if (!output) context.geo = { locations: [], unknownEvidenceIds: context.evidence.map((item) => item.id) }
}

async function runAnswer(
  stage: Extract<AdvancedSearchStage, { type: 'answer' }>,
  context: RunContext,
  agent: AgentRuntime | null,
): Promise<void> {
  const output = await executeStage(stage, context, 0, AnswerOutputSchema, async () => {
    if (context.route === 'clarify') {
      return {
        output: clarificationAnswer(context),
        status: 'degraded',
        note: '分流节点要求先澄清问题；没有读取数据，也没有调用答案模型。',
      }
    }
    if (context.evidence.length === 0 || context.grade?.verdict === 'insufficient') {
      return {
        output: answerFallback(context),
        status: 'degraded',
        note: '证据门禁拒绝了无依据的生成。',
      }
    }
    const model = await runStructuredModel(
      stage,
      'answer',
      AnswerOutputSchema,
      context,
      agent,
      () => answerFallback(context),
    )
    return { ...model, output: sanitizeAnswer(stage, model.output, context) }
  })
  context.final = output
}

function definitionHash(request: AdvancedSearchDryRunRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(request.definition))
    .digest('hex')
}

function evaluation(context: RunContext): Record<string, unknown> {
  const completed = context.traces.filter((trace) => trace.status !== 'skipped')
  const valid = completed.filter((trace) => trace.validation.valid)
  const modelStages = completed.filter((trace) => trace.model)
  const fallbackStages = modelStages.filter((trace) => trace.model?.fallback)
  const modelResponseValidations = modelStages.flatMap((trace) => (
    trace.model?.responseValidation ? [trace.model.responseValidation] : []
  ))
  const citations = context.final?.citations || []
  return {
    schemaPassRate: completed.length === 0 ? 1 : valid.length / completed.length,
    effectiveSchemaPassRate: completed.length === 0 ? 1 : valid.length / completed.length,
    modelSchemaPassRate: modelResponseValidations.length === 0
      ? null
      : modelResponseValidations.filter((item) => item.valid).length / modelResponseValidations.length,
    stageCount: completed.length,
    degradedStages: completed.filter((trace) => trace.status === 'degraded').length,
    failedStages: completed.filter((trace) => trace.status === 'failed').length,
    modelStages: modelStages.length,
    modelFallbackStages: fallbackStages.length,
    evidenceCount: context.evidence.length,
    citationCount: citations.length,
    citationCoverage: context.evidence.length === 0
      ? (context.final?.refused ? 1 : 0)
      : Math.min(1, new Set(citations.map((item) => item.evidenceId)).size / context.evidence.length),
    correctiveRetries: context.retryCount,
  }
}

export async function runAdvancedSearchDryRun({
  body,
  search,
  agent,
}: {
  body: unknown
  search: SearchRuntime | null
  agent: AgentRuntime | null
}): Promise<Record<string, unknown>> {
  const parsed = AdvancedSearchDryRunRequestSchema.safeParse(body)
  if (!parsed.success) throw invalidRequest(parsed.error)
  const request = parsed.data
  if (request.definition.agentKey !== ADVANCED_SEARCH_AGENT_KEY || !request.definition.dryRunOnly) {
    throw new AppError(400, 'agent_market_dry_run_required', 'Only the built-in dry-run Agent is allowed')
  }
  const initialFilters = normalizedFilters(request.filters)
  if (activeDryRuns >= MAX_CONCURRENT_DRY_RUNS) {
    throw new AppError(429, 'agent_market_busy', 'Agent Market already has the maximum number of dry runs in progress')
  }
  activeDryRuns += 1
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MAX_RUN_MS)
  const started = Date.now()
  const stages = stageMap(request)
  const context: RunContext = {
    request,
    signal: controller.signal,
    originalQuery: request.query,
    route: 'knowledge_search',
    routeReason: 'Dry-run 默认知识检索分支。',
    normalizedQuestion: request.query,
    filters: initialFilters,
    activeQuery: request.query,
    alternateQueries: [],
    missingFacts: [],
    candidateLists: [],
    evidence: [],
    grade: null,
    geo: { locations: [], unknownEvidenceIds: [] },
    final: null,
    retryCount: 0,
    traces: [],
  }

  try {
    const triage = stages.get('triage') as Extract<AdvancedSearchStage, { type: 'triage' }>
    if (triage.state === 'active') await runTriage(triage, context, agent)
    else context.traces.push(skippedTrace(triage, context, 0, '阶段位于回收站；默认进入 knowledge_search。'))

    const rewrite = stages.get('rewrite') as Extract<AdvancedSearchStage, { type: 'rewrite' }>
    const retrieveStage = stages.get('retrieve') as Extract<AdvancedSearchStage, { type: 'retrieve' }>
    const fuseStage = stages.get('fuse') as Extract<AdvancedSearchStage, { type: 'fuse' }>
    const gradeStage = stages.get('grade') as Extract<AdvancedSearchStage, { type: 'grade' }>

    if (shouldSkipForBranch('rewrite', context)) {
      context.traces.push(skippedTrace(rewrite, context, 0, '分流结果要求先澄清问题。'))
    } else if (context.route === 'structured_filter') {
      context.activeQuery = context.normalizedQuestion
      context.traces.push(skippedTrace(rewrite, context, 0, 'structured_filter 分支保留标准化问题和受控过滤条件，不做生成式改写。'))
    } else if (rewrite.state === 'active') {
      await runRewrite(rewrite, context, agent, 0)
    } else {
      context.traces.push(skippedTrace(rewrite, context, 0, '阶段位于回收站；使用原始查询。'))
    }

    if (shouldSkipForBranch('retrieve', context)) {
      context.traces.push(skippedTrace(retrieveStage, context, 0, '分流结果要求先澄清问题。'))
    } else if (retrieveStage.state === 'active') {
      await runRetrieve(retrieveStage, context, search, agent, 0)
    } else {
      context.traces.push(skippedTrace(retrieveStage, context, 0, '阶段位于回收站；不会读取 PG / ES。'))
    }

    if (shouldSkipForBranch('fuse', context)) {
      context.traces.push(skippedTrace(fuseStage, context, 0, '分流结果要求先澄清问题。'))
    } else if (fuseStage.state === 'active') {
      await runFuse(fuseStage, context, 0)
    } else {
      context.evidence = context.candidateLists.flatMap((list) => list.items).slice(0, 20)
      context.traces.push(skippedTrace(fuseStage, context, 0, '阶段位于回收站；候选按召回顺序直通。'))
    }

    if (shouldSkipForBranch('grade', context)) {
      context.traces.push(skippedTrace(gradeStage, context, 0, '分流结果要求先澄清问题。'))
    } else if (gradeStage.state === 'active') {
      await runGrade(gradeStage, context, agent, 0)
    } else {
      context.traces.push(skippedTrace(gradeStage, context, 0, '阶段位于回收站；融合证据未经模型评分。'))
    }

    const correctiveReady = context.route !== 'clarify'
      && gradeStage.state === 'active'
      && gradeStage.options.maxRetries > 0
      && context.grade?.verdict !== 'useful'
      && rewrite.state === 'active'
      && retrieveStage.state === 'active'
      && fuseStage.state === 'active'
    if (correctiveReady) {
      context.retryCount = 1
      await runRewrite(rewrite, context, agent, 1)
      if (context.alternateQueries[0]) context.activeQuery = context.alternateQueries[0]
      await runRetrieve(retrieveStage, context, search, agent, 1)
      await runFuse(fuseStage, context, 1)
      await runGrade(gradeStage, context, agent, 1)
    }

    const geo = stages.get('geo') as Extract<AdvancedSearchStage, { type: 'geo' }>
    if (shouldSkipForBranch('geo', context)) {
      context.traces.push(skippedTrace(geo, context, 0, '分流结果要求先澄清问题。'))
    } else if (geo.state === 'active') {
      await runGeo(geo, context)
    } else {
      context.traces.push(skippedTrace(geo, context, 0, '阶段位于回收站；不执行地理归一。'))
    }

    const answer = stages.get('answer') as Extract<AdvancedSearchStage, { type: 'answer' }>
    if (answer.state === 'active') {
      await runAnswer(answer, context, agent)
    } else {
      context.traces.push(skippedTrace(answer, context, 0, '阶段位于回收站；本次没有最终答案。'))
    }

    if (controller.signal.aborted) {
      throw new AppError(504, 'agent_market_timeout', 'The Agent Market dry run exceeded its deadline')
    }
    const finishedAt = new Date().toISOString()
    return {
      contractVersion: 'mx-insight.agent-market.dry-run.v1',
      agentKey: ADVANCED_SEARCH_AGENT_KEY,
      dryRun: true,
      definitionHash: definitionHash(request),
      startedAt: new Date(started).toISOString(),
      finishedAt,
      durationMs: Date.now() - started,
      graph: {
        lockedEntry: 'access-and-dry-run-gate',
        stages: ADVANCED_SEARCH_STAGE_TYPES,
        lockedExit: 'trace-and-eval-gate',
      },
      safety: {
        writes: 0,
        queueJobs: 0,
        outboxEvents: 0,
        publicSearchMutations: 0,
        nightAllCalls: 0,
        arbitrarySql: false,
        arbitraryElasticsearchDsl: false,
      },
      dataAccess: {
        postgres: context.traces.some((trace) => JSON.stringify(trace.toolCalls).includes('postgres')),
        elasticsearch: context.traces.some((trace) => JSON.stringify(trace.toolCalls).includes('elasticsearch')),
        modelAvailable: Boolean(agent?.available),
      },
      traces: context.traces,
      final: context.final,
      evaluation: evaluation(context),
    }
  } finally {
    clearTimeout(timeout)
    activeDryRuns -= 1
  }
}
