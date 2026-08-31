import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowCounterClockwise,
  BracketsCurly,
  Brain,
  CaretLeft,
  CaretRight,
  Database,
  FloppyDisk,
  FlowArrow,
  LockKey,
  MagnifyingGlass,
  PencilSimple,
  Play,
  Plus,
  Pulse,
  Recycle,
  ShieldCheck,
  Storefront,
  Trash,
  Warning,
  Wrench,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  getAgentMarketRunHistoryStorage,
  inspectAgentMarketRunTerminal,
  readAgentMarketRunHistory,
  rememberAgentMarketRun,
  type AgentMarketRunTerminalAudit,
} from './agent-market-run-history.ts'
import {
  ConfirmDialog,
  DropdownField,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  PageHeading,
  StatusBadge,
  useRemoteData,
} from './components.jsx'
import {
  ADVANCED_SEARCH_AGENT_KEY,
  ADVANCED_SEARCH_STAGE_TYPES,
  AdvancedSearchDefinitionSchema,
  type AdvancedSearchDefinition,
  type AdvancedSearchStage,
  type AdvancedSearchStageType,
} from '../agent-market/advanced-search/schemas.ts'
import {
  ADVANCED_SEARCH_INPUT_EXAMPLE,
  ADVANCED_SEARCH_STAGE_META,
  ADVANCED_SEARCH_TOOLS,
  freshAdvancedSearchDefinition,
  jsonSchemaForStage,
} from '../agent-market/advanced-search/manifest.ts'
import './agent-market.css'

type Snapshot = {
  agentKey: string
  revision: number
  source: 'builtin' | 'database'
  definition: AdvancedSearchDefinition
  updatedBy: string | null
  updatedAt: string | null
}

type CatalogCategory = {
  categoryKey: string
  name: string
  description: string
  sortOrder: number
  revision: number
  builtin: boolean
  agentCount: number
  createdAt: string | null
  updatedAt: string | null
}

type AgentLifecycle = 'draft' | 'published' | 'disabled'

type CatalogAgent = {
  agentKey: string
  name: string
  summary: string
  categoryKey: string
  kind: 'builtin' | 'custom'
  lifecycle: AgentLifecycle
  executorKey: string | null
  runnable: boolean
  dryRunOnly: boolean
  tags: string[]
  revision: number
  builtin: boolean
  updatedAt: string | null
  lastRun: unknown | null
}

type Catalog = {
  categories: CatalogCategory[]
  agents: CatalogAgent[]
}

type TraceStatus = 'succeeded' | 'degraded' | 'skipped' | 'failed' | 'unknown'

type StageTrace = {
  stageId: string
  type: AdvancedSearchStageType
  title: string
  attempt: number
  status: TraceStatus
  durationMs: number | null
  input: unknown
  messages: Array<{ role: string, content: string }>
  parameters: Record<string, unknown>
  toolCalls: Array<Record<string, unknown>>
  output: unknown
  validation: {
    schemaName: string
    valid: boolean | null
    issues: Array<{ path: string, message: string }>
  }
  model: null | {
    sequenceKey: string | null
    provider: string | null
    model: string | null
    proxy: string | null
    temperature: number | null
    effectiveTemperature: number | null
    maxTokens: number | null
    latencyMs: number | null
    inputTokens: number | null
    outputTokens: number | null
    fallback: boolean
    errorCode: string | null
    responseValidation: null | {
      valid: boolean | null
      issues: Array<{ path: string, message: string }>
    }
  }
  note: string | null
}

type DryRunResult = {
  contractVersion: string
  definitionHash: string
  durationMs: number | null
  safety: Record<string, unknown>
  dataAccess: Record<string, unknown>
  traces: StageTrace[]
  final: null | {
    answer: string
    citations: Array<{ evidenceId: string, claim: string }>
    confidence: number | null
    limitations: string[]
    refused: boolean
  }
  evaluation: Record<string, unknown>
}

type PageProps = {
  token: string
  session: { kind?: string } | null
  onUnauthorized?: (error: unknown) => void
  notify?: (message: string, tone?: string) => void
}

type FilterDraft = {
  platform: string
  datasetId: string
  objectType: string
  fromTime: string
  toTime: string
}

type InspectorTab = 'input' | 'prompt' | 'schema' | 'output' | 'tool' | 'metrics'
type CompareTarget = 'previous' | 'baseline'

const EMPTY_FILTERS: FilterDraft = {
  platform: '',
  datasetId: '',
  objectType: '',
  fromTime: '',
  toTime: '',
}

const SEARCH_PROFILE_OPTIONS = [
  { value: 'canonical.balanced.v1', label: 'Balanced · 默认严格检索' },
  { value: 'canonical.phrase.v1', label: 'Phrase · 原文短语' },
  { value: 'canonical.terms-all.v1', label: 'Terms All · 全词命中' },
  { value: 'canonical.zh-recall.v1', label: 'ZH Recall · 中文召回' },
  { value: 'canonical.title-prefix.v1', label: 'Title Prefix · 标题前缀' },
]

const INSPECTOR_TABS: Array<{ id: InspectorTab, label: string }> = [
  { id: 'input', label: 'Input' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'schema', label: 'Schema' },
  { id: 'output', label: 'Output' },
  { id: 'tool', label: 'Tool' },
  { id: 'metrics', label: 'Metrics' },
]

const LIFECYCLE_OPTIONS = [
  { value: 'draft', label: '草稿', description: '保留配置，暂不作为正式市场条目。' },
  { value: 'published', label: '已发布', description: '在 Agent Market 中正常展示。' },
  { value: 'disabled', label: '已停用', description: '保留历史，但禁止运行。' },
]

const GRAPH_X = [74, 222, 370, 518, 666, 814, 962]
const INSPECTOR_COLLAPSED_STORAGE_KEY = 'mx-insight-hub.agent-market.inspector-collapsed'

function readInspectorCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeInspectorCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(INSPECTOR_COLLAPSED_STORAGE_KEY, String(collapsed))
  } catch {
    // The workbench remains usable when storage is blocked or exhausted.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeCategory(value: unknown): CatalogCategory | null {
  if (!isRecord(value)) return null
  const categoryKey = stringValue(value.categoryKey).trim()
  if (!categoryKey) return null
  return {
    categoryKey,
    name: stringValue(value.name, categoryKey),
    description: stringValue(value.description),
    sortOrder: numberValue(value.sortOrder),
    revision: Math.max(0, Math.trunc(numberValue(value.revision))),
    builtin: value.builtin === true || value.systemOwned === true,
    agentCount: Math.max(0, Math.trunc(numberValue(value.agentCount))),
    createdAt: nullableString(value.createdAt),
    updatedAt: nullableString(value.updatedAt),
  }
}

function normalizeAgent(value: unknown): CatalogAgent | null {
  if (!isRecord(value)) return null
  const agentKey = stringValue(value.agentKey).trim()
  if (!agentKey) return null
  const kind = value.kind === 'builtin' || value.systemOwned === true ? 'builtin' : 'custom'
  const lifecycle: AgentLifecycle = value.lifecycle === 'draft'
    || value.lifecycle === 'published'
    || value.lifecycle === 'disabled'
    ? value.lifecycle
    : value.enabled === false ? 'disabled' : value.enabled === true ? 'published' : 'draft'
  return {
    agentKey,
    name: stringValue(value.name, stringValue(value.displayName, agentKey)),
    summary: stringValue(value.summary, stringValue(value.description)),
    categoryKey: stringValue(value.categoryKey),
    kind,
    lifecycle,
    executorKey: nullableString(value.executorKey),
    runnable: value.runnable === true,
    dryRunOnly: value.dryRunOnly === true,
    tags: Array.isArray(value.tags)
      ? [...new Set(value.tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()))
        .map((tag) => tag.trim()))]
      : [],
    revision: Math.max(0, Math.trunc(numberValue(value.revision))),
    builtin: value.builtin === true || value.systemOwned === true,
    updatedAt: nullableString(value.updatedAt),
    lastRun: value.lastRun ?? null,
  }
}

function normalizeCatalog(value: unknown): Catalog {
  if (!isRecord(value)) return { categories: [], agents: [] }
  const categories = (Array.isArray(value.categories) ? value.categories : [])
    .map(normalizeCategory)
    .filter((item): item is CatalogCategory => Boolean(item))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'))
  const agents = (Array.isArray(value.agents) ? value.agents : [])
    .map(normalizeAgent)
    .filter((item): item is CatalogAgent => Boolean(item))
  return { categories, agents }
}

function normalizeIssues(value: unknown): Array<{ path: string, message: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    return [{ path: stringValue(item.path), message: stringValue(item.message, '未知校验问题') }]
  })
}

function normalizeTrace(value: unknown): StageTrace | null {
  if (!isRecord(value)) return null
  const type = stringValue(value.type)
  if (!ADVANCED_SEARCH_STAGE_TYPES.includes(type as AdvancedSearchStageType)) return null
  const status: TraceStatus = value.status === 'succeeded'
    || value.status === 'degraded'
    || value.status === 'skipped'
    || value.status === 'failed'
    ? value.status
    : 'unknown'
  const validation = isRecord(value.validation) ? value.validation : {}
  const modelValue = isRecord(value.model) ? value.model : null
  const responseValidation = modelValue && isRecord(modelValue.responseValidation)
    ? modelValue.responseValidation
    : null
  const messages = Array.isArray(value.messages)
    ? value.messages.flatMap((message) => isRecord(message)
      ? [{ role: stringValue(message.role, 'unknown'), content: stringValue(message.content) }]
      : [])
    : []
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.filter(isRecord) : []
  return {
    stageId: stringValue(value.stageId, type),
    type: type as AdvancedSearchStageType,
    title: stringValue(value.title, ADVANCED_SEARCH_STAGE_META[type as AdvancedSearchStageType].label),
    attempt: Math.max(0, Math.trunc(numberValue(value.attempt))),
    status,
    durationMs: nullableNumber(value.durationMs),
    input: value.input,
    messages,
    parameters: isRecord(value.parameters) ? value.parameters : {},
    toolCalls,
    output: value.output,
    validation: {
      schemaName: stringValue(validation.schemaName),
      valid: typeof validation.valid === 'boolean' ? validation.valid : null,
      issues: normalizeIssues(validation.issues),
    },
    model: modelValue ? {
      sequenceKey: nullableString(modelValue.sequenceKey),
      provider: nullableString(modelValue.provider),
      model: nullableString(modelValue.model),
      proxy: nullableString(modelValue.proxy)
        || nullableString(modelValue.proxyKey)
        || nullableString(modelValue.route),
      temperature: nullableNumber(modelValue.temperature),
      effectiveTemperature: nullableNumber(modelValue.effectiveTemperature),
      maxTokens: nullableNumber(modelValue.maxTokens),
      latencyMs: nullableNumber(modelValue.latencyMs),
      inputTokens: nullableNumber(modelValue.inputTokens),
      outputTokens: nullableNumber(modelValue.outputTokens),
      fallback: modelValue.fallback === true,
      errorCode: nullableString(modelValue.errorCode),
      responseValidation: responseValidation ? {
        valid: typeof responseValidation.valid === 'boolean' ? responseValidation.valid : null,
        issues: normalizeIssues(responseValidation.issues),
      } : null,
    } : null,
    note: nullableString(value.note),
  }
}

