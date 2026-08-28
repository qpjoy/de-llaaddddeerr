import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  ArrowCounterClockwise,
  BracketsCurly,
  Brain,
  ChartBar,
  CheckCircle,
  Database,
  FloppyDisk,
  FlowArrow,
  LockKey,
  Play,
  Recycle,
  ShieldCheck,
  Storefront,
  Trash,
  Warning,
  Wrench,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  DropdownField,
  ErrorState,
  Field,
  LoadingState,
  PageHeading,
  StatusBadge,
  useRemoteData,
} from './components.jsx'
import {
  ADVANCED_SEARCH_AGENT_KEY,
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

type StageTrace = {
  stageId: string
  type: AdvancedSearchStageType
  title: string
  attempt: number
  status: 'succeeded' | 'degraded' | 'skipped' | 'failed'
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
  model: null | {
    provider: string | null
    model: string | null
    temperature: number
    maxTokens: number
    latencyMs: number | null
    inputTokens: number | null
    outputTokens: number | null
    fallback: boolean
    errorCode: string | null
    responseValidation: null | {
      valid: boolean
      issues: Array<{ path: string, message: string }>
    }
  }
  note: string | null
}

type DryRunResult = {
  contractVersion: string
  dryRun: true
  definitionHash: string
  durationMs: number
  safety: Record<string, unknown>
  dataAccess: {
    postgres: boolean
    elasticsearch: boolean
    modelAvailable: boolean
  }
  traces: StageTrace[]
  final: null | {
    answer: string
    citations: Array<{ evidenceId: string, claim: string }>
    confidence: number
    limitations: string[]
    refused: boolean
  }
  evaluation: Record<string, number | null>
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

const STAGE_TABS = [
  { id: 'prompt', label: 'Prompt / 参数' },
  { id: 'schema', label: 'Zod Schema' },
  { id: 'result', label: 'Result' },
  { id: 'metrics', label: 'Metrics' },
] as const

type StageTab = typeof STAGE_TABS[number]['id']

function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
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

function nullable(value: string): string | null {
  return value.trim() || null
}

function nullableDateTime(value: string): string | null {
  return value.trim() ? new Date(value).toISOString() : null
}

function definitionText(definition: AdvancedSearchDefinition): string {
  return JSON.stringify(definition)
}

function traceTone(status: StageTrace['status']): string {
  if (status === 'succeeded') return 'active'
  if (status === 'degraded') return 'degraded'
  if (status === 'failed') return 'down'
  return 'disabled'
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function metricNumber(value: unknown): string {
  return typeof value === 'number'
    ? Number.isInteger(value) ? String(value) : value.toFixed(2)
    : '—'
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
          options={SEARCH_PROFILE_OPTIONS as any}
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
        <Field label={'最低相关度 · ' + stage.options.minRelevance.toFixed(2)} hint="低于阈值的证据不会进入答案阶段。">
          <input className="mih-market-range" type="range" min="0" max="1" step="0.05"
            value={stage.options.minRelevance} disabled={disabled}
            onChange={(event) => onChange((candidate) => {
              if (candidate.type === 'grade') candidate.options.minRelevance = Number(event.target.value)
            })} />
        </Field>
        <Field label="最大纠错回环" hint="MVP 强制 0 或 1，避免无限模型/检索调用。">
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
        <span><strong>强制引用</strong><small>引用 ID 不在本次 evidence 中时自动丢弃；无有效引用则 fallback。</small></span>
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
          <div className="mih-market-role-grid">
            <Field label="system" hint="运行时还会追加不可编辑的 Schema / 安全契约。">
              <textarea className="qp-input mih-market-prompt" value={stage.prompt.system}
                disabled={disabled} onChange={(event) => onChange((candidate) => {
                  if ('prompt' in candidate) candidate.prompt.system = event.target.value
                })} />
            </Field>
            <Field label="user template" hint="支持 {{query}}、{{filters}}、{{evidence}}、{{geo}} 等受控变量。">
              <textarea className="qp-input mih-market-prompt" value={stage.prompt.user}
                disabled={disabled} onChange={(event) => onChange((candidate) => {
                  if ('prompt' in candidate) candidate.prompt.user = event.target.value
                })} />
            </Field>
          </div>
          <div className="mih-market-option-grid">
            <Field label={'Temperature · ' + stage.model.temperature.toFixed(2)}
              hint="每个 Agent 阶段独立控制，不使用全局 temperature。">
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
          <div><strong>固定工具阶段</strong><p>没有 Prompt 或 temperature。工具输入由代码和 Zod 限制，模型不能生成 SQL、DSL 或连接信息。</p></div>
        </div>
      )}
      <StageOptionsEditor stage={stage} disabled={disabled} onChange={onChange} />
    </div>
  )
}

function StageResult({
  stage,
  traces,
}: {
  stage: AdvancedSearchStage
  traces: StageTrace[]
}) {
  const meta = ADVANCED_SEARCH_STAGE_META[stage.type]
  if (traces.length === 0) {
    return (
      <div className="mih-market-empty-result">
        <span>返回示例</span>
        <pre>{pretty(meta.outputExample)}</pre>
      </div>
    )
  }
  return (
    <div className="mih-market-trace-list">
      {traces.map((trace) => (
        <article key={trace.stageId + ':' + trace.attempt} className="mih-market-trace">
          <header>
            <strong>{trace.attempt > 0 ? '纠错回环 #' + trace.attempt : '首轮执行'}</strong>
            <StatusBadge status={traceTone(trace.status)} label={trace.status} />
          </header>
          {trace.note ? <p>{trace.note}</p> : null}
          {trace.messages.length > 0 ? (
            <details>
              <summary>查看渲染后的消息</summary>
              {trace.messages.map((message, index) => (
                <div className="mih-market-message" key={message.role + ':' + index}>
                  <span>{message.role}</span>
                  <pre>{message.content}</pre>
                </div>
              ))}
            </details>
          ) : null}
          <details open>
            <summary>结构化阶段结果</summary>
            <pre>{pretty(trace.output)}</pre>
          </details>
        </article>
      ))}
    </div>
  )
}

function StageMetrics({ traces }: { traces: StageTrace[] }) {
  if (traces.length === 0) return <p className="mih-market-muted">运行后显示耗时、模型、token、工具调用与 Schema 结果。</p>
  return (
    <div className="mih-market-metrics-table">
      {traces.map((trace) => (
        <article key={trace.stageId + ':metrics:' + trace.attempt}>
          <span>Attempt <strong>{trace.attempt}</strong></span>
          <span>耗时 <strong>{trace.durationMs} ms</strong></span>
          <span>有效输出 Schema <strong>{trace.validation.valid ? 'PASS' : 'FAIL'}</strong></span>
          <span>模型响应 Schema <strong>{trace.model?.responseValidation
            ? (trace.model.responseValidation.valid ? 'PASS' : 'FAIL')
            : '—'}</strong></span>
          <span>模型 <strong>{trace.model?.model || (trace.toolCalls.length ? '固定工具' : '—')}</strong></span>
          <span>Tokens <strong>{metricNumber(trace.model?.inputTokens)} / {metricNumber(trace.model?.outputTokens)}</strong></span>
          <span>Tool calls <strong>{trace.toolCalls.length}</strong></span>
          {trace.model?.errorCode ? <span>降级码 <strong>{trace.model.errorCode}</strong></span> : null}
          {trace.model?.responseValidation && !trace.model.responseValidation.valid ? (
            <span className="mih-market-schema-issues">模型响应问题
              <strong>{trace.model.responseValidation.issues.slice(0, 3)
                .map((issue) => (issue.path ? issue.path + ': ' : '') + issue.message)
                .join(' · ')}</strong>
            </span>
          ) : null}
        </article>
      ))}
    </div>
  )
}