function normalizeRun(value: unknown): DryRunResult | null {
  const candidates = [
    value,
    isRecord(value) ? value.result : null,
    isRecord(value) ? value.run : null,
    isRecord(value) ? value.payload : null,
  ]
  const source = candidates.find((candidate) => isRecord(candidate) && Array.isArray(candidate.traces))
  if (!isRecord(source)) return null
  const finalValue = isRecord(source.final) ? source.final : null
  const citations = finalValue && Array.isArray(finalValue.citations)
    ? finalValue.citations.flatMap((citation) => isRecord(citation)
      ? [{ evidenceId: stringValue(citation.evidenceId), claim: stringValue(citation.claim) }]
      : [])
    : []
  return {
    contractVersion: stringValue(source.contractVersion),
    definitionHash: stringValue(source.definitionHash),
    durationMs: nullableNumber(source.durationMs),
    safety: isRecord(source.safety) ? source.safety : {},
    dataAccess: isRecord(source.dataAccess) ? source.dataAccess : {},
    traces: (source.traces as unknown[]).map(normalizeTrace).filter((trace): trace is StageTrace => Boolean(trace)),
    final: finalValue ? {
      answer: stringValue(finalValue.answer),
      citations,
      confidence: nullableNumber(finalValue.confidence),
      limitations: Array.isArray(finalValue.limitations)
        ? finalValue.limitations.filter((item): item is string => typeof item === 'string')
        : [],
      refused: finalValue.refused === true,
    } : null,
    evaluation: isRecord(source.evaluation) ? source.evaluation : {},
  }
}

function pretty(value: unknown): string {
  if (value === undefined) return '—'
  try {
    return JSON.stringify(value, null, 2) ?? '—'
  } catch {
    return String(value)
  }
}

function nullable(value: string): string | null {
  return value.trim() || null
}

function nullableDateTime(value: string): string | null {
  return value.trim() ? new Date(value).toISOString() : null
}

function definitionText(definition: AdvancedSearchDefinition): string {
  return JSON.stringify(definition)
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatMilliseconds(value: number | null): string {
  return value == null ? '—' : Math.round(value) + ' ms'
}

function metricNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number.isInteger(value) ? String(value) : value.toFixed(2)
    : '—'
}