function StageCard({
  stage,
  selected,
  tab,
  traces,
  canEdit,
  onSelect,
  onTab,
  onMutate,
  onTrash,
  onDragStart,
}: {
  stage: AdvancedSearchStage
  selected: boolean
  tab: StageTab
  traces: StageTrace[]
  canEdit: boolean
  onSelect: () => void
  onTab: (tab: StageTab) => void
  onMutate: (mutate: (stage: AdvancedSearchStage) => void) => void
  onTrash: () => void
  onDragStart: (event: DragEvent<HTMLElement>) => void
}) {
  const meta = ADVANCED_SEARCH_STAGE_META[stage.type]
  const Icon = meta.kind === 'agent' ? Brain : Wrench
  const latest = traces.at(-1)
  return (
    <article className={'mih-market-stage' + (selected ? ' is-selected' : '')}
      draggable={canEdit} onDragStart={onDragStart}>
      <header className="mih-market-stage__header">
        <button type="button" className="mih-market-stage__select" onClick={onSelect}
          aria-expanded={selected}>
          <span className={'mih-market-stage__icon is-' + meta.kind}><Icon size={20} weight="duotone" /></span>
          <span>
            <small>{meta.lesson}</small>
            <strong>{meta.label}</strong>
            <p>{meta.description}</p>
          </span>
        </button>
        <div className="mih-market-stage__actions">
          {latest ? <StatusBadge status={traceTone(latest.status)} label={latest.status} /> : null}
          <span className="qp-tag">{meta.kind === 'agent' ? 'Agent' : 'Tool'}</span>
          {canEdit ? (
            <button className="qp-button qp-button--ghost qp-icon-button" type="button"
              aria-label={'把 ' + meta.label + ' 移入回收站'} title="移入回收站" onClick={onTrash}>
              <Trash size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      {selected ? (
        <div className="mih-market-stage__body">
          <nav className="mih-market-tabs" aria-label={meta.label + ' 详情'}>
            {STAGE_TABS.map((item) => (
              <button key={item.id} type="button" className={tab === item.id ? 'is-active' : ''}
                onClick={() => onTab(item.id)}>{item.label}</button>
            ))}
          </nav>
          {tab === 'prompt' ? (
            <PromptEditor stage={stage} disabled={!canEdit} onChange={onMutate} />
          ) : null}
          {tab === 'schema' ? (
            <div className="mih-market-schema-grid">
              <div><span>Zod / TypeScript 教学摘录（运行时以右侧为准）</span><pre>{meta.schemaCode}</pre></div>
              <div><span>同源 JSON Schema</span><pre>{pretty(jsonSchemaForStage(stage.type))}</pre></div>
            </div>
          ) : null}
          {tab === 'result' ? <StageResult stage={stage} traces={traces} /> : null}
          {tab === 'metrics' ? <StageMetrics traces={traces} /> : null}
        </div>
      ) : null}
    </article>
  )
}

function LockedGate({
  kind,
  title,
  description,
}: {
  kind: 'entry' | 'exit'
  title: string
  description: string
}) {
  const Icon = kind === 'entry' ? ShieldCheck : ChartBar
  return (
    <article className="mih-market-gate">
      <span><Icon size={21} weight="duotone" aria-hidden="true" /></span>
      <div><small>LOCKED RUNTIME NODE</small><strong>{title}</strong><p>{description}</p></div>
      <LockKey size={16} aria-label="不可删除" />
    </article>
  )
}

function EvaluationCompare({
  previous,
  current,
}: {
  previous: DryRunResult | null
  current: DryRunResult | null
}) {
  if (!current) return null
  const percent = (value: number | null | undefined) => value == null ? null : value * 100
  const rows = [
    ['总耗时', previous?.durationMs, current.durationMs, 'ms'],
    ['证据数', previous?.evaluation.evidenceCount, current.evaluation.evidenceCount, ''],
    ['有效输出 Schema', percent(previous?.evaluation.effectiveSchemaPassRate), percent(current.evaluation.effectiveSchemaPassRate), '%'],
    ['模型响应 Schema', percent(previous?.evaluation.modelSchemaPassRate), percent(current.evaluation.modelSchemaPassRate), '%'],
    ['降级阶段', previous?.evaluation.degradedStages, current.evaluation.degradedStages, ''],
    ['引用覆盖', percent(previous?.evaluation.citationCoverage), percent(current.evaluation.citationCoverage), '%'],
  ] as const
  return (
    <Panel title="Trace / Eval Gate" subtitle="上一轮仅作观察对照；概率系统应再绑定固定评测集，不以单次结果判定优劣。">
      <div className="mih-market-compare">
        <div className="mih-market-compare__head"><span>指标</span><span>上一轮</span><span>当前轮</span></div>
        {rows.map(([label, before, after, unit]) => (
          <div key={label}><span>{label}</span><strong>{before == null ? '—' : metricNumber(before) + unit}</strong><strong>{metricNumber(after) + unit}</strong></div>
        ))}
      </div>
    </Panel>
  )
}

export function AgentMarketPage({ token, session, onUnauthorized, notify }: PageProps) {
  const load = useCallback(
    () => adminApi.agentMarketItem(token, ADVANCED_SEARCH_AGENT_KEY),
    [token],
  )
  const remote = useRemoteData(load, onUnauthorized) as {
    data: Snapshot | null
    error: any
    loading: boolean
    refresh: () => void
  }
  const [snapshot, setSnapshot] = useState<Snapshot>({
    agentKey: ADVANCED_SEARCH_AGENT_KEY,
    revision: 0,
    source: 'builtin',
    definition: freshAdvancedSearchDefinition(),
    updatedBy: null,
    updatedAt: null,
  })
  const [draft, setDraft] = useState<AdvancedSearchDefinition>(() => freshAdvancedSearchDefinition())
  const [query, setQuery] = useState<string>(ADVANCED_SEARCH_INPUT_EXAMPLE.query)
  const [filters, setFilters] = useState<FilterDraft>(EMPTY_FILTERS)
  const [selectedStage, setSelectedStage] = useState<AdvancedSearchStageType>('triage')
  const [tab, setTab] = useState<StageTab>('prompt')
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<unknown>(null)
  const [result, setResult] = useState<DryRunResult | null>(null)
  const [previousResult, setPreviousResult] = useState<DryRunResult | null>(null)
  const canEdit = session?.kind === 'admin-token'

  useEffect(() => {
    if (!remote.data) return
    const parsed = AdvancedSearchDefinitionSchema.safeParse(remote.data.definition)
    if (!parsed.success) return
    const next: Snapshot = { ...remote.data, definition: parsed.data }
    setSnapshot(next)
    setDraft(structuredClone(parsed.data))
  }, [remote.data])

  const activeStages = useMemo(
    () => draft.stages.filter((stage) => stage.state === 'active'),
    [draft],
  )
  const trashedStages = useMemo(
    () => draft.stages.filter((stage) => stage.state === 'trashed'),
    [draft],
  )
  const dirty = definitionText(draft) !== definitionText(snapshot.definition)
  const tracesByStage = useMemo(() => {
    const grouped = new Map<AdvancedSearchStageType, StageTrace[]>()
    for (const trace of result?.traces || []) {
      grouped.set(trace.type, [...(grouped.get(trace.type) || []), trace])
    }
    return grouped
  }, [result])

  const mutateStage = (stageId: string, mutate: (stage: AdvancedSearchStage) => void) => {
    setDraft((current) => updateStage(current, stageId, mutate))
  }

  const moveToTrash = (stageId: string) => {
    setDraft((current) => setStageState(current, stageId, 'trashed'))
    const next = activeStages.find((stage) => stage.id !== stageId)
    if (selectedStage === stageId && next) setSelectedStage(next.type)
  }

  const restore = (stageId: string) => {
    setDraft((current) => setStageState(current, stageId, 'active'))
    setSelectedStage(stageId as AdvancedSearchStageType)
  }

  const dragId = (event: DragEvent): string => event.dataTransfer.getData('text/plain')
  const onDragStart = (stageId: string) => (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', stageId)
  }
  const allowDrop = (event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const save = async () => {
    const parsed = AdvancedSearchDefinitionSchema.safeParse(draft)
    if (!parsed.success) {
      notify?.('当前配置未通过 Zod 校验，请检查空 Prompt 或超出范围的参数。', 'warning')
      return
    }
    setSaving(true)
    try {
      const saved = await adminApi.saveAgentMarketItem(token, ADVANCED_SEARCH_AGENT_KEY, {
        expectedRevision: snapshot.revision,
        definition: parsed.data,
      })
      setSnapshot(saved)
      setDraft(structuredClone(saved.definition))
      notify?.('Agent Market 草稿已保存为 revision ' + saved.revision, 'success')
    } catch (error: any) {
      if (error?.status === 401) onUnauthorized?.(error)
      notify?.(error?.message || '保存失败', 'warning')
    } finally {
      setSaving(false)
    }
  }

  const run = async () => {
    const parsed = AdvancedSearchDefinitionSchema.safeParse(draft)
    if (!parsed.success || !query.trim()) {
      notify?.('请输入问题，并修正未通过 Zod 校验的阶段配置。', 'warning')
      return
    }
    setRunning(true)
    setRunError(null)
    try {
      const runSnapshot = structuredClone(parsed.data)
      const next = await adminApi.runAgentMarketDryRun(token, ADVANCED_SEARCH_AGENT_KEY, {
        dryRun: true,
        query: query.trim(),
        filters: {
          platform: nullable(filters.platform),
          datasetId: nullable(filters.datasetId),
          objectType: nullable(filters.objectType),
          fromTime: nullableDateTime(filters.fromTime),
          toTime: nullableDateTime(filters.toTime),
        },
        definition: runSnapshot,
      })
      setPreviousResult(result)
      setResult(next)
      notify?.('Dry run 完成：0 次业务写入，' + next.traces.length + ' 条阶段 Trace。', 'success')
    } catch (error: any) {
      if (error?.status === 401) onUnauthorized?.(error)
      setRunError(error)
    } finally {
      setRunning(false)
    }
  }

  if (remote.loading && !remote.data) return <LoadingState label="正在打开 Agent Market" />
  if (remote.error && !remote.data) return <ErrorState error={remote.error} onRetry={remote.refresh} />

  return (
    <>
      <PageHeading
        eyebrow="AGENT MARKET / LEARNABLE DRY RUN"
        title="Agent Market"
        description="第一个示例把进阶搜索拆成可编辑、可验证、可回收的显式阶段图。它只读当前 PG / ES，不接管主搜索，也不进入 MX-H2I 登录与联网链路。"
        loading={false}
        onRefresh={undefined}
      >
        <StatusBadge status="active" label="1 个内置 Agent" />
      </PageHeading>

      <section className="mih-market-hero">
        <div>
          <span className="mih-market-hero__icon"><Storefront size={30} weight="duotone" /></span>
          <div>
            <p className="qp-kicker">MARKET ITEM · {snapshot.source.toUpperCase()} REV {snapshot.revision}</p>
            <h2>{draft.displayName}</h2>
            <p>{draft.description}</p>
          </div>
        </div>
        <dl>
          <div><dt>Active</dt><dd>{activeStages.length}</dd></div>
          <div><dt>Trash</dt><dd>{trashedStages.length}</dd></div>
          <div><dt>Writes</dt><dd>0</dd></div>
          <div><dt>Tools</dt><dd>{ADVANCED_SEARCH_TOOLS.length}</dd></div>
        </dl>
      </section>

      {!canEdit ? (
        <div className="mih-inline-warning mih-market-permission">
          <LockKey size={17} aria-hidden="true" />
          Launcher 平台管理员可查看定义与示例；保存 Prompt 和运行有模型成本的 dry-run 需要 Admin Token。
        </div>
      ) : null}

      <div className="mih-market-layout">
        <aside className="mih-market-runner">
          <Panel title="运行实验" subtitle="运行使用当前未保存草稿的不可变快照。">
            <Field label="user" hint="这是本次 dry-run 的用户消息。">
              <textarea className="qp-input mih-market-query" value={query} disabled={!canEdit || running}
                onChange={(event) => setQuery(event.target.value)} />
            </Field>
            <details className="mih-market-filters">
              <summary>受控检索过滤条件</summary>
              <Field label="Platform" hint="可选的精确平台过滤。"><input className="qp-input" value={filters.platform}
                disabled={!canEdit || running} onChange={(event) => setFilters({ ...filters, platform: event.target.value })} /></Field>
              <Field label="Dataset ID" hint="可选的精确数据集过滤。"><input className="qp-input" value={filters.datasetId}
                disabled={!canEdit || running} onChange={(event) => setFilters({ ...filters, datasetId: event.target.value })} /></Field>
              <Field label="Object Type" hint="可选的精确对象类型过滤。"><input className="qp-input" value={filters.objectType}
                disabled={!canEdit || running} onChange={(event) => setFilters({ ...filters, objectType: event.target.value })} /></Field>
              <Field label="From Time" hint="可选的事件时间下界。"><input className="qp-input" type="datetime-local" value={filters.fromTime}
                disabled={!canEdit || running} onChange={(event) => setFilters({ ...filters, fromTime: event.target.value })} /></Field>
              <Field label="To Time" hint="可选的事件时间上界。"><input className="qp-input" type="datetime-local" value={filters.toTime}
                disabled={!canEdit || running} onChange={(event) => setFilters({ ...filters, toTime: event.target.value })} /></Field>
            </details>
            <div className="mih-market-run-actions">
              <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || running}
                onClick={run}><Play size={17} weight="fill" />{running ? '运行中' : '运行 --dry-run'}</button>
              <button className="qp-button qp-button--outline" type="button"
                disabled={!canEdit || saving || !dirty} onClick={save}>
                <FloppyDisk size={17} />{saving ? '保存中' : '保存草稿'}
              </button>
            </div>
            <button className="qp-button qp-button--ghost mih-market-reset" type="button"
              disabled={!canEdit || !dirty} onClick={() => setDraft(structuredClone(snapshot.definition))}>
              <ArrowCounterClockwise size={16} />撤销未保存修改
            </button>
            {runError ? <ErrorState error={runError as any} onRetry={undefined} /> : null}
          </Panel>

          <Panel title="白名单工具" subtitle="模型只能提出结构化字段，代码决定是否执行工具。">
            <div className="mih-market-tools">
              {ADVANCED_SEARCH_TOOLS.map((tool) => (
                <article key={tool.id}>
                  <Wrench size={17} weight="duotone" />
                  <div><code>{tool.id}</code><p>{tool.description}</p></div>
                  <span>sideEffect: none</span>
                </article>
              ))}
            </div>
          </Panel>

          {result?.final ? (
            <Panel title={result.final.refused ? '本次拒答' : '本次答案'}
              subtitle={'Confidence ' + Math.round(result.final.confidence * 100) + '%'}>
              <div className="mih-market-answer">
                <p>{result.final.answer}</p>
                {result.final.citations.map((citation) => (
                  <div key={citation.evidenceId}><code>{citation.evidenceId}</code><span>{citation.claim}</span></div>
                ))}
                {result.final.limitations.map((item) => <small key={item}>· {item}</small>)}
              </div>
            </Panel>
          ) : null}
        </aside>

        <section className="mih-market-graph" aria-label="Agent 阶段图"
          onDragOver={allowDrop} onDrop={(event) => {
            const id = dragId(event)
            if (id) restore(id)
          }}>
          <div className="mih-market-graph__heading">
            <div><p className="qp-kicker">EXPLICIT STAGE GRAPH</p><h2>进阶搜索 Agent</h2></div>
            <span><FlowArrow size={18} />每阶段独立 Prompt / 参数 / Schema / Result</span>
          </div>
          <LockedGate kind="entry" title="Access + DryRun Gate"
            description="Internal 会话、Admin Token、dryRun=true、白名单工具和输入上限由服务端强制，不能拖走。" />
          <div className="mih-market-flow-line" aria-hidden="true" />
          {activeStages.map((stage) => (
            <div className="mih-market-stage-wrap" key={stage.id}>
              <StageCard
                stage={stage}
                selected={selectedStage === stage.type}
                tab={tab}
                traces={tracesByStage.get(stage.type) || []}
                canEdit={canEdit}
                onSelect={() => setSelectedStage(stage.type)}
                onTab={setTab}
                onMutate={(mutate) => mutateStage(stage.id, mutate)}
                onTrash={() => moveToTrash(stage.id)}
                onDragStart={onDragStart(stage.id)}
              />
              {stage.type === 'triage' ? (
                <div className="mih-market-branch-note" aria-label="意图分流条件边">
                  <span>knowledge_search → rewrite</span>
                  <span>structured_filter → retrieve</span>
                  <span>clarify → grounded refusal</span>
                </div>
              ) : null}
              {stage.type === 'grade' && stage.options.maxRetries > 0 ? (
                <div className="mih-market-branch-note is-loop" aria-label="纠错回环">
                  <ArrowCounterClockwise size={14} aria-hidden="true" />
                  <span>partial / insufficient → rewrite · 最多 {stage.options.maxRetries} 次</span>
                </div>
              ) : null}
              <div className="mih-market-flow-line" aria-hidden="true" />
            </div>
          ))}
          <LockedGate kind="exit" title="Trace + Eval Gate"
            description="显示渲染消息、结构化结果、工具、模型、token、耗时与分支理由；不展示或声称展示隐藏思维链。" />

          <section className={'mih-market-trash' + (trashedStages.length ? ' has-items' : '')}
            onDragOver={allowDrop} onDrop={(event) => {
              event.stopPropagation()
              const id = dragId(event)
              if (id) moveToTrash(id)
            }}>
            <header><Recycle size={22} weight="duotone" /><div><strong>阶段回收站</strong><p>拖入测试删除后的影响；配置、Prompt 与原位置仍保留。</p></div></header>
            <div>
              {trashedStages.map((stage) => (
                <article key={stage.id} draggable={canEdit} onDragStart={onDragStart(stage.id)}>
                  <span>{ADVANCED_SEARCH_STAGE_META[stage.type].label}</span>
                  <button className="qp-button qp-button--ghost" type="button" disabled={!canEdit}
                    onClick={() => restore(stage.id)}>
                    <ArrowCounterClockwise size={15} />恢复
                  </button>
                </article>
              ))}
              {trashedStages.length === 0 ? <small>把任一业务阶段拖到这里，或使用阶段右上角的删除按钮。</small> : null}
            </div>
          </section>
        </section>
      </div>

      <EvaluationCompare previous={previousResult} current={result} />

      <Panel title="安全边界" subtitle="这个 Demo 是影子实验面，不是生产 Agent 发布或主搜索切换开关。">
        <div className="mih-market-boundaries">
          <div><CheckCircle size={20} /><strong>只读 PG / ES</strong><p>不调用 HubService 计费/幂等写路径，不调用 Night-All，不入队、不出 outbox。</p></div>
          <div><BracketsCurly size={20} /><strong>Zod 单一真相</strong><p>TS 类型、运行时验证和 JSON Schema 同源；教学代码是标明用途的可读摘录，返回示例必须通过真实 Schema。</p></div>
          <div><Database size={20} /><strong>不改主结果</strong><p>搜索 Profile、索引别名、canonical 记录、用户授权与 MX-H2I 网络状态均不写。</p></div>
          <div><Warning size={20} /><strong>模型仍可能计费</strong><p>配置 provider 后，Agent 阶段会真实调用模型；无模型时显示确定性降级。</p></div>
        </div>
      </Panel>
    </>
  )
}