function metricFrom(result: DryRunResult | null, ...keys: string[]): number | null {
  if (!result) return null
  for (const key of keys) {
    const value = result.evaluation[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function percentMetric(value: number | null): string {
  return value == null ? '—' : (value * 100).toFixed(value * 100 < 10 ? 1 : 0) + '%'
}

function traceTone(status: TraceStatus): string {
  if (status === 'succeeded') return 'active'
  if (status === 'degraded') return 'degraded'
  if (status === 'failed') return 'down'
  return 'disabled'
}

function traceLabel(status: TraceStatus): string {
  if (status === 'succeeded') return '成功'
  if (status === 'degraded') return '降级'
  if (status === 'failed') return '失败'
  if (status === 'skipped') return '跳过'
  return '未知'
}

function traceDisplayLabel(trace: StageTrace): string {
  return traceLabel(trace.status) + ' · ' + formatMilliseconds(trace.durationMs)
}

function traceReason(trace: StageTrace): string {
  if (trace.note) return trace.note
  if (trace.model?.errorCode) return '模型返回降级码：' + trace.model.errorCode
  const issue = trace.validation.issues[0] || trace.model?.responseValidation?.issues[0]
  if (issue) return (issue.path ? issue.path + '：' : '') + issue.message
  if (trace.status === 'skipped') return '该阶段未执行；服务端未返回具体跳过原因。'
  if (trace.status === 'degraded') return '该阶段已走降级路径；服务端未返回具体原因。'
  if (trace.status === 'failed') return '该阶段执行失败；服务端未返回具体原因。'
  if (trace.status === 'succeeded') return '该阶段已按服务端 Trace 标记为成功完成。'
  return '服务端 Trace 未返回补充说明。'
}

function lifecycleLabel(lifecycle: AgentLifecycle): string {
  if (lifecycle === 'published') return '已发布'
  if (lifecycle === 'disabled') return '已停用'
  return '草稿'
}

function lifecycleTone(lifecycle: AgentLifecycle): string {
  if (lifecycle === 'published') return 'active'
  if (lifecycle === 'disabled') return 'disabled'
  return 'degraded'
}

function lastRunSummary(value: unknown): string {
  if (value == null) return '暂无运行'
  const run = normalizeRun(value)
  if (run) {
    const failed = run.traces.some((trace) => trace.status === 'failed')
    const degraded = run.traces.some((trace) => trace.status === 'degraded')
    const status = failed ? '失败' : degraded ? '降级' : run.traces.length ? '完成' : '已有记录'
    return run.durationMs == null ? status : status + ' · ' + formatMilliseconds(run.durationMs)
  }
  if (!isRecord(value)) return '已有运行记录'
  const status = nullableString(value.status) || nullableString(value.outcome)
  const duration = nullableNumber(value.durationMs)
  const at = nullableString(value.finishedAt) || nullableString(value.updatedAt) || nullableString(value.createdAt)
  return [status, duration == null ? null : formatMilliseconds(duration), at ? formatDateTime(at) : null]
    .filter(Boolean)
    .join(' · ') || '已有运行记录'
}

function setStageState(
  definition: AdvancedSearchDefinition,
  stageId: string,
  state: 'active' | 'trashed',
): AdvancedSearchDefinition {
  const next = structuredClone(definition)
  const stage = next.stages.find((candidate) => candidate.id === stageId)
  if (stage) stage.state = state
  return next
}

function updateStage(
  definition: AdvancedSearchDefinition,
  stageId: string,
  mutate: (stage: AdvancedSearchStage) => void,
): AdvancedSearchDefinition {
  const next = structuredClone(definition)
  const stage = next.stages.find((candidate) => candidate.id === stageId)
  if (stage) mutate(stage)
  return next
}

function latestTrace(traces: StageTrace[]): StageTrace | null {
  return traces.length ? traces[traces.length - 1] : null
}

function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={'qp-panel mih-panel mih-market-panel ' + className}>
      <header className="mih-panel__header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="mih-page-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

function StageOptionsEditor({
  stage,
  disabled,
  onChange,
}: {
  stage: AdvancedSearchStage
  disabled: boolean
  onChange: (mutate: (stage: AdvancedSearchStage) => void) => void
}) {
  if (stage.type === 'retrieve') {
    return (
      <div className="mih-market-option-grid">
        <Field label="Top K" hint="每个召回后端最多返回 1–20 条。">
          <input className="qp-input" type="number" min="1" max="20" value={stage.options.topK}
            disabled={disabled} onChange={(event) => {
              const value = Number(event.target.value)
              onChange((candidate) => {
                if (candidate.type === 'retrieve' && Number.isInteger(value)) candidate.options.topK = value
              })
            }} />
        </Field>
        <DropdownField
          label="Search Profile"
          value={stage.options.searchProfile}
          options={SEARCH_PROFILE_OPTIONS as never[]}
          disabled={disabled}
          onChange={(value: string) => onChange((candidate) => {
            if (candidate.type === 'retrieve') {
              candidate.options.searchProfile = value as typeof candidate.options.searchProfile
            }
          })}
          hint="只允许 Hub 已发布的检索 Profile；不接受任意 ES DSL。"
        />
        <label className="mih-market-check">
          <input type="checkbox" checked={stage.options.includeSemantic} disabled={disabled}
            onChange={(event) => onChange((candidate) => {
              if (candidate.type === 'retrieve') candidate.options.includeSemantic = event.target.checked
            })} />
          <span><strong>包含语义召回</strong><small>Embedding 不可用时明确显示 lexical-only。</small></span>
        </label>
      </div>
    )
  }
  if (stage.type === 'fuse') {
    return (
      <div className="mih-market-option-grid">
        <Field label="RRF k" hint="阻尼常数；不直接混合不可比较的原始分数。">
          <input className="qp-input" type="number" min="10" max="100" value={stage.options.rrfK}
            disabled={disabled} onChange={(event) => {
              const value = Number(event.target.value)
              onChange((candidate) => {
                if (candidate.type === 'fuse' && Number.isInteger(value)) candidate.options.rrfK = value
              })
            }} />
        </Field>
        <Field label="融合后 Top K" hint="融合、去重后最多保留 1–20 条。">
          <input className="qp-input" type="number" min="1" max="20" value={stage.options.topK}
            disabled={disabled} onChange={(event) => {
              const value = Number(event.target.value)
              onChange((candidate) => {
                if (candidate.type === 'fuse' && Number.isInteger(value)) candidate.options.topK = value
              })
            }} />
        </Field>
      </div>
    )
  }
  if (stage.type === 'geo') {
    return (
      <Field label={'最低置信度 · ' + stage.options.minConfidence.toFixed(2)}
        hint="结构化地理字段为 1.0，正文 taxonomy 命中为 0.9。">
        <input className="mih-market-range" type="range" min="0" max="1" step="0.05"
          value={stage.options.minConfidence} disabled={disabled}
          onChange={(event) => onChange((candidate) => {
            if (candidate.type === 'geo') candidate.options.minConfidence = Number(event.target.value)
          })} />
      </Field>
    )
  }
  if (stage.type === 'rewrite') {
    return (
      <Field label="查询数量" hint="首轮 1 条；纠错回环最多携带 2 条备选。">
        <input className="qp-input" type="number" min="1" max="3" value={stage.options.queryCount}
          disabled={disabled} onChange={(event) => {
            const value = Number(event.target.value)
            onChange((candidate) => {
              if (candidate.type === 'rewrite' && Number.isInteger(value)) candidate.options.queryCount = value
            })
          }} />
      </Field>
    )
  }
  if (stage.type === 'grade') {
    return (
      <div className="mih-market-option-grid">
        <Field label={'最低相关度 · ' + stage.options.minRelevance.toFixed(2)}
          hint="低于阈值的证据不会进入答案阶段。">
          <input className="mih-market-range" type="range" min="0" max="1" step="0.05"
            value={stage.options.minRelevance} disabled={disabled}
            onChange={(event) => onChange((candidate) => {
              if (candidate.type === 'grade') candidate.options.minRelevance = Number(event.target.value)
            })} />
        </Field>
        <Field label="最大纠错回环" hint="强制 0 或 1，避免无限模型/检索调用。">
          <input className="qp-input" type="number" min="0" max="1" value={stage.options.maxRetries}
            disabled={disabled} onChange={(event) => {
              const value = Number(event.target.value)
              onChange((candidate) => {
                if (candidate.type === 'grade' && Number.isInteger(value)) candidate.options.maxRetries = value
              })
            }} />
        </Field>
      </div>
    )
  }
  if (stage.type === 'answer') {
    return (
      <label className="mih-market-check">
        <input type="checkbox" checked={stage.options.requireCitations} disabled={disabled}
          onChange={(event) => onChange((candidate) => {
            if (candidate.type === 'answer') candidate.options.requireCitations = event.target.checked
          })} />
        <span><strong>强制引用</strong><small>无有效 evidence ID 时进入明确拒答。</small></span>
      </label>
    )
  }
  return null
}

function PromptEditor({
  stage,
  disabled,
  onChange,
}: {
  stage: AdvancedSearchStage
  disabled: boolean
  onChange: (mutate: (stage: AdvancedSearchStage) => void) => void
}) {
  const modelStage = 'prompt' in stage && 'model' in stage
  return (
    <div className="mih-market-editor">
      {modelStage ? (
        <>
          <Field label="system" hint="运行时追加不可编辑的 Schema / 安全契约。">
            <textarea className="qp-input mih-market-prompt" value={stage.prompt.system}
              disabled={disabled} onChange={(event) => onChange((candidate) => {
                if ('prompt' in candidate) candidate.prompt.system = event.target.value
              })} />
          </Field>
          <Field label="user template" hint="支持 {{query}}、{{filters}}、{{evidence}}、{{geo}}。">
            <textarea className="qp-input mih-market-prompt" value={stage.prompt.user}
              disabled={disabled} onChange={(event) => onChange((candidate) => {
                if ('prompt' in candidate) candidate.prompt.user = event.target.value
              })} />
          </Field>
          <div className="mih-market-option-grid">
            <Field label={'Temperature · ' + stage.model.temperature.toFixed(2)}
              hint="每阶段独立控制。">
              <input className="mih-market-range" type="range" min="0" max="2" step="0.05"
                value={stage.model.temperature} disabled={disabled}
                onChange={(event) => onChange((candidate) => {
                  if ('model' in candidate) candidate.model.temperature = Number(event.target.value)
                })} />
            </Field>
            <Field label="Max Tokens" hint="运行时硬限制为 64–4096。">
              <input className="qp-input" type="number" min="64" max="4096" step="64"
                value={stage.model.maxTokens} disabled={disabled}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  onChange((candidate) => {
                    if ('model' in candidate && Number.isInteger(value)) candidate.model.maxTokens = value
                  })
                }} />
            </Field>
          </div>
        </>
      ) : (
        <div className="mih-market-tool-note">
          <Wrench size={20} weight="duotone" aria-hidden="true" />
          <div><strong>固定工具阶段</strong><p>没有 Prompt 或 temperature；工具输入由代码和 Zod 限制。</p></div>
        </div>
      )}
      <StageOptionsEditor stage={stage} disabled={disabled} onChange={onChange} />
    </div>
  )
}

function CategoryEditorModal({
  category,
  busy,
  onClose,
  onDelete,
  onSubmit,
}: {
  category: CatalogCategory | null
  busy: boolean
  onClose: () => void
  onDelete?: () => void
  onSubmit: (value: { categoryKey: string, name: string, description?: string, sortOrder: number }) => void
}) {
  const [categoryKey, setCategoryKey] = useState(category?.categoryKey || '')
  const [name, setName] = useState(category?.name || '')
  const [description, setDescription] = useState(category?.description || '')
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 100))
  const formId = category ? 'mih-market-category-edit' : 'mih-market-category-create'
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit({
      categoryKey: categoryKey.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      sortOrder: Number(sortOrder),
    })
  }
  return (
    <Modal
      title={category ? '编辑分类' : '新建分类'}
      description={category ? 'revision ' + category.revision + ' · ' + category.agentCount + ' 个 Agent' : '创建可复用的市场导航分类。'}
      size="small"
      busy={busy}
      initialFocusRef={undefined}
      onClose={onClose}
      footer={(
        <>
          {category && onDelete ? (
            <button className="qp-button qp-button--danger" type="button" disabled={busy} onClick={onDelete}>
              <Trash size={16} aria-hidden="true" />删除分类
            </button>
          ) : null}
          <span className="mih-market-modal-spacer" />
          <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="qp-button qp-button--primary" type="submit" form={formId} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      )}
    >
      <form id={formId} className="mih-market-form" onSubmit={submit}>
        <Field label="Category Key" hint="创建后不可修改；建议使用小写字母、数字、点、下划线或短横线。">
          <input className="qp-input" required autoFocus={!category} pattern="[a-z0-9][a-z0-9._-]{0,63}"
            value={categoryKey} disabled={Boolean(category) || busy}
            onChange={(event) => setCategoryKey(event.target.value)} />
        </Field>
        <Field label="分类名称" hint={undefined}>
          <input className="qp-input" required maxLength={120} value={name} disabled={busy}
            onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="说明" hint={undefined}>
          <textarea className="qp-input" maxLength={1000} value={description} disabled={busy}
            onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label="排序" hint="数值越小越靠前。">
          <input className="qp-input" required type="number" min="0" max="10000"
            value={sortOrder} disabled={busy} onChange={(event) => setSortOrder(event.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

function AgentEditorModal({
  agent,
  categories,
  busy,
  onClose,
  onSubmit,
}: {
  agent: CatalogAgent | null
  categories: CatalogCategory[]
  busy: boolean
  onClose: () => void
  onSubmit: (value: {
    agentKey: string
    name: string
    summary?: string
    categoryKey: string
    tags: string[]
    lifecycle: AgentLifecycle
  }) => void
}) {
  const [agentKey, setAgentKey] = useState(agent?.agentKey || '')
  const [name, setName] = useState(agent?.name || '')
  const [summary, setSummary] = useState(agent?.summary || '')
  const [categoryKey, setCategoryKey] = useState(agent?.categoryKey || categories[0]?.categoryKey || '')
  const [tags, setTags] = useState(agent?.tags.join(', ') || '')
  const [lifecycle, setLifecycle] = useState<AgentLifecycle>(agent?.lifecycle || 'draft')
  const formId = agent ? 'mih-market-agent-edit' : 'mih-market-agent-create'
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit({
      agentKey: agentKey.trim(),
      name: name.trim(),
      summary: summary.trim() || undefined,
      categoryKey,
      tags: [...new Set(tags.split(',').map((tag) => tag.trim()).filter(Boolean))],
      lifecycle,
    })
  }
  return (
    <Modal
      title={agent ? '编辑 Agent' : '新建 Agent'}
      description={agent
        ? (agent.kind === 'builtin' ? '内置' : '自定义') + ' · revision ' + agent.revision
        : '自定义 Agent 先进入目录；执行器需由服务端能力接入。'}
      size="medium"
      busy={busy}
      initialFocusRef={undefined}
      onClose={onClose}
      footer={(
        <>
          <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="qp-button qp-button--primary" type="submit" form={formId} disabled={busy || !categoryKey}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      )}
    >
      <form id={formId} className="mih-market-form" onSubmit={submit}>
        <Field label="Agent Key" hint="创建后不可修改。">
          <input className="qp-input" required autoFocus={!agent} pattern="[a-z0-9][a-z0-9._-]{0,126}"
            value={agentKey} disabled={Boolean(agent) || busy}
            onChange={(event) => setAgentKey(event.target.value)} />
        </Field>
        <Field label="Agent 名称" hint={undefined}>
          <input className="qp-input" required maxLength={120} value={name} disabled={busy}
            onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="简介" hint={undefined}>
          <textarea className="qp-input" maxLength={1000} value={summary} disabled={busy}
            onChange={(event) => setSummary(event.target.value)} />
        </Field>
        <DropdownField label="分类" required value={categoryKey} disabled={busy}
          options={categories.map((category) => ({
            value: category.categoryKey,
            label: category.name,
            description: category.description || category.categoryKey,
          })) as never[]}
          onChange={setCategoryKey} />
        <Field label="标签" hint="使用英文逗号分隔。">
          <input className="qp-input" value={tags} disabled={busy}
            onChange={(event) => setTags(event.target.value)} />
        </Field>
        {agent ? (
          <>
            <DropdownField label="生命周期" value={lifecycle} disabled={busy}
              options={LIFECYCLE_OPTIONS.filter((option) => agent.executorKey
                ? option.value !== 'draft'
                : option.value !== 'published') as never[]}
              onChange={(value: AgentLifecycle) => setLifecycle(value)} />
            <div className="mih-market-readonly">
              <span>Executor</span>
              <strong>{agent.executorKey || '未配置执行器'}</strong>
              <small>执行器由服务端注册，目录表单不会伪造或覆盖它。</small>
            </div>
          </>
        ) : (
          <div className="mih-inline-warning">
            <LockKey size={17} aria-hidden="true" />
            新建的 custom Agent 默认未配置执行器，因此不能运行；可先用于流程设计与目录管理。
          </div>
        )}
      </form>
    </Modal>
  )
}

function CatalogRail({
  catalog,
  loading,
  selectedAgentKey,
  selectedCategory,
  search,
  canAdmin,
  onSelectAgent,
  onCategory,
  onSearch,
  onCreateCategory,
  onEditCategory,
  onCreateAgent,
  onEditAgent,
  onToggleAgent,
}: {
  catalog: Catalog
  loading: boolean
  selectedAgentKey: string
  selectedCategory: string
  search: string
  canAdmin: boolean
  onSelectAgent: (agentKey: string) => void
  onCategory: (categoryKey: string) => void
  onSearch: (value: string) => void
  onCreateCategory: () => void
  onEditCategory: (category: CatalogCategory) => void
  onCreateAgent: () => void
  onEditAgent: (agent: CatalogAgent) => void
  onToggleAgent: (agent: CatalogAgent) => void
}) {
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN')
  const agents = catalog.agents.filter((agent) => {
    if (selectedCategory !== 'all' && agent.categoryKey !== selectedCategory) return false
    if (!normalizedSearch) return true
    return [agent.name, agent.summary, agent.agentKey, ...agent.tags]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch))
  })
  const currentCategory = catalog.categories.find((category) => category.categoryKey === selectedCategory)
  const categoryOptions = [
    { value: 'all', label: '全部分类 · ' + catalog.agents.length },
    ...catalog.categories.map((category) => ({
      value: category.categoryKey,
      label: category.name + ' · ' + category.agentCount,
      description: category.description || category.categoryKey,
    })),
  ]
  return (
    <aside className="mih-market-catalog" aria-label="Agent Market 目录">
      <header className="mih-market-catalog__header">
        <div><p className="qp-kicker">AGENT MARKET</p><h2>Agent Market</h2></div>
        {canAdmin ? (
          <div className="mih-market-catalog__create">
            <button className="qp-button qp-button--ghost qp-icon-button" type="button"
              aria-label="新建分类" title="新建分类" onClick={onCreateCategory}>
              <Plus size={16} aria-hidden="true" />
            </button>
            <button className="qp-button qp-button--primary qp-icon-button" type="button"
              aria-label="新建 Agent" title="新建 Agent" disabled={!catalog.categories.length}
              onClick={onCreateAgent}>
              <Brain size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </header>
      <label className="mih-market-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <span className="mih-sr-only">搜索 Agent</span>
        <input type="search" value={search} placeholder="搜索名称、描述或标签…"
          onChange={(event) => onSearch(event.target.value)} />
      </label>
      <div className="mih-market-category-select">
        <DropdownField label="分类" className="mih-market-compact-dropdown" value={selectedCategory} options={categoryOptions as never[]}
          onChange={onCategory} />
        {canAdmin && currentCategory ? (
          <button className="qp-button qp-button--ghost qp-icon-button" type="button"
            aria-label={'编辑分类 ' + currentCategory.name} title="编辑当前分类"
            onClick={() => onEditCategory(currentCategory)}>
            <PencilSimple size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="mih-market-category-chips" aria-label="快捷分类">
        <button type="button" className={selectedCategory === 'all' ? 'is-active' : ''}
          aria-pressed={selectedCategory === 'all'} onClick={() => onCategory('all')}>全部</button>
        {catalog.categories.slice(0, 4).map((category) => (
          <button type="button" key={category.categoryKey}
            className={selectedCategory === category.categoryKey ? 'is-active' : ''}
            aria-pressed={selectedCategory === category.categoryKey}
            onClick={() => onCategory(category.categoryKey)}>
            {category.name}
          </button>
        ))}
      </div>
      <div className="mih-market-agent-list" aria-busy={loading || undefined}>
        {agents.map((agent) => (
          <article key={agent.agentKey}
            className={'mih-market-agent-card' + (selectedAgentKey === agent.agentKey ? ' is-selected' : '')}>
            <button className="mih-market-agent-card__select" type="button"
              aria-pressed={selectedAgentKey === agent.agentKey}
              onClick={() => onSelectAgent(agent.agentKey)}>
              <span className={'mih-market-agent-card__icon is-' + agent.kind}>
                {agent.kind === 'builtin'
                  ? <Storefront size={20} weight="duotone" aria-hidden="true" />
                  : <Brain size={20} weight="duotone" aria-hidden="true" />}
              </span>
              <span className="mih-market-agent-card__copy">
                <span>
                  <strong>{agent.name}</strong>
                  <StatusBadge status={lifecycleTone(agent.lifecycle)} label={lifecycleLabel(agent.lifecycle)} />
                </span>
                <small>{agent.summary || '暂无简介'}</small>
              </span>
            </button>
            <div className="mih-market-agent-card__meta">
              <span>{agent.executorKey ? (agent.runnable ? '可运行' : '执行器不可用') : '未配置执行器'}</span>
              <span>{lastRunSummary(agent.lastRun)}</span>
            </div>
            {agent.tags.length ? (
              <div className="mih-market-agent-card__tags">
                {agent.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            ) : null}
            {canAdmin ? (
              <div className="mih-market-agent-card__actions">
                <button type="button" className="qp-button qp-button--ghost"
                  onClick={() => onEditAgent(agent)}>
                  <PencilSimple size={14} aria-hidden="true" />编辑
                </button>
                <button type="button" className="qp-button qp-button--ghost"
                  onClick={() => onToggleAgent(agent)}>
                  {agent.lifecycle === 'disabled'
                    ? <><ArrowCounterClockwise size={14} aria-hidden="true" />恢复</>
                    : <><LockKey size={14} aria-hidden="true" />停用</>}
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {!agents.length && !loading ? (
          <EmptyState icon={Storefront} title="没有匹配的 Agent"
            description={search ? '调整搜索词或切换分类。' : '该分类暂时没有 Agent。'}
            action={undefined} />
        ) : null}
      </div>
      <footer className="mih-market-catalog__footer">
        <span>共 {agents.length} / {catalog.agents.length} 个 Agent</span>
        {loading ? <span role="status">正在刷新…</span> : null}
      </footer>
    </aside>
  )
}

function RunConfiguration({
  canAdmin,
  enabled,
  running,
  saving,
  dirty,
  sequenceKey,
  sequenceOptions,
  sequenceHint,
  query,
  filters,
  runLabel,
  runDisabledReason,
  agentControlError,
  runError,
  onSequence,
  onQuery,
  onFilters,
  onRun,
  onSave,
  onReset,
}: {
  canAdmin: boolean
  enabled: boolean
  running: boolean
  saving: boolean
  dirty: boolean
  sequenceKey: string
  sequenceOptions: Array<{ value: string, label: string, description?: string, disabled?: boolean }>
  sequenceHint: string
  query: string
  filters: FilterDraft
  runLabel: string
  runDisabledReason: string | null
  agentControlError: unknown
  runError: unknown
  onSequence: (value: string) => void
  onQuery: (value: string) => void
  onFilters: (value: FilterDraft) => void
  onRun: () => void
  onSave: () => void
  onReset: () => void
}) {
  return (
    <section className="mih-market-command" aria-label="Dry Run 配置">
      <div className="mih-market-command__sequence">
        <DropdownField label="LLM Sequence" value={sequenceKey} options={sequenceOptions as never[]}
          hint={sequenceHint} disabled={!canAdmin || !enabled || running || Boolean(agentControlError)}
          onChange={onSequence} />
      </div>
      <Field label="本次输入" hint="仅用于 dry-run；不会写入业务数据。">
        <textarea className="qp-input mih-market-command__query" value={query}
          disabled={!canAdmin || !enabled || running} onChange={(event) => onQuery(event.target.value)} />
      </Field>
      <div className="mih-market-command__actions">
        <button className="qp-button qp-button--primary" type="button"
          disabled={Boolean(runDisabledReason) || running} title={runDisabledReason || undefined}
          onClick={onRun}>
          <Play size={17} weight="fill" aria-hidden="true" />{runLabel}
        </button>
        <button className="qp-button qp-button--outline" type="button"
          disabled={!canAdmin || !enabled || saving || !dirty} onClick={onSave}>
          <FloppyDisk size={16} aria-hidden="true" />{saving ? '保存中…' : '保存 Prompt'}
        </button>
        <button className="qp-button qp-button--ghost qp-icon-button" type="button"
          aria-label="撤销未保存修改" title="撤销未保存修改"
          disabled={!canAdmin || !enabled || !dirty} onClick={onReset}>
          <ArrowCounterClockwise size={16} aria-hidden="true" />
        </button>
      </div>
      <details className="mih-market-filters">
        <summary>受控过滤条件</summary>
        <div>
          <Field label="Platform" hint={undefined}><input className="qp-input" value={filters.platform}
            disabled={!canAdmin || !enabled || running}
            onChange={(event) => onFilters({ ...filters, platform: event.target.value })} /></Field>
          <Field label="Dataset ID" hint={undefined}><input className="qp-input" value={filters.datasetId}
            disabled={!canAdmin || !enabled || running}
            onChange={(event) => onFilters({ ...filters, datasetId: event.target.value })} /></Field>
          <Field label="Object Type" hint={undefined}><input className="qp-input" value={filters.objectType}
            disabled={!canAdmin || !enabled || running}
            onChange={(event) => onFilters({ ...filters, objectType: event.target.value })} /></Field>
          <Field label="From Time" hint={undefined}><input className="qp-input" type="datetime-local" value={filters.fromTime}
            disabled={!canAdmin || !enabled || running}
            onChange={(event) => onFilters({ ...filters, fromTime: event.target.value })} /></Field>
          <Field label="To Time" hint={undefined}><input className="qp-input" type="datetime-local" value={filters.toTime}
            disabled={!canAdmin || !enabled || running}
            onChange={(event) => onFilters({ ...filters, toTime: event.target.value })} /></Field>
        </div>
      </details>
      {agentControlError ? (
        <div className="mih-inline-warning"><Warning size={16} aria-hidden="true" />Sequence 数据不可用，模型阶段将无法显式选择。</div>
      ) : null}
      {runError ? <ErrorState error={runError} onRetry={undefined} /> : null}
    </section>
  )
}

function AgentFlowGraph({
  definition,
  tracesByStage,
  terminalTrace,
  selectedStage,
  running,
  onSelect,
}: {
  definition: AdvancedSearchDefinition
  tracesByStage: Map<AdvancedSearchStageType, StageTrace[]>
  terminalTrace: StageTrace | null
  selectedStage: AdvancedSearchStageType
  running: boolean
  onSelect: (stage: AdvancedSearchStageType) => void
}) {
  const grade = definition.stages.find((stage) => stage.type === 'grade')
  const loopEnabled = grade?.type === 'grade' && grade.state === 'active' && grade.options.maxRetries > 0
  const retryObserved = [...tracesByStage.values()].some((traces) => traces.some((trace) => trace.attempt > 0))
  return (
    <section className="mih-market-flow" aria-labelledby="mih-market-flow-title">
      <header className="mih-market-flow__header">
        <div><p className="qp-kicker">OBSERVABLE AGENT LOOP</p><h2 id="mih-market-flow-title">阶段图谱 · 分支与纠错回环</h2></div>
        <div className="mih-market-flow__legend" aria-label="状态图例">
          <span data-status="succeeded">成功</span>
          <span data-status="degraded">降级</span>
          <span data-status="skipped">跳过</span>
          <span data-status="failed">失败</span>
          <span data-status="idle">未运行</span>
        </div>
      </header>
      <div className="mih-market-flow__viewport">
        <div className="mih-market-flow__canvas">
          <svg className="mih-market-flow__edges" viewBox="0 0 1040 230" aria-hidden="true">
            <defs>
              <marker id="mih-market-arrow" viewBox="0 0 8 8" refX="6" refY="4"
                markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0 0 L8 4 L0 8 Z" />
              </marker>
            </defs>
            {definition.stages.slice(0, -1).map((stage, index) => {
              const trace = latestTrace(tracesByStage.get(stage.type) || [])
              const status = stage.state === 'trashed' ? 'disabled' : trace?.status || 'idle'
              return (
                <line key={stage.id + '-edge'} x1={GRAPH_X[index] + 42} y1="92"
                  x2={GRAPH_X[index + 1] - 42} y2="92"
                  data-status={status} markerEnd="url(#mih-market-arrow)" />
              )
            })}
            {loopEnabled ? (
              <path className="mih-market-flow__loop" d="M666 137 C666 206 222 206 222 137"
                markerEnd="url(#mih-market-arrow)" />
            ) : null}
          </svg>
          {definition.stages.map((stage, index) => {
            const meta = ADVANCED_SEARCH_STAGE_META[stage.type]
            const Icon = meta.kind === 'agent' ? Brain : Wrench
            const traces = tracesByStage.get(stage.type) || []
            const trace = latestTrace(traces)
            const status = stage.state === 'trashed' ? 'disabled' : trace?.status || 'idle'
            const stateLabel = stage.state === 'trashed'
              ? '已移出流程'
              : trace ? traceLabel(trace.status) + '，' + formatMilliseconds(trace.durationMs) : '未运行'
            return (
              <button key={stage.id} type="button"
                className={'mih-market-flow-node' + (selectedStage === stage.type ? ' is-selected' : '')}
                style={{ '--mih-node-left': GRAPH_X[index] + 'px' } as CSSProperties}
                data-status={status}
                aria-pressed={selectedStage === stage.type}
                aria-label={meta.label + '，' + stateLabel}
                onClick={() => onSelect(stage.type)}>
                <span className="mih-market-flow-node__orb"><Icon size={23} weight="duotone" aria-hidden="true" /></span>
                <strong>{meta.label}</strong>
                <small>{stage.state === 'trashed'
                  ? '已移出'
                  : trace
                    ? traceDisplayLabel(trace) + (trace.attempt > 0 ? ' · retry ' + trace.attempt : '')
                    : '未运行'}</small>
              </button>
            )
          })}
          <div className="mih-market-flow__branches">
            <span>knowledge_search → 改写</span>
            <span>structured_filter → 召回</span>
            <span>clarify → 安全拒答</span>
          </div>
          {loopEnabled ? (
            <div className="mih-market-flow__loop-label">
              <ArrowCounterClockwise size={14} aria-hidden="true" />
              {retryObserved ? '证据不足 · 已观察重试 1/1' : '证据不足 → 改写 · 上限 1 次'}
            </div>
          ) : null}
          {running ? (
            <div className="mih-market-flow__pending" role="status">
              请求执行中；节点状态将在服务端返回真实 Trace 后更新
            </div>
          ) : null}
        </div>
      </div>
      {terminalTrace && !running ? (
        <div className="mih-market-flow__terminal" data-status={terminalTrace.status}
          role="status" aria-live="polite">
          <span>本次终态</span>
          <strong>{traceDisplayLabel(terminalTrace)}</strong>
          <small title={traceReason(terminalTrace)}>
            {ADVANCED_SEARCH_STAGE_META[terminalTrace.type].label}：{traceReason(terminalTrace)}
          </small>
        </div>
      ) : null}
    </section>
  )
}

function AttemptPicker({
  traces,
  attempt,
  onChange,
}: {
  traces: StageTrace[]
  attempt: number | null
  onChange: (attempt: number) => void
}) {
  if (traces.length <= 1) return null
  return (
    <div className="mih-market-attempts" aria-label="阶段执行轮次">
      {traces.map((trace) => (
        <button key={trace.stageId + '-' + trace.attempt} type="button"
          className={attempt === trace.attempt ? 'is-active' : ''}
          aria-pressed={attempt === trace.attempt}
          onClick={() => onChange(trace.attempt)}>
          {trace.attempt === 0 ? '首轮' : '重试 ' + trace.attempt}
        </button>
      ))}
    </div>
  )
}

function TraceMetrics({
  trace,
  reference,
}: {
  trace: StageTrace | null
  reference: StageTrace | null
}) {
  if (!trace) return <p className="mih-market-muted">运行后显示真实耗时、Provider、Proxy、Token 与 Schema 结果。</p>
  const rows = [
    ['阶段耗时', formatMilliseconds(trace.durationMs), formatMilliseconds(reference?.durationMs ?? null)],
    ['Provider', trace.model?.provider || '—', reference?.model?.provider || '—'],
    ['Proxy', trace.model?.proxy || '—', reference?.model?.proxy || '—'],
    ['Model', trace.model?.model || (trace.toolCalls.length ? '固定工具' : '—'), reference?.model?.model || '—'],
    ['Sequence', trace.model?.sequenceKey || '—', reference?.model?.sequenceKey || '—'],
    ['输入 / 输出 Tokens',
      metricNumber(trace.model?.inputTokens) + ' / ' + metricNumber(trace.model?.outputTokens),
      metricNumber(reference?.model?.inputTokens) + ' / ' + metricNumber(reference?.model?.outputTokens)],
    ['输出 Schema', trace.validation.valid == null ? '—' : trace.validation.valid ? 'PASS' : 'FAIL',
      reference?.validation.valid == null ? '—' : reference.validation.valid ? 'PASS' : 'FAIL'],
    ['工具调用', String(trace.toolCalls.length), reference ? String(reference.toolCalls.length) : '—'],
  ]
  return (
    <div className="mih-market-inspector-metrics">
      <div className="mih-market-inspector-metrics__head"><span>指标</span><span>当前</span><span>对照</span></div>
      {rows.map(([label, current, previous]) => (
        <div key={label}><span>{label}</span><strong>{current}</strong><small>{previous}</small></div>
      ))}
      {trace.model?.errorCode ? (
        <div className="mih-inline-warning"><Warning size={16} aria-hidden="true" />降级码：{trace.model.errorCode}</div>
      ) : null}
    </div>
  )
}

function StageInspector({
  stage,
  traces,
  referenceTraces,
  tab,
  attempt,
  canEdit,
  onTab,
  onAttempt,
  onMutate,
  onToggleStage,
  onCollapse,
}: {
  stage: AdvancedSearchStage
  traces: StageTrace[]
  referenceTraces: StageTrace[]
  tab: InspectorTab
  attempt: number | null
  canEdit: boolean
  onTab: (tab: InspectorTab) => void
  onAttempt: (attempt: number) => void
  onMutate: (mutate: (stage: AdvancedSearchStage) => void) => void
  onToggleStage: () => void
  onCollapse: () => void
}) {
  const meta = ADVANCED_SEARCH_STAGE_META[stage.type]
  const trace = traces.find((item) => item.attempt === attempt) || latestTrace(traces)
  const referenceTrace = latestTrace(referenceTraces)
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? INSPECTOR_TABS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
    const next = INSPECTOR_TABS[nextIndex]
    onTab(next.id)
    window.requestAnimationFrame(() => document.getElementById('mih-market-tab-' + next.id)?.focus())
  }
  return (
    <aside className="mih-market-inspector" id="mih-market-stage-inspector" aria-label="阶段详情">
      <header className="mih-market-inspector__header">
        <div><p className="qp-kicker">{meta.lesson}</p><h2>{meta.label}</h2><p>{meta.description}</p></div>
        <div className="mih-market-inspector__header-actions">
          <button className="qp-button qp-button--ghost" type="button" disabled={!canEdit}
            onClick={onToggleStage}>
            {stage.state === 'active'
              ? <><Recycle size={15} aria-hidden="true" />移出流程</>
              : <><ArrowCounterClockwise size={15} aria-hidden="true" />恢复阶段</>}
          </button>
          <button className="qp-button qp-button--ghost mih-market-inspector__collapse" type="button"
            id="mih-market-inspector-collapse" aria-controls="mih-market-stage-inspector"
            aria-expanded="true" aria-label="向右收起阶段详情" title="向右收起阶段详情"
            onClick={onCollapse}>
            <CaretRight size={16} aria-hidden="true" /><span>收起</span>
          </button>
        </div>
      </header>
      <AttemptPicker traces={traces} attempt={trace?.attempt ?? null} onChange={onAttempt} />
      <div className="qp-panel-tabs mih-market-inspector__tabs" role="tablist" aria-label={meta.label + ' 详情'}>
        {INSPECTOR_TABS.map((item, index) => (
          <button key={item.id} id={'mih-market-tab-' + item.id} type="button"
            className={'qp-panel-tab' + (tab === item.id ? ' is-active' : '')}
            role="tab" aria-selected={tab === item.id}
            aria-controls={'mih-market-tabpanel-' + item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            onClick={() => onTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <section className="mih-market-inspector__body" id={'mih-market-tabpanel-' + tab}
        role="tabpanel" aria-labelledby={'mih-market-tab-' + tab}>
        {tab === 'input' ? (
          trace ? (
            <div className="mih-market-code-block">
              <span>Attempt {trace.attempt} · 真实阶段输入</span>
              <pre>{pretty(trace.input)}</pre>
            </div>
          ) : <p className="mih-market-muted">运行后显示服务端返回的真实阶段输入。</p>
        ) : null}
        {tab === 'prompt' ? <PromptEditor stage={stage} disabled={!canEdit} onChange={onMutate} /> : null}
        {tab === 'schema' ? (
          <div className="mih-market-schema-stack">
            <div className="mih-market-code-block"><span>{meta.schemaName} · Zod 摘录</span><pre>{meta.schemaCode}</pre></div>
            <div className="mih-market-code-block"><span>同源 JSON Schema</span><pre>{pretty(jsonSchemaForStage(stage.type))}</pre></div>
          </div>
        ) : null}
        {tab === 'output' ? (
          trace ? (
            <>
              {trace.note ? <p className="mih-market-trace-note">{trace.note}</p> : null}
              <div className="mih-market-code-block"><span>结构化阶段输出</span><pre>{pretty(trace.output)}</pre></div>
              {trace.validation.issues.length ? (
                <ul className="mih-market-issues">
                  {trace.validation.issues.map((issue, index) => (
                    <li key={issue.path + '-' + index}>{issue.path ? issue.path + ': ' : ''}{issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : <p className="mih-market-muted">暂无运行输出；这里不会显示示例值冒充真实结果。</p>
        ) : null}
        {tab === 'tool' ? (
          <>
            <div className="mih-market-tool-contracts">
              {meta.toolIds.map((toolId) => {
                const tool = ADVANCED_SEARCH_TOOLS.find((candidate) => candidate.id === toolId)
                return tool ? (
                  <article key={tool.id}>
                    <Wrench size={17} weight="duotone" aria-hidden="true" />
                    <div><strong>{tool.label}</strong><code>{tool.id}</code><p>{tool.description}</p></div>
                    <span>sideEffect: {tool.sideEffect}</span>
                  </article>
                ) : null
              })}
              {!meta.toolIds.length ? <p className="mih-market-muted">该阶段没有固定工具契约。</p> : null}
            </div>
            {trace ? (
              <div className="mih-market-code-block"><span>本次真实 Tool Calls · {trace.toolCalls.length}</span><pre>{pretty(trace.toolCalls)}</pre></div>
            ) : <p className="mih-market-muted">运行后显示真实工具调用。</p>}
          </>
        ) : null}
        {tab === 'metrics' ? <TraceMetrics trace={trace} reference={referenceTrace} /> : null}
      </section>
    </aside>
  )
}

function RunColumn({
  title,
  label,
  trace,
  result,
  empty,
}: {
  title: string
  label: string
  trace: StageTrace | null
  result: DryRunResult | null
  empty: string
}) {
  return (
    <article className="mih-market-run-column">
      <header>
        <div><span>{label}</span><strong>{title}</strong></div>
        {trace ? <StatusBadge status={traceTone(trace.status)} label={traceLabel(trace.status)} /> : null}
      </header>
      {trace ? (
        <>
          <div><span>阶段输入</span><pre>{pretty(trace.input)}</pre></div>
          <div><span>阶段输出</span><pre>{pretty(trace.output)}</pre></div>
          <dl>
            <div><dt>阶段耗时</dt><dd>{formatMilliseconds(trace.durationMs)}</dd></div>
            <div><dt>Provider</dt><dd>{trace.model?.provider || '—'}</dd></div>
            <div><dt>Proxy</dt><dd>{trace.model?.proxy || '—'}</dd></div>
            <div><dt>总耗时</dt><dd>{formatMilliseconds(result?.durationMs ?? null)}</dd></div>
          </dl>
        </>
      ) : <p className="mih-market-run-column__empty">{empty}</p>}
    </article>
  )
}

function RunComparison({
  stageType,
  current,
  previous,
  baseline,
  compareTarget,
  onCompareTarget,
}: {
  stageType: AdvancedSearchStageType
  current: DryRunResult | null
  previous: DryRunResult | null
  baseline: DryRunResult | null
  compareTarget: CompareTarget
  onCompareTarget: (value: CompareTarget) => void
}) {
  const reference = compareTarget === 'previous' ? previous : baseline
  const currentTrace = latestTrace(current?.traces.filter((trace) => trace.type === stageType) || [])
  const referenceTrace = latestTrace(reference?.traces.filter((trace) => trace.type === stageType) || [])
  const referenceTitle = compareTarget === 'previous' ? '上一轮' : '已保存基线'
  return (
    <section className="mih-market-comparison" aria-labelledby="mih-market-comparison-title">
      <header>
        <div>
          <p className="qp-kicker">INPUT / OUTPUT DIFF</p>
          <h2 id="mih-market-comparison-title">当前草稿 vs {referenceTitle}</h2>
          <p>同一阶段的真实输入与结构化输出并排诊断；n=1 仅定位问题，不代表整体质量。</p>
        </div>
        <DropdownField label="对照对象" className="mih-market-compact-dropdown" value={compareTarget}
          options={[
            { value: 'previous', label: '上一轮（本会话）', description: previous ? '已有可比较运行' : '暂无上一轮' },
            { value: 'baseline', label: '已保存基线（lastRun）', description: baseline ? '已有 Trace 基线' : '暂无可用 Trace 基线' },
          ] as never[]}
          onChange={onCompareTarget} />
      </header>
      <div className="mih-market-comparison__grid">
        <RunColumn label="REFERENCE" title={referenceTitle} trace={referenceTrace} result={reference}
          empty={compareTarget === 'previous' ? '暂无上一轮。完成第二次 dry-run 后可比较。' : 'catalog.lastRun 未提供可观测 Trace 基线。'} />
        <RunColumn label="CURRENT" title="当前运行" trace={currentTrace} result={current}
          empty="尚未运行。运行后这里显示真实输入与输出。" />
      </div>
    </section>
  )
}

function RunMetricCard({
  label,
  current,
  reference,
  hint,
}: {
  label: string
  current: string
  reference: string
  hint: string
}) {
  return (
    <article className="mih-market-run-metric">
      <span>{label}</span>
      <div><small>对照</small><small>当前</small></div>
      <div><strong>{reference}</strong><strong>{current}</strong></div>
      <p>{hint}</p>
    </article>
  )
}

function RunMetrics({
  current,
  reference,
}: {
  current: DryRunResult | null
  reference: DryRunResult | null
}) {
  const currentModels = current?.traces.map((trace) => trace.model).filter((model) => Boolean(model)) || []
  const referenceModels = reference?.traces.map((trace) => trace.model).filter((model) => Boolean(model)) || []
  const currentProvider = currentModels.find((model) => model?.provider)?.provider || '—'
  const referenceProvider = referenceModels.find((model) => model?.provider)?.provider || '—'
  const currentProxy = currentModels.find((model) => model?.proxy)?.proxy || '—'
  const referenceProxy = referenceModels.find((model) => model?.proxy)?.proxy || '—'
  const currentTokens = currentModels.reduce((sum, model) => sum + (model?.inputTokens || 0) + (model?.outputTokens || 0), 0)
  const referenceTokens = referenceModels.reduce((sum, model) => sum + (model?.inputTokens || 0) + (model?.outputTokens || 0), 0)
  const currentAccuracy = metricFrom(current, 'accuracy', 'answerAccuracy')
  const referenceAccuracy = metricFrom(reference, 'accuracy', 'answerAccuracy')
  const currentSchema = metricFrom(current, 'effectiveSchemaPassRate')
  const referenceSchema = metricFrom(reference, 'effectiveSchemaPassRate')
  const currentCitation = metricFrom(current, 'citationCoverage')
  const referenceCitation = metricFrom(reference, 'citationCoverage')
  return (
    <section className="mih-market-run-metrics" aria-labelledby="mih-market-run-metrics-title">
      <header>
        <div><p className="qp-kicker">RUN DIAGNOSTICS</p><h2 id="mih-market-run-metrics-title">服务与质量对比</h2></div>
        <span><Pulse size={16} aria-hidden="true" />n=1 单次诊断</span>
      </header>
      <div>
        <RunMetricCard label="服务总耗时" reference={formatMilliseconds(reference?.durationMs ?? null)}
          current={formatMilliseconds(current?.durationMs ?? null)} hint="端到端 dry-run" />
        <RunMetricCard label="Provider" reference={referenceProvider} current={currentProvider}
          hint="来自真实阶段 Trace" />
        <RunMetricCard label="Proxy" reference={referenceProxy} current={currentProxy}
          hint="Trace 未返回则为 —" />
        <RunMetricCard label="准确性（评测集）" reference={percentMetric(referenceAccuracy)}
          current={percentMetric(currentAccuracy)} hint="未绑定评测集不计算" />
        <RunMetricCard label="输出 Schema" reference={percentMetric(referenceSchema)}
          current={percentMetric(currentSchema)} hint="有效结构化输出" />
        <RunMetricCard label="引用覆盖" reference={percentMetric(referenceCitation)}
          current={percentMetric(currentCitation)} hint="仅真实 evaluation" />
        <RunMetricCard label="Token 总量" reference={reference ? metricNumber(referenceTokens) : '—'}
          current={current ? metricNumber(currentTokens) : '—'} hint="输入 + 输出" />
      </div>
      <p className="mih-market-diagnostic-note">
        “准确性”必须绑定固定数据集与判分器；单次运行只能诊断耗时、路由、Schema、引用与工具行为，不能外推整体准确率。
      </p>
    </section>
  )
}

function TerminalAuditPanel({ audit }: { audit: AgentMarketRunTerminalAudit | null }) {
  if (!audit) return null
  const outcomeLabel = {
    result: 'result · 已生成结果',
    refusal: 'refusal · 安全拒答',
    failed: 'failed · 明确失败',
    skipped: 'skipped · 答案跳过',
    missing: 'missing · 缺少终态',
  }[audit.finalOutcome]
  const path = audit.takenPath.map((entry) => (
    entry.stage + (entry.attempt > 0 ? '[retry ' + entry.attempt + ']' : '') + ':' + entry.status
  )).join(' → ')
  return (
    <section className="mih-market-terminal-audit" aria-labelledby="mih-market-terminal-audit-title">
      <header>
        <div><p className="qp-kicker">TERMINAL AUDIT</p><h2 id="mih-market-terminal-audit-title">本次运行终态</h2></div>
        <StatusBadge status={audit.complete ? 'active' : 'down'} label={audit.complete ? '完整' : '不完整'} />
      </header>
      <div className="mih-market-terminal-audit__facts">
        <span className="qp-tag">完整性 · {audit.complete ? 'PASS' : 'FAIL'}</span>
        <span className="qp-tag">节点终态 · {audit.terminalStages.length}/{ADVANCED_SEARCH_STAGE_TYPES.length}</span>
        <span className="qp-tag">最终结局 · {outcomeLabel}</span>
        <span className="qp-tag">Retry · 声明 {audit.retry.declared} / 观测 {audit.retry.observed} · {audit.retry.consistent ? '一致' : '不一致'}</span>
      </div>
      <p className="mih-market-terminal-audit__path">
        <strong>Taken path</strong>
        <span>{path || '没有可确认的执行路径'}</span>
      </p>
      {!audit.complete ? (
        <div className="mih-inline-warning">
          <Warning size={16} aria-hidden="true" />
          缺少终态：{audit.missingTerminalStages.join('、') || 'Retry 或 Final 契约不一致'}。本次响应保留用于诊断，不标记为成功。
        </div>
      ) : null}
    </section>
  )
}

function UnsupportedWorkbench({ agent }: { agent: CatalogAgent }) {
  return (
    <div className="mih-market-unsupported">
      <span><Brain size={34} weight="duotone" aria-hidden="true" /></span>
      <div><p className="qp-kicker">AGENT WORKBENCH</p><h2>{agent.name}</h2><p>{agent.summary || '该 Agent 暂无说明。'}</p></div>
      <dl>
        <div><dt>目录状态</dt><dd>{lifecycleLabel(agent.lifecycle)}</dd></div>
        <div><dt>Executor</dt><dd>{agent.executorKey || '未配置执行器'}</dd></div>
        <div><dt>最近运行</dt><dd>{lastRunSummary(agent.lastRun)}</dd></div>
      </dl>
      <div className="mih-inline-warning">
        <LockKey size={17} aria-hidden="true" />
        {agent.executorKey
          ? '该执行器尚未接入通用可视化协议；目录信息保持可管理，但不会伪造节点、输入、输出或指标。'
          : '未配置执行器。可先完善目录与流程设计，接入服务端执行器后再运行。'}
      </div>
      <button className="qp-button qp-button--primary" type="button" disabled>
        <Play size={16} weight="fill" aria-hidden="true" />
        {agent.executorKey ? '执行器工作台待接入' : '未配置执行器'}
      </button>
    </div>
  )
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function AgentMarketPage({ token, session, onUnauthorized, notify }: PageProps) {
  const canAdmin = session?.kind === 'admin-token'
  const runHistoryStorage = useMemo(() => getAgentMarketRunHistoryStorage(), [])
  const loadCatalog = useCallback(() => adminApi.agentMarketCatalog(token), [token])
  const catalogRemote = useRemoteData(loadCatalog, onUnauthorized) as {
    data: unknown
    error: unknown
    loading: boolean
    refresh: () => void
  }
  const catalog = useMemo(() => normalizeCatalog(catalogRemote.data), [catalogRemote.data])
  const [selectedAgentKey, setSelectedAgentKey] = useState('')
  const selectedAgent = catalog.agents.find((agent) => agent.agentKey === selectedAgentKey) || null
  const selectedExecutorKey = selectedAgent?.executorKey || null
  const isAdvancedWorkbench = selectedExecutorKey === ADVANCED_SEARCH_AGENT_KEY

  useEffect(() => {
    if (!catalog.agents.length) {
      setSelectedAgentKey('')
      return
    }
    if (catalog.agents.some((agent) => agent.agentKey === selectedAgentKey)) return
    const preferred = catalog.agents.find((agent) => agent.executorKey === ADVANCED_SEARCH_AGENT_KEY)
      || catalog.agents.find((agent) => agent.agentKey === 'advanced-search')
      || catalog.agents[0]
    setSelectedAgentKey(preferred.agentKey)
  }, [catalog.agents, selectedAgentKey])

  const loadDefinition = useCallback(
    () => isAdvancedWorkbench && selectedExecutorKey
      ? adminApi.agentMarketItem(token, selectedExecutorKey)
      : Promise.resolve(null),
    [isAdvancedWorkbench, selectedExecutorKey, token],
  )
  const definitionRemote = useRemoteData(loadDefinition, onUnauthorized) as {
    data: unknown
    error: unknown
    loading: boolean
    refresh: () => void
  }
  const loadAgentControl = useCallback(() => adminApi.agent(token), [token])
  const agentControl = useRemoteData(loadAgentControl, onUnauthorized) as {
    data: unknown
    error: unknown
    loading: boolean
  }

  const initialDefinition = useMemo(() => freshAdvancedSearchDefinition(), [])
  const [snapshot, setSnapshot] = useState<Snapshot>({
    agentKey: ADVANCED_SEARCH_AGENT_KEY,
    revision: 0,
    source: 'builtin',
    definition: initialDefinition,
    updatedBy: null,
    updatedAt: null,
  })
  const [draft, setDraft] = useState<AdvancedSearchDefinition>(() => structuredClone(initialDefinition))
  const [definitionError, setDefinitionError] = useState<Error | null>(null)
  const [query, setQuery] = useState<string>(ADVANCED_SEARCH_INPUT_EXAMPLE.query)
  const [filters, setFilters] = useState<FilterDraft>(EMPTY_FILTERS)
  const [sequenceKey, setSequenceKey] = useState('')
  const [selectedStage, setSelectedStage] = useState<AdvancedSearchStageType>('triage')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('prompt')
  const [selectedAttempt, setSelectedAttempt] = useState<number | null>(null)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(readInspectorCollapsed)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<unknown>(null)
  const [result, setResult] = useState<DryRunResult | null>(null)
  const [previousResult, setPreviousResult] = useState<DryRunResult | null>(null)
  const [compareTarget, setCompareTarget] = useState<CompareTarget>('previous')
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [categoryEditor, setCategoryEditor] = useState<CatalogCategory | 'create' | null>(null)
  const [categoryDelete, setCategoryDelete] = useState<CatalogCategory | null>(null)
  const [agentEditor, setAgentEditor] = useState<CatalogAgent | 'create' | null>(null)
  const [lifecycleConfirm, setLifecycleConfirm] = useState<CatalogAgent | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)

  const changeInspectorCollapsed = useCallback((collapsed: boolean) => {
    setInspectorCollapsed(collapsed)
    writeInspectorCollapsed(collapsed)
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.getElementById(collapsed
          ? 'mih-market-inspector-expand'
          : 'mih-market-inspector-collapse')?.focus()
      })
    }
  }, [])

  useEffect(() => {
    if (selectedCategory !== 'all'
      && !catalog.categories.some((category) => category.categoryKey === selectedCategory)) {
      setSelectedCategory('all')
    }
  }, [catalog.categories, selectedCategory])

  useEffect(() => {
    const emptyDefinition = freshAdvancedSearchDefinition()
    setSnapshot({
      agentKey: ADVANCED_SEARCH_AGENT_KEY,
      revision: 0,
      source: 'builtin',
      definition: emptyDefinition,
      updatedBy: null,
      updatedAt: null,
    })
    setDraft(structuredClone(emptyDefinition))
    setDefinitionError(null)
    setResult(null)
    setPreviousResult(null)
    setRunError(null)
    setSelectedStage('triage')
    setInspectorTab('prompt')
    setSelectedAttempt(null)
  }, [selectedAgentKey])

  useEffect(() => {
    if (!canAdmin || !isAdvancedWorkbench || !selectedAgentKey) return
    const restored = readAgentMarketRunHistory(runHistoryStorage, selectedAgentKey)
      .map((entry) => normalizeRun(entry.run))
      .filter((entry): entry is DryRunResult => entry !== null)
    setResult(restored[0] || null)
    setPreviousResult(restored[1] || null)
  }, [canAdmin, isAdvancedWorkbench, runHistoryStorage, selectedAgentKey])

  useEffect(() => {
    if (canAdmin) return
    setResult(null)
    setPreviousResult(null)
  }, [canAdmin])

  useEffect(() => {
    if (!isAdvancedWorkbench || !selectedExecutorKey || !definitionRemote.data) return
    if (!isRecord(definitionRemote.data)) {
      setDefinitionError(new Error('Agent definition 响应格式无效'))
      return
    }
    const parsed = AdvancedSearchDefinitionSchema.safeParse(definitionRemote.data.definition)
    if (!parsed.success) {
      setDefinitionError(new Error('Agent definition 未通过运行时 Schema 校验'))
      return
    }
    const next: Snapshot = {
      agentKey: stringValue(definitionRemote.data.agentKey, selectedExecutorKey || ADVANCED_SEARCH_AGENT_KEY),
      revision: Math.max(0, Math.trunc(numberValue(definitionRemote.data.revision))),
      source: definitionRemote.data.source === 'database' ? 'database' : 'builtin',
      definition: parsed.data,
      updatedBy: nullableString(definitionRemote.data.updatedBy),
      updatedAt: nullableString(definitionRemote.data.updatedAt),
    }
    setSnapshot(next)
    setDraft(structuredClone(parsed.data))
    setDefinitionError(null)
  }, [definitionRemote.data, isAdvancedWorkbench, selectedExecutorKey])

  const sequenceConfig = useMemo(() => {
    const data = isRecord(agentControl.data) ? agentControl.data : {}
    const control = isRecord(data.control) ? data.control : {}
    const settings = isRecord(data.settings) ? data.settings : {}
    const chatSettings = isRecord(settings.chat) ? settings.chat : {}
    const providerRevision = numberValue(chatSettings.revision)
    const sequences = (Array.isArray(control.sequences) ? control.sequences : [])
      .filter(isRecord)
      .filter((sequence) => sequence.kind === 'chat' && sequence.enabled === true)
    const bindings = (Array.isArray(control.bindings) ? control.bindings : []).filter(isRecord)
    const binding = bindings.find((candidate) => candidate.kind === 'chat' && nullableString(candidate.sequenceKey))
    const defaultKey = binding ? nullableString(binding.sequenceKey) : null
    const defaultSequence = sequences.find((sequence) => sequence.sequenceKey === defaultKey)
    const defaultReady = Boolean(defaultSequence) && numberValue(defaultSequence?.providerRevision) === providerRevision
    return {
      options: [
        {
          value: '',
          label: defaultReady
            ? '使用业务默认：' + stringValue(defaultSequence?.displayName, defaultKey || 'Chat Sequence')
            : '未设置可用业务默认（模型阶段确定性降级）',
          description: defaultReady
            ? '显式绑定 ' + defaultKey
            : '不会自动选取第一个 Provider 或 Sequence。',
        },
        ...sequences.map((sequence) => ({
          value: stringValue(sequence.sequenceKey),
          label: stringValue(sequence.displayName, stringValue(sequence.sequenceKey)) + ' · ' + stringValue(sequence.sequenceKey),
          description: numberValue(sequence.providerRevision) === providerRevision
            ? '匹配当前 Provider revision'
            : 'Provider 已变化；需要重新验证',
          disabled: numberValue(sequence.providerRevision) !== providerRevision,
        })),
      ],
      hint: defaultReady
        ? '保留业务默认或显式选择已验证 Sequence；运行请求会记录实际选择。'
        : '没有可用业务默认；可显式选择已验证 Sequence，否则模型阶段确定性降级。',
    }
  }, [agentControl.data])

  const dirty = definitionText(draft) !== definitionText(snapshot.definition)
  const tracesByStage = useMemo(() => {
    const grouped = new Map<AdvancedSearchStageType, StageTrace[]>()
    for (const trace of result?.traces || []) {
      grouped.set(trace.type, [...(grouped.get(trace.type) || []), trace])
    }
    return grouped
  }, [result])
  const baselineResult = useMemo(() => normalizeRun(selectedAgent?.lastRun), [selectedAgent?.lastRun])
  const comparisonResult = compareTarget === 'previous' ? previousResult : baselineResult
  const previousTracesByStage = useMemo(() => {
    const grouped = new Map<AdvancedSearchStageType, StageTrace[]>()
    for (const trace of comparisonResult?.traces || []) {
      grouped.set(trace.type, [...(grouped.get(trace.type) || []), trace])
    }
    return grouped
  }, [comparisonResult])
  const selectedStageDefinition = draft.stages.find((stage) => stage.type === selectedStage) || draft.stages[0]
  const selectedStageTraces = tracesByStage.get(selectedStage) || []
  const terminalAudit = useMemo(
    () => result ? inspectAgentMarketRunTerminal(result, draft) : null,
    [draft, result],
  )

  useEffect(() => {
    setSelectedAttempt(latestTrace(selectedStageTraces)?.attempt ?? null)
  }, [result, selectedStage])

  const handleAdminError = (error: unknown, fallback: string) => {
    if (isRecord(error) && error.status === 401) onUnauthorized?.(error)
    notify?.(errorMessage(error, fallback), 'warning')
  }

  const save = async () => {
    if (!canAdmin || !selectedExecutorKey || !isAdvancedWorkbench) return
    const parsed = AdvancedSearchDefinitionSchema.safeParse(draft)
    if (!parsed.success) {
      notify?.('当前配置未通过 Zod 校验，请检查空 Prompt 或超出范围的参数。', 'warning')
      return
    }
    setSaving(true)
    try {
      const response = await adminApi.saveAgentMarketItem(token, selectedExecutorKey, {
        expectedRevision: snapshot.revision,
        definition: parsed.data,
      })
      if (!isRecord(response)) throw new Error('保存响应格式无效')
      const savedDefinition = AdvancedSearchDefinitionSchema.safeParse(response.definition)
      if (!savedDefinition.success) throw new Error('保存结果未通过 Agent definition Schema')
      const saved: Snapshot = {
        agentKey: stringValue(response.agentKey, selectedExecutorKey),
        revision: Math.max(0, Math.trunc(numberValue(response.revision))),
        source: response.source === 'database' ? 'database' : 'builtin',
        definition: savedDefinition.data,
        updatedBy: nullableString(response.updatedBy),
        updatedAt: nullableString(response.updatedAt),
      }
      setSnapshot(saved)
      setDraft(structuredClone(saved.definition))
      notify?.('Agent Prompt 已保存为 revision ' + saved.revision, 'success')
    } catch (error) {
      handleAdminError(error, '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const runDisabledReason = useMemo(() => {
    if (!selectedAgent) return '请选择 Agent'
    if (!canAdmin) return '当前 Hub 管理会话无操作权限'
    if (!selectedAgent.executorKey) return '未配置执行器'
    if (!selectedAgent.runnable) return selectedAgent.lifecycle === 'disabled' ? 'Agent 已停用' : '当前不可运行'
    if (!isAdvancedWorkbench) return '当前执行器尚未接入此可视化工作台'
    if (definitionRemote.loading) return '正在加载执行定义'
    if (definitionRemote.error || definitionError) return '执行定义不可用'
    return null
  }, [canAdmin, definitionError, definitionRemote.error, definitionRemote.loading, isAdvancedWorkbench, selectedAgent])

  const runLabel = running
    ? '运行中…'
    : runDisabledReason === '未配置执行器' ? '未配置执行器' : runDisabledReason || '运行 Dry Run'

  const run = async () => {
    if (runDisabledReason || !selectedAgent?.runnable || !selectedExecutorKey) return
    const parsed = AdvancedSearchDefinitionSchema.safeParse(draft)
    if (!parsed.success || !query.trim()) {
      notify?.('请输入问题，并修正未通过 Zod 校验的阶段配置。', 'warning')
      return
    }
    setRunning(true)
    setRunError(null)
    try {
      const response = await adminApi.runAgentMarketDryRun(token, selectedExecutorKey, {
        dryRun: true,
        sequenceKey: sequenceKey || null,
        query: query.trim(),
        filters: {
          platform: nullable(filters.platform),
          datasetId: nullable(filters.datasetId),
          objectType: nullable(filters.objectType),
          fromTime: nullableDateTime(filters.fromTime),
          toTime: nullableDateTime(filters.toTime),
        },
        definition: structuredClone(parsed.data),
      })
      const next = normalizeRun(response)
      if (!next) throw new Error('Dry run 响应缺少可观测 traces')
      const audit = inspectAgentMarketRunTerminal(response, parsed.data)
      setPreviousResult(result)
      setResult(next)
      if (canAdmin) rememberAgentMarketRun(runHistoryStorage, selectedAgentKey, response)
      catalogRemote.refresh()
      if (!audit.complete) {
        const issue = audit.missingTerminalStages.length
          ? '缺少 ' + audit.missingTerminalStages.join('、') + ' 的终态 Trace'
          : !audit.retry.consistent ? 'Retry 声明与观测不一致' : '缺少 Final 终态'
        setRunError(new Error('Dry run 响应不完整：' + issue))
        notify?.('Dry run 已返回但终态审计未通过：' + issue, 'warning')
      } else {
        const outcome = audit.finalOutcome === 'refusal' ? '安全拒答' : audit.finalOutcome
        notify?.('Dry run 完成（' + outcome + '）：0 次业务写入，' + next.traces.length + ' 条阶段 Trace。', 'success')
      }
    } catch (error) {
      if (isRecord(error) && error.status === 401) onUnauthorized?.(error)
      setRunError(error)
    } finally {
      setRunning(false)
    }
  }

  const submitCategory = async (value: { categoryKey: string, name: string, description?: string, sortOrder: number }) => {
    if (!canAdmin) return
    const editing = categoryEditor && categoryEditor !== 'create' ? categoryEditor : null
    setCatalogBusy(true)
    try {
      if (editing) {
        await adminApi.updateAgentMarketCategory(token, editing.categoryKey, {
          expectedRevision: editing.revision,
          name: value.name,
          description: value.description,
          sortOrder: value.sortOrder,
        })
        notify?.('分类“' + value.name + '”已更新', 'success')
      } else {
        await adminApi.createAgentMarketCategory(token, value)
        notify?.('分类“' + value.name + '”已创建', 'success')
      }
      setCategoryEditor(null)
      catalogRemote.refresh()
    } catch (error) {
      handleAdminError(error, '分类保存失败')
    } finally {
      setCatalogBusy(false)
    }
  }

  const confirmDeleteCategory = async () => {
    if (!categoryDelete || !canAdmin) return
    setCatalogBusy(true)
    try {
      await adminApi.deleteAgentMarketCategory(token, categoryDelete.categoryKey, {
        expectedRevision: categoryDelete.revision,
      })
      notify?.('分类“' + categoryDelete.name + '”已删除', 'success')
      setCategoryDelete(null)
      setSelectedCategory('all')
      catalogRemote.refresh()
    } catch (error) {
      handleAdminError(error, '分类删除失败')
    } finally {
      setCatalogBusy(false)
    }
  }

  const submitAgent = async (value: {
    agentKey: string
    name: string
    summary?: string
    categoryKey: string
    tags: string[]
    lifecycle: AgentLifecycle
  }) => {
    if (!canAdmin) return
    const editing = agentEditor && agentEditor !== 'create' ? agentEditor : null
    setCatalogBusy(true)
    try {
      if (editing) {
        await adminApi.updateAgentMarketAgent(token, editing.agentKey, {
          expectedRevision: editing.revision,
          name: value.name,
          summary: value.summary,
          categoryKey: value.categoryKey,
          tags: value.tags,
          lifecycle: value.lifecycle,
        })
        notify?.('Agent“' + value.name + '”已更新', 'success')
      } else {
        await adminApi.createAgentMarketAgent(token, {
          agentKey: value.agentKey,
          name: value.name,
          summary: value.summary,
          categoryKey: value.categoryKey,
          tags: value.tags,
        })
        notify?.('Agent“' + value.name + '”已创建；未配置执行器', 'success')
      }
      setAgentEditor(null)
      catalogRemote.refresh()
    } catch (error) {
      handleAdminError(error, 'Agent 保存失败')
    } finally {
      setCatalogBusy(false)
    }
  }

  const confirmLifecycle = async () => {
    if (!lifecycleConfirm || !canAdmin) return
    const lifecycle: AgentLifecycle = lifecycleConfirm.lifecycle === 'disabled'
      ? (lifecycleConfirm.executorKey ? 'published' : 'draft')
      : 'disabled'
    setCatalogBusy(true)
    try {
      await adminApi.updateAgentMarketAgent(token, lifecycleConfirm.agentKey, {
        expectedRevision: lifecycleConfirm.revision,
        name: lifecycleConfirm.name,
        summary: lifecycleConfirm.summary || undefined,
        categoryKey: lifecycleConfirm.categoryKey,
        tags: lifecycleConfirm.tags,
        lifecycle,
      })
      notify?.(lifecycleConfirm.name + ' 已' + (lifecycle === 'disabled' ? '停用' : '恢复'), 'success')
      setLifecycleConfirm(null)
      catalogRemote.refresh()
    } catch (error) {
      handleAdminError(error, lifecycle === 'disabled' ? '停用失败' : '恢复失败')
    } finally {
      setCatalogBusy(false)
    }
  }

  if (catalogRemote.loading && !catalogRemote.data) return <LoadingState label="正在加载 Agent Market 目录" />
  if (catalogRemote.error && !catalogRemote.data) return <ErrorState error={catalogRemote.error} onRetry={catalogRemote.refresh} />

  return (
    <>
      <PageHeading className="mih-market-page-heading" eyebrow="AGENT CENTER / OBSERVABLE MARKET"
        title="Agent Market"
        description="从真实目录选择 Agent，观察阶段流转、输入输出与运行差异；所有 Demo dry-run 保持 0 次业务写入。"
        loading={catalogRemote.loading} onRefresh={catalogRemote.refresh}>
        <StatusBadge status="active" label={catalog.agents.length + ' 个 Agent'} />
        {canAdmin ? (
          <>
            <button className="qp-button qp-button--outline" type="button" onClick={() => setCategoryEditor('create')}>
              <Plus size={16} aria-hidden="true" />新建分类
            </button>
            <button className="qp-button qp-button--primary" type="button"
              disabled={!catalog.categories.length} onClick={() => setAgentEditor('create')}>
              <Brain size={16} aria-hidden="true" />新建 Agent
            </button>
          </>
        ) : null}
      </PageHeading>
      {!canAdmin ? (
        <div className="mih-inline-warning mih-market-permission">
          <LockKey size={17} aria-hidden="true" />
          当前 Hub 管理会话为只读；Agent Market 直接复用当前会话凭据，无需再次认证。
        </div>
      ) : null}
      <section className={'mih-market-workbench' + (inspectorCollapsed ? ' is-inspector-collapsed' : '')}>
        <CatalogRail catalog={catalog} loading={catalogRemote.loading}
          selectedAgentKey={selectedAgentKey} selectedCategory={selectedCategory} search={search}
          canAdmin={canAdmin} onSelectAgent={setSelectedAgentKey}
          onCategory={setSelectedCategory} onSearch={setSearch}
          onCreateCategory={() => setCategoryEditor('create')}
          onEditCategory={(category) => setCategoryEditor(category)}
          onCreateAgent={() => setAgentEditor('create')}
          onEditAgent={(agent) => setAgentEditor(agent)}
          onToggleAgent={setLifecycleConfirm} />
        <main className="mih-market-main">
          {selectedAgent ? (
            <>
              <header className="mih-market-agent-heading">
                <div>
                  <span className="mih-market-agent-heading__icon"><Brain size={24} weight="duotone" aria-hidden="true" /></span>
                  <div>
                    <p className="qp-kicker">
                      {selectedAgent.kind.toUpperCase()} · {selectedAgent.agentKey} · REV {selectedAgent.revision}
                    </p>
                    <h2>{selectedAgent.name}</h2><p>{selectedAgent.summary || '暂无简介'}</p>
                  </div>
                </div>
                <div className="mih-market-agent-heading__status">
                  <StatusBadge status={lifecycleTone(selectedAgent.lifecycle)} label={lifecycleLabel(selectedAgent.lifecycle)} />
                  <span className="qp-tag">{selectedAgent.executorKey
                    ? (selectedAgent.dryRunOnly ? 'Dry Run Only' : 'Runtime')
                    : 'Catalog Only · 未配置执行器'}</span>
                  <span className="qp-tag">Writes 0</span>
                  {canAdmin ? (
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button"
                      aria-label={'编辑 ' + selectedAgent.name} onClick={() => setAgentEditor(selectedAgent)}>
                      <PencilSimple size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </header>
              {isAdvancedWorkbench ? (
                <>
                  <RunConfiguration canAdmin={canAdmin}
                    enabled={!definitionRemote.loading && !definitionRemote.error && !definitionError}
                    running={running} saving={saving} dirty={dirty}
                    sequenceKey={sequenceKey} sequenceOptions={sequenceConfig.options}
                    sequenceHint={sequenceConfig.hint} query={query} filters={filters}
                    runLabel={runLabel} runDisabledReason={runDisabledReason}
                    agentControlError={agentControl.error} runError={runError}
                    onSequence={setSequenceKey} onQuery={setQuery} onFilters={setFilters}
                    onRun={run} onSave={save}
                    onReset={() => setDraft(structuredClone(snapshot.definition))} />
                  {definitionRemote.loading && !definitionRemote.data ? (
                    <LoadingState label="正在加载 Agent 执行定义" />
                  ) : definitionRemote.error || definitionError ? (
                    <ErrorState error={definitionRemote.error || definitionError} onRetry={definitionRemote.refresh} />
                  ) : (
                    <>
                      <AgentFlowGraph definition={draft} tracesByStage={tracesByStage}
                        terminalTrace={latestTrace(result?.traces || [])}
                        selectedStage={selectedStage} running={running} onSelect={(stage) => {
                          setSelectedStage(stage)
                          setInspectorTab('input')
                        }} />
                      <TerminalAuditPanel audit={terminalAudit} />
                      <RunComparison stageType={selectedStage} current={result} previous={previousResult}
                        baseline={baselineResult} compareTarget={compareTarget} onCompareTarget={setCompareTarget} />
                      <RunMetrics current={result} reference={comparisonResult} />
                    </>
                  )}
                </>
              ) : <UnsupportedWorkbench agent={selectedAgent} />}
            </>
          ) : (
            <EmptyState icon={Storefront} title="目录中还没有 Agent"
              description={canAdmin ? '先创建分类，再创建第一个 Agent。' : '请联系管理员配置 Agent Market。'}
              action={canAdmin && !catalog.categories.length ? (
                <button className="qp-button qp-button--primary" type="button" onClick={() => setCategoryEditor('create')}>
                  <Plus size={16} aria-hidden="true" />新建分类
                </button>
              ) : undefined} />
          )}
          <section className="mih-market-safety" aria-label="运行安全边界">
            <div><ShieldCheck size={18} aria-hidden="true" /><span><strong>Hub 管理会话 + Dry Run Gate</strong><small>无需额外凭据；服务端强制 dryRun=true 与输入上限</small></span></div>
            <div><Database size={18} aria-hidden="true" /><span><strong>PG / ES 只读</strong><small>不写 canonical、outbox 或主搜索配置</small></span></div>
            <div><BracketsCurly size={18} aria-hidden="true" /><span><strong>Zod 契约</strong><small>输出、Schema 与 UI 观测同源</small></span></div>
            <div><Warning size={18} aria-hidden="true" /><span><strong>模型可能计费</strong><small>真实 Provider 调用会产生模型成本</small></span></div>
          </section>
        </main>
        {inspectorCollapsed ? (
          <aside className="mih-market-inspector-rail" aria-label="阶段详情已收起">
            <button className="qp-button qp-button--ghost" type="button"
              id="mih-market-inspector-expand" aria-controls="mih-market-stage-inspector"
              aria-expanded="false" aria-label="向左展开阶段详情" title="向左展开阶段详情"
              onClick={() => changeInspectorCollapsed(false)}>
              <CaretLeft size={17} aria-hidden="true" /><span>展开阶段详情</span>
            </button>
          </aside>
        ) : selectedAgent && isAdvancedWorkbench && selectedStageDefinition ? (
          <StageInspector stage={selectedStageDefinition} traces={selectedStageTraces}
            referenceTraces={previousTracesByStage.get(selectedStage) || []}
            tab={inspectorTab} attempt={selectedAttempt} canEdit={canAdmin}
            onTab={setInspectorTab} onAttempt={setSelectedAttempt}
            onMutate={(mutate) => setDraft((current) => updateStage(current, selectedStageDefinition.id, mutate))}
            onToggleStage={() => setDraft((current) => setStageState(
              current,
              selectedStageDefinition.id,
              selectedStageDefinition.state === 'active' ? 'trashed' : 'active',
            ))}
            onCollapse={() => changeInspectorCollapsed(true)} />
        ) : (
          <aside className="mih-market-inspector mih-market-inspector--empty"
            id="mih-market-stage-inspector" aria-label="阶段详情">
            <button className="qp-button qp-button--ghost mih-market-inspector__collapse" type="button"
              id="mih-market-inspector-collapse" aria-controls="mih-market-stage-inspector"
              aria-expanded="true" aria-label="向右收起阶段详情" title="向右收起阶段详情"
              onClick={() => changeInspectorCollapsed(true)}>
              <CaretRight size={16} aria-hidden="true" /><span>收起</span>
            </button>
            <FlowArrow size={30} weight="duotone" aria-hidden="true" />
            <strong>阶段详情</strong>
            <p>{selectedAgent ? '当前 Agent 暂无可观测阶段协议。' : '选择 Agent 后查看阶段详情。'}</p>
          </aside>
        )}
      </section>
      {categoryEditor ? (
        <CategoryEditorModal category={categoryEditor === 'create' ? null : categoryEditor}
          busy={catalogBusy} onClose={() => setCategoryEditor(null)}
          onDelete={categoryEditor === 'create' || categoryEditor.builtin ? undefined : () => {
            setCategoryDelete(categoryEditor)
            setCategoryEditor(null)
          }}
          onSubmit={submitCategory} />
      ) : null}
      {categoryDelete ? (
        <ConfirmDialog title={'删除分类“' + categoryDelete.name + '”？'}
          description="只有空分类可以删除；服务端会以 revision 做并发保护。"
          confirmLabel={catalogBusy ? '删除中…' : '删除分类'} busy={catalogBusy}
          onCancel={() => setCategoryDelete(null)} onConfirm={confirmDeleteCategory}>
          <p>当前目录报告 {categoryDelete.agentCount} 个 Agent。若数量大于 0，请先移动这些 Agent。</p>
        </ConfirmDialog>
      ) : null}
      {agentEditor ? (
        <AgentEditorModal agent={agentEditor === 'create' ? null : agentEditor}
          categories={catalog.categories} busy={catalogBusy}
          onClose={() => setAgentEditor(null)} onSubmit={submitAgent} />
      ) : null}
      {lifecycleConfirm ? (
        <ConfirmDialog title={lifecycleConfirm.lifecycle === 'disabled'
          ? '恢复“' + lifecycleConfirm.name + '”？'
          : '停用“' + lifecycleConfirm.name + '”？'}
          description={lifecycleConfirm.lifecycle === 'disabled'
            ? '恢复后按 Agent 类型回到可管理状态；能否运行仍以服务端 runnable 为准。'
            : '停用会禁止新的运行，但保留配置与历史。'}
          confirmLabel={catalogBusy
            ? '处理中…'
            : lifecycleConfirm.lifecycle === 'disabled' ? '恢复 Agent' : '停用 Agent'}
          tone={lifecycleConfirm.lifecycle === 'disabled' ? 'primary' : 'danger'}
          busy={catalogBusy} onCancel={() => setLifecycleConfirm(null)} onConfirm={confirmLifecycle}>
          <p>将提交 expectedRevision={lifecycleConfirm.revision}，不会覆盖其他管理员的并发修改。</p>
        </ConfirmDialog>
      ) : null}
    </>
  )
}
