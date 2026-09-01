import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  Brain,
  Database,
  FileArrowUp,
  Key,
  MagnifyingGlass,
  Pause,
  PencilSimple,
  Play,
  Plugs,
  Plus,
  ShieldCheck,
  Table,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  DropdownField,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
  Modal,
  PageHeading,
  StatusBadge,
  formatDate,
  formatNumber,
  useRemoteData,
} from './components.jsx'

const SSL_MODE_OPTIONS = [
  { value: 'disable', label: 'disable（同机或受控内网）' },
  { value: 'require', label: 'require' },
  { value: 'verify-ca', label: 'verify-ca' },
  { value: 'verify-full', label: 'verify-full' },
]

const INLINE_DATABASE_CONNECTION = ''

function databaseConnectionOptions(value) {
  return [
    {
      value: INLINE_DATABASE_CONNECTION,
      label: '任务内独立填写',
      description: '在当前任务保存完整 PostgreSQL 连接',
    },
    ...asList(value).map((connection) => ({
      value: connection.id,
      label: connection.displayName || connection.connectionKey,
      description: `${connection.host || '—'}:${connection.port || 5432} / ${connection.database || '—'}`,
      disabled: connection.engine && connection.engine !== 'postgresql',
    })),
  ]
}

function DatabaseConnectionField({ value, onChange, state, className = 'mih-form__wide' }) {
  return (
    <DropdownField
      label="数据库连接"
      value={value || INLINE_DATABASE_CONNECTION}
      onChange={onChange}
      options={databaseConnectionOptions(state?.data)}
      disabled={state?.loading && !state?.data}
      className={className}
      hint={state?.error
        ? '共享配置暂不可用；仍可选择任务内独立填写。'
        : '引用“数据库配置”中的共享连接，或为当前任务完整填写。'}
    />
  )
}

const PROVIDER_AUTH_OPTIONS = [
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'none', label: '无需认证' },
]

const PROVIDER_PROTOCOL_OPTIONS = [
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
]

const DEDICATED_CONNECTION = 'dedicated'
const INHERIT_CHAT_CONNECTION = 'inherit-chat'
const INHERIT_CHAT_OPTION_PREFIX = 'inherit-chat:'

function providerConnection(provider, kind = 'embedding') {
  if (kind !== 'embedding') return { mode: DEDICATED_CONNECTION }
  const connection = provider?.connection
  if (connection?.mode === INHERIT_CHAT_CONNECTION && connection.providerId) {
    return { mode: INHERIT_CHAT_CONNECTION, providerId: String(connection.providerId) }
  }
  return { mode: DEDICATED_CONNECTION }
}

function normalizeEmbeddingCapability(capability = {}, fallbackStatus = 'probe-required') {
  const status = ['supported', 'unsupported', 'probe-required'].includes(capability.status)
    ? capability.status
    : fallbackStatus
  const reason = String(capability.reason || (
    status === 'supported'
      ? '该连接在 Embedding 能力目录中。'
      : status === 'unsupported'
        ? '该调用协议不提供 Embedding 接口。'
        : '能力尚未确认，保存后必须执行 Embedding 连接测试。'
  ))
  return {
    ...capability,
    status,
    reason,
    models: Array.isArray(capability.models)
      ? capability.models
      : Array.isArray(capability.knownModels) ? capability.knownModels : [],
  }
}

function embeddingCatalogConnection(provider, catalog) {
  if (!Array.isArray(catalog?.providers)) return null
  const protocol = provider?.protocol || 'openai-compatible'
  let hostname = null
  try {
    hostname = new URL(provider?.baseUrl || '').hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    // Keep an invalid or unfinished URL probe-required until form validation runs.
  }
  const entry = catalog.providers.find((candidate) => (
    hostname && Array.isArray(candidate?.hosts)
      && candidate.hosts.some((host) => String(host).toLowerCase().replace(/\.$/, '') === hostname)
  ))
  if (entry) {
    if (entry.status === 'supported'
      && Array.isArray(entry.protocols)
      && !entry.protocols.includes(protocol)) {
      return normalizeEmbeddingCapability({
        ...entry,
        status: 'unsupported',
        reason: '该 Provider 协议不能调用目录声明的 Embedding endpoint。',
      }, 'unsupported')
    }
    return normalizeEmbeddingCapability(entry, entry.status)
  }
  if (protocol !== 'openai-compatible') {
    return normalizeEmbeddingCapability({
      status: 'unsupported',
      vendor: 'custom',
      reason: '当前 Embedding 调用仅支持 OpenAI-compatible 协议。',
    }, 'unsupported')
  }
  return normalizeEmbeddingCapability({
    status: 'probe-required',
    vendor: 'custom',
    reason: hostname
      ? '该 OpenAI-compatible 服务的 Embedding 能力未知，启用前必须连接测试。'
      : 'Provider Base URL 尚未识别，启用 Embedding 前必须连接测试。',
  })
}

function embeddingConnectionCapability(provider, catalog) {
  return embeddingCatalogConnection(provider, catalog)
    || normalizeEmbeddingCapability(provider?.embeddingCapability, provider?.protocol === 'anthropic-messages' ? 'unsupported' : 'probe-required')
}

function embeddingModelCapability(provider, model, catalog) {
  const connection = embeddingConnectionCapability(provider, catalog)
  const modelId = String(model || '').trim()
  if (connection.status !== 'supported') {
    return { ...connection, model: modelId, defaultDimensions: null, configurableDimensions: false, allowedDimensions: null }
  }
  const known = connection.models.find((entry) => embeddingModelName(entry) === modelId)
  if (!known) {
    return {
      ...connection,
      status: 'probe-required',
      reason: modelId
        ? '该模型不在当前 Embedding 白名单中，启用前必须连接测试。'
        : '尚未选择 Embedding 模型。',
      model: modelId,
      defaultDimensions: null,
      configurableDimensions: false,
      allowedDimensions: null,
    }
  }
  return {
    ...connection,
    ...known,
    model: modelId,
    defaultDimensions: known.defaultDimensions ?? null,
    configurableDimensions: known.configurableDimensions === true,
    allowedDimensions: known.allowedDimensions || null,
  }
}

function embeddingCapabilityLabel(status) {
  if (status === 'supported') return '支持 Embedding'
  if (status === 'unsupported') return '不支持 Embedding'
  return '需要连接测试'
}

function embeddingModelName(entry) {
  return typeof entry === 'string' ? entry : String(entry?.id || entry?.model || entry?.name || '')
}

function embeddingDefaultDimensions(provider, model, catalog) {
  const dimensions = Number(embeddingModelCapability(provider, model, catalog).defaultDimensions)
  return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : null
}

// Pages for the data plane: external sources (P4), the model agent (P5) and the
// retrieval pipeline. Each one surfaces the degradation state rather than only
// the happy path — a system quietly running on a fallback is the thing an
// operator most needs to see and least likely to go looking for.

// Mirrors the Panel/DataTable primitives in pages.jsx rather than defining a
// parallel set: two panel implementations drift, and the drift shows up as
// inconsistent spacing that nobody owns.
function Panel({ title, subtitle, actions, children }) {
  return (
    <section className="qp-panel mih-panel">
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

function DataTable({ label, children }) {
  return (
    <div className="qp-data-table mih-table-wrap">
      <table className="mih-table" aria-label={label}>{children}</table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// External sources
// ---------------------------------------------------------------------------

export function SourcesPage({ token, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.sources(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const loadTelegramPipeline = useCallback(() => adminApi.telegramMonitorPipeline(token), [token])
  const telegramPipeline = useRemoteData(loadTelegramPipeline, onUnauthorized)
  const loadTelegramSqlitePipeline = useCallback(() => adminApi.telegramSqlitePipeline(token), [token])
  const telegramSqlitePipeline = useRemoteData(loadTelegramSqlitePipeline, onUnauthorized)
  const loadProvinceOpinionPipeline = useCallback(() => adminApi.provinceOpinionPipeline(token), [token])
  const provinceOpinionPipeline = useRemoteData(loadProvinceOpinionPipeline, onUnauthorized)
  const loadMobileCommercePipeline = useCallback(() => adminApi.mobileCommercePipeline(token), [token])
  const mobileCommercePipeline = useRemoteData(loadMobileCommercePipeline, onUnauthorized)
  const loadDatabaseConnections = useCallback(() => adminApi.databaseConnections(token), [token])
  const databaseConnections = useRemoteData(loadDatabaseConnections, onUnauthorized)
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [telegramOpen, setTelegramOpen] = useState(false)
  const [telegramSqliteOpen, setTelegramSqliteOpen] = useState(false)
  const [provinceOpinionOpen, setProvinceOpinionOpen] = useState(false)
  const [mobileCommerceOpen, setMobileCommerceOpen] = useState(false)

  if (state.loading && !state.data) return <LoadingState label="正在加载外部数据源" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const sources = asList(state.data)
  const genericSources = sources.filter((source) => !PIPELINE_MANAGED_SOURCE_KEYS.has(source.sourceKey))

  const openTelegramTaskDetail = (task) => {
    const sourceKey = telegramTaskSourceKey(task)
    const source = sources.find((candidate) => candidate.sourceKey === sourceKey)
      || (typeof task?.source === 'object' ? task.source : null)
    if (!source) {
      notify?.(`无法读取子任务 ${sourceKey || task?.role || 'unknown'} 的数据源详情`, 'warning')
      return
    }
    setTelegramOpen(false)
    setSelected(source)
  }

  return (
    <>
      <PageHeading
        eyebrow="DATA CLEANING CENTER / TASK PLANS"
        title="清洗任务计划"
        description="表格、文本与异构库接入。原始副本永久保留，未映射字段进 extensions，映射版本化且必须批准后才生效。"
        loading={state.loading}
        onRefresh={state.refresh}
      >
        <button className="qp-button" type="button" onClick={() => setCreating(true)}>注册数据源</button>
      </PageHeading>

      <Panel title="首次文件导入" subtitle="支持浏览器直传或粘贴服务器受控路径；目录监听和云桶仍未上线">
        <ol className="mih-step-list">
          <li><strong>注册文件源</strong><span>选择浏览器上传或服务器路径；服务器路径可以直接复制粘贴，不需要从下拉列表寻找。</span></li>
          <li><strong>预览样例</strong><span>上传小样或读取服务器文件；预览只解析结构并匹配格式规则，不写 canonical 数据。</span></li>
          <li><strong>审核并批准映射</strong><span>保存规则推断或 Agent 建议为版本，确认 externalId、正文和时间字段后批准。</span></li>
          <li><strong>正式导入</strong><span>再次选择文件执行导入；结果会出现在任务记录和数据中心，完全相同的内容会幂等跳过。</span></li>
        </ol>
        <p className="mih-inline-warning"><Warning size={16} aria-hidden="true" />支持首个工作表的 xlsx/xlsm，以及 csv、tsv、json、jsonl/ndjson、txt/md。HanLP 属于检索投影阶段，不需要在文件源表单里单独配置。</p>
      </Panel>

      <TelegramPipelineCard
        pipeline={telegramPipeline.data}
        loading={telegramPipeline.loading}
        error={telegramPipeline.error}
        onOpen={() => setTelegramOpen(true)}
        onRetry={telegramPipeline.refresh}
      />

      <TelegramSqlitePipelineCard
        pipeline={telegramSqlitePipeline.data}
        loading={telegramSqlitePipeline.loading}
        error={telegramSqlitePipeline.error}
        onOpen={() => setTelegramSqliteOpen(true)}
        onRetry={telegramSqlitePipeline.refresh}
      />

      <ProvinceOpinionPipelineCard
        pipeline={provinceOpinionPipeline.data}
        loading={provinceOpinionPipeline.loading}
        error={provinceOpinionPipeline.error}
        onOpen={() => setProvinceOpinionOpen(true)}
        onRetry={provinceOpinionPipeline.refresh}
      />

      <MobileCommercePipelineCard
        pipeline={mobileCommercePipeline.data}
        loading={mobileCommercePipeline.loading}
        error={mobileCommercePipeline.error}
        onOpen={() => setMobileCommerceOpen(true)}
        onRetry={mobileCommercePipeline.refresh}
      />

      {genericSources.length === 0 ? (
        <EmptyState
          icon={Database}
          title="还没有注册通用数据源"
          description="Telegram monitor、SQLite API、全国省份舆情与手机电商采集已作为固定业务任务单独管理；这里可继续注册文件或其他只读 PostgreSQL 数据源。"
        />
      ) : (
        <Panel title="通用数据源" subtitle="每个源有独立的 dataset，不会与固定业务清洗任务混合">
          <DataTable label="外部数据源列表">
            <thead>
              <tr><th>标识</th><th>名称</th><th>来源</th><th>Dataset / 平台</th><th>同步策略</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {genericSources.map((source) => (
                <tr key={source.id}>
                  <td><code className="mih-source-label">{source.sourceKey}</code></td>
                  <td>{source.displayName}</td>
                  <td>
                    <strong>{source.sourceKind === 'file'
                      ? (source.connection?.fileMode === 'server_path' ? '服务器路径' : '文件上传')
                      : `${source.connection?.host || '数据库'}:${source.connection?.port || 5432}`}</strong>
                    <small className="mih-source-label">{source.sourceKind === 'database'
                      ? `${source.connection?.schema || 'public'}.${source.connection?.table || '—'}`
                      : source.connection?.fileMode === 'server_path'
                        ? `${source.connection?.rootId || '受控根目录'}:${source.connection?.relativePath || '—'}`
                        : 'xlsx/xlsm · csv/tsv · json/jsonl/ndjson · txt/md'}</small>
                  </td>
                  <td><code className="mih-source-label">{source.datasetId}</code><small className="mih-source-label">{source.platform} · {source.objectType}</small></td>
                  <td>{source.sourceKind === 'database' ? `${formatNumber(source.syncIntervalSeconds || 60)} 秒` : '手动导入'}</td>
                  <td><StatusBadge status={source.status} /></td>
                  <td>
                    <button className="qp-button qp-button--ghost" type="button" onClick={() => setSelected(source)}>
                      {source.sourceKind === 'database' ? '检查与同步' : '映射与导入'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Panel>
      )}

      {creating ? (
        <CreateSourceModal
          token={token}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); state.refresh() }}
          databaseConnections={databaseConnections}
        />
      ) : null}
      {telegramOpen && telegramPipeline.data ? (
        <TelegramPipelineModal
          token={token}
          pipeline={telegramPipeline.data}
          loading={telegramPipeline.loading}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setTelegramOpen(false)}
          onRefresh={telegramPipeline.refresh}
          onPipelineChanged={(updated) => {
            if (updated?.tasks) telegramPipeline.setData(updated)
            telegramPipeline.refresh()
            state.refresh()
          }}
          onOpenAdvanced={openTelegramTaskDetail}
          databaseConnections={databaseConnections}
        />
      ) : null}
      {telegramSqliteOpen && telegramSqlitePipeline.data ? (
        <TelegramSqlitePipelineModal
          token={token}
          pipeline={telegramSqlitePipeline.data}
          loading={telegramSqlitePipeline.loading}
          error={telegramSqlitePipeline.error}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setTelegramSqliteOpen(false)}
          onRefresh={telegramSqlitePipeline.refresh}
          onPipelineChanged={(updated) => {
            if (updated?.tasks) telegramSqlitePipeline.setData(updated)
            telegramSqlitePipeline.refresh()
            state.refresh()
          }}
        />
      ) : null}
      {provinceOpinionOpen && provinceOpinionPipeline.data ? (
        <ProvinceOpinionPipelineModal
          token={token}
          pipeline={provinceOpinionPipeline.data}
          loading={provinceOpinionPipeline.loading}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setProvinceOpinionOpen(false)}
          onRefresh={provinceOpinionPipeline.refresh}
          onPipelineChanged={(updated) => {
            if (updated?.task) provinceOpinionPipeline.setData(updated)
            provinceOpinionPipeline.refresh()
            state.refresh()
          }}
          databaseConnections={databaseConnections}
        />
      ) : null}
      {mobileCommerceOpen && mobileCommercePipeline.data ? (
        <MobileCommercePipelineModal
          token={token}
          pipeline={mobileCommercePipeline.data}
          loading={mobileCommercePipeline.loading}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setMobileCommerceOpen(false)}
          onRefresh={mobileCommercePipeline.refresh}
          onPipelineChanged={(updated) => {
            if (updated?.task) mobileCommercePipeline.setData(updated)
            mobileCommercePipeline.refresh()
            state.refresh()
          }}
          databaseConnections={databaseConnections}
        />
      ) : null}
      {selected ? (
        <SourceDetailModal
          token={token}
          source={selected}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setSelected(null)}
          onSourceChanged={(source) => { setSelected(source); state.refresh() }}
          databaseConnections={databaseConnections}
        />
      ) : null}
    </>
  )
}

const PIPELINE_MANAGED_SOURCE_KEYS = new Set([
  'telegram-monitor-chats',
  'telegram-monitor-messages',
  'telegram-sqlite-api-chats',
  'telegram-sqlite-api-messages',
  'province-opinion-results',
  'mobile-commerce-collected-items',
])

const TELEGRAM_TASK_META = {
  chats: {
    label: '会话目录',
    table: 'tg_monitor_chats',
    dataset: 'telegram.monitor.chats.v1',
    objectType: 'chat',
  },
  messages: {
    label: '消息事实',
    table: 'tg_monitor_messages',
    dataset: 'telegram.monitor.messages.v1',
    objectType: 'message',
  },
}

function telegramTaskMeta(task) {
  const sourceKey = telegramTaskSourceKey(task)
  if (task?.role === 'chats' || sourceKey.endsWith('-chats')) return TELEGRAM_TASK_META.chats
  return TELEGRAM_TASK_META.messages
}

function telegramTaskCursorStatus(task) {
  return task?.cursor?.status || 'idle'
}

// Ten sync cycles, floored at 15 minutes -- the same bar the server applies.
const ABANDONED_RUN_CYCLES = 10
const ABANDONED_RUN_FLOOR_MS = 15 * 60 * 1_000

function telegramTaskSilenceMs(task) {
  const updatedAt = task?.cursor?.updatedAt || task?.cursor?.updated_at
  if (!updatedAt) return null
  const silence = Date.now() - new Date(updatedAt).getTime()
  return Number.isFinite(silence) ? silence : null
}

/**
 * A task the scheduler will never pick up again without help.
 *
 * `failed` is the obvious case. A `running` cursor whose worker died is the
 * quiet one: it also makes isDue false, it also freezes the paired task, and
 * it needs either the scheduler's guarded self-recovery or an operator action.
 */
function telegramTaskStuck(task) {
  const status = telegramTaskCursorStatus(task)
  if (status === 'failed') return true
  if (status !== 'running') return false
  const silence = telegramTaskSilenceMs(task)
  if (silence == null) return false
  const cadence = Number(task?.source?.syncIntervalSeconds || 300) * 1_000
  return silence >= Math.max(cadence * ABANDONED_RUN_CYCLES, ABANDONED_RUN_FLOOR_MS)
}

function telegramStuckDescription(task) {
  const status = telegramTaskCursorStatus(task)
  if (status === 'failed') {
    const candidate = task?.cursor?.last_error || task?.cursor?.lastError || task?.cursor?.error
    const code = typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(candidate)
      ? candidate
      : null
    return code ? `游标停在 failed · ${code}` : '游标停在 failed'
  }
  const silence = telegramTaskSilenceMs(task)
  const minutes = silence == null ? null : Math.round(silence / 60_000)
  return minutes == null
    ? '运行中但已静默'
    : `运行中但已静默 ${minutes >= 120 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`}`
}

function telegramTaskSourceKey(task) {
  if (typeof task?.source === 'string') return task.source
  return task?.source?.sourceKey || task?.sourceKey || ''
}

function telegramPipelineIsRunning(pipeline) {
  return pipeline?.draining === true || pipeline?.status === 'draining' || (pipeline?.tasks || []).some((task) => (
    ['running', 'draining'].includes(String(task?.cursor?.status || '').toLowerCase())
  ))
}

function telegramPipelineConfigured(pipeline) {
  if (pipeline?.configured != null) return Boolean(pipeline.configured)
  if (pipeline?.connection?.host && pipeline?.connection?.database && pipeline?.connection?.username) return true
  return Boolean(pipeline?.tasks?.length) && pipeline.tasks.every((task) => (
    task.source?.connection?.host && task.source?.connection?.database && task.source?.connection?.username
  ))
}

function telegramConnectionConsistent(pipeline) {
  return pipeline?.connectionConsistent
    ?? pipeline?.consistency?.connection
    ?? (pipeline?.consistent && Boolean(pipeline?.connection))
    ?? true
}

function telegramScheduleConsistent(pipeline) {
  return pipeline?.syncIntervalConsistent
    ?? pipeline?.consistency?.syncIntervalSeconds
    ?? pipeline?.consistent
    ?? true
}

function telegramPipelineStatus(pipeline) {
  if (telegramPipelineIsRunning(pipeline)) return { status: 'warning', label: pipeline?.status === 'paused' ? '暂停中 · 排空批次' : '正在运行' }
  if (pipeline?.status === 'active') return { status: 'active', label: '已启用' }
  if (pipeline?.status === 'mixed') return { status: 'warning', label: '子任务状态不一致' }
  return { status: 'disabled', label: telegramPipelineConfigured(pipeline) ? '已暂停' : '待配置' }
}

function telegramPreparationTables(preparation) {
  const tables = preparation?.tables || preparation?.tableStatus || preparation?.inspection?.tables
  if (Array.isArray(tables)) return tables
  return Object.entries(tables || {}).map(([role, table]) => ({ role, ...(table || {}) }))
}

function telegramPreparationSteps(preparation) {
  return preparation?.steps || preparation?.lastRun?.steps || preparation?.preparation?.steps || []
}

function telegramPreparationIssues(preparation) {
  return [
    ...(preparation?.blockers || []),
    ...(preparation?.issues || []),
    ...(preparation?.warnings || []),
  ].map((issue) => typeof issue === 'string' ? issue : issue?.message || issue?.reason || JSON.stringify(issue))
}

function telegramPreparationCheck(value) {
  if (value == null) return { status: 'unknown', label: '待探测' }
  if (typeof value === 'boolean') return value
    ? { status: 'ready', label: '已就绪' }
    : { status: 'not_ready', label: '待修复' }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    const ready = ['ready', 'valid', 'installed', 'present', 'ok', 'complete', 'completed'].includes(normalized)
    return { status: ready ? 'ready' : normalized, label: value }
  }
  const ready = value.ready ?? value.valid ?? value.installed ?? value.exists ?? value.ok
  return {
    status: value.status || value.state || (ready === true ? 'ready' : ready === false ? 'not_ready' : 'unknown'),
    label: value.label || value.message || (ready === true ? '已就绪' : ready === false ? '待修复' : '待探测'),
  }
}

function TelegramPipelineCard({ pipeline, loading, error, onOpen, onRetry }) {
  const status = telegramPipelineStatus(pipeline)
  const tasks = pipeline?.tasks || []
  const latestRunAt = tasks
    .map((task) => task.latestRun?.finishedAt || task.latestRun?.startedAt || task.latestRun?.createdAt)
    .filter(Boolean)
    .sort()
    .at(-1)

  return (
    <section className="qp-panel mih-telegram-card" aria-labelledby="telegram-pipeline-title">
      <div className="mih-telegram-card__identity">
        <span className="mih-telegram-card__icon"><Database size={22} weight="duotone" aria-hidden="true" /></span>
        <div>
          <p className="qp-kicker">BUSINESS PIPELINE / TELEGRAM</p>
          <h2 id="telegram-pipeline-title">Telegram monitor 清洗任务</h2>
          <p>一套源库连接，固定协调 chats 与 messages 的幂等清洗、PG 落库和 ES 索引。</p>
        </div>
      </div>
      {error && !pipeline ? (
        <div className="mih-telegram-card__error"><ErrorState error={error} onRetry={onRetry} /></div>
      ) : (
        <>
          <dl className="mih-telegram-card__facts">
            <div><dt>运行状态</dt><dd><StatusBadge status={status.status} label={status.label} /></dd></div>
            <div><dt>源库</dt><dd><code>{telegramPipelineConfigured(pipeline) ? `${pipeline.connection?.host || '连接待统一'}:${pipeline.connection?.port || 5432}` : '尚未配置'}</code></dd></div>
            <div><dt>数据库</dt><dd><code>{pipeline?.connection?.database || '—'}</code></dd></div>
            <div><dt>输入任务</dt><dd>{tasks.length || 2} 个固定表</dd></div>
            <div><dt>同步周期</dt><dd>{telegramScheduleConsistent(pipeline) ? `${formatNumber(pipeline?.syncIntervalSeconds || 300)} 秒` : '待统一'}</dd></div>
            <div><dt>最近运行</dt><dd>{latestRunAt ? formatDate(latestRunAt) : '尚未运行'}</dd></div>
          </dl>
          <div className="mih-telegram-card__actions">
            {!telegramConnectionConsistent(pipeline) || !telegramScheduleConsistent(pipeline) ? <span className="mih-telegram-card__alert"><Warning size={15} />双表连接或周期不一致，需重新统一保存</span> : null}
            <button className="qp-button qp-button--ghost" type="button" disabled={loading || !pipeline} onClick={onOpen}>
              {loading ? '正在刷新…' : '打开任务控制'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

const TELEGRAM_SQLITE_TASK_META = {
  chats: {
    label: '会话目录',
    endpoint: '/v1/chats',
    dataset: 'telegram.sqlite.chats.v1',
    objectType: 'chat',
    sourceKey: 'telegram-sqlite-api-chats',
  },
  messages: {
    label: '消息事实',
    endpoint: '/v1/messages?include_deleted=true',
    dataset: 'telegram.sqlite.messages.v1',
    objectType: 'message',
    sourceKey: 'telegram-sqlite-api-messages',
  },
}

function telegramSqliteTaskMeta(task) {
  const sourceKey = telegramTaskSourceKey(task)
  if (task?.role === 'chats' || sourceKey.endsWith('-chats')) return TELEGRAM_SQLITE_TASK_META.chats
  return TELEGRAM_SQLITE_TASK_META.messages
}

function telegramSqlitePipelineConfigured(pipeline) {
  if (pipeline?.configured != null) return Boolean(pipeline.configured)
  return Boolean(pipeline?.connection?.baseUrl && pipeline?.connection?.tokenConfigured)
}

function telegramSqlitePipelineStatus(pipeline) {
  if (telegramPipelineIsRunning(pipeline)) {
    return {
      status: 'warning',
      label: pipeline?.status === 'paused' ? '暂停中 · 排空批次' : '正在运行',
    }
  }
  if (pipeline?.status === 'active') return { status: 'active', label: '已启用' }
  if (pipeline?.status === 'mixed') return { status: 'warning', label: '子任务状态不一致' }
  return {
    status: 'disabled',
    label: telegramSqlitePipelineConfigured(pipeline) ? '已暂停' : '待配置',
  }
}

function sqlitePipelineIssueMessages(...values) {
  return values.flatMap((value) => {
    if (value == null) return []
    const items = Array.isArray(value) ? value : [value]
    return items.map((item) => (
      typeof item === 'string' ? item : item?.message || item?.reason || item?.code || JSON.stringify(item)
    ))
  }).filter(Boolean)
}

function TelegramSqlitePipelineCard({ pipeline, loading, error, onOpen, onRetry }) {
  const status = telegramSqlitePipelineStatus(pipeline)
  const tasks = pipeline?.tasks || []
  const warnings = sqlitePipelineIssueMessages(pipeline?.warnings)
  const latestRunAt = tasks
    .map((task) => task.latestRun?.finishedAt || task.latestRun?.startedAt || task.latestRun?.createdAt)
    .filter(Boolean)
    .sort()
    .at(-1)

  return (
    <section className="qp-panel mih-telegram-card" aria-labelledby="telegram-sqlite-pipeline-title">
      <div className="mih-telegram-card__identity">
        <span className="mih-telegram-card__icon"><Database size={22} weight="duotone" aria-hidden="true" /></span>
        <div>
          <p className="qp-kicker">BUSINESS PIPELINE / TELEGRAM SQLITE API</p>
          <h2 id="telegram-sqlite-pipeline-title">Telegram SQLite API 清洗任务</h2>
          <p>首次或换库时全量对齐；平时追新增，凌晨只复扫上一自然日窗口。</p>
        </div>
      </div>
      {error && !pipeline ? (
        <div className="mih-telegram-card__error"><ErrorState error={error} onRetry={onRetry} /></div>
      ) : (
        <>
          <dl className="mih-telegram-card__facts mih-telegram-card__facts--sqlite">
            <div><dt>运行状态</dt><dd><StatusBadge status={status.status} label={status.label} /></dd></div>
            <div><dt>只读 API</dt><dd><code>{pipeline?.connection?.baseUrl || '尚未配置'}</code></dd></div>
            <div><dt>访问凭据</dt><dd>{pipeline?.connection?.tokenConfigured ? 'Bearer Token 已配置' : 'Token 待配置'}</dd></div>
            <div><dt>输入任务</dt><dd>{tasks.length || 2} 个固定资源</dd></div>
            <div><dt>同步周期</dt><dd>{formatNumber(pipeline?.syncIntervalSeconds || 300)} 秒</dd></div>
            <div><dt>最近运行</dt><dd>{latestRunAt ? formatDate(latestRunAt) : '尚未运行'}</dd></div>
          </dl>
          <div className="mih-telegram-card__actions">
            {warnings.length > 0 ? <span className="mih-telegram-card__alert"><Warning size={15} />{warnings[0]}</span> : null}
            <button className="qp-button qp-button--ghost" type="button" disabled={loading || !pipeline} onClick={onOpen}>
              {loading ? '正在刷新…' : '打开任务控制'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function provinceOpinionRunning(pipeline) {
  return ['running', 'draining'].includes(String(
    pipeline?.task?.cursor?.status || pipeline?.task?.latestRun?.status || '',
  ).toLowerCase())
}

function provinceOpinionStatus(pipeline) {
  if (telegramTaskStuck(pipeline?.task)) return { status: 'error', label: '任务需恢复' }
  if (provinceOpinionRunning(pipeline)) return { status: 'warning', label: '正在运行' }
  if (pipeline?.task?.scheduling?.status === 'failed') return { status: 'error', label: '任务需恢复' }
  if (pipeline?.task?.scheduling?.status === 'blocked') return { status: 'error', label: '自动调度被阻断' }
  if (pipeline?.task?.scheduling?.status === 'overdue') return { status: 'error', label: '自动调度逾期' }
  if (pipeline?.status === 'active' && pipeline?.configurationIssues?.length > 0) {
    return { status: 'error', label: '门禁异常' }
  }
  if (pipeline?.status === 'active') return { status: 'active', label: '已启用' }
  return { status: 'disabled', label: pipeline?.configured ? '已暂停' : '待配置' }
}

function ProvinceOpinionPipelineCard({ pipeline, loading, error, onOpen, onRetry }) {
  const status = provinceOpinionStatus(pipeline)
  const task = pipeline?.task
  const latestRunAt = task?.latestRun?.finishedAt || task?.latestRun?.startedAt || task?.latestRun?.createdAt

  return (
    <section className="qp-panel mih-telegram-card" aria-labelledby="province-opinion-pipeline-title">
      <div className="mih-telegram-card__identity">
        <span className="mih-telegram-card__icon"><Database size={22} weight="duotone" aria-hidden="true" /></span>
        <div>
          <p className="qp-kicker">BUSINESS PIPELINE / PUBLIC OPINION</p>
          <h2 id="province-opinion-pipeline-title">全国省份舆情清洗任务</h2>
          <p>固定读取 monitor_strategy_results；首次全量、后续按可靠更新水位增量，按省提供热门、最新与详情接口。</p>
        </div>
      </div>
      {error && !pipeline ? (
        <div className="mih-telegram-card__error"><ErrorState error={error} onRetry={onRetry} /></div>
      ) : (
        <>
          <dl className="mih-telegram-card__facts">
            <div><dt>运行状态</dt><dd><StatusBadge status={status.status} label={status.label} /></dd></div>
            <div><dt>源库</dt><dd><code>{pipeline?.configured ? `${pipeline.connection?.host}:${pipeline.connection?.port || 5432}` : '尚未配置'}</code></dd></div>
            <div><dt>固定表</dt><dd><code>public.monitor_strategy_results</code></dd></div>
            <div><dt>输入任务</dt><dd>1 个固定结果表</dd></div>
            <div><dt>同步周期</dt><dd>{formatNumber(pipeline?.syncIntervalSeconds || 300)} 秒</dd></div>
            <div><dt>Agent 归类</dt><dd><StatusBadge
              status={pipeline?.classification?.status === 'active' ? 'active' : 'disabled'}
              label={pipeline?.classification?.status === 'active'
                ? `运行中 · 待处理 ${formatNumber(pipeline.classification.tasks?.pending || 0)}`
                : '独立暂停'} /></dd></div>
            <div><dt>HanLP 索引</dt><dd><StatusBadge
              status={pipeline?.indexing?.readyToSchedule ? 'active' : 'suspended'}
              label={pipeline?.indexing?.readyToSchedule ? '严格后端已配置' : '阻止启用'} /></dd></div>
            <div><dt>最近运行</dt><dd>{latestRunAt ? formatDate(latestRunAt) : '尚未运行'}</dd></div>
            <div><dt>自动调度</dt><dd>{task?.scheduling?.message || '等待状态证据'}</dd></div>
          </dl>
          <div className="mih-telegram-card__actions">
            {pipeline?.status !== 'active' ? <span className="mih-telegram-card__alert"><Warning size={15} />默认暂停；源表水位合同完成前不会导入</span> : null}
            <button className="qp-button qp-button--ghost" type="button" disabled={loading || !pipeline} onClick={onOpen}>
              {loading ? '正在刷新…' : '打开任务控制'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

const MOBILE_COMMERCE_FIELDS = [
  'id',
  'platform',
  'task_run_id',
  'task_id',
  'keyword',
  'brand',
  'title',
  'product_link',
  'shop_name',
  'shop_link',
  'goods_id',
  'shop_id',
  'price',
  'sales',
  'ship_from',
  'shop_level',
  'shop_fans',
  'shop_reputation',
  'comment_count',
  'good_rate',
  'tags',
  'collected_at',
  'metadata_json',
  'device_serial',
  'is_reported',
]

function mobileCommerceRunning(pipeline) {
  return ['running', 'draining'].includes(String(
    pipeline?.task?.cursor?.status || pipeline?.task?.latestRun?.status || '',
  ).toLowerCase())
}

function mobileCommerceStatus(pipeline) {
  if (telegramTaskStuck(pipeline?.task)) return { status: 'down', label: '任务需恢复' }
  if (mobileCommerceRunning(pipeline)) return { status: 'warning', label: '正在运行' }
  if (pipeline?.status === 'active') return { status: 'active', label: '已启用' }
  return { status: 'disabled', label: pipeline?.configured ? '已暂停' : '待配置' }
}

function mobileCommerceMappingLabel(pipeline) {
  const mapping = pipeline?.mapping || pipeline?.task?.mapping || {}
  const activeVersion = mapping.version || mapping.activeVersion || pipeline?.task?.activeMapping?.version
  if (activeVersion) return `已批准 v${activeVersion}`
  if (mapping.builtInAvailable && mapping.builtInVersion) return `内置 v${mapping.builtInVersion} 已准备`
  return mapping.status || '待审核'
}

function MobileCommercePipelineCard({ pipeline, loading, error, onOpen, onRetry }) {
  const status = mobileCommerceStatus(pipeline)
  const task = pipeline?.task || {}
  const latestRunAt = task.latestRun?.finishedAt || task.latestRun?.startedAt || task.latestRun?.createdAt
  const sourceConnection = pipeline?.databaseConnection || pipeline?.connection

  return (
    <section className="qp-panel mih-telegram-card" aria-labelledby="mobile-commerce-pipeline-title">
      <div className="mih-telegram-card__identity">
        <span className="mih-telegram-card__icon"><Database size={22} weight="duotone" aria-hidden="true" /></span>
        <div>
          <p className="qp-kicker">BUSINESS PIPELINE / MOBILE COMMERCE</p>
          <h2 id="mobile-commerce-pipeline-title">手机电商采集清洗任务</h2>
          <p>固定读取 mb_collected_items，按平台目录分类并映射到 canonical 数据中心；当前仅从已存数据库读取。</p>
        </div>
      </div>
      {error && !pipeline ? (
        <div className="mih-telegram-card__error"><ErrorState error={error} onRetry={onRetry} /></div>
      ) : (
        <>
          <dl className="mih-telegram-card__facts">
            <div><dt>运行状态</dt><dd><StatusBadge status={status.status} label={status.label} /></dd></div>
            <div><dt>源库</dt><dd><code>{pipeline?.configured ? `${sourceConnection?.host || '共享数据库配置'}:${sourceConnection?.port || 5432}` : '尚未配置'}</code></dd></div>
            <div><dt>固定表</dt><dd><code>public.mb_collected_items</code></dd></div>
            <div><dt>Dataset</dt><dd><code>mobile-commerce.collected-items.v1</code></dd></div>
            <div><dt>字段映射</dt><dd>{mobileCommerceMappingLabel(pipeline)}</dd></div>
            <div><dt>同步周期</dt><dd>{formatNumber(pipeline?.syncIntervalSeconds || 300)} 秒</dd></div>
            <div><dt>读取模式</dt><dd><code>stored-only</code></dd></div>
            <div><dt>最近运行</dt><dd>{latestRunAt ? formatDate(latestRunAt) : '尚未运行'}</dd></div>
          </dl>
          <div className="mih-telegram-card__actions">
            <span className="mih-telegram-card__alert"><Warning size={15} />远端主动拉取接口未接入</span>
            <button className="qp-button qp-button--ghost" type="button" disabled={loading || !pipeline} onClick={onOpen}>
              {loading ? '正在刷新…' : '打开任务控制'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function MobileCommercePipelineModal({
  token, pipeline, loading, onUnauthorized, notify, onClose, onRefresh, onPipelineChanged,
  databaseConnections,
}) {
  const task = pipeline.task || {}
  const connection = pipeline.connection || {}
  const configured = Boolean(pipeline.configured)
  const running = mobileCommerceRunning(pipeline)
  const status = mobileCommerceStatus(pipeline)
  const stuck = telegramTaskStuck(task) || ['failed', 'blocked', 'overdue'].includes(task.scheduling?.status)
  const mapping = pipeline.mapping || task.mapping || task.activeMapping || {}
  const catalogClassification = pipeline.catalogClassification || task.catalogClassification || {}
  const writerContract = pipeline.writerContract || {}
  const writerContractVersion = writerContract.contractVersion || writerContract.version
  const writerContractDigest = writerContract.contractDigest || writerContract.digest
  const latestWriterAttestation = pipeline.contractAttestation || writerContract.latestAttestation || null
  const writerContractCurrent = Boolean(
    latestWriterAttestation
    && latestWriterAttestation.confirmed !== false
    && latestWriterAttestation.contractVersion === writerContractVersion
    && latestWriterAttestation.contractDigest === writerContractDigest,
  )
  const [form, setForm] = useState(() => ({
    databaseConnectionId: pipeline.databaseConnectionId || INLINE_DATABASE_CONNECTION,
    host: connection.host || '',
    port: String(connection.port || 5432),
    database: connection.database || '',
    username: connection.username || '',
    password: connection.password || '',
    sslMode: connection.sslMode || 'require',
    syncIntervalSeconds: String(pipeline.syncIntervalSeconds || 300),
  }))
  const [busyAction, setBusyAction] = useState(null)
  const [writerContractConfirmed, setWriterContractConfirmed] = useState(false)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const configurationIssues = sqlitePipelineIssueMessages(pipeline.configurationIssues)
  const mappingLabel = mobileCommerceMappingLabel(pipeline)
  const agentMessage = pipeline.agent?.message || mapping.agentStudio?.message

  useEffect(() => {
    if (!running || loading) return undefined
    const timer = window.setTimeout(onRefresh, 2_000)
    return () => window.clearTimeout(timer)
  }, [loading, onRefresh, running])

  const mutate = async (action, request, successMessage) => {
    setBusyAction(action)
    try {
      const updated = await request()
      if (updated?.task || updated?.status) onPipelineChanged(updated)
      else onRefresh()
      notify?.(successMessage, 'success')
      return updated
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      notify?.(error.message, 'error')
      return null
    } finally {
      setBusyAction(null)
    }
  }

  const save = (event) => {
    event.preventDefault()
    mutate(
      'save',
      () => adminApi.updateMobileCommercePipeline(token, {
        ...(form.databaseConnectionId
          ? { databaseConnectionId: form.databaseConnectionId }
          : {
              connection: {
                host: form.host.trim(),
                port: Number(form.port),
                database: form.database.trim(),
                username: form.username.trim(),
                sslMode: form.sslMode,
                ...(form.password ? { password: form.password } : {}),
              },
            }),
        syncIntervalSeconds: Number(form.syncIntervalSeconds),
      }),
      '手机电商采集源库连接已验证并保存；任务仍保持暂停',
    )
  }

  const changeStatus = (nextStatus) => mutate(
    `status-${nextStatus}`,
    () => adminApi.updateMobileCommercePipelineStatus(
      token,
      nextStatus,
      nextStatus === 'active' ? {
        confirmed: true,
        contractVersion: writerContractVersion,
        contractDigest: writerContractDigest,
      } : null,
    ),
    nextStatus === 'active' ? '手机电商采集清洗任务已启用' : '已安全暂停手机电商采集清洗任务',
  )

  const runSync = () => mutate(
    'sync',
    () => adminApi.runMobileCommercePipeline(token, { batchSize: 500 }),
    '手机电商采集同步已提交',
  )

  const resumeFailed = () => mutate(
    'resume',
    () => adminApi.resumeMobileCommercePipeline(token),
    '任务已从原 checkpoint 恢复，未重放已提交数据',
  )

  const resetCheckpoint = (event) => {
    event.preventDefault()
    if (resetConfirmation !== 'mobile-commerce') return
    mutate(
      'reset',
      async () => {
        const updated = await adminApi.resetMobileCommercePipelineCheckpoint(token, {
          confirmPipelineKey: resetConfirmation,
        })
        setResetConfirmation('')
        return updated
      },
      '一次性全量对齐已准备；下次同步会从源表起点重新扫描',
    )
  }

  return (
    <Modal
      title={pipeline.displayName || '手机电商采集清洗任务'}
      description="固定 PostgreSQL 业务管线 · 手机端多商家平台采集结果 · 当前只读取 Hub 已配置数据库"
      size="xlarge"
      onClose={onClose}
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button>}
    >
      <div className="mih-telegram-toolbar">
        <div>
          <StatusBadge status={status.status} label={status.label} />
          <code>{pipeline.pipelineKey || 'mobile-commerce'}</code>
          <span className="mih-telegram-toolbar__warning"><Warning size={15} />stored-only · 远端接口未接入</span>
        </div>
        <div className="mih-page-actions">
          {pipeline.status === 'active' ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)} onClick={() => changeStatus('paused')}>
              <Pause size={16} />{busyAction === 'status-paused' ? '安全暂停中…' : '安全暂停'}
            </button>
          ) : (
            <button className="qp-button qp-button--ghost" type="button"
              disabled={Boolean(busyAction) || !configured || running || !writerContractVersion || !writerContractDigest || !writerContractConfirmed}
              title={!configured ? '先验证并保存源库连接' : running ? '等待当前批次收口' : !writerContractVersion || !writerContractDigest ? 'writer 合同尚未加载' : !writerContractConfirmed ? '请先确认源端 writer 合同' : ''}
              onClick={() => changeStatus('active')}>
              <Play size={16} />{busyAction === 'status-active' ? '正在启用…' : '启用任务'}
            </button>
          )}
          {stuck ? <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)} onClick={resumeFailed}>
            <ArrowClockwise size={16} />{busyAction === 'resume' ? '正在恢复…' : '恢复卡住的任务'}
          </button> : null}
          <button className="qp-button" type="button" disabled={Boolean(busyAction) || pipeline.status !== 'active' || !writerContractCurrent}
            title={!writerContractCurrent ? '当前 writer 合同尚未确认' : ''} onClick={runSync}>
            <ArrowClockwise size={16} />{busyAction === 'sync' ? '正在提交…' : '立即同步'}
          </button>
        </div>
      </div>

      <Panel title="只读源库与调度" subtitle="固定表、游标、Dataset 与字段合同由业务版本管理；连接可引用公共配置或在任务内完整填写">
        <form className="mih-form mih-form--grid mih-telegram-config" onSubmit={save}>
          <DatabaseConnectionField value={form.databaseConnectionId} state={databaseConnections}
            onChange={(databaseConnectionId) => setForm({ ...form, databaseConnectionId })} />
          {!form.databaseConnectionId ? <>
            <Field label="主机"><input className="qp-input" required value={form.host} placeholder="127.0.0.1" onChange={(event) => setForm({ ...form, host: event.target.value })} /></Field>
            <Field label="端口"><input className="qp-input" type="number" min="1" max="65535" required value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></Field>
            <Field label="数据库"><input className="qp-input" required value={form.database} placeholder="night_all" onChange={(event) => setForm({ ...form, database: event.target.value })} /></Field>
            <Field label="用户名"><input className="qp-input" required autoComplete="off" value={form.username} placeholder="mx_data" onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
            <Field label="密码" hint={connection.passwordConfigured ? '已配置；留空保留当前密码' : '保存前会验证只读连接'}><input className="qp-input" type="password" required={!connection.passwordConfigured} autoComplete="off" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
            <DropdownField label="SSL 模式" value={form.sslMode}
              onChange={(sslMode) => setForm({ ...form, sslMode })} options={SSL_MODE_OPTIONS} />
          </> : null}
          <Field label="同步间隔（秒）" hint="60–86400；首次空 checkpoint 会完整扫描">
            <input className="qp-input" type="number" min="60" max="86400" required value={form.syncIntervalSeconds}
              onChange={(event) => setForm({ ...form, syncIntervalSeconds: event.target.value })} />
          </Field>
          <div className="mih-page-actions mih-form__wide">
            <button className="qp-button qp-button--ghost" type="submit" disabled={Boolean(busyAction) || pipeline.status !== 'paused' || running}>
              {busyAction === 'save' ? '正在验证并保存…' : '验证并保存连接'}
            </button>
          </div>
        </form>
        {configurationIssues.length > 0 ? <ul className="mih-source-issues mih-source-issues--warning">
          {configurationIssues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
        </ul> : null}
      </Panel>

      <Panel title="源端 Writer 增量合同" subtitle="持续写入表的可靠增量依赖上游提交语义；每次启用都要确认当前版本并留下审计记录">
        <ul className="mih-source-issues mih-source-issues--warning">
          <li>{writerContract.summary?.mutation || '进入清洗计划的记录采用追加语义；若未来允许原地更新，必须先升级为可观察的 updated_at 或变更日志合同。'}</li>
          <li>{writerContract.summary?.identity || 'id 是采集行的稳定唯一标识，不等同于商家平台商品主键。'}</li>
          <li>{writerContract.summary?.watermark || 'collected_at 与 id 组成稳定、单调且不可回退的游标；提交后的记录不能落到 checkpoint 之前。'}</li>
          <li>{writerContract.summary?.deletion || '源端应采用追加或可观察更新语义；不可观察的硬删除不会被增量游标捕获。'}</li>
          <li>{writerContract.summary?.ordering || '同一 collected_at 下必须以 id 稳定排序，重试数据由 Canonical 幂等键去重。'}</li>
        </ul>
        {pipeline.status !== 'active' || !writerContractCurrent ? (
          <label className="mih-agent-consent">
            <input type="checkbox" checked={writerContractConfirmed} disabled={Boolean(busyAction) || running}
              onChange={(event) => setWriterContractConfirmed(event.target.checked)} />
            <span>
              <strong>我已验证源端实现满足上述合同</strong>
              <small>合同 {writerContractVersion || '待加载'} · 摘要 {writerContractDigest?.slice(0, 12) || '待加载'}… · 勾选后点击“启用任务”写入审计记录</small>
            </span>
          </label>
        ) : (
          <p className="mih-preview-provenance">当前 writer 合同已确认，自动调度与立即同步可用。</p>
        )}
      </Panel>

      <Panel title="固定输入与 25 字段合同" subtitle="源表结构基本固定；Agent 可以提出规范字段与目录分类建议，但只有已审核映射会用于入库">
        <div className="mih-telegram-capabilities">
          <div><strong>固定输入</strong><p><code>public.mb_collected_items</code><br /><code>(collected_at, id)</code> 严格增量游标</p></div>
          <div><strong>Canonical Dataset</strong><p><code>mobile-commerce.collected-items.v1</code><br /><code>mobile_commerce · commerce_capture</code></p></div>
          <div><strong>字段映射</strong><p>{mappingLabel}<br />固定合同 {MOBILE_COMMERCE_FIELDS.length} 个字段；{agentMessage || 'Agent Studio 仅预留建议能力，不能自动覆盖已批准映射。'}</p></div>
          <div><strong>按行目录分类</strong><p><code>platform</code> 逐行映射数据源目录中的抖音、快手、淘宝、闲鱼及其 alias；未知值标为 <code>unknown / unmapped</code> 并保留原值，不猜测归属。<br />{catalogClassification.mappingStatus || catalogClassification.status || catalogClassification.summary || '目录规则随业务版本审核。'}</p></div>
          <div><strong>读取边界</strong><p><code>stored-only</code><br />当前只读取数据库持续新增记录，不会调用尚未实现的手机端远端接口。</p></div>
          <div><strong>公开投影</strong><p><code>GET /api/v1/data/mobile-commerce/items</code><br />仅返回审核后的 allowlist 字段，不暴露 raw、设备或连接凭据。</p></div>
          <div><strong>检索链路</strong><p>批准映射 → Canonical 入库 → 异步检索投影 → Elasticsearch 搜索；源表与 ES 均不是事实主库。</p></div>
          <div><strong>未来“获取最新”</strong><p>由外部手机采集执行器抓取；Hub 只负责异步触发并读取其结果，不在本机抓取。远端接口当前未接入，也不会伪装成可用操作。</p></div>
        </div>
        <details className="mih-inline-details"><summary>查看固定 25 字段</summary>
          <pre className="mih-code-block">{MOBILE_COMMERCE_FIELDS.join(', ')}</pre>
        </details>
      </Panel>

      <Panel title="任务状态与映射证据" subtitle="运行证据来自持久化 task/import run；界面汇总不替代 durable lineage">
        <div className="mih-telegram-task-grid">
          <article className="mih-telegram-task">
            <header><div><span className="mih-telegram-task__role">手机电商采集结果</span><code>{task.sourceKey || 'mobile-commerce-collected-items'}</code></div><StatusBadge status={task.cursor?.status || pipeline.status} /></header>
            <dl className="mih-telegram-task__definition">
              <div><dt>固定表</dt><dd><code>public.mb_collected_items</code></dd></div>
              <div><dt>Dataset / 对象</dt><dd><code>mobile-commerce.collected-items.v1</code><small>mobile_commerce · commerce_capture</small></dd></div>
              <div><dt>映射</dt><dd>{mappingLabel}<small>Agent 建议不能自动覆盖已批准版本</small></dd></div>
              <div><dt>Checkpoint</dt><dd><code>{compactCheckpoint(task.checkpoint || task.cursor?.position)}</code></dd></div>
              <div><dt>下次调度</dt><dd>{formatDate(task.nextDueAt)}<small>{task.scheduling?.message}</small></dd></div>
            </dl>
          </article>
        </div>
      </Panel>

      <PipelineRunHistory token={token} tasks={[task]} onUnauthorized={onUnauthorized} labelOf={() => '手机电商采集结果'} />

      {pipeline.status === 'paused' && !running ? (
        <section className="mih-source-danger" aria-labelledby="mobile-commerce-checkpoint-reset-title">
          <div className="mih-source-danger__copy">
            <Warning size={24} weight="duotone" aria-hidden="true" />
            <div>
              <h3 id="mobile-commerce-checkpoint-reset-title">一次性全量对齐</h3>
              <p>重置后下一次同步会从 mb_collected_items 起点重扫。Canonical 仍幂等去重，但会增加源库、PG 与索引负载。</p>
            </div>
          </div>
          <form className="mih-source-danger__form" onSubmit={resetCheckpoint}>
            <Field label="输入业务标识以确认" hint={<code>mobile-commerce</code>}>
              <input className="qp-input" value={resetConfirmation} autoComplete="off" spellCheck="false"
                onChange={(event) => setResetConfirmation(event.target.value)} />
            </Field>
            <button className="qp-button qp-button--danger" type="submit" disabled={Boolean(busyAction) || resetConfirmation !== 'mobile-commerce'}>
              {busyAction === 'reset' ? '正在准备全量对齐…' : '准备一次性全量对齐'}
            </button>
          </form>
        </section>
      ) : null}
    </Modal>
  )
}

function ProvinceOpinionPipelineModal({
  token, pipeline, loading, onUnauthorized, notify, onClose, onRefresh, onPipelineChanged, databaseConnections,
}) {
  const configured = Boolean(pipeline.configured)
  const running = provinceOpinionRunning(pipeline)
  const status = provinceOpinionStatus(pipeline)
  const task = pipeline.task || {}
  const connection = pipeline.connection || {}
  const servingIndexes = pipeline.servingIndexes || {}
  const writerContract = pipeline.writerContract || {}
  const latestWriterAttestation = writerContract.latestAttestation || null
  const writerContractCurrent = Boolean(
    latestWriterAttestation
    && latestWriterAttestation.contractVersion === writerContract.version
    && latestWriterAttestation.contractDigest === writerContract.digest,
  )
  const [form, setForm] = useState(() => ({
    databaseConnectionId: pipeline.databaseConnectionId || INLINE_DATABASE_CONNECTION,
    host: connection.host || '',
    port: String(connection.port || 5432),
    database: connection.database || '',
    username: connection.username || '',
    password: connection.password || '',
    sslMode: connection.sslMode || 'require',
    syncIntervalSeconds: String(pipeline.syncIntervalSeconds || 300),
  }))
  const [busyAction, setBusyAction] = useState(null)
  const [writerContractConfirmed, setWriterContractConfirmed] = useState(false)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const loadProgress = useCallback(
    () => configured
      ? adminApi.provinceOpinionPipelineProgress(token)
      : Promise.resolve(null),
    [configured, token],
  )
  const progress = useRemoteData(loadProgress, onUnauthorized)
  const progressIssues = sqlitePipelineIssueMessages(
    progress.data?.blocker,
    progress.data?.issues,
    pipeline.configurationIssues,
  )
  const stuck = telegramTaskStuck(task)
  const refreshGates = () => {
    progress.refresh()
    onRefresh()
  }

  useEffect(() => {
    if (!running || loading) return undefined
    const timer = window.setTimeout(onRefresh, 2_000)
    return () => window.clearTimeout(timer)
  }, [loading, onRefresh, running])

  const mutate = async (action, request, successMessage) => {
    setBusyAction(action)
    try {
      const updated = await request()
      if (updated?.task && updated?.status) onPipelineChanged(updated)
      else onRefresh()
      progress.refresh()
      notify?.(successMessage, 'success')
      return updated
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      notify?.(error.message, 'error')
      return null
    } finally {
      setBusyAction(null)
    }
  }

  const save = (event) => {
    event.preventDefault()
    mutate(
      'save',
      () => adminApi.updateProvinceOpinionPipeline(token, {
        ...(form.databaseConnectionId
          ? { databaseConnectionId: form.databaseConnectionId }
          : {
              connection: {
                host: form.host.trim(),
                port: Number(form.port),
                database: form.database.trim(),
                username: form.username.trim(),
                password: form.password,
                sslMode: form.sslMode,
              },
            }),
        syncIntervalSeconds: Number(form.syncIntervalSeconds),
      }),
      '全国省份舆情源库连接已验证并保存；任务仍保持暂停',
    )
  }

  const changeStatus = (nextStatus) => mutate(
    `status-${nextStatus}`,
    () => adminApi.updateProvinceOpinionPipelineStatus(
      token,
      nextStatus,
      nextStatus === 'active' ? {
        confirmed: writerContractConfirmed,
        contractVersion: pipeline.writerContract?.version,
        contractDigest: pipeline.writerContract?.digest,
      } : null,
    ),
    nextStatus === 'active' ? '全国省份舆情清洗任务已启用' : '已安全暂停全国省份舆情清洗任务',
  )

  const confirmWriterContract = () => mutate(
    'attest',
    () => adminApi.updateProvinceOpinionPipelineStatus(token, 'active', {
      confirmed: writerContractConfirmed,
      contractVersion: writerContract.version,
      contractDigest: writerContract.digest,
    }),
    '当前 writer 合同已确认；自动调度与立即同步已恢复',
  )

  const runSync = () => mutate(
    'sync',
    () => adminApi.runProvinceOpinionPipeline(token, { batchSize: 200 }),
    '全国省份舆情同步已提交',
  )

  const resumeFailed = () => mutate(
    'resume',
    () => adminApi.resumeProvinceOpinionPipeline(token),
    '任务已从原 checkpoint 恢复；没有重置或重放已完成数据',
  )

  const resetCheckpoint = (event) => {
    event.preventDefault()
    if (resetConfirmation !== 'province-opinion') return
    mutate(
      'reset',
      async () => {
        const updated = await adminApi.resetProvinceOpinionPipelineCheckpoint(token, {
          confirmPipelineKey: resetConfirmation,
        })
        setResetConfirmation('')
        return updated
      },
      '一次性全量对齐已准备；下次同步会从源表起点重新扫描',
    )
  }

  return (
    <Modal
      title={pipeline.displayName || '全国省份舆情'}
      description={pipeline.status === 'active'
        ? '固定 PostgreSQL 业务管线 · 已启用，持续受源表合同与 Hub 服务索引门禁约束'
        : configured
          ? '固定 PostgreSQL 业务管线 · 已配置但保持暂停，不会自动调度导入'
          : '固定 PostgreSQL 业务管线 · 当前只完成能力，不连接、不启用、不导入现有数据'}
      size="xlarge"
      onClose={onClose}
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button>}
    >
      <div className="mih-telegram-toolbar">
        <div>
          <StatusBadge status={status.status} label={status.label} />
          <code>{pipeline.pipelineKey || 'province-opinion'}</code>
          <span className="mih-telegram-toolbar__warning"><Warning size={15} />源表合同未验证前保持暂停</span>
        </div>
        <div className="mih-page-actions">
          {pipeline.status === 'active' ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)} onClick={() => changeStatus('paused')}>
              <Pause size={16} />{busyAction === 'status-paused' ? '安全暂停中…' : '安全暂停'}
            </button>
          ) : (
            <button className="qp-button qp-button--ghost" type="button"
              disabled={Boolean(busyAction) || !configured || running || progress.loading || !progress.data || progressIssues.length > 0 || !writerContractConfirmed}
              title={!configured ? '先验证并保存源库连接' : progress.loading || !progress.data ? '先核对源表门禁' : progressIssues.length > 0 ? '源表或 Hub 服务索引门禁未满足' : !writerContractConfirmed ? '请先确认源端 writer 合同' : ''}
              onClick={() => changeStatus('active')}>
              <Play size={16} />{busyAction === 'status-active' ? '正在启用…' : '启用任务'}
            </button>
          )}
          {stuck ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)} onClick={resumeFailed}>
              <ArrowClockwise size={16} />{busyAction === 'resume' ? '正在恢复…' : '恢复卡住的任务'}
            </button>
          ) : null}
          <button className="qp-button" type="button"
            disabled={Boolean(busyAction) || pipeline.status !== 'active' || !writerContractCurrent}
            title={!writerContractCurrent ? '先确认当前 writer 合同' : ''}
            onClick={runSync}>
            <ArrowClockwise size={16} />{busyAction === 'sync' ? '正在提交…' : '立即同步'}
          </button>
        </div>
      </div>

      <p className="mih-inline-warning">
        <Warning size={16} aria-hidden="true" />
        附件样例的两条记录 province 都为空；给出的表结构也没有 updated_at。created_at 只代表插入时间，无法发现后续补写的省份、来源、热度或 LLM 结果，所以服务端会明确阻止启用，不会临时用 created_at 冒充更新水位。
      </p>

      <Panel title="只读源库与调度" subtitle="只填写连接坐标；表名、Dataset、对象类型和游标字段由业务版本固定">
        <form className="mih-form mih-form--grid mih-telegram-config" onSubmit={save}>
          <DatabaseConnectionField value={form.databaseConnectionId} state={databaseConnections}
            onChange={(databaseConnectionId) => setForm({ ...form, databaseConnectionId })} />
          {!form.databaseConnectionId ? <>
            <Field label="主机"><input className="qp-input" required value={form.host} placeholder="127.0.0.1" onChange={(event) => setForm({ ...form, host: event.target.value })} /></Field>
            <Field label="端口"><input className="qp-input" type="number" min="1" max="65535" required value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></Field>
            <Field label="数据库"><input className="qp-input" required value={form.database} placeholder="night_all" onChange={(event) => setForm({ ...form, database: event.target.value })} /></Field>
            <Field label="用户名"><input className="qp-input" required autoComplete="off" value={form.username} placeholder="mx_data" onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
            <Field label="密码" hint="明文保存，仅 Admin Token 管理面可读取"><input className="qp-input" type="password" required autoComplete="off" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
            <DropdownField label="SSL 模式" value={form.sslMode}
              onChange={(sslMode) => setForm({ ...form, sslMode })}
              options={[{ ...SSL_MODE_OPTIONS[0], label: 'disable（受控内网）' }, ...SSL_MODE_OPTIONS.slice(1)]} />
          </> : null}
          <Field label="同步间隔（秒）" hint="60–86400；首次空 checkpoint 会完整扫描">
            <input className="qp-input" type="number" min="60" max="86400" required value={form.syncIntervalSeconds}
              onChange={(event) => setForm({ ...form, syncIntervalSeconds: event.target.value })} />
          </Field>
          <div className="mih-page-actions mih-form__wide">
            <button className="qp-button qp-button--ghost" type="submit" disabled={Boolean(busyAction) || pipeline.status !== 'paused' || running}>
              {busyAction === 'save' ? '正在验证并保存…' : '验证并保存连接'}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="固定输入、增量与服务索引门禁" subtitle="连接测试只证明可达；启用还必须通过源表合同和 Hub 在线服务索引探测"
        actions={<button className="qp-button qp-button--ghost" type="button" disabled={!configured || progress.loading || loading} onClick={refreshGates}><ArrowClockwise size={16} />核对源表</button>}>
        <div className="mih-telegram-capabilities">
          <div><strong>固定表</strong><p><code>public.monitor_strategy_results</code><br /><code>public-opinion.province.v1 · opinion_item</code></p></div>
          <div><strong>可靠水位</strong><p><code>updated_at + id</code>；上游需增加非空 updated_at，并保证 province/source/heat/LLM 的每次更新都会推进。</p></div>
          <div><strong>源端游标索引</strong><p><code>(updated_at, id)</code>；禁止不可观察的硬删除，并保证迟提交不会落到已越过的 checkpoint 后方。</p></div>
          <div><strong>Hub 在线服务索引</strong><p>{servingIndexes.ready ? '已就绪' : `待安装：${(servingIndexes.missing || []).join('、') || '状态不可用'}`}<br /><code>scripts/province-opinion-serving-indexes.sql</code></p></div>
          <div><strong>HanLP 分词门禁</strong><p>{pipeline.indexing?.readyToSchedule
            ? `已配置 ${pipeline.indexing.configuredBackend}；服务瞬时故障时严格等待并退避`
            : '未配置严格 HanLP 后端/URL；固定源不能启用或调度'}<br /><code>MX_COMMON_SEGMENTER=hanlp</code></p></div>
        </div>
        {progress.loading && !progress.data ? <LoadingState label="正在核对省份舆情源表" /> : null}
        {progress.error ? <ErrorState error={progress.error} onRetry={progress.refresh} /> : null}
        {progressIssues.length > 0 ? <ul className="mih-source-issues mih-source-issues--warning">{progressIssues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul> : null}
        {progress.data && progressIssues.length === 0 ? (
          <p className="mih-preview-provenance">源表门禁通过 · 总行数 {formatNumber(progress.data.totalRows)} · 已完成 {formatNumber(progress.data.completedRows)} · 剩余 {formatNumber(progress.data.remainingRows)}</p>
        ) : null}
      </Panel>

      <Panel title="源端 Writer 增量合同" subtitle="Schema 无法证明提交顺序；每次启用都必须显式确认并留下审计记录">
        <ul className="mih-source-issues mih-source-issues--warning">
          <li>{pipeline.writerContract?.summary?.watermark}</li>
          <li>{pipeline.writerContract?.summary?.deletion}</li>
          <li>{pipeline.writerContract?.summary?.ordering}</li>
        </ul>
        {pipeline.status !== 'active' || !writerContractCurrent ? (
          <label className="mih-agent-consent">
            <input type="checkbox" checked={writerContractConfirmed} disabled={Boolean(busyAction) || running}
              onChange={(event) => setWriterContractConfirmed(event.target.checked)} />
            <span>
              <strong>我已验证源端实现满足上述合同</strong>
              <small>
                合同 {writerContract.version || 'province-opinion.writer.v2'} · 摘要 {writerContract.digest?.slice(0, 12) || '待加载'}…
                {pipeline.status === 'active' ? ' · 勾选后点击“确认当前合同”写入审计记录' : ' · 勾选后点击“启用任务”写入审计记录'}
              </small>
            </span>
          </label>
        ) : (
          <p className="mih-preview-provenance">当前 writer 合同已确认，自动调度与立即同步可用。</p>
        )}
        {pipeline.status === 'active' && !writerContractCurrent ? (
          <div className="mih-page-actions">
            <button className="qp-button qp-button--ghost" type="button"
              disabled={Boolean(busyAction) || !configured || running || progress.loading || !progress.data || progressIssues.length > 0 || !writerContractConfirmed}
              title={!configured ? '先验证并保存源库连接' : progress.loading || !progress.data ? '先核对源表门禁' : progressIssues.length > 0 ? '源表或 Hub 服务索引门禁未满足' : !writerContractConfirmed ? '先勾选确认源端实现满足当前合同' : ''}
              onClick={confirmWriterContract}>
              <ShieldCheck size={16} />{busyAction === 'attest' ? '正在确认…' : '确认当前合同'}
            </button>
          </div>
        ) : null}
        {latestWriterAttestation ? (
          <p className="mih-preview-provenance">
            最近确认：{latestWriterAttestation.attestedBy || 'admin-token'} · {formatDate(latestWriterAttestation.attestedAt)}
            {writerContractCurrent ? ' · 当前合同' : ' · 与当前版本或摘要不匹配'}
          </p>
        ) : <p className="mih-preview-provenance">尚无 writer 合同确认记录。</p>}
      </Panel>

      <Panel title="省份接口与全局归类" subtitle="热门/最新读取 Hub PostgreSQL 当前态；全局文本检索继续使用统一 canonical search">
        <div className="mih-telegram-capabilities">
          <div><strong>省份热门 / 最新</strong><p><code>GET /api/v1/data/public-opinion/provinces/CN-JS/items?sort=hot|latest</code></p></div>
          <div><strong>点击详情</strong><p><code>GET /api/v1/data/public-opinion/items/:id</code>；只返回标题、摘要、链接、省份、热度和审核过的来源字段。</p></div>
          <div><strong>全局搜索</strong><p><code>POST /api/v1/data/canonical/search</code>，以 platform / datasetId / objectType 归类；不改 Night-All 兼容接口。</p></div>
        </div>
      </Panel>

      <Panel title="清洗、Agent 归档与严格索引" subtitle="三段独立恢复：固定源提交、Agent 派生分析、HanLP 分词投影">
        <div className="mih-telegram-capabilities">
          <div><strong>可公开字段</strong><p>province 规范为 ISO 代码，heat_score 为数值列；来源平台保持内容来源，不覆盖 Hub 授权平台。</p></div>
          <div><strong>追加式原始修订</strong><p>strategy/run/hash、关键词、llm_reason 与 raw 按 source revision 保留；仅抽取去重后的语义字段和证据窗口进入模型。</p></div>
          <div><strong>多维 Agent 归档</strong><p>事件省份、发布者省份、地理范围、事件类型与来源类型分别形成 assertion；Agent 只能提案，不改 raw、canonical 或 checkpoint。</p></div>
          <div><strong>当前 Agent 状态</strong><p>{pipeline.classification
            ? `${pipeline.classification.status === 'active' ? '已启用' : '已暂停'} · 待处理 ${formatNumber(pipeline.classification.tasks?.pending || 0)} · 失败隔离 ${formatNumber(pipeline.classification.tasks?.dead || 0)} · 未采纳派生断言 ${formatNumber(pipeline.classification.assertions?.proposed || 0)}`
            : 'Agent 派生面尚不可用；固定源同步与索引不受影响。'}</p></div>
          <div><strong>严格 HanLP 索引</strong><p>每条 canonical 投影必须经过 HanLP；服务过载或不可达时保留待投影并退避，不写入本地 fallback 分词结果。</p></div>
          <div><strong>三级背压</strong><p>源库每页 200 条并留 2 秒续页间隔；Agent 默认 12 条/分钟且单并发；HanLP live batch 与 bulk 并发均受 Hub 专用上限保护。</p></div>
        </div>
      </Panel>

      <div className="mih-telegram-task-grid">
        <article className="mih-telegram-task">
          <header><div><span className="mih-telegram-task__role">省份舆情结果</span><code>{task.sourceKey || 'province-opinion-results'}</code></div><StatusBadge status={task.cursor?.status || pipeline.status} /></header>
          <dl className="mih-telegram-task__definition">
            <div><dt>Dataset / 对象</dt><dd><code>{task.source?.datasetId || 'public-opinion.province.v1'}</code><small>public_opinion · opinion_item</small></dd></div>
            <div><dt>固定映射</dt><dd>{task.activeMapping?.version ? `v${task.activeMapping.version}` : task.builtInMappingAvailable ? 'v1 · 待启用审批' : '缺失'}</dd></div>
            <div><dt>Checkpoint</dt><dd><code>{compactCheckpoint(task.cursor?.position)}</code></dd></div>
            <div><dt>下次调度</dt><dd>{formatDate(task.nextDueAt)}<small>{task.scheduling?.message}</small></dd></div>
          </dl>
        </article>
      </div>

      <PipelineRunHistory token={token} tasks={[task]} onUnauthorized={onUnauthorized} labelOf={() => '省份舆情结果'} />

      {pipeline.status === 'paused' && !running ? (
        <section className="mih-source-danger" aria-labelledby="province-opinion-checkpoint-reset-title">
          <div className="mih-source-danger__copy">
            <Warning size={24} weight="duotone" aria-hidden="true" />
            <div>
              <h3 id="province-opinion-checkpoint-reset-title">一次性全量对齐</h3>
              <p>重置后下一次同步会从源表起点重扫；Canonical 幂等去重，但源库、PG 和投影负载会增加。普通新增、暂停恢复与 ES 重建不需要本操作。</p>
            </div>
          </div>
          <form className="mih-source-danger__form" onSubmit={resetCheckpoint}>
            <Field label="输入业务标识以确认" hint={<code>province-opinion</code>}>
              <input className="qp-input" value={resetConfirmation} autoComplete="off" spellCheck="false"
                onChange={(event) => setResetConfirmation(event.target.value)} />
            </Field>
            <button className="qp-button qp-button--danger" type="submit" disabled={Boolean(busyAction) || resetConfirmation !== 'province-opinion'}>
              {busyAction === 'reset' ? '正在准备全量对齐…' : '准备一次性全量对齐'}
            </button>
          </form>
        </section>
      ) : null}
    </Modal>
  )
}

function TelegramSqlitePipelineModal({
  token, pipeline, loading, error, onUnauthorized, notify, onClose, onRefresh, onPipelineChanged,
}) {
  const configured = telegramSqlitePipelineConfigured(pipeline)
  const running = telegramPipelineIsRunning(pipeline)
  const status = telegramSqlitePipelineStatus(pipeline)
  const [form, setForm] = useState(() => ({
    baseUrl: pipeline.connection?.baseUrl || '',
    token: '',
    syncIntervalSeconds: String(pipeline.syncIntervalSeconds || 300),
  }))
  const loadProgress = useCallback(
    () => configured ? adminApi.telegramSqlitePipelineProgress(token) : Promise.resolve({ tasks: [] }),
    [configured, token],
  )
  const progress = useRemoteData(loadProgress, onUnauthorized)
  const [busyAction, setBusyAction] = useState(null)
  const [followupRefreshes, setFollowupRefreshes] = useState(0)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const warnings = sqlitePipelineIssueMessages(pipeline.warnings, pipeline.strategy?.warnings)
  const progressTasks = Array.isArray(progress.data) ? progress.data : progress.data?.tasks || []
  const connectionEditable = !running && !['active', 'draining'].includes(pipeline.status)

  useEffect(() => {
    if ((!running && followupRefreshes === 0) || loading) return undefined
    const timer = window.setTimeout(() => {
      onRefresh()
      setHistoryRevision((value) => value + 1)
      if (followupRefreshes > 0) setFollowupRefreshes((value) => Math.max(0, value - 1))
    }, 2_000)
    return () => window.clearTimeout(timer)
  }, [followupRefreshes, loading, onRefresh, running])

  const wasRunning = useRef(running)
  useEffect(() => {
    if (running) {
      wasRunning.current = true
      return
    }
    if (!wasRunning.current) return
    wasRunning.current = false
    setHistoryRevision((value) => value + 1)
  }, [running])

  const mutate = async (action, request, successMessage) => {
    setBusyAction(action)
    try {
      const updated = await request()
      if (updated?.tasks && updated?.status) onPipelineChanged(updated)
      else onRefresh()
      progress.refresh()
      if (action === 'sync' || action === 'resume') {
        // The 202 sync response can win the race with the worker's first cursor
        // write. Keep observing long enough to see it start; once running is
        // visible, the regular running poll owns refresh through completion.
        setFollowupRefreshes(6)
        setHistoryRevision((value) => value + 1)
      }
      notify?.(successMessage, 'success')
      return updated
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      notify?.(error.message, 'error')
      return null
    } finally {
      setBusyAction(null)
    }
  }

  const save = (event) => {
    event.preventDefault()
    const nextToken = form.token.trim()
    mutate(
      'save',
      async () => {
        const updated = await adminApi.updateTelegramSqlitePipeline(token, {
          connection: {
            baseUrl: form.baseUrl.trim().replace(/\/$/, ''),
            ...(nextToken ? { token: nextToken } : {}),
          },
          syncIntervalSeconds: Number(form.syncIntervalSeconds),
        })
        setForm((current) => ({ ...current, token: '' }))
        return updated
      },
      'Telegram SQLite API 连接已验证并应用到两个固定任务',
    )
  }

  const changeStatus = (nextStatus) => mutate(
    `status-${nextStatus}`,
    () => adminApi.updateTelegramSqlitePipelineStatus(token, nextStatus),
    nextStatus === 'active'
      ? 'Telegram SQLite API 清洗任务已启用'
      : '已请求安全暂停，运行中批次会先完成收口',
  )

  const runSync = () => mutate(
    'sync',
    () => adminApi.runTelegramSqlitePipeline(token, { batchSize: 500 }),
    'Telegram SQLite API 双任务同步已提交',
  )

  const resumeFailed = () => mutate(
    'resume',
    () => adminApi.resumeTelegramSqlitePipeline(token),
    '失败游标已清除；两个任务将从各自的 checkpoint 继续，未重放任何数据',
  )

  const resetCheckpoints = (event) => {
    event.preventDefault()
    if (resetConfirmation !== 'telegram-sqlite') return
    mutate(
      'reset',
      async () => {
        const updated = await adminApi.resetTelegramSqlitePipelineCheckpoints(token, {
          confirmPipelineKey: resetConfirmation,
        })
        setResetConfirmation('')
        return updated
      },
      '一次性全量对齐已准备：两个 SQLite API 子任务的增量水位已重置；启用后点击立即同步执行完整幂等扫描',
    )
  }

  const tasks = pipeline.tasks || []
  // The scheduler treats any cursor that is not idle as not due, and both tasks
  // are enqueued together, so one failed cursor silently freezes the pair.
  const failedTasks = tasks.filter((task) => telegramTaskStuck(task))

  return (
    <Modal
      title={pipeline.displayName || 'Telegram SQLite API 清洗任务'}
      description="固定 Telegram SQLite 只读业务管线 · 共享 HTTP 连接与统一调度"
      size="xlarge"
      onClose={onClose}
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button>}
    >
      <div className="mih-telegram-toolbar">
        <div>
          <StatusBadge status={status.status} label={status.label} />
          <code>{pipeline.pipelineKey || 'telegram-sqlite'}</code>
          <span className="mih-telegram-toolbar__warning"><Warning size={15} />最终一致管线，不宣称精确增量</span>
        </div>
        <div className="mih-page-actions">
          {['active', 'mixed', 'draining'].includes(pipeline.status) ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)} onClick={() => changeStatus('paused')}>
              <Pause size={16} />{busyAction === 'status-paused' ? '安全暂停中…' : '安全暂停'}
            </button>
          ) : (
            <button className="qp-button qp-button--ghost" type="button"
              disabled={Boolean(busyAction) || !configured || running}
              title={!configured ? '先验证并保存只读 API 连接' : running ? '等待当前批次收口' : ''}
              onClick={() => changeStatus('active')}>
              <Play size={16} />{busyAction === 'status-active' ? '正在启用…' : '启用任务'}
            </button>
          )}
          {failedTasks.length > 0 ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)}
              title="清除失败或已静默的运行状态，从上次 checkpoint 继续；不会重放已提交批次" onClick={resumeFailed}>
              <ArrowClockwise size={16} />{busyAction === 'resume' ? '正在恢复…' : '恢复卡住的任务'}
            </button>
          ) : null}
          <button className="qp-button" type="button" disabled={Boolean(busyAction) || pipeline.status !== 'active'} onClick={runSync}>
            <ArrowClockwise size={16} />{busyAction === 'sync' ? '正在提交…' : '立即同步'}
          </button>
        </div>
      </div>

      {error ? <ErrorState error={error} onRetry={onRefresh} /> : null}

      {failedTasks.length > 0 ? (
        <p className="mih-inline-warning">
          <Warning size={16} aria-hidden="true" />
          {failedTasks.map((task) => `${telegramSqliteTaskMeta(task).label}（${telegramStuckDescription(task)}）`).join('、')}。
          两个任务同批调度，所以一个卡住会连带另一个停止排程。调度器只会在确认原运行已超时、保留可续跑 importRunId 且队列没有活跃任务时自动恢复暂态故障；其他故障仍需人工处理。
          「恢复卡住的任务」只清除卡住状态并从各自 checkpoint 继续，不重放已提交批次，也不重置 Checkpoint；最多重取当前未提交页。
          判定标准是静默超过 10 个同步周期（默认 50 分钟）；仍在推进的批次不会被打断。
        </p>
      ) : null}

      <Panel title="只读 API 与调度" subtitle="连接由 Hub 服务端使用；浏览器不会直接请求远端 SQLite API，也不会把 Bearer Token 放入 URL">
        <p className="mih-inline-warning"><Key size={16} aria-hidden="true" />Token 留空表示保留已保存凭据；保存操作会先验证健康状态、认证和只读资源。</p>
        <form className="mih-form mih-form--grid mih-telegram-config" onSubmit={save}>
          <Field label="Base URL" hint="填写调用地址，例如 http://54.151.151.135:8780；0.0.0.0 只是远端监听地址" className="mih-form__wide">
            <input className="qp-input" type="url" required value={form.baseUrl} placeholder="http://54.151.151.135:8780"
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
          </Field>
          <Field label="Bearer Token" hint={pipeline.connection?.tokenConfigured ? '已配置；留空保持当前 Token' : '尚未配置 Token'}>
            <input className="qp-input" type="password" autoComplete="new-password" value={form.token}
              required={!pipeline.connection?.tokenConfigured} placeholder={pipeline.connection?.tokenConfigured ? '留空保持不变' : '输入 SQLite API Token'}
              onChange={(event) => setForm({ ...form, token: event.target.value })} />
          </Field>
          <Field label="同步间隔（秒）" hint="60–86400；表示 Hub 判断任务是否到期的周期">
            <input className="qp-input" type="number" min="60" max="86400" required value={form.syncIntervalSeconds}
              onChange={(event) => setForm({ ...form, syncIntervalSeconds: event.target.value })} />
          </Field>
          <div className="mih-page-actions mih-form__wide">
            <StatusBadge status={pipeline.connection?.tokenConfigured ? 'active' : 'disabled'}
              label={pipeline.connection?.tokenConfigured ? 'Token 已配置' : 'Token 待配置'} />
            <button className="qp-button qp-button--ghost" type="submit" disabled={Boolean(busyAction) || !connectionEditable}
              title={!connectionEditable ? '请先安全暂停并等待运行批次排空' : ''}>
              {busyAction === 'save' ? '正在验证并保存…' : '验证并保存共享连接'}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="同步与数据保留策略" subtitle="首次或换库时全量对齐；平时读取增量窗口，凌晨只对上一自然日，不定时扫描全部历史">
        <div className="mih-telegram-capabilities">
          <div><strong>日常只追新增</strong><p>首次接入完整扫描；之后从 lastMessageAt 回退 2 小时读取到当前边界，重复记录由 canonical identity 幂等吸收。</p></div>
          <div><strong>凌晨只对日窗口</strong><p>上海时区 02:00 后仅复扫上一自然日一次，不是扫描全部历史；更换 SQLite 时另由人工触发一次性全量对齐。</p></div>
          <div><strong>原文、删除与检索分层</strong><p>源响应及带 deleted_at 的记录都写入 Hub PG，不做词汇规避或内容过滤；HanLP/CJK 只在 Elasticsearch 检索投影阶段生效。</p></div>
        </div>
        {pipeline.strategy ? <details className="mih-inline-details"><summary>查看当前策略证据</summary><pre className="mih-code-block">{JSON.stringify(pipeline.strategy, null, 2)}</pre></details> : null}
        {warnings.length > 0 ? <ul className="mih-source-issues mih-source-issues--warning">{warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul> : null}
      </Panel>

      <Panel title="固定资源与清洗状态" subtitle="两个 endpoint、Dataset 和映射由业务版本固定；诊断展示运行证据，不把倒序分页描述成精确增量"
        actions={<button className="qp-button qp-button--ghost" type="button" disabled={progress.loading} onClick={progress.refresh}><ArrowClockwise size={16} />刷新两任务诊断</button>}>
        <div className="mih-telegram-task-grid">
          {(tasks.length ? tasks : [{ role: 'chats' }, { role: 'messages' }]).map((task) => (
            <TelegramSqliteTaskCard key={task.role || telegramTaskSourceKey(task)} task={task} progress={progressTasks} configured={configured} />
          ))}
        </div>
        {progress.loading && !progress.data ? <LoadingState label="正在读取 SQLite API 管线诊断" /> : null}
        {progress.error ? <ErrorState error={progress.error} onRetry={progress.refresh} /> : null}
      </Panel>

      <PipelineRunHistory token={token} tasks={tasks} onUnauthorized={onUnauthorized}
        refreshRevision={historyRevision}
        labelOf={(sourceKey) => (sourceKey?.endsWith('chats') ? '会话目录' : '消息事实')} />

      <Panel title="处理链路与索引能力" subtitle="远端只读响应先作为原始证据保留；删除标记留在 canonical/revision，公共 ES 按 current-state tombstone 收敛">
        <div className="mih-telegram-flow" aria-label="Telegram SQLite API 数据处理链路">
          {['只读 HTTP API', '原始 PG', 'Canonical PG', 'Outbox', 'Elasticsearch'].map((step, index) => (
            <span key={step}>{index > 0 ? <b aria-hidden="true">→</b> : null}<em>{step}</em></span>
          ))}
        </div>
      </Panel>

      {pipeline.status === 'paused' && !running ? (
        <section className="mih-source-danger" aria-labelledby="telegram-sqlite-checkpoint-reset-title">
          <div className="mih-source-danger__copy">
            <Warning size={24} weight="duotone" aria-hidden="true" />
            <div>
              <h3 id="telegram-sqlite-checkpoint-reset-title">更换 SQLite / 一次性全量对齐</h3>
              <p>本操作统一重置两个增量水位；启用任务后，下一次同步会完整扫描新库。Canonical 仍会幂等去重，但远端读取和 PG/ES 投影负载会明显增加。</p>
              <p>仅用于同一逻辑数据集的换库或完整重放；源库缺席不会被推断为删除。无关的新语料必须使用新的 Dataset，不能覆盖本任务。</p>
            </div>
          </div>
          <form className="mih-source-danger__form" onSubmit={resetCheckpoints}>
            <Field label="输入业务标识以确认" hint={<code>telegram-sqlite</code>}>
              <input className="qp-input" value={resetConfirmation} autoComplete="off" spellCheck="false"
                onChange={(event) => setResetConfirmation(event.target.value)} />
            </Field>
            <button className="qp-button qp-button--danger" type="submit"
              disabled={Boolean(busyAction) || resetConfirmation !== 'telegram-sqlite'}>
              {busyAction === 'reset' ? '正在准备全量对齐…' : '准备一次性全量对齐'}
            </button>
          </form>
        </section>
      ) : null}
    </Modal>
  )
}

function TelegramSqliteTaskCard({ task, progress, configured }) {
  const meta = telegramSqliteTaskMeta(task)
  const sourceKey = telegramTaskSourceKey(task) || meta.sourceKey
  const diagnostic = progress.find((entry) => entry.role === task.role || entry.sourceKey === sourceKey)
  const latest = task.latestRun
  const cursorStatus = telegramTaskCursorStatus(task)
  const mappingVersion = task.activeMapping?.version ?? task.activeMapping ?? '—'
  const endpoint = task.endpoint || task.source?.connection?.endpoint || meta.endpoint
  const dataset = task.dataset || task.source?.datasetId || meta.dataset
  const issues = sqlitePipelineIssueMessages(diagnostic?.blocker, diagnostic?.issues, diagnostic?.warnings, task.warnings)
  const checkedAt = diagnostic?.checkedAt || diagnostic?.updatedAt
  const stat = (names) => {
    const key = names.find((name) => latest?.[name] != null)
    return key ? latest[key] : 0
  }

  return (
    <article className="mih-telegram-task">
      <header>
        <div><span className="mih-telegram-task__role">{meta.label}</span><code>{sourceKey}</code></div>
        <StatusBadge status={cursorStatus === 'failed' ? 'down' : cursorStatus === 'running' ? 'warning' : task.source?.status || cursorStatus}
          label={cursorStatus === 'running' ? '运行中' : undefined} />
      </header>
      <dl className="mih-telegram-task__definition">
        <div><dt>只读 endpoint</dt><dd><code>{endpoint}</code></dd></div>
        <div><dt>Dataset / 对象</dt><dd><code>{dataset}</code><small>telegram · {task.source?.objectType || meta.objectType}</small></dd></div>
        <div><dt>映射</dt><dd>{mappingVersion === '—' ? '待配置' : `固定 v${mappingVersion}`}<small>无损 JSON 值保留；大整数以原始十进制字符串保真</small></dd></div>
        <div><dt>下次调度</dt><dd>{formatDate(task.nextDueAt)}</dd></div>
      </dl>
      <div className="mih-telegram-task__checkpoint"><span>Checkpoint</span><code>{compactCheckpoint(task.cursor?.position)}</code></div>
      <div className="mih-telegram-task__run">
        <span>最近批次</span>
        <dl>
          <div><dt>读取</dt><dd>{formatNumber(stat(['rowCount', 'inputRows', 'readRows', 'rowsRead', 'processedCount']))}</dd></div>
          <div><dt>入库</dt><dd>{formatNumber(stat(['ingestedCount', 'ingested', 'ingestedRows', 'writtenRows']))}</dd></div>
          <div><dt>变更</dt><dd>{formatNumber(stat(['changedCount', 'changed', 'changedRows', 'updatedRows']))}</dd></div>
          <div><dt>删除</dt><dd>{formatNumber(stat(['deletedCount', 'deleted', 'deletedRows']))}</dd></div>
          <div><dt>拒绝</dt><dd>{formatNumber(stat(['rejectedCount', 'rejected', 'rejectedRows']))}</dd></div>
        </dl>
      </div>
      <div className="mih-telegram-progress">
        <div><span>只读诊断</span><strong>{checkedAt ? formatDate(checkedAt) : configured ? '等待首次核对' : '连接待配置'}</strong></div>
        <small className={issues.length > 0 ? 'mih-telegram-progress__warning' : undefined}>{issues.length > 0
          ? issues.join('；')
          : diagnostic?.summary || diagnostic?.message || '正常运行读取 2 小时重叠增量；凌晨只对上一日窗口，换库时人工全量对齐。'}</small>
      </div>
      <footer>
        <span>最近运行：{latest ? formatDate(latest.finishedAt || latest.startedAt || latest.createdAt) : '尚未运行'}</span>
        <code>最终一致</code>
      </footer>
    </article>
  )
}

function TelegramPipelineModal({
  token, pipeline, loading, onUnauthorized, notify, onClose, onRefresh, onPipelineChanged, onOpenAdvanced,
  databaseConnections,
}) {
  const initialConnection = pipeline.connection || pipeline.tasks?.[0]?.source?.connection || {}
  const configured = telegramPipelineConfigured(pipeline)
  const connectionConsistent = telegramConnectionConsistent(pipeline)
  const scheduleConsistent = telegramScheduleConsistent(pipeline)
  const [form, setForm] = useState(() => ({
    databaseConnectionId: pipeline.databaseConnectionId || INLINE_DATABASE_CONNECTION,
    host: initialConnection.host || '',
    port: String(initialConnection.port || 5432),
    database: initialConnection.database || '',
    username: initialConnection.username || '',
    password: initialConnection.password || '',
    sslMode: initialConnection.sslMode || 'require',
    syncIntervalSeconds: String(pipeline.syncIntervalSeconds || pipeline.tasks?.[0]?.source?.syncIntervalSeconds || 300),
  }))
  const loadProgress = useCallback(
    () => configured ? adminApi.telegramMonitorPipelineProgress(token) : Promise.resolve({ tasks: [] }),
    [configured, token],
  )
  const progress = useRemoteData(loadProgress, onUnauthorized)
  const [busyAction, setBusyAction] = useState(null)
  const [writerContractConfirmed, setWriterContractConfirmed] = useState(false)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const running = telegramPipelineIsRunning(pipeline)
  const status = telegramPipelineStatus(pipeline)
  const progressBlockers = (progress.data?.tasks || []).filter((task) => task.blocker)

  useEffect(() => {
    if (!running || loading) return undefined
    const timer = window.setTimeout(onRefresh, 2_000)
    return () => window.clearTimeout(timer)
  }, [loading, onRefresh, running])

  const mutate = async (action, request, successMessage) => {
    setBusyAction(action)
    try {
      const updated = await request()
      if (updated?.tasks && updated?.status) onPipelineChanged(updated)
      else onRefresh()
      notify?.(successMessage, 'success')
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const save = (event) => {
    event.preventDefault()
    mutate(
      'save',
      () => adminApi.updateTelegramMonitorPipeline(token, {
        ...(form.databaseConnectionId
          ? { databaseConnectionId: form.databaseConnectionId }
          : {
              connection: {
                host: form.host.trim(),
                port: Number(form.port),
                database: form.database.trim(),
                username: form.username.trim(),
                password: form.password,
                sslMode: form.sslMode,
              },
            }),
        syncIntervalSeconds: Number(form.syncIntervalSeconds),
      }),
      'Telegram monitor 连接已验证并统一写入两个子任务',
    )
  }

  const changeStatus = (nextStatus) => mutate(
    `status-${nextStatus}`,
    () => adminApi.updateTelegramMonitorPipelineStatus(
      token,
      nextStatus,
      nextStatus === 'active' ? {
        confirmed: writerContractConfirmed,
        contractVersion: pipeline.writerContract?.version,
        contractDigest: pipeline.writerContract?.digest,
      } : null,
    ),
    nextStatus === 'active' ? 'Telegram monitor 清洗任务已启用' : '已请求安全暂停，运行中批次会先完成收口',
  )

  const runSync = () => mutate(
    'sync',
    () => adminApi.runTelegramMonitorPipeline(token, { batchSize: 1000 }),
    '双表同步任务已提交',
  )

  const resumeFailed = () => mutate(
    'resume',
    () => adminApi.resumeTelegramMonitorPipeline(token),
    '失败游标已清除；两个任务将从各自的 checkpoint 继续，未重放任何数据',
  )

  // One failed cursor stops the pair, because both tasks are scheduled together
  // and the scheduler skips any cursor that is not idle.
  const failedTasks = (pipeline.tasks || []).filter((task) => telegramTaskStuck(task))

  const resetCheckpoints = (event) => {
    event.preventDefault()
    if (resetConfirmation !== 'telegram-monitor') return
    mutate(
      'reset',
      async () => {
        const result = await adminApi.resetTelegramMonitorPipelineCheckpoints(token, {
          confirmPipelineKey: resetConfirmation,
        })
        setResetConfirmation('')
        progress.refresh()
        return result
      },
      '两个 TG 子任务的 Checkpoint 已统一重置；下次同步会从起点幂等重放',
    )
  }

  const tasks = pipeline.tasks || []

  return (
    <Modal
      title={pipeline.displayName || 'Telegram monitor 清洗任务'}
      description="固定 TG v2 业务管线 · 共享源库连接与统一调度"
      size="xlarge"
      onClose={onClose}
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button>}
    >
      <div className="mih-telegram-toolbar">
        <div>
          <StatusBadge status={status.status} label={status.label} />
          <code>{pipeline.pipelineKey || 'telegram-monitor'}</code>
          {!connectionConsistent || !scheduleConsistent ? <span className="mih-telegram-toolbar__warning"><Warning size={15} />双表连接或调度周期存在漂移</span> : null}
        </div>
        <div className="mih-page-actions">
          {pipeline.status === 'active' || pipeline.status === 'mixed' ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)} onClick={() => changeStatus('paused')}>
              <Pause size={16} />{busyAction === 'status-paused' ? '安全暂停中…' : '安全暂停'}
            </button>
          ) : (
            <button className="qp-button qp-button--ghost" type="button"
              disabled={Boolean(busyAction) || !configured || !connectionConsistent || !scheduleConsistent || running || progressBlockers.length > 0 || !writerContractConfirmed}
              title={!configured ? '先保存并验证源库连接' : !connectionConsistent || !scheduleConsistent ? '先统一双表连接与调度周期' : progressBlockers.length > 0 ? '源表水位或索引门禁未满足，请查看子任务进度提示' : !writerContractConfirmed ? '请先确认源端 writer 增量合同' : ''}
              onClick={() => changeStatus('active')}>
              <Play size={16} />{busyAction === 'status-active' ? '正在启用…' : '启用任务'}
            </button>
          )}
          {failedTasks.length > 0 ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busyAction)}
              title="清除失败或已静默的运行状态，从上次 checkpoint 继续；不会重放数据" onClick={resumeFailed}>
              <ArrowClockwise size={16} />{busyAction === 'resume' ? '正在恢复…' : '恢复卡住的任务'}
            </button>
          ) : null}
          <button className="qp-button" type="button" disabled={Boolean(busyAction) || pipeline.status !== 'active'} onClick={runSync}>
            <ArrowClockwise size={16} />{busyAction === 'sync' ? '正在提交…' : '立即同步'}
          </button>
        </div>
      </div>

      {failedTasks.length > 0 ? (
        <p className="mih-inline-warning">
          <Warning size={16} aria-hidden="true" />
          {failedTasks.map((task) => `${telegramTaskMeta(task).label}（${telegramStuckDescription(task)}）`).join('、')}。
          两个任务同批调度，所以一个卡住会连带另一个一起停止排程，直到人工恢复。
          「恢复卡住的任务」只清除卡住状态并从各自 checkpoint 继续，不重放数据，也不重置 Checkpoint。
          判定标准是静默超过 10 个同步周期（默认 50 分钟）；仍在推进的批次不会被打断。
        </p>
      ) : null}

      <Panel title="源库与调度" subtitle="只填写一次连接；Hub 会验证只读权限，并把同一连接应用到两个固定输入表">
        <p className="mih-inline-warning"><Key size={16} aria-hidden="true" />连接与明文密码仅 Admin Token 管理面可读取和修改，不需要额外 Provider Key。</p>
        <form className="mih-form mih-form--grid mih-telegram-config" onSubmit={save}>
          <DatabaseConnectionField value={form.databaseConnectionId} state={databaseConnections}
            onChange={(databaseConnectionId) => setForm({ ...form, databaseConnectionId })} />
          {!form.databaseConnectionId ? <>
            <Field label="主机"><input className="qp-input" required value={form.host} placeholder="127.0.0.1" onChange={(event) => setForm({ ...form, host: event.target.value })} /></Field>
            <Field label="端口"><input className="qp-input" type="number" min="1" max="65535" required value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></Field>
            <Field label="数据库"><input className="qp-input" required value={form.database} placeholder="night_all" onChange={(event) => setForm({ ...form, database: event.target.value })} /></Field>
            <Field label="用户名"><input className="qp-input" required autoComplete="off" value={form.username} placeholder="mx_data" onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
            <Field label="密码" hint="明文保存，仅 Admin Token 接口返回"><input className="qp-input" type="text" required autoComplete="off" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
            <DropdownField label="SSL 模式" value={form.sslMode}
              onChange={(sslMode) => setForm({ ...form, sslMode })} options={SSL_MODE_OPTIONS} />
          </> : null}
          <Field label="同步间隔（秒）" hint="60–86400；暂停后不再发起新批次"><input className="qp-input" type="number" min="60" max="86400" required value={form.syncIntervalSeconds} onChange={(event) => setForm({ ...form, syncIntervalSeconds: event.target.value })} /></Field>
          <div className="mih-page-actions mih-form__wide">
            <button className="qp-button qp-button--ghost" type="submit" disabled={Boolean(busyAction) || pipeline.status !== 'paused' || running}
              title={running ? '运行中的批次收口后才能修改连接' : pipeline.status !== 'paused' ? '请先安全暂停整个业务任务' : ''}>
              {busyAction === 'save' ? '正在验证并保存…' : '验证并保存共享连接'}
            </button>
          </div>
        </form>
      </Panel>

      <TelegramSourcePreparationPanel
        key={[
          pipeline.databaseConnectionId,
          pipeline.connection?.host,
          pipeline.connection?.port,
          pipeline.connection?.database,
          pipeline.connection?.username,
        ].join(':')}
        token={token}
        pipeline={pipeline}
        configured={configured}
        connectionConsistent={connectionConsistent}
        running={running}
        disabled={Boolean(busyAction)}
        onUnauthorized={onUnauthorized}
        notify={notify}
        onPrepared={() => {
          onRefresh()
          progress.refresh()
        }}
      />

      <Panel title="源端 Writer 增量合同" subtitle="Schema 探测无法证明并发提交顺序；每次启用都必须由管理员显式确认并留存审计记录">
        <ul className="mih-source-issues mih-source-issues--warning">
          <li>{pipeline.writerContract?.summary?.watermark || '任何新增、编辑、指标、媒体和软删除都必须推进统一 updated_at。'}</li>
          <li>{pipeline.writerContract?.summary?.deletion || '禁止无法被 Hub 观察到的硬删除；删除必须以源表字段保留。'}</li>
          <li>{pipeline.writerContract?.summary?.ordering || '提交顺序不得让较晚提交落到 Hub 已越过的 checkpoint 之前；否则应使用 CDC/outbox。'}</li>
        </ul>
        <label className="mih-agent-consent">
          <input type="checkbox" checked={writerContractConfirmed} disabled={Boolean(busyAction) || running}
            onChange={(event) => setWriterContractConfirmed(event.target.checked)} />
          <span>
            <strong>我已验证源端实现满足上述合同</strong>
            <small>合同 {pipeline.writerContract?.version || 'telegram-monitor.writer.v1'} · 摘要 {pipeline.writerContract?.digest?.slice(0, 12) || '待加载'}…；确认人和时间会随启用操作永久记录。</small>
          </span>
        </label>
        {pipeline.writerContract?.latestAttestation ? (
          <p className="mih-preview-provenance">最近确认：{pipeline.writerContract.latestAttestation.attestedBy || 'admin-token'} · {formatDate(pipeline.writerContract.latestAttestation.attestedAt)}</p>
        ) : <p className="mih-preview-provenance">尚无 writer 合同确认记录。</p>}
      </Panel>

      <Panel title="固定输入与清洗状态" subtitle="表、Dataset、对象类型和 TG v2 映射属于业务定义，不随部署配置漂移"
        actions={<button className="qp-button qp-button--ghost" type="button" disabled={progress.loading} onClick={progress.refresh}><ArrowClockwise size={16} />精确核对源库进度</button>}>
        {progressBlockers.length > 0 ? (
          <p className="mih-inline-warning"><Warning size={16} aria-hidden="true" />连接已可用，但 {progressBlockers.map((task) => telegramTaskMeta(task).label).join('、')} 的安全增量水位尚未满足；修复源表契约前任务会保持暂停。</p>
        ) : null}
        <div className="mih-telegram-task-grid">
          {(tasks.length ? tasks : [{ role: 'chats' }, { role: 'messages' }]).map((task) => (
            <TelegramTaskCard key={task.role || telegramTaskSourceKey(task)} task={task} progress={progress.data?.tasks || []}
              configured={configured} onOpenAdvanced={() => onOpenAdvanced(task)} />
          ))}
        </div>
        {progress.loading && !progress.data ? <LoadingState label="正在精确统计源表进度" /> : null}
        {progress.error ? <ErrorState error={progress.error} onRetry={progress.refresh} /> : null}
      </Panel>

      <PipelineRunHistory token={token} tasks={pipeline.tasks || []} onUnauthorized={onUnauthorized}
        labelOf={(sourceKey) => (sourceKey?.endsWith('chats') ? '会话目录' : '消息事实')} />

      <Panel title="处理链路与索引能力" subtitle="业务映射与运行基础设施分层，确保重试和 ES 重建不会重复污染规范数据">
        <div className="mih-telegram-flow" aria-label="Telegram 数据处理链路">
          {['只读源表', '原始 PG', 'Canonical PG', 'Outbox', 'Elasticsearch'].map((step, index) => (
            <span key={step}>{index > 0 ? <b aria-hidden="true">→</b> : null}<em>{step}</em></span>
          ))}
        </div>
        <div className="mih-telegram-capabilities">
          <div><strong>确定性清洗</strong><p>固定 TG v2 分别清洗双表，以 chatId 保留可联查关系并幂等写入；主流程不调用 LLM。</p></div>
          <div><strong>漂移处理</strong><p>新增或缺失字段进入可观测告警。Agent 仅可生成映射建议，当前未启用自动采纳。</p></div>
          <div><strong>检索阶段</strong><p>ES 预置中英文 title/body 全文检索、名称模糊匹配与结构化过滤；Embedding 属于后续独立阶段。</p></div>
        </div>
      </Panel>

      {pipeline.status === 'paused' && !running ? (
        <section className="mih-source-danger" aria-labelledby="telegram-checkpoint-reset-title">
          <div className="mih-source-danger__copy">
            <Warning size={24} weight="duotone" aria-hidden="true" />
            <div>
              <h3 id="telegram-checkpoint-reset-title">统一重置双表 Checkpoint</h3>
              <p>下一次同步会从两个固定源表起点重放。Canonical 仍会幂等去重，但源库读取和 PG/ES 重投影负载可能明显增加。</p>
              <p>仅在“准备 / 修复源库”明确提示需要重置，或经审计决定全量重放时使用；首次接入、普通新增、暂停恢复与 ES 重建都不需要重置。</p>
            </div>
          </div>
          <form className="mih-source-danger__form" onSubmit={resetCheckpoints}>
            <Field label="输入业务标识以确认" hint={<code>telegram-monitor</code>}>
              <input className="qp-input" value={resetConfirmation} autoComplete="off" spellCheck="false"
                onChange={(event) => setResetConfirmation(event.target.value)} />
            </Field>
            <button className="qp-button qp-button--danger" type="submit"
              disabled={Boolean(busyAction) || resetConfirmation !== 'telegram-monitor'}>
              {busyAction === 'reset' ? '正在统一重置…' : '确认重置双表 Checkpoint'}
            </button>
          </form>
        </section>
      ) : null}
    </Modal>
  )
}

function TelegramSourcePreparationPanel({
  token, pipeline, configured, connectionConsistent, running, disabled, onUnauthorized, notify, onPrepared,
}) {
  const connectionFingerprint = [
    pipeline.connection?.host,
    pipeline.connection?.port,
    pipeline.connection?.database,
    pipeline.connection?.username,
  ].join(':')
  const load = useCallback(
    () => configured
      ? adminApi.telegramMonitorSourcePreparation(token)
      : Promise.resolve({ status: 'needs_prepare', ready: false, tables: [], warnings: [] }),
    [configured, connectionFingerprint, token],
  )
  const preparation = useRemoteData(load, onUnauthorized)
  const [confirmation, setConfirmation] = useState('')
  const [migrationUsername, setMigrationUsername] = useState('')
  const [migrationPassword, setMigrationPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [prepareError, setPrepareError] = useState(null)
  const data = preparation.data || {}
  const tables = telegramPreparationTables(data)
  const steps = telegramPreparationSteps(data)
  const issues = telegramPreparationIssues(data)
  const ready = Boolean(data.ready)
  const pausedAndDrained = pipeline.status === 'paused' && !running
  const credentialsIncomplete = Boolean(migrationUsername.trim()) !== Boolean(migrationPassword)
  const canPrepare = configured && connectionConsistent && pausedAndDrained && !disabled && !submitting
  const displayedError = prepareError || preparation.error

  const refreshPreparation = () => {
    setPrepareError(null)
    preparation.refresh()
  }

  const submit = async (event) => {
    event.preventDefault()
    if (!canPrepare || credentialsIncomplete || confirmation !== 'telegram-monitor') return
    setSubmitting(true)
    setPrepareError(null)
    try {
      const username = migrationUsername.trim()
      const result = await adminApi.prepareTelegramMonitorSource(token, {
        confirmPipelineKey: confirmation,
        ...(username && migrationPassword ? { migrationCredentials: { username, password: migrationPassword } } : {}),
      })
      preparation.setData(result)
      setConfirmation('')
      notify?.('TG 源库合同已准备并重新核验；清洗任务仍保持暂停，请确认后再启用', 'success')
      onPrepared?.()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setPrepareError(error)
      notify?.(error.message, 'error')
      preparation.refresh()
    } finally {
      setMigrationUsername('')
      setMigrationPassword('')
      setSubmitting(false)
    }
  }

  const sourceLabel = data.source
    ? `${data.source.database || pipeline.connection?.database || '源库'} · ${data.source.user || pipeline.connection?.username || '—'} · PostgreSQL ${data.source.serverVersion || '—'}`
    : configured ? `${pipeline.connection?.database || '源库'} · ${pipeline.connection?.username || '—'}` : '请先保存共享连接'

  return (
    <Panel
      title="一键准备 / 修复 TG 源库"
      subtitle="可重复执行的源库迁移：补齐 updated_at，安装数据库触发器、游标索引和硬删除保护"
      actions={<button className="qp-button qp-button--ghost" type="button" disabled={!configured || preparation.loading || submitting} onClick={refreshPreparation}><ArrowClockwise size={16} />重新探测</button>}
    >
      <div className="mih-telegram-prepare__summary">
        <div>
          <StatusBadge
            status={ready ? 'ready' : data.status === 'needs_prepare' ? 'not_ready' : data.status || 'unknown'}
            label={!configured ? '连接待配置' : ready ? '源库合同已就绪' : preparation.loading ? '正在探测' : '需要准备或修复'}
          />
          {data.applied ? <StatusBadge status="ready" label="本次已应用迁移" /> : null}
          {data.migrationAccountUsed ? <StatusBadge status="ready" label="本次使用一次性迁移账号" /> : null}
          <code>{sourceLabel}</code>
          {data.contract?.generation ? <code>contract v{data.contract.installedVersion || data.contract.version} · {data.contract.generation.slice(0, 12)}…</code> : null}
        </div>
        <p>此操作会直接 <strong>ALTER 两个源表</strong>，由源 PostgreSQL 安装并维护 <code>updated_at</code> 触发器与 <code>(updated_at, id)</code> 游标索引，并通过数据库保护阻止 Hub 无法观察的硬删除。它不会开始同步、不会启用任务，也不会自动重置 Checkpoint。</p>
      </div>

      {data.permissions ? (
        <div className="mih-telegram-prepare__permissions">
          <StatusBadge status={data.permissions.canPrepare ? 'ready' : 'disabled'} label={data.permissions.canPrepare ? '已保存账号可执行迁移' : '已保存账号仅用于运行 / 探测'} />
          <span>本次探测强制只读：{data.source?.readOnly ? '是' : '否'}</span>
          <span>数据库 owner：{data.permissions.isDatabaseOwner ? '是' : '否'}</span>
          <span>superuser：{data.permissions.isSuperuser ? '是' : '否'}</span>
          {!data.permissions.canPrepare ? <small>执行时请使用下方临时 source owner / DDL 账号；不会替换已保存的运行连接。</small> : null}
        </div>
      ) : null}

      {data.requiresCheckpointReset ? (
        <p className="mih-telegram-prepare__critical"><Warning size={17} aria-hidden="true" /><span>检测到源库身份或游标合同发生变化；准备完成后仍需人工核对，并在确需全量重放时单独执行“统一重置双表 Checkpoint”。本操作不会代替你重置。{data.checkpointResetReason ? <small>{data.checkpointResetReason}</small> : null}</span></p>
      ) : null}

      {issues.length > 0 ? (
        <ul className="mih-source-issues mih-source-issues--warning">
          {issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
        </ul>
      ) : null}

      {displayedError ? (
        <div className="mih-telegram-prepare__error">
          <ErrorState error={displayedError} onRetry={refreshPreparation} />
          {displayedError.details ? <details className="mih-inline-details"><summary>安全错误详情</summary><pre className="mih-code-block">{JSON.stringify(displayedError.details, null, 2)}</pre></details> : null}
        </div>
      ) : null}

      <div className="mih-telegram-prepare__tables">
        {(tables.length ? tables : [
          { role: 'chats', table: 'public.tg_monitor_chats' },
          { role: 'messages', table: 'public.tg_monitor_messages' },
        ]).map((table) => (
          <TelegramPreparationTable key={table.role || table.table} table={table}
            contract={data.contract} probed={tables.length > 0} />
        ))}
      </div>

      {steps.length > 0 ? (
        <div className="mih-telegram-prepare__steps">
          <strong>最近探测 / 执行步骤</strong>
          <ol>
            {steps.map((step, index) => {
              const value = typeof step === 'string' ? { message: step } : step
              const stepStatus = value.status === 'applied' ? 'ready' : value.status === 'needed' ? 'not_ready' : value.status || 'unknown'
              return (
                <li key={value.key || `${value.message}-${index}`}>
                  <StatusBadge status={stepStatus} label={value.status === 'applied' ? '已执行' : value.status === 'needed' ? '待执行' : undefined} />
                  <span>{value.message || value.key || '未命名步骤'}</span>
                </li>
              )
            })}
          </ol>
        </div>
      ) : null}

      <form className="mih-telegram-prepare__form" onSubmit={submit}>
        <div className="mih-telegram-prepare__notice">
          <Warning size={22} weight="duotone" aria-hidden="true" />
          <div>
            <strong>仅在任务已暂停且批次排空后执行</strong>
            <p>{data.permissions?.canPrepare
              ? <>已保存的 <code>{pipeline.connection?.username || '源库账号'}</code> 已通过本次 DDL 权限核验，下面两个临时账号字段请留空。</>
              : <>已保存账号不能修改源表时，请在下面临时输入双表 owner（或其成员）且具备 database CREATE 权限的账号，或 superuser。</>} 临时账号只用于本次请求，不保存、不回填，也不会由接口返回；准备成功后，运行期仍使用已保存连接。</p>
          </div>
        </div>
        <div className="mih-form mih-form--grid mih-telegram-prepare__credentials">
          <Field label="临时 DDL 用户名（仅在需要时）" hint="双表 owner（或成员）+ database CREATE，或 superuser">
            <input className="qp-input" autoComplete="off" value={migrationUsername} onChange={(event) => setMigrationUsername(event.target.value)} />
          </Field>
          <Field label="临时 DDL 密码（仅在需要时）" hint="请求结束立即从页面状态清除">
            <input className="qp-input" type="password" autoComplete="new-password" value={migrationPassword} onChange={(event) => setMigrationPassword(event.target.value)} />
          </Field>
        </div>
        {credentialsIncomplete ? <p className="mih-telegram-prepare__field-error">临时 DDL 用户名和密码必须同时填写，或同时留空。</p> : null}
        <div className="mih-telegram-prepare__confirm">
          <Field label="输入业务标识以二次确认" hint={<code>telegram-monitor</code>}>
            <input className="qp-input" value={confirmation} autoComplete="off" spellCheck="false" onChange={(event) => setConfirmation(event.target.value)} />
          </Field>
          <button className="qp-button qp-button--danger" type="submit" disabled={!canPrepare || credentialsIncomplete || confirmation !== 'telegram-monitor'}
            title={!configured ? '先验证并保存共享连接' : !connectionConsistent ? '先统一两个固定任务的连接' : !pausedAndDrained ? '请先安全暂停并等待运行批次排空' : ''}>
            {submitting ? '正在准备源库…' : ready ? '重新核验并修复源库' : '准备 / 修复源库'}
          </button>
        </div>
      </form>
    </Panel>
  )
}

function TelegramPreparationTable({ table, contract, probed = true }) {
  const name = table.table || table.tableName || table.qualifiedName || (table.role === 'chats' ? 'public.tg_monitor_chats' : 'public.tg_monitor_messages')
  const updatedAtType = String(table.updatedAt?.type || '').toLowerCase()
  const updatedAtReady = table.updatedAt?.ready ?? Boolean(table.updatedAt?.exists && !table.updatedAt?.nullable && ['timestamptz', 'timestamp with time zone'].includes(updatedAtType))
  const stableIdReady = Boolean(table.stableId?.ready)
  const competingTriggers = table.trigger?.laterCompetingTriggers || []
  const triggerReady = Boolean(table.trigger?.installed && table.trigger?.enabledAlways && competingTriggers.length === 0)
  const indexReady = Boolean(table.cursorIndex?.ready)
  const deleteGuardReady = Boolean(table.deleteGuard?.installed && table.deleteGuard?.enabledAlways)
  const tableReady = Boolean(table.exists && updatedAtReady && stableIdReady && triggerReady && indexReady && deleteGuardReady)
  const contractReady = tableReady && contract?.installedVersion === contract?.version
  // An inspection that never ran knows nothing. Deriving these rows from an
  // empty response renders every check as "待安装" -- reporting absence where
  // the truth is ignorance, which reads as a source that lost its triggers when
  // in fact nothing was ever probed. A null value renders as 待探测 instead.
  const checks = !probed ? [
    ['updated_at', null], ['稳定 ID', null], ['强制触发器', null],
    ['游标索引', null], ['硬删除保护', null], ['表合同', null],
  ] : [
    ['updated_at', { ready: updatedAtReady, label: table.updatedAt?.exists ? `${table.updatedAt.type || 'timestamp'} · ${table.updatedAt.nullable ? '允许 NULL' : 'NOT NULL'}` : '列待安装' }],
    ['稳定 ID', { ready: stableIdReady, label: table.stableId?.exists ? table.stableId.ready ? 'NOT NULL · UNIQUE' : '存在但不满足唯一非空' : '列待核验' }],
    ['强制触发器', { ready: triggerReady, label: table.trigger?.installed ? !table.trigger.enabledAlways ? '已安装 · 未启用 ALWAYS' : competingTriggers.length ? `存在后置竞争触发器：${competingTriggers.join('、')}` : '已安装 · ENABLE ALWAYS' : '触发器待安装' }],
    ['游标索引', { ready: indexReady, label: table.cursorIndex?.exists ? table.cursorIndex.valid && table.cursorIndex.ready ? '存在 · VALID / READY' : '存在但不可用' : '索引待创建' }],
    ['硬删除保护', { ready: deleteGuardReady, label: table.deleteGuard?.installed ? table.deleteGuard.enabledAlways ? '已安装 · ENABLE ALWAYS' : '已安装 · 未启用 ALWAYS' : '待安装' }],
    ['表合同', { ready: contractReady, label: contractReady ? `TG source v${contract.installedVersion} 已满足` : '尚未满足' }],
  ]

  return (
    <article className="mih-telegram-prepare-table">
      <header><strong>{table.role === 'chats' ? '会话目录' : table.role === 'messages' ? '消息事实' : table.role || '固定输入表'}</strong><code>{name}</code></header>
      <dl>
        {checks.map(([label, value]) => {
          const check = telegramPreparationCheck(value)
          return <div key={label}><dt>{label}</dt><dd><StatusBadge status={check.status} label={check.label} /></dd></div>
        })}
      </dl>
    </article>
  )
}

function TelegramTaskCard({ task, progress, configured, onOpenAdvanced }) {
  const meta = telegramTaskMeta(task)
  const sourceKey = telegramTaskSourceKey(task)
    || (meta.objectType === 'chat' ? 'telegram-monitor-chats' : 'telegram-monitor-messages')
  const exact = progress.find((entry) => entry.role === task.role || entry.sourceKey === sourceKey)
  const latest = task.latestRun
  const cursorStatus = task.cursor?.status || latest?.status || 'idle'
  const mappingVersion = task.activeMapping?.version ?? task.activeMapping ?? '—'
  const percent = Math.max(0, Math.min(100, Number(exact?.percent || 0)))
  const stat = (names) => {
    const key = names.find((name) => latest?.[name] != null)
    return key ? latest[key] : 0
  }

  return (
    <article className="mih-telegram-task">
      <header>
        <div><span className="mih-telegram-task__role">{meta.label}</span><code>{sourceKey}</code></div>
        <StatusBadge status={cursorStatus === 'failed' ? 'down' : cursorStatus === 'running' ? 'warning' : task.source?.status || cursorStatus} label={cursorStatus === 'running' ? '运行中' : undefined} />
      </header>
      <dl className="mih-telegram-task__definition">
        <div><dt>输入表</dt><dd><code>{task.source?.connection?.schema || 'public'}.{meta.table}</code></dd></div>
        <div><dt>Dataset / 对象</dt><dd><code>{meta.dataset}</code><small>telegram · {meta.objectType}</small></dd></div>
        <div><dt>映射</dt><dd>内置 TG v{task.builtInMappingVersion || 2}<small>当前批准：{mappingVersion === '—' ? '待配置' : `v${mappingVersion}`}{(task.builtInMappingAvailable ?? task.builtInAvailable) === false ? ' · 内置版本不可用' : ''}</small></dd></div>
        <div><dt>下次调度</dt><dd>{formatDate(task.nextDueAt)}</dd></div>
      </dl>
      <div className="mih-telegram-task__checkpoint"><span>Checkpoint</span><code>{compactCheckpoint(task.cursor?.position)}</code></div>
      <div className="mih-telegram-task__run">
        <span>最近批次</span>
        <dl>
          <div><dt>读取</dt><dd>{formatNumber(stat(['rowCount', 'inputRows', 'readRows', 'rowsRead', 'processedCount']))}</dd></div>
          <div><dt>入库</dt><dd>{formatNumber(stat(['ingestedCount', 'ingested', 'ingestedRows', 'writtenRows']))}</dd></div>
          <div><dt>变更</dt><dd>{formatNumber(stat(['changedCount', 'changed', 'changedRows', 'updatedRows']))}</dd></div>
          <div><dt>删除</dt><dd>{formatNumber(stat(['deletedCount', 'deleted', 'deletedRows']))}</dd></div>
          <div><dt>拒绝</dt><dd>{formatNumber(stat(['rejectedCount', 'rejected', 'rejectedRows']))}</dd></div>
        </dl>
      </div>
      <div className="mih-telegram-progress">
        <div><span>精确源库快照</span><strong>{exact ? `${exact.completedRows == null ? '—' : formatNumber(exact.completedRows)} / ${formatNumber(exact.totalRows)}` : configured ? '打开时核对中' : '连接待配置'}</strong></div>
        <div className="mih-telegram-progress__track"><i style={{ width: `${percent}%` }} /></div>
        <small className={exact?.blocker ? 'mih-telegram-progress__warning' : undefined}>{exact
          ? exact.blocker
            ? `同步门禁：${(exact.issues || []).join('；') || exact.blocker}。已核对总量，但不会伪造已完成/剩余比例。`
            : `剩余 ${exact.remainingRows == null ? '待建立 checkpoint' : formatNumber(exact.remainingRows)} · ${exact.percent == null ? '进度待计算' : `${percent.toFixed(percent % 1 ? 1 : 0)}%`} · ${exact.checkedAt ? `核对于 ${formatDate(exact.checkedAt)}` : '本次打开时核对'}`
          : configured ? '该统计只在打开窗口或手动点击时读取源库，不参与高频轮询。' : '保存共享连接后才能读取源库总量与剩余量。'}</small>
      </div>
      <footer>
        <span>最近运行：{latest ? formatDate(latest.finishedAt || latest.startedAt || latest.createdAt) : '尚未运行'}</span>
        <button className="qp-button qp-button--ghost" type="button" disabled={!task.source && !sourceKey} onClick={onOpenAdvanced}>只读诊断</button>
      </footer>
    </article>
  )
}

function compactCheckpoint(position) {
  if (!position || Object.keys(position).length === 0) return '尚未建立'
  const serialized = JSON.stringify(position)
  return serialized.length > 104 ? `${serialized.slice(0, 101)}…` : serialized
}

function asList(value) {
  if (Array.isArray(value)) return value
  for (const key of ['items', 'sources', 'rules']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

function formatRuleOfPreview(preview) {
  return preview?.selectedFormatRule
    || preview?.matchedFormatRule
    || preview?.detection?.formatRule
    || preview?.builtinFormatRule
    || null
}

function formatRuleFormats(rule) {
  const formats = rule?.inputFormats || rule?.formats
  const values = Array.isArray(formats)
    ? formats
    : [rule?.inputFormat || rule?.format || 'file']
  return [...new Set(values.filter(Boolean).map((value) => String(value).toLowerCase()))]
}

function formatRuleFormatLabel(rule) {
  return formatRuleFormats(rule).map((value) => value.toUpperCase()).join(' / ')
}

function formatRuleOptions(value) {
  const rules = asList(value)
    .filter((rule) => rule?.ruleKey)
    .sort((left, right) => {
      const leftGroup = `${left.platform || 'other'}\u0000${formatRuleFormats(left).join('/')}`
      const rightGroup = `${right.platform || 'other'}\u0000${formatRuleFormats(right).join('/')}`
      return leftGroup.localeCompare(rightGroup) || String(left.displayName || left.ruleKey).localeCompare(String(right.displayName || right.ruleKey))
    })
  const options = [{ value: '', label: '自动识别（推荐）' }]
  let previousGroup = null
  for (const rule of rules) {
    const platform = rule.platform || 'other'
    const inputFormat = formatRuleFormats(rule).join('/')
    const group = `${platform}\u0000${inputFormat}`
    if (group !== previousGroup) {
      options.push({
        value: `__group:${platform}:${inputFormat}`,
        label: `${platform.toUpperCase()} · ${formatRuleFormatLabel(rule)}`,
        disabled: true,
        group: true,
      })
      previousGroup = group
    }
    options.push({
      value: rule.ruleKey,
      label: `${rule.displayName || rule.ruleKey}${rule.version ? ` · v${rule.version}` : ''}`,
    })
  }
  return options
}

function preferredRuleOfSource(source) {
  return source?.preferredRuleKey || source?.connection?.preferredRuleKey || ''
}

function previewDetection(preview) {
  if (!preview) return null
  const detection = preview.detection || preview.recognition || {}
  const rule = formatRuleOfPreview(preview)
  const platform = detection.platform || preview.detectedPlatform || rule?.platform || null
  const ruleKey = detection.ruleKey || rule?.ruleKey || null
  const inputFormat = detection.inputFormat || detection.format || rule?.inputFormat || preview.fileStructure?.format || null
  const confidence = detection.confidence ?? preview.detectionConfidence ?? null
  const basis = Array.isArray(detection.basis) ? detection.basis.filter(Boolean) : []
  const method = detection.method || detection.origin || preview.detectionMethod || basis.join(' + ') || null
  if (!platform && !ruleKey && !inputFormat && confidence == null && !method) return null
  return {
    platform,
    ruleKey,
    displayName: detection.displayName || rule?.displayName || null,
    inputFormat,
    confidence,
    method,
    reason: detection.reason || detection.explanation || null,
  }
}

function previewSamples(preview) {
  if (!preview) return []
  const sampling = preview.sampling?.items || preview.samples || preview.sampleRows
  if (Array.isArray(sampling)) return sampling.map((item, index) => ({
    ...item,
    position: item.position || item.segment || (typeof item.source === 'string' ? item.source : null) || (index === 0 ? 'head' : null),
  }))
  if (sampling && typeof sampling === 'object') {
    return ['head', 'middle', 'tail'].flatMap((position) => {
      const values = Array.isArray(sampling[position]) ? sampling[position] : sampling[position] ? [sampling[position]] : []
      return values.map((item) => ({ ...item, position }))
    })
  }
  if (Array.isArray(preview.sampling?.sampledPositions)) {
    return preview.sampling.sampledPositions.map(({ position, index }) => ({
      position,
      rowIndex: Number.isInteger(index) ? index + 1 : null,
      sampled: true,
    }))
  }
  return Array.isArray(preview.sample) ? preview.sample.map((item, index) => ({
    ...item,
    position: index === 0 ? 'head' : 'sample',
    rowIndex: index + 1,
  })) : []
}

function samplePositionLabel(value) {
  return { head: '首部', middle: '中部', tail: '尾部' }[value] || '样例'
}

function confidenceLabel(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '未提供'
  return `${Math.round((number <= 1 ? number * 100 : number) * 10) / 10}%`
}

function CreateSourceModal({ token, onUnauthorized, notify, onClose, onCreated, databaseConnections }) {
  const [form, setForm] = useState({
    sourceKey: '', displayName: '', sourceKind: 'file', datasetId: '', platform: 'external', objectType: 'record',
    fileMode: 'upload', serverPath: '', preferredRuleKey: '',
    databaseConnectionId: INLINE_DATABASE_CONNECTION,
    host: '', port: '5432', database: '', username: '', password: '', sslMode: 'require',
    schema: 'public', table: '', cursorColumn: '', idColumn: '', syncIntervalSeconds: '300',
  })
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const loadFormatRules = useCallback(() => adminApi.fileFormatRules(token), [token])
  const formatRules = useRemoteData(loadFormatRules, onUnauthorized)
  const ruleOptions = useMemo(() => formatRuleOptions(formatRules.data), [formatRules.data])
  const selectedRule = asList(formatRules.data).find((rule) => rule.ruleKey === form.preferredRuleKey)

  const submit = async (event) => {
    event.preventDefault()
    setError(null)
    const serverPath = form.serverPath.trim()
    if (form.sourceKind === 'file' && form.fileMode === 'server_path' && !serverPath) {
      setError({ code: 'server_path_required', message: '服务器路径不能为空' })
      return
    }
    setSubmitting(true)
    try {
      const body = {
        sourceKey: form.sourceKey.trim(), displayName: form.displayName.trim(), sourceKind: form.sourceKind,
        ...(form.datasetId.trim() ? { datasetId: form.datasetId.trim() } : {}),
        platform: form.platform.trim() || 'external', objectType: form.objectType.trim() || 'record',
      }
      if (form.sourceKind === 'file') {
        body.fileMode = form.fileMode
        if (form.preferredRuleKey) body.preferredRuleKey = form.preferredRuleKey
        if (form.fileMode === 'server_path') body.serverPath = serverPath
      }
      if (form.sourceKind === 'database') {
        body.syncIntervalSeconds = Number(form.syncIntervalSeconds)
        body.connection = {
          ...(form.databaseConnectionId ? {} : {
            host: form.host.trim(), port: Number(form.port), database: form.database.trim(),
            username: form.username.trim(), password: form.password, sslMode: form.sslMode,
          }),
          schema: form.schema.trim() || 'public', table: form.table.trim(),
          ...(form.cursorColumn.trim() ? { cursorColumn: form.cursorColumn.trim() } : {}),
          ...(form.idColumn.trim() ? { idColumn: form.idColumn.trim() } : {}),
        }
        if (form.databaseConnectionId) body.databaseConnectionId = form.databaseConnectionId
      }
      await adminApi.createSource(token, body)
      notify?.(`数据源 ${form.sourceKey} 已注册`, 'success')
      onCreated()
    } catch (requestError) {
      setError(requestError)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="注册外部数据源"
      description="文件可由浏览器上传或直接粘贴服务器路径；数据库连接信息仅 Admin Token 管理面可见。"
      onClose={onClose}
      footer={
        <>
          <button className="qp-button qp-button--ghost" type="button" onClick={onClose}>取消</button>
          <button className="qp-button" type="submit" form="create-source" disabled={submitting}>
            {submitting ? '正在验证并注册…' : (form.sourceKind === 'database' ? '验证并注册' : '注册')}
          </button>
        </>
      }
    >
      <form id="create-source" onSubmit={submit} className="mih-form mih-form--grid">
        <Field label="标识" hint="小写字母或数字开头，可包含点号、下划线与连字符，最长 128 个字符">
          <input className="qp-input" value={form.sourceKey} required maxLength={128}
            pattern="[a-z0-9][a-z0-9._-]*" title="请使用小写字母或数字开头，并仅包含小写字母、数字、点号、下划线或连字符"
            onChange={(event) => setForm({ ...form, sourceKey: event.target.value })} />
        </Field>
        <Field label="名称">
          <input className="qp-input" value={form.displayName} required
            onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
        </Field>
        <DropdownField label="类型" value={form.sourceKind}
          onChange={(value) => setForm({ ...form, sourceKind: value })}
          options={[
            { value: 'file', label: '文件（浏览器上传或服务器路径）' },
            { value: 'database', label: '只读 PostgreSQL 拉取' },
          ]} />
        <Field label="Dataset" hint="留空时自动生成 external.&lt;标识&gt;.v1">
          <input className="qp-input" value={form.datasetId} placeholder="telegram.monitor.messages.v1"
            onChange={(event) => setForm({ ...form, datasetId: event.target.value })} />
        </Field>
        <Field label="平台">
          <input className="qp-input" value={form.platform} required placeholder="telegram"
            onChange={(event) => setForm({ ...form, platform: event.target.value })} />
        </Field>
        <Field label="对象类型">
          <input className="qp-input" value={form.objectType} required placeholder="message"
            onChange={(event) => setForm({ ...form, objectType: event.target.value })} />
        </Field>
        {form.sourceKind === 'database' ? (
          <>
            <p className="mih-inline-warning mih-form__wide"><Key size={16} />连接信息会在保存前以只读会话验证；明文密码仅当前 Admin Token 管理面可读取。</p>
            <DatabaseConnectionField value={form.databaseConnectionId} state={databaseConnections}
              onChange={(databaseConnectionId) => setForm({ ...form, databaseConnectionId })} />
            {!form.databaseConnectionId ? <>
              <Field label="主机">
                <input className="qp-input" value={form.host} required placeholder="127.0.0.1"
                  onChange={(event) => setForm({ ...form, host: event.target.value })} />
              </Field>
              <Field label="端口">
                <input className="qp-input" type="number" min="1" max="65535" value={form.port} required
                  onChange={(event) => setForm({ ...form, port: event.target.value })} />
              </Field>
              <Field label="数据库">
                <input className="qp-input" value={form.database} required placeholder="night_all"
                  onChange={(event) => setForm({ ...form, database: event.target.value })} />
              </Field>
              <Field label="用户名">
                <input className="qp-input" value={form.username} required autoComplete="off" placeholder="mx_data"
                  onChange={(event) => setForm({ ...form, username: event.target.value })} />
              </Field>
              <Field label="密码" hint="明文保存并仅向 Admin Token 管理接口返回">
                <input className="qp-input" type="text" value={form.password} required autoComplete="off"
                  onChange={(event) => setForm({ ...form, password: event.target.value })} />
              </Field>
              <DropdownField label="SSL 模式" value={form.sslMode}
                onChange={(sslMode) => setForm({ ...form, sslMode })} options={SSL_MODE_OPTIONS} />
            </> : null}
            <Field label="Schema">
              <input className="qp-input" value={form.schema} required
                onChange={(event) => setForm({ ...form, schema: event.target.value })} />
            </Field>
            <Field label="表名">
              <input className="qp-input" value={form.table} required placeholder="tg_monitor_messages"
                onChange={(event) => setForm({ ...form, table: event.target.value })} />
            </Field>
            <Field label="变更水位列" hint="可先留空注册；完成 writer 语义与索引验证后再配置">
              <input className="qp-input" value={form.cursorColumn} placeholder="updated_at"
                onChange={(event) => setForm({ ...form, cursorColumn: event.target.value })} />
            </Field>
            <Field label="稳定 ID 列" hint="与水位组成严格全序游标">
              <input className="qp-input" value={form.idColumn} placeholder="id"
                onChange={(event) => setForm({ ...form, idColumn: event.target.value })} />
            </Field>
            <Field label="同步间隔（秒）" hint="60–86400；仅在完成安全探测并启用后运行">
              <input className="qp-input" type="number" min="60" max="86400" required value={form.syncIntervalSeconds}
                onChange={(event) => setForm({ ...form, syncIntervalSeconds: event.target.value })} />
            </Field>
          </>
        ) : null}
        {form.sourceKind === 'file' ? (
          <>
            <DropdownField label="文件入口" value={form.fileMode}
              onChange={(value) => setForm({ ...form, fileMode: value })}
              options={[
                { value: 'upload', label: '浏览器上传' },
                { value: 'server_path', label: '服务器路径' },
              ]} />
            <DropdownField label="格式规则" value={form.preferredRuleKey}
              className="mih-form__wide"
              disabled={formatRules.loading}
              onChange={(value) => {
                const rule = asList(formatRules.data).find((candidate) => candidate.ruleKey === value)
                setForm({
                  ...form,
                  preferredRuleKey: value,
                  ...(rule?.platform ? { platform: rule.platform } : {}),
                  ...(rule?.objectType ? { objectType: rule.objectType } : {}),
                  ...(rule?.datasetId ? { datasetId: rule.datasetId } : {}),
                })
              }}
              options={ruleOptions} />
            <p className="mih-file-rule-hint mih-form__wide">
              {formatRules.loading
                ? '正在读取可用格式规则…'
                : formatRules.error
                  ? '格式规则目录暂不可用；仍可使用自动识别注册，稍后在详情中重试。'
                  : selectedRule
                    ? `显式使用 ${selectedRule.displayName || selectedRule.ruleKey}；平台 ${selectedRule.platform || form.platform} · 格式 ${formatRuleFormatLabel(selectedRule)}`
                    : '自动识别会根据文件结构、平台证据与已批准规则选择建议；正式导入前仍需人工批准映射。'}
            </p>
            {form.fileMode === 'server_path' ? (
              <Field label="服务器文件路径" hint="直接粘贴完整路径；不支持目录、通配符或路径下拉">
                <input className="qp-input mih-server-path-input" value={form.serverPath} required
                  spellCheck="false" autoComplete="off" placeholder="/shared_dir/reports/2026-08/report.xlsx"
                  onChange={(event) => setForm({ ...form, serverPath: event.target.value })} />
              </Field>
            ) : null}
          </>
        ) : null}
        {error ? <ErrorState error={error} /> : null}
      </form>
    </Modal>
  )
}

function SourceDetailModal({ token, source, onUnauthorized, notify, onClose, onSourceChanged, databaseConnections }) {
  const managedByPipeline = PIPELINE_MANAGED_SOURCE_KEYS.has(source.sourceKey)
  const [currentSource, setCurrentSource] = useState(source)
  const isServerPathSource = currentSource.sourceKind === 'file'
    && currentSource.connection?.fileMode === 'server_path'
  const load = useCallback(() => adminApi.sourceMappings(token, source.sourceKey), [token, source.sourceKey])
  const mappings = useRemoteData(load, onUnauthorized)
  const loadRuns = useCallback(() => adminApi.importRuns(token, source.sourceKey), [token, source.sourceKey])
  const runs = useRemoteData(loadRuns, onUnauthorized)
  const loadSchema = useCallback(
    () => source.sourceKind === 'database' ? adminApi.sourceSchema(token, source.sourceKey) : Promise.resolve(null),
    [token, source.sourceKey, source.sourceKind],
  )
  const schema = useRemoteData(loadSchema, onUnauthorized)
  const loadSync = useCallback(
    () => source.sourceKind === 'database' ? adminApi.sourceSync(token, source.sourceKey) : Promise.resolve(null),
    [token, source.sourceKey, source.sourceKind],
  )
  const sync = useRemoteData(loadSync, onUnauthorized)
  const loadAgentStatus = useCallback(
    () => source.sourceKind === 'file' ? adminApi.agent(token) : Promise.resolve(null),
    [token, source.sourceKind],
  )
  const agentStatus = useRemoteData(loadAgentStatus, onUnauthorized)
  const loadServerFileRoots = useCallback(
    () => isServerPathSource ? adminApi.listServerFileRoots(token) : Promise.resolve([]),
    [isServerPathSource, token],
  )
  const serverFileRoots = useRemoteData(loadServerFileRoots, onUnauthorized)
  const loadFormatRules = useCallback(
    () => source.sourceKind === 'file' ? adminApi.fileFormatRules(token) : Promise.resolve([]),
    [source.sourceKind, token],
  )
  const formatRules = useRemoteData(loadFormatRules, onUnauthorized)
  const [preview, setPreview] = useState(null)
  const [serverPath, setServerPath] = useState('')
  const [preferredRuleKey, setPreferredRuleKey] = useState(() => preferredRuleOfSource(source))
  const [useAgentPreview, setUseAgentPreview] = useState(true)
  const [editingSettings, setEditingSettings] = useState(false)
  const [mappingDraft, setMappingDraft] = useState('{}')
  const [checkpointResetError, setCheckpointResetError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [statusTransition, setStatusTransition] = useState(null)
  const fileRef = useRef(null)
  // One hidden file input serves both actions, so it has to know which one
  // opened it. Without this the import button silently ran a preview.
  const intentRef = useRef('preview')
  const isDraining = currentSource.status === 'paused' && sync.data?.cursor?.status === 'running'
  const mappingMutationBlocked = managedByPipeline || (currentSource.sourceKind === 'database' && (
    isDraining || sync.loading || Boolean(sync.error)
  ))

  useEffect(() => {
    if (!isDraining || sync.loading) return undefined
    const timer = window.setTimeout(sync.refresh, 2_000)
    return () => window.clearTimeout(timer)
  }, [isDraining, sync.loading, sync.refresh])

  const activeMapping = useMemo(
    () => (mappings.data || []).find((mapping) => mapping.approved),
    [mappings.data],
  )
  const ruleOptions = useMemo(() => formatRuleOptions(formatRules.data), [formatRules.data])
  const selectedRule = asList(formatRules.data).find((rule) => rule.ruleKey === preferredRuleKey)
  const selectedPreviewRule = formatRuleOfPreview(preview)
  const detection = previewDetection(preview)
  const samples = previewSamples(preview)
  const serverImportReady = Boolean(
    activeMapping
    && preview?.inputSha256
    && preview?.schemaFingerprint
    && activeMapping.schemaFingerprint === preview.schemaFingerprint,
  )

  const runPreview = async (file) => {
    setBusy(true)
    try {
      setPreview(await adminApi.previewImport(token, source.sourceKey, file, {
        useAgent: useAgentPreview,
        preferredRuleKey: preferredRuleKey || null,
      }))
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const runServerPreview = async () => {
    const path = serverPath.trim()
    setBusy(true)
    try {
      setPreview(await adminApi.serverPreview(token, source.sourceKey, {
        ...(path ? { serverPath: path } : {}),
        agent: useAgentPreview,
        preferredRuleKey: preferredRuleKey || null,
      }))
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveSuggestion = async ({ approveImmediately = false } = {}) => {
    const fieldMap = preview?.suggestion?.fieldMap || preview?.inferredFieldMap
    if (!fieldMap) {
      notify?.('当前预览没有可保存的字段映射', 'warning')
      return
    }
    setBusy(true)
    try {
      const created = await adminApi.createMapping(token, source.sourceKey, {
        fieldMap,
        origin: preview?.suggestion?.origin || 'inferred',
        agentModel: preview?.suggestion?.model,
        ...(preview?.suggestion?.confidence != null
          ? { agentConfidence: preview.suggestion.confidence }
          : {}),
        ...((selectedPreviewRule?.ruleKey || detection?.ruleKey || preferredRuleKey)
          ? { selectedRuleKey: selectedPreviewRule?.ruleKey || detection?.ruleKey || preferredRuleKey }
          : {}),
        ...(preview?.schemaFingerprint ? { schemaFingerprint: preview.schemaFingerprint } : {}),
        ...(preview?.fileStructure ? { fileStructure: preview.fileStructure } : {}),
        ...(selectedPreviewRule?.versionId
          ? { formatRuleVersionId: selectedPreviewRule.versionId }
          : {}),
      })
      const saved = approveImmediately
        ? await adminApi.approveMapping(token, source.sourceKey, created.version)
        : created
      mappings.setData([
        saved,
        ...(mappings.data || []).filter((mapping) => mapping.id !== saved.id),
      ])
      notify?.(
        approveImmediately ? `映射 v${saved.version} 已保存并批准，可以导入` : `映射 v${saved.version} 已创建，待批准`,
        'success',
      )
      mappings.refresh()
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const approve = async (version) => {
    if (mappingMutationBlocked) {
      notify?.('同步状态尚未安全收口，请确认游标为 idle 后再批准新映射', 'warning')
      return
    }
    setBusy(true)
    try {
      const approved = await adminApi.approveMapping(token, source.sourceKey, version)
      const currentMappings = mappings.data || []
      mappings.setData(currentMappings.some((mapping) => mapping.id === approved.id)
        ? currentMappings.map((mapping) => mapping.id === approved.id ? approved : mapping)
        : [approved, ...currentMappings])
      notify?.(`映射 v${version} 已批准`, 'success')
      mappings.refresh()
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const runImport = async (file) => {
    setBusy(true)
    try {
      const result = await adminApi.runImport(token, source.sourceKey, file)
      mappings.refresh()
      runs.refresh()
      if (result.status === 'skipped') {
        notify?.('内容完全相同的文件已导入过，本次跳过', 'info')
      } else {
        notify?.(`导入完成：${result.ingested} 条入库，${result.rejected} 条被拒绝`, result.rejected > 0 ? 'warning' : 'success')
      }
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const runServerImport = async () => {
    const path = serverPath.trim()
    if (!activeMapping) {
      notify?.('请先批准当前文件结构的映射', 'warning')
      return
    }
    if (!preview?.inputSha256) {
      notify?.('请先预览当前服务器文件，确认内容哈希后再导入', 'warning')
      return
    }
    if (!preview.schemaFingerprint || activeMapping.schemaFingerprint !== preview.schemaFingerprint) {
      notify?.('已批准映射与当前文件结构不一致，请保存并批准本次预览的映射', 'warning')
      return
    }
    setBusy(true)
    try {
      const result = await adminApi.serverImport(token, source.sourceKey, {
        ...(path ? { serverPath: path } : {}),
        expectedSha256: preview.inputSha256,
      })
      mappings.refresh()
      runs.refresh()
      if (result.status === 'skipped') {
        notify?.('当前内容与已成功导入的文件相同，本次跳过', 'info')
      } else {
        notify?.(
          `导入完成：${formatNumber(result.ingested || 0)} 条入库，${formatNumber(result.rejected || 0)} 条被拒绝`,
          result.rejected > 0 ? 'warning' : 'success',
        )
      }
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveManualMapping = async () => {
    setBusy(true)
    try {
      const fieldMap = JSON.parse(mappingDraft)
      const created = await adminApi.createMapping(token, source.sourceKey, { fieldMap, origin: 'manual' })
      notify?.(`映射 v${created.version} 已创建，待批准`, 'success')
      mappings.refresh()
    } catch (error) {
      notify?.(error instanceof SyntaxError ? 'FieldMap 不是有效 JSON' : error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (status) => {
    setBusy(true)
    setStatusTransition(status)
    try {
      const updated = await adminApi.updateSource(token, source.sourceKey, { status })
      setCurrentSource(updated)
      onSourceChanged(updated)
      notify?.(
        status === 'active'
          ? '数据源已启用'
          : '已请求安全暂停；当前批次会在边界收口，游标变为 idle 后即可修改配置',
        'success',
      )
      schema.refresh()
      sync.refresh()
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
      setStatusTransition(null)
    }
  }

  const saveDatabaseSettings = async (settings) => {
    setBusy(true)
    try {
      const updated = await adminApi.updateSource(token, source.sourceKey, settings)
      setCurrentSource(updated)
      onSourceChanged(updated)
      setEditingSettings(false)
      notify?.('数据库源配置已更新，请重新探测后再启用', 'success')
      schema.refresh()
      sync.refresh()
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const previewDatabase = async () => {
    setBusy(true)
    try {
      setPreview(await adminApi.previewDatabaseSource(token, source.sourceKey, 3))
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async () => {
    setBusy(true)
    try {
      const result = await adminApi.testSource(token, source.sourceKey)
      notify?.(`连接正常 · PostgreSQL ${result.connection?.serverVersion || result.serverVersion || '未知版本'} · 只读`, 'success')
      schema.refresh()
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const runSync = async () => {
    setBusy(true)
    try {
      const result = await adminApi.runSourceSync(token, source.sourceKey, { batchSize: 1000 })
      notify?.(result.alreadyScheduled ? '同步任务已在队列中' : '同步任务已进入队列', 'success')
      sync.refresh()
      runs.refresh()
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const resetCheckpoint = async (confirmSourceKey) => {
    setBusy(true)
    setCheckpointResetError(null)
    try {
      await adminApi.resetSourceCheckpoint(token, source.sourceKey, { confirmSourceKey })
      notify?.(`数据源 ${source.sourceKey} 的 checkpoint 已重置`, 'success')
      sync.refresh()
      runs.refresh()
      onSourceChanged(currentSource)
      return true
    } catch (error) {
      setCheckpointResetError(error)
      return false
    } finally {
      setBusy(false)
    }
  }

  const schemaIssues = schema.data?.issues || []
  const canActivate = Boolean(
    activeMapping && schema.data && schemaIssues.length === 0 && !sync.loading && !sync.error && !isDraining,
  )
  const agentModels = agentStatus.data?.chat || []
  const agentAvailable = Boolean(agentStatus.data?.available && agentModels.length > 0)
  const agentModelLabel = agentModels.map((model) => `${model.id} / ${model.model}`).join(' → ')

  return (
    <Modal title={currentSource.displayName}
      description={`标识 ${currentSource.sourceKey} · dataset ${currentSource.datasetId}${managedByPipeline ? ' · Telegram 业务子任务只读诊断' : ''}`}
      size="xlarge" onClose={onClose}
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button>}>

      {currentSource.sourceKind === 'database' ? (
        <DatabaseSourceControl
          key={`${currentSource.id}:${currentSource.updatedAt || ''}`}
          source={currentSource}
          schema={schema}
          sync={sync}
          preview={preview}
          checkpointResetError={checkpointResetError}
          busy={busy}
          statusTransition={statusTransition}
          isDraining={isDraining}
          editing={editingSettings}
          canActivate={canActivate}
          readOnly={managedByPipeline}
          onEdit={() => setEditingSettings(true)}
          onCancelEdit={() => setEditingSettings(false)}
          onSave={saveDatabaseSettings}
          onStatus={changeStatus}
          onSync={runSync}
          onTest={testConnection}
          onPreview={previewDatabase}
          onResetCheckpoint={resetCheckpoint}
          databaseConnections={databaseConnections}
        />
      ) : null}

      <Panel title="字段映射" subtitle={managedByPipeline
        ? '由 Telegram monitor 业务版本统一管理；此处只读展示'
        : '创建时未批准；批准之后才能用于导入'}>
        {mappings.loading ? <LoadingState /> : null}
        {mappings.error ? <ErrorState error={mappings.error} onRetry={mappings.refresh} /> : null}
        {(mappings.data || []).length === 0 ? (
          <EmptyState icon={Plugs} title="还没有映射" description={currentSource.sourceKind === 'file'
            ? (isServerPathSource ? '先读取服务器文件，匹配或生成建议映射。' : '先上传一个样例文件生成建议映射。')
            : '根据探测到的字段创建一个版本化 fieldMap。'} />
        ) : (
          <DataTable label="字段映射版本">
            <thead><tr><th>版本</th><th>来源</th><th>模型</th><th>状态</th><th>创建时间</th><th /></tr></thead>
            <tbody>
              {(mappings.data || []).map((mapping) => (
                <tr key={mapping.id}>
                  <td>v{mapping.version}</td>
                  <td>{{ manual: '手动', agent: 'Agent 建议', inferred: '规则推断', format_rule: '格式规则' }[mapping.origin] || mapping.origin}</td>
                  <td><code>{mapping.agentModel || '—'}</code></td>
                  <td><StatusBadge status={mapping.approved ? 'active' : 'pending'} label={mapping.approved ? '已批准' : '待批准'} /></td>
                  <td>{formatDate(mapping.createdAt)}</td>
                  <td>
                    <details className="mih-inline-details"><summary>fieldMap</summary><pre className="mih-code-block">{JSON.stringify(mapping.fieldMap, null, 2)}</pre></details>
                    {mapping.approved || managedByPipeline ? null : <button className="qp-button qp-button--ghost" type="button" disabled={busy || mappingMutationBlocked}
                      title={mappingMutationBlocked ? '确认同步游标 idle 后再批准' : ''} onClick={() => approve(mapping.version)}>批准</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        {currentSource.sourceKind === 'database' && !managedByPipeline ? (
          <div className="mih-source-mapping-editor">
            <Field label="新映射版本（JSON）" hint="只创建待批准版本；已启用数据源需先暂停才能批准">
              <textarea className="qp-input mih-json-editor" value={mappingDraft} spellCheck="false"
                onChange={(event) => setMappingDraft(event.target.value)} />
            </Field>
            <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={saveManualMapping}>创建映射版本</button>
          </div>
        ) : null}
      </Panel>

      {currentSource.sourceKind === 'file' ? <Panel
        title={isServerPathSource ? '服务器文件' : '上传'}
        subtitle={activeMapping ? `将使用已批准的映射 v${activeMapping.version}` : '尚无已批准映射，只能预览 · 单文件上限 64 MiB · 表格与 JSONL 最多 50 万行'}
        actions={
          isServerPathSource ? (
            <>
              <button className="qp-button qp-button--ghost" type="button" disabled={busy}
                onClick={runServerPreview}>
                <MagnifyingGlass size={16} aria-hidden="true" /> 读取并预览
              </button>
              <button className="qp-button" type="button"
                disabled={busy || !serverImportReady}
                title={!activeMapping
                  ? '需先批准映射'
                  : !preview?.inputSha256
                    ? '需先预览当前文件'
                    : !serverImportReady
                      ? '需批准与当前文件结构一致的映射'
                      : ''}
                onClick={runServerImport}>
                <FileArrowUp size={16} aria-hidden="true" /> 从服务器导入
              </button>
            </>
          ) : (
            <>
              <input ref={fileRef} type="file" hidden accept=".xlsx,.xlsm,.csv,.tsv,.json,.jsonl,.ndjson,.txt,.md"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) (intentRef.current === 'import' ? runImport : runPreview)(file)
                  // Reset so re-selecting the same file fires change again.
                  event.target.value = ''
                }} />
              <button className="qp-button qp-button--ghost" type="button" disabled={busy}
                onClick={() => { intentRef.current = 'preview'; fileRef.current?.click() }}>
                <FileArrowUp size={16} aria-hidden="true" /> 选择文件并预览
              </button>
            </>
          )
        }
      >
        <div className="mih-file-rule-control">
          <DropdownField label="格式规则" value={preferredRuleKey}
            disabled={busy || formatRules.loading}
            onChange={(value) => { setPreferredRuleKey(value); setPreview(null) }}
            options={ruleOptions} />
          <div>
            <strong>{selectedRule ? selectedRule.displayName || selectedRule.ruleKey : '自动识别'}</strong>
            <small>{formatRules.loading
              ? '正在读取规则目录…'
              : formatRules.error
                ? '规则目录暂不可用；可继续自动预览或重试。'
                : selectedRule
                  ? `${selectedRule.platform || '未限定平台'} · ${formatRuleFormatLabel(selectedRule)} · ${selectedRule.ruleKey}`
                  : '根据结构指纹与平台证据识别；预览后再人工确认。'}</small>
          </div>
          {formatRules.error ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={formatRules.loading}
              onClick={formatRules.refresh}>重试规则目录</button>
          ) : null}
        </div>
        {isServerPathSource ? (
          <div className="mih-server-file-control">
            <Field label="服务器文件路径" hint="留空读取已注册文件；也可粘贴白名单内另一精确路径。不支持目录和通配符">
              <input className="qp-input mih-server-path-input" value={serverPath} spellCheck="false"
                autoComplete="off" placeholder="/shared_dir/reports/2026-08/report.xlsx"
                onChange={(event) => { setServerPath(event.target.value); setPreview(null) }} />
            </Field>
            {serverFileRoots.loading ? <small>正在核对允许的服务器根目录…</small> : null}
            {serverFileRoots.error ? <ErrorState error={serverFileRoots.error} onRetry={serverFileRoots.refresh} /> : null}
            <p>已注册安全定位：<code>{currentSource.connection?.rootId || '受控根目录'}:{currentSource.connection?.relativePath || '—'}</code></p>
            {asList(serverFileRoots.data).length > 0 ? (
              <p>可用只读根标识：{asList(serverFileRoots.data).map((root) => (
                <code key={root.rootId}>{root.rootId}</code>
              ))}</p>
            ) : null}
          </div>
        ) : null}
        <label className={`mih-agent-consent${agentAvailable ? '' : ' is-disabled'}`}>
          <input type="checkbox" checked={useAgentPreview} disabled={!agentAvailable || busy}
            onChange={(event) => setUseAgentPreview(event.target.checked)} />
          <span>
            <strong>自动使用 Agent 分析首部 / 中部 / 尾部结构</strong>
            {agentStatus.loading ? (
              <small>正在读取 Agent 模型链路；当前预览保持本地规则推断。</small>
            ) : agentStatus.error ? (
              <small>无法确认 Agent 模型链路：{agentStatus.error.message}。为保护样例，当前只允许本地规则推断。</small>
            ) : agentAvailable ? (
              <small>仅发送列名，不发送 value-shape 或原始单元格值。模型服务故障时可能按顺序发送到：{agentModelLabel}</small>
            ) : (
              <small>未配置可用 Agent 模型；预览只使用 Hub 内置规则，不向模型服务发送数据。</small>
            )}
          </span>
        </label>
        <p className="mih-preview-provenance">xlsx/xlsm 只读第一个工作表的缓存值，csv/tsv/json 使用 UTF-8；JSON 中的 64 位 ID 必须写成字符串。预览时请先确认 externalId 是稳定去重键。</p>
        {preview ? (
          <>
            <div className="mih-metric-grid mih-metric-grid--compact">
              <MetricCard icon={Table} label="行数" value={formatNumber(preview.rowCount)} />
              <MetricCard icon={Database} label="列数" value={formatNumber(preview.columns?.length || 0)} />
              <MetricCard icon={Warning} label="未映射列" value={formatNumber(preview.unmappedColumns?.length || 0)}
                hint="这些列会进入 extensions" tone={preview.unmappedColumns?.length > 0 ? 'warning' : 'primary'} />
            </div>
            {detection ? (
              <section className="mih-file-detection" aria-label="文件识别结果">
                <header>
                  <div><strong>平台与格式识别</strong><span>{preferredRuleKey ? '显式规则优先' : '自动识别结果'}</span></div>
                  <StatusBadge status={detection.ruleKey ? 'active' : 'warning'}
                    label={detection.ruleKey ? '已识别规则' : '待确认规则'} />
                </header>
                <dl>
                  <div><dt>平台</dt><dd>{detection.platform || '未识别'}</dd></div>
                  <div><dt>格式</dt><dd>{detection.inputFormat ? String(detection.inputFormat).toUpperCase() : '未识别'}</dd></div>
                  <div><dt>规则</dt><dd>{detection.displayName || detection.ruleKey || '未匹配'}</dd></div>
                  <div><dt>置信度</dt><dd>{confidenceLabel(detection.confidence)}</dd></div>
                  <div><dt>方法</dt><dd>{detection.method || (preferredRuleKey ? 'explicit' : 'structure')}</dd></div>
                </dl>
                {detection.reason ? <p>{detection.reason}</p> : null}
              </section>
            ) : null}
            {samples.length > 0 ? (
              <section className="mih-file-samples" aria-label="首中尾抽样">
                <header><strong>首 / 中 / 尾抽样</strong><span>抽样仅用于确认结构与映射，不会写入 canonical 数据。</span></header>
                <div>
                  {samples.map((sample, index) => {
                    const raw = sample.raw ?? sample.record ?? sample.value ?? sample
                    const mapped = sample.mapped ?? sample.output ?? null
                    const hasPayload = Object.prototype.hasOwnProperty.call(sample, 'raw')
                      || Object.prototype.hasOwnProperty.call(sample, 'record')
                      || Object.prototype.hasOwnProperty.call(sample, 'value')
                      || Boolean(mapped)
                      || Boolean(sample.rejected)
                    return (
                      <article key={`${sample.position || 'sample'}:${sample.rowIndex ?? sample.index ?? index}`}>
                        <span>{samplePositionLabel(sample.position)}{sample.rowIndex != null ? ` · 第 ${formatNumber(sample.rowIndex)} 行` : ''}</span>
                        {hasPayload ? <><strong>源记录</strong><pre className="mih-code-block">{JSON.stringify(raw, null, 2)}</pre></> : (
                          <small>该位置已参与确定性结构识别；当前响应只返回抽样位置与 value-free 证据。</small>
                        )}
                        {mapped ? <><strong>映射后</strong><pre className="mih-code-block">{JSON.stringify(mapped, null, 2)}</pre></> : null}
                        {sample.rejected ? <small className="mih-sample-rejected">拒绝：{sample.rejected}</small> : null}
                      </article>
                    )
                  })}
                </div>
              </section>
            ) : null}
            {preview.schemaFingerprint ? (
              <div className={`mih-format-rule-match${selectedPreviewRule ? ' is-matched' : ''}`}>
                <header>
                  <div>
                    <strong>{selectedPreviewRule ? '已匹配格式规则' : '发现新的文件结构'}</strong>
                    <span>{selectedPreviewRule
                      ? '相同结构的文件可以复用这条已批准规则'
                      : '尚无精确结构匹配；保存并批准后可供同结构文件复用'}</span>
                  </div>
                  <StatusBadge status={selectedPreviewRule ? 'active' : 'warning'}
                    label={selectedPreviewRule ? '精确匹配' : '待确认'} />
                </header>
                <dl>
                  <div><dt>结构指纹</dt><dd><code>{preview.schemaFingerprint}</code></dd></div>
                  <div><dt>格式规则</dt><dd>{selectedPreviewRule
                    ? <><strong>{selectedPreviewRule.displayName || selectedPreviewRule.ruleKey}</strong><small><code>{selectedPreviewRule.ruleKey}</code>{selectedPreviewRule.version ? ` · v${selectedPreviewRule.version}` : ''}</small></>
                    : '—'}</dd></div>
                </dl>
                {preview.fileStructure ? (
                  <details><summary>查看文件结构证据</summary><pre className="mih-code-block">{JSON.stringify(preview.fileStructure, null, 2)}</pre></details>
                ) : null}
              </div>
            ) : null}
            {preview.suggestion?.degradedReason ? (
              // Say when the suggestion came from the deterministic matcher
              // because the model was unavailable, rather than presenting it as
              // an agent result.
              <p className="mih-inline-warning">
                <Warning size={16} aria-hidden="true" /> Agent 不可用，以下为规则推断结果：{preview.suggestion.degradedReason}
              </p>
            ) : null}
            <p className="mih-preview-provenance">
              建议来源：{preview.suggestion?.origin === 'agent'
                ? `Agent · ${preview.suggestion.model || '已配置模型'}`
                : preview.suggestion?.origin === 'format_rule'
                  ? `格式规则 · ${selectedPreviewRule?.displayName || '精确结构匹配'}`
                  : 'Hub 本地规则推断'}
            </p>
            <pre className="mih-code-block">{JSON.stringify(preview.suggestion?.fieldMap || preview.inferredFieldMap, null, 2)}</pre>
            <div className="mih-page-actions">
              <button className="qp-button qp-button--ghost" type="button" disabled={busy}
                onClick={() => saveSuggestion()}>
                保存为新映射版本
              </button>
              <button className="qp-button qp-button--outline" type="button" disabled={busy}
                onClick={() => saveSuggestion({ approveImmediately: true })}>
                保存并批准映射
              </button>
              {isServerPathSource ? (
                <button className="qp-button" type="button" disabled={busy || !serverImportReady}
                  title={serverImportReady ? '' : '需先批准与当前文件结构一致的映射'}
                  onClick={runServerImport}>
                  {serverImportReady
                    ? '从服务器导入当前文件'
                    : activeMapping ? '需要批准当前结构' : '需要先批准映射'}
                </button>
              ) : (
                <button className="qp-button" type="button" disabled={busy || !activeMapping}
                  onClick={() => { intentRef.current = 'import'; fileRef.current?.click() }}>
                  {activeMapping ? '选择文件并导入' : '需要先批准映射'}
                </button>
              )}
            </div>
          </>
        ) : (
          <EmptyState icon={FileArrowUp} title={isServerPathSource ? '读取服务器文件' : '选择一个样例文件'}
            description={isServerPathSource
              ? '留空即读取已注册文件，也可粘贴白名单内其他精确路径；预览不会写入数据。'
              : '预览会显示列、行数、推断映射和前几行的映射结果，不会写入任何数据。'} />
        )}
      </Panel> : null}

      <RunHistory runs={runs} />
    </Modal>
  )
}

function DatabaseSourceControl({
  source, schema, sync, preview, checkpointResetError, busy, statusTransition, isDraining, editing, canActivate,
  readOnly = false, onEdit, onCancelEdit, onSave, onStatus, onSync, onTest, onPreview, onResetCheckpoint,
  databaseConnections,
}) {
  const [draft, setDraft] = useState(() => ({
    databaseConnectionId: source.databaseConnectionId || INLINE_DATABASE_CONNECTION,
    host: source.connection?.host || '',
    port: String(source.connection?.port || 5432),
    database: source.connection?.database || '',
    username: source.connection?.username || '',
    password: source.connection?.password || '',
    sslMode: source.connection?.sslMode || 'require',
    schema: source.connection?.schema || 'public',
    table: source.connection?.table || '',
    cursorColumn: source.connection?.cursorColumn || '',
    idColumn: source.connection?.idColumn || '',
    syncIntervalSeconds: String(source.syncIntervalSeconds || 60),
  }))
  const [resetConfirmation, setResetConfirmation] = useState('')

  const submit = (event) => {
    event.preventDefault()
    onSave({
      databaseConnectionId: draft.databaseConnectionId || null,
      syncIntervalSeconds: Number(draft.syncIntervalSeconds),
      connection: {
        ...(draft.databaseConnectionId ? {} : {
          host: draft.host.trim(), port: Number(draft.port), database: draft.database.trim(),
          username: draft.username.trim(), password: draft.password, sslMode: draft.sslMode,
        }),
        schema: draft.schema.trim() || 'public', table: draft.table.trim(),
        cursorColumn: draft.cursorColumn.trim() || null,
        idColumn: draft.idColumn.trim() || null,
      },
    })
  }

  const resetCheckpoint = async (event) => {
    event.preventDefault()
    if (resetConfirmation !== source.sourceKey) return
    if (await onResetCheckpoint(resetConfirmation)) setResetConfirmation('')
  }
  const sharedConnection = asList(databaseConnections?.data).find((connection) => connection.id === source.databaseConnectionId)

  return (
    <>
      <Panel title={readOnly ? '业务子任务诊断' : '数据库源控制'}
        subtitle={readOnly
          ? '连接、调度、状态和映射由 Telegram monitor 业务统一管理；此处只读检查源表和运行证据'
          : '暂停会等待当前批次在安全边界收口，不会中断已开始的源库查询或写入'}
        actions={
          <>
            {!readOnly && (source.status === 'active' ? (
              <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={() => onStatus('paused')}>
                <Pause size={16} /> {statusTransition === 'paused' ? '正在等待批次边界…' : '安全暂停'}
              </button>
            ) : (
              <button className="qp-button qp-button--ghost" type="button" disabled={busy || !canActivate}
                title={isDraining ? '正在等待当前批次收口' : canActivate ? '' : '需先解决探测问题并批准映射'}
                onClick={() => onStatus('active')}><Play size={16} /> {statusTransition === 'active' ? '正在启用…' : '启用'}</button>
            ))}
            {!readOnly ? <button className="qp-button qp-button--ghost" type="button"
              disabled={busy || source.status !== 'paused' || isDraining}
              title={isDraining ? '当前批次收口后才能修改连接配置' : source.status !== 'paused' ? '请先安全暂停后修改连接配置' : ''}
              onClick={onEdit}>编辑配置</button> : null}
            <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onTest}>测试连接</button>
            {!readOnly ? <button className="qp-button" type="button" disabled={busy || source.status !== 'active'} onClick={onSync}><ArrowClockwise size={16} /> 立即同步</button> : null}
          </>
        }>
        <dl className="mih-source-definition">
          <div><dt>连接配置</dt><dd>{source.databaseConnectionId
            ? <><strong>{sharedConnection?.displayName || '共享数据库配置'}</strong><small><code>{sharedConnection?.connectionKey || source.databaseConnectionId}</code></small></>
            : '任务内独立填写'}</dd></div>
          <div><dt>连接地址</dt><dd><code>{source.connection?.host || '—'}:{source.connection?.port || 5432}</code></dd></div>
          <div><dt>数据库 / 用户</dt><dd><code>{source.connection?.database || '—'} / {source.connection?.username || '—'}</code></dd></div>
          <div><dt>密码</dt><dd><code>{source.databaseConnectionId ? '由数据库配置管理' : source.connection?.password || '—'}</code><small>仅 Admin Token 管理面可见</small></dd></div>
          <div><dt>SSL</dt><dd><code>{source.connection?.sslMode || 'require'}</code></dd></div>
          <div><dt>源表</dt><dd><code>{source.connection?.schema || 'public'}.{source.connection?.table || '—'}</code></dd></div>
          <div><dt>游标</dt><dd><code>{source.connection?.cursorColumn || '未配置'} + {source.connection?.idColumn || '未配置'}</code></dd></div>
          <div><dt>调度</dt><dd>{formatNumber(source.syncIntervalSeconds || 60)} 秒</dd></div>
          <div><dt>状态</dt><dd><StatusBadge status={isDraining ? 'warning' : source.status} label={isDraining ? '暂停中 · 排空批次' : undefined} /></dd></div>
          <div><dt>最近变更</dt><dd>{formatDate(source.updatedAt)}</dd></div>
        </dl>
        {isDraining ? <p className="mih-inline-warning"><Warning size={16} aria-hidden="true" />暂停已生效于调度层；当前批次仍在安全收口。完成前不会允许改连接、批准映射或重置 Checkpoint。</p> : null}
        {readOnly ? <p className="mih-inline-warning"><Warning size={16} aria-hidden="true" />这是固定业务子任务。请返回 Telegram monitor 任务控制统一修改连接、周期和启停状态。</p> : null}
        <p className="mih-inline-warning"><Key size={16} aria-hidden="true" />连接信息随数据源管理，密码以明文回填；本页面和对应接口仅允许 Admin Token 会话访问。</p>
        {editing && !readOnly ? (
          <form className="mih-form mih-form--grid mih-source-settings" onSubmit={submit}>
            <DatabaseConnectionField value={draft.databaseConnectionId} state={databaseConnections}
              onChange={(databaseConnectionId) => setDraft({ ...draft, databaseConnectionId })} />
            {!draft.databaseConnectionId ? <>
              <Field label="主机"><input className="qp-input" required value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} /></Field>
              <Field label="端口"><input className="qp-input" type="number" min="1" max="65535" required value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} /></Field>
              <Field label="数据库"><input className="qp-input" required value={draft.database} onChange={(event) => setDraft({ ...draft, database: event.target.value })} /></Field>
              <Field label="用户名"><input className="qp-input" required autoComplete="off" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></Field>
              <Field label="密码" hint="明文保存并仅向 Admin Token 管理接口返回">
                <input className="qp-input" type="text" required autoComplete="off" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
              </Field>
              <DropdownField label="SSL 模式" value={draft.sslMode}
                onChange={(sslMode) => setDraft({ ...draft, sslMode })} options={SSL_MODE_OPTIONS} />
            </> : null}
            <Field label="Schema"><input className="qp-input" required value={draft.schema} onChange={(event) => setDraft({ ...draft, schema: event.target.value })} /></Field>
            <Field label="表名"><input className="qp-input" required value={draft.table} onChange={(event) => setDraft({ ...draft, table: event.target.value })} /></Field>
            <Field label="变更水位列"><input className="qp-input" value={draft.cursorColumn} onChange={(event) => setDraft({ ...draft, cursorColumn: event.target.value })} /></Field>
            <Field label="稳定 ID 列"><input className="qp-input" value={draft.idColumn} onChange={(event) => setDraft({ ...draft, idColumn: event.target.value })} /></Field>
            <Field label="同步间隔（秒）"><input className="qp-input" type="number" min="60" max="86400" required value={draft.syncIntervalSeconds} onChange={(event) => setDraft({ ...draft, syncIntervalSeconds: event.target.value })} /></Field>
            <div className="mih-page-actions mih-form__wide">
              <button className="qp-button qp-button--ghost" type="button" onClick={onCancelEdit}>取消</button>
              <button className="qp-button" type="submit" disabled={busy}>验证并保存</button>
            </div>
          </form>
        ) : null}
      </Panel>

      <Panel title="Schema 与安全探测" subtitle="只读取元数据；样例预览只返回类型、空值和序列化长度"
        actions={<><button className="qp-button qp-button--ghost" type="button" disabled={schema.loading} onClick={schema.refresh}>重新探测</button><button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onPreview}>查看 3 行 value-shape</button></>}>
        {schema.loading && !schema.data ? <LoadingState label="正在探测源表" /> : null}
        {schema.error ? <ErrorState error={schema.error} onRetry={schema.refresh} /> : null}
        {schema.data ? (
          <>
            <div className="mih-metric-grid mih-metric-grid--compact">
              <MetricCard icon={Table} label="估算行数" value={schema.data.estimatedRows == null ? '—' : formatNumber(schema.data.estimatedRows)} />
              <MetricCard icon={Database} label="总大小" value={formatBytes(schema.data.totalBytes)} />
              <MetricCard icon={Key} label="索引" value={formatNumber(schema.data.indexes?.length || 0)} />
              <MetricCard icon={Warning} label="阻断问题" value={formatNumber(schema.data.issues?.length || 0)} tone={schema.data.issues?.length ? 'warning' : 'success'} />
            </div>
            {schema.data.issues?.length ? <ul className="mih-source-issues">{schema.data.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p className="mih-inline-success">Schema、游标类型、复合索引与全序约束已通过探测。</p>}
            {schema.data.warnings?.length ? <ul className="mih-source-issues mih-source-issues--warning">{schema.data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
            <DataTable label="源表字段">
              <thead><tr><th>#</th><th>字段</th><th>PostgreSQL 类型</th><th>可空</th></tr></thead>
              <tbody>{(schema.data.columns || []).map((column) => <tr key={column.name}><td>{column.ordinal}</td><td><code>{column.name}</code></td><td>{column.dataType}<small>{column.databaseType}</small></td><td>{column.nullable ? '是' : '否'}</td></tr>)}</tbody>
            </DataTable>
            {preview?.sampleShapes ? (
              <div className="mih-source-shapes">
                <h3>Value-shape 样例</h3>
                <p>仅包含 JSON 类型、空值标记与序列化长度，不包含源数据内容。</p>
                <pre className="mih-code-block">{JSON.stringify(preview.sampleShapes, null, 2)}</pre>
              </div>
            ) : null}
          </>
        ) : null}
      </Panel>

      <Panel title="增量游标与队列" subtitle="游标只在规范化数据成功写入后推进；失败批次保留原位置以便幂等重试">
        {sync.loading && !sync.data ? <LoadingState label="正在读取同步状态" /> : null}
        {sync.error ? <ErrorState error={sync.error} onRetry={sync.refresh} /> : null}
        {sync.data ? <div className="mih-source-sync-grid">
          <div><span>游标状态</span><StatusBadge status={sync.data.cursor?.status || 'idle'} /></div>
          <div><span>累计处理</span><strong>{formatNumber(sync.data.cursor?.processedCount ?? sync.data.cursor?.processed_count ?? 0)}</strong></div>
          <div><span>最后错误</span><code>{sync.data.cursor?.lastError || sync.data.cursor?.last_error || '—'}</code></div>
          <div><span>最近运行</span><StatusBadge status={sync.data.latestRun?.status === 'succeeded' ? 'active' : sync.data.latestRun?.status === 'failed' ? 'down' : sync.data.latestRun?.status || 'idle'} label={sync.data.latestRun?.status || '尚未运行'} /></div>
          <div><span>游标更新时间</span><strong>{formatDate(sync.data.cursor?.updatedAt || sync.data.cursor?.updated_at)}</strong></div>
          <div><span>下次调度</span><strong>{formatDate(sync.data.nextDueAt)}</strong></div>
          <div className="mih-source-sync-grid__wide"><span>Checkpoint</span><pre className="mih-code-block">{JSON.stringify(sync.data.cursor?.position || {}, null, 2)}</pre></div>
          {Array.isArray(sync.data.queue) ? <div className="mih-source-sync-grid__wide"><span>同步队列</span><div className="mih-source-queue-stats">
            {sync.data.queue.length > 0
              ? sync.data.queue.map((entry) => <span className="qp-tag" key={`${entry.queue}:${entry.status}`}>{entry.status} <strong>{formatNumber(entry.count)}</strong></span>)
              : <small>当前没有排队或运行中的任务</small>}
          </div></div> : null}
        </div> : null}
        {!readOnly && source.status === 'paused' && !isDraining && !sync.loading && !sync.error ? (
          <section className="mih-source-danger" aria-labelledby="checkpoint-reset-title">
            <div className="mih-source-danger__copy">
              <Warning size={24} weight="duotone" aria-hidden="true" />
              <div>
                <h3 id="checkpoint-reset-title">重置增量 Checkpoint</h3>
                <p>下一次同步会从源表起点重新扫描。Canonical 写入仍会幂等去重，但大表重放会产生明显读取负载；现有规范化数据和历史任务不会被删除。</p>
              </div>
            </div>
            <form className="mih-source-danger__form" onSubmit={resetCheckpoint}>
              <Field label="输入完整 Source Key 以确认" hint={<><code>{source.sourceKey}</code>（区分大小写，必须完全一致）</>}>
                <input className="qp-input" value={resetConfirmation} autoComplete="off" spellCheck="false"
                  onChange={(event) => setResetConfirmation(event.target.value)} />
              </Field>
              <button className="qp-button qp-button--danger" type="submit"
                disabled={busy || resetConfirmation !== source.sourceKey}>
                {busy ? '处理中…' : '确认重置 Checkpoint'}
              </button>
            </form>
            {checkpointResetError ? <ErrorState error={checkpointResetError} /> : null}
          </section>
        ) : null}
      </Panel>
    </>
  )
}

/**
 * Merge the run history of a fixed pipeline's tasks into one timeline.
 *
 * The generic source modal has shown this table all along; the two fixed
 * pipelines only ever rendered `latestRun`, so the per-sync time and row counts
 * an operator remembers were simply not on this screen. Every task is read
 * from the same per-source endpoint and interleaved. That keeps paired tasks
 * comparable while also supporting a fixed pipeline with one input.
 */
function PipelineRunHistory({ token, tasks, onUnauthorized, labelOf, refreshRevision = 0 }) {
  const sourceKeys = tasks.map((task) => telegramTaskSourceKey(task)).filter(Boolean)
  const signature = sourceKeys.join(',')
  const load = useCallback(
    async () => {
      if (!signature) return { items: [], failures: [] }
      const keys = signature.split(',')
      const perTask = await Promise.allSettled(keys.map(async (key) => {
        const runs = await adminApi.importRuns(token, key)
        return asList(runs).map((run) => ({ ...run, sourceKey: key }))
      }))
      const unauthorized = perTask.find((result) => result.status === 'rejected' && result.reason?.status === 401)
      if (unauthorized) throw unauthorized.reason
      return {
        items: perTask.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
          .sort((left, right) => (
            String(right.startedAt || right.createdAt || '').localeCompare(String(left.startedAt || left.createdAt || ''))
          )),
        failures: perTask.flatMap((result, index) => result.status === 'rejected' ? [{
          sourceKey: keys[index],
          code: result.reason?.code || 'request_failed',
          message: result.reason?.message || '任务记录读取失败',
        }] : []),
      }
    },
    [refreshRevision, signature, token],
  )
  const runs = useRemoteData(load, onUnauthorized)
  const items = asList(runs.data?.items)
  const failures = asList(runs.data?.failures)

  const displayStatus = (run) => {
    if (run.status !== 'running') {
      return {
        status: run.status === 'succeeded' ? 'active' : run.status === 'failed' ? 'down' : run.status,
        label: run.status,
      }
    }
    const task = tasks.find((candidate) => telegramTaskSourceKey(candidate) === run.sourceKey)
    if (task?.latestRun?.id === run.id && telegramTaskStuck(task)) {
      return { status: 'down', label: '等待恢复' }
    }
    return { status: 'running', label: 'running' }
  }

  return (
    <Panel title="任务与清洗记录" subtitle="固定任务合并的运行时间线：每次运行的读取、入库、变更、删除、拒绝与失败原因"
      actions={<button className="qp-button qp-button--ghost" type="button" disabled={runs.loading} onClick={runs.refresh}>
        <ArrowClockwise size={16} />刷新记录
      </button>}>
      {runs.loading && !runs.data ? <LoadingState label="正在加载任务记录" /> : null}
      {runs.error ? <ErrorState error={runs.error} onRetry={runs.refresh} /> : null}
      {failures.length > 0 ? <ul className="mih-source-issues mih-source-issues--warning">
        {failures.map((failure) => <li key={failure.sourceKey}>
          <code>{failure.sourceKey}</code>：{failure.message}（{failure.code}）
        </li>)}
      </ul> : null}
      {items.length === 0 && failures.length === 0 && !runs.loading && !runs.error
        ? <EmptyState icon={Database} title="还没有任务记录" description="同步执行后，这里会出现每次运行的可审计证据。" />
        : null}
      {items.length > 0 ? <DataTable label="固定管线运行历史">
        <thead><tr><th>开始时间</th><th>任务</th><th>状态</th><th>读取</th><th>入库</th><th>变更</th><th>删除</th><th>拒绝</th><th>错误</th></tr></thead>
        <tbody>{items.map((run) => {
          const status = displayStatus(run)
          return <tr key={run.id}>
            <td>{formatDate(run.startedAt || run.createdAt)}<small>{formatDate(run.finishedAt) !== '—' ? `结束 ${formatDate(run.finishedAt)}` : status.label === '等待恢复' ? '等待恢复' : '运行中'}</small></td>
            <td>{labelOf(run.sourceKey)}<small><code>{run.sourceKey}</code></small></td>
            <td><StatusBadge status={status.status} label={status.label} /></td>
            <td>{formatNumber(run.rowCount || 0)}</td>
            <td>{formatNumber(run.ingestedCount || 0)}</td>
            <td>{formatNumber(run.changedCount || 0)}</td>
            <td>{formatNumber(run.deletedCount || 0)}</td>
            <td>{formatNumber(run.rejectedCount || 0)}</td>
            <td><code>{run.lastError || run.error || '—'}</code></td>
          </tr>
        })}</tbody>
      </DataTable> : null}
    </Panel>
  )
}

function RunHistory({ runs }) {
  const items = asList(runs.data)
  const latest = items[0]
  return (
    <Panel title="任务与清洗记录" subtitle="每次运行记录输入、游标区间、写入、变更、删除、拒绝和失败原因">
      {runs.loading && !runs.data ? <LoadingState label="正在加载任务记录" /> : null}
      {runs.error ? <ErrorState error={runs.error} onRetry={runs.refresh} /> : null}
      {latest ? <div className="mih-metric-grid mih-metric-grid--compact">
        <MetricCard icon={Table} label="本次读取" value={formatNumber(latest.rowCount || 0)} />
        <MetricCard icon={Database} label="规范化入库" value={formatNumber(latest.ingestedCount || 0)} />
        <MetricCard icon={ArrowClockwise} label="实际变更" value={formatNumber(latest.changedCount || 0)} />
        <MetricCard icon={Warning} label="拒绝 / 删除" value={`${formatNumber(latest.rejectedCount || 0)} / ${formatNumber(latest.deletedCount || 0)}`} tone={latest.rejectedCount ? 'warning' : 'primary'} />
      </div> : null}
      {items.length === 0 && !runs.loading && !runs.error ? <EmptyState icon={Database} title="还没有任务记录" description="文件导入或数据库同步后，这里会出现可审计的运行证据。" /> : null}
      {items.length > 0 ? <DataTable label="导入和同步任务历史">
        <thead><tr><th>开始时间</th><th>状态</th><th>映射</th><th>读取</th><th>入库</th><th>变更</th><th>删除</th><th>拒绝</th><th>错误</th></tr></thead>
        <tbody>{items.map((run) => <tr key={run.id}>
          <td>{formatDate(run.startedAt)}<small>{run.inputName || 'database pull'}</small></td>
          <td><StatusBadge status={run.status === 'succeeded' ? 'active' : run.status === 'failed' ? 'down' : run.status} label={run.status} /></td>
          <td>v{run.mappingVersion}</td><td>{formatNumber(run.rowCount || 0)}</td><td>{formatNumber(run.ingestedCount || 0)}</td>
          <td>{formatNumber(run.changedCount || 0)}</td><td>{formatNumber(run.deletedCount || 0)}</td><td>{formatNumber(run.rejectedCount || 0)}</td><td><code>{run.lastError || '—'}</code></td>
        </tr>)}</tbody>
      </DataTable> : null}
    </Panel>
  )
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = bytes
  let unit = -1
  do { amount /= 1024; unit += 1 } while (amount >= 1024 && unit < units.length - 1)
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function AgentPage({ token, session, onUnauthorized, notify, section = 'providers' }) {
  const load = useCallback(() => adminApi.agent(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [testingProvider, setTestingProvider] = useState(null)
  const [providerTests, setProviderTests] = useState({})
  const [pipelineBusy, setPipelineBusy] = useState(null)
  const [revealTarget, setRevealTarget] = useState(null)

  if (state.loading && !state.data) return <LoadingState label="正在读取模型链路" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const agent = state.data || {}
  const chatSetting = agentProviderSetting(agent, 'chat')
  const embeddingSetting = agentProviderSetting(agent, 'embedding')
  const chatProviders = mergeProviderStatus(chatSetting.providers, agent.chat)
  const embeddingProviders = mergeProviderStatus(embeddingSetting.providers, agent.embeddings)
  const pipelines = Array.isArray(agent.pipelines) ? agent.pipelines : []
  const canEdit = session?.kind === 'admin-token'
  const llmSequences = agent.control?.sequences || []
  const proxySequences = agent.control?.proxy?.sequences || []
  const proxyEndpoints = agent.control?.proxy?.endpoints || []

  const saveSetting = async (kind, body) => {
    try {
      const updated = await adminApi.updateAgentProviders(token, kind, body)
      state.setData({
        ...agent,
        settings: { ...agent.settings, [kind]: updated },
      })
      setProviderTests({})
      notify?.(
        updated.runtimeApplied === false
          ? `${kind === 'chat' ? '对话' : 'Embedding'} Provider 配置已保存，运行时正在重试应用`
          : `${kind === 'chat' ? '对话' : 'Embedding'} Provider 配置已保存并生效`,
        updated.runtimeApplied === false ? 'warning' : 'success',
      )
      state.refresh()
      return updated
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      throw error
    }
  }

  const testProvider = async (kind, providerId, key) => {
    setTestingProvider(key)
    try {
      const result = await adminApi.testAgentProvider(token, kind, providerId)
      setProviderTests((current) => ({ ...current, [key]: result }))
      notify?.(`${providerId} 连接成功（${result.latencyMs} ms）`, 'success')
      state.refresh()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setProviderTests((current) => ({ ...current, [key]: { ok: false, message: error.message } }))
      notify?.(`${providerId} 连接测试失败：${error.message}`, 'warning')
    } finally {
      setTestingProvider(null)
    }
  }

  const runPipelineAction = async (key, action, operation, message) => {
    setPipelineBusy(`${key}:${action}`)
    try {
      await operation()
      notify?.(message, 'success')
      await state.refresh()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      notify?.(error.message, 'warning')
      return null
    } finally {
      setPipelineBusy(null)
    }
  }

  return (
    <>
      <PageHeading
        eyebrow={section === 'providers' ? 'AGENT CENTER / LLM PROVIDERS' : 'AGENT CENTER / LEGACY RUNTIME'}
        title={section === 'providers' ? 'LLM Provider' : '原中心 Agent'}
        description={section === 'providers'
          ? 'Provider 是可复用模型账号目录，不设置 Provider 默认；实际服务顺序与系统默认仅由显式 LLM Sequence 决定。'
          : '保留原有分析管线、断言、限流与处理边界，便于后续逐项迁移和优化。'}
        loading={state.loading}
        onRefresh={state.refresh}
      />
      {section === 'providers' && !agent.available ? (
        <EmptyState icon={Brain} title="未配置模型 provider"
          description={canEdit
            ? '可在下方配置 Provider。未配置时映射建议回退到规则推断，Hub 与现有联网功能不中断。'
            : '未配置时映射建议回退到规则推断，Hub 与现有联网功能不中断。'} />
      ) : null}
      {section === 'providers' ? <AgentProviderPanel
        kind="chat"
        title="Chat Provider Catalog"
        subtitle="Catalog 顺序只用于目录管理；第一条记录不会成为系统默认"
        setting={chatSetting}
        providers={chatProviders}
        canEdit={canEdit}
        onSave={(body) => saveSetting('chat', body)}
        onTest={testProvider}
        testingProvider={testingProvider}
        providerTests={providerTests}
        onReveal={(provider) => setRevealTarget({ kind: 'chat', provider })}
        llmSequences={llmSequences}
        proxySequences={proxySequences}
        proxyEndpoints={proxyEndpoints}
        inheritedEmbeddingProviders={embeddingProviders}
        embeddingCapabilities={agent.embeddingCapabilities}
      /> : null}
      {section === 'providers' ? <AgentProviderPanel
        kind="embedding"
        title="Embedding Provider Catalog"
        subtitle={`当前运行维度 ${agent.embeddingDimensions ?? '未配置'}；同一 Sequence 内所有模型必须同模型、同维度；第一条记录不代表默认`}
        setting={embeddingSetting}
        providers={embeddingProviders}
        canEdit={canEdit}
        onSave={(body) => saveSetting('embedding', body)}
        onTest={testProvider}
        testingProvider={testingProvider}
        providerTests={providerTests}
        onReveal={(provider) => setRevealTarget({ kind: 'embedding', provider })}
        llmSequences={llmSequences}
        proxySequences={proxySequences}
        proxyEndpoints={proxyEndpoints}
        chatProviders={chatProviders}
        chatProviderSource={chatSetting.source}
        embeddingCapabilities={agent.embeddingCapabilities}
      /> : null}
      {section === 'runtime' ? pipelines.map((pipeline) => (
        <AgentPipelinePanel
          key={pipeline.pipelineKey}
          pipeline={pipeline}
          canEdit={canEdit}
          busy={pipelineBusy}
          onAction={runPipelineAction}
          token={token}
        />
      )) : null}
      {section === 'runtime' ? <Panel title="处理边界" subtitle="固定省份源已接入独立 Agent 派生面；同步、分类与严格 HanLP 索引各自可恢复">
        <div className="mih-agent-scope-grid">
          <div><strong>文件映射建议</strong><p>管理员显式选择后，只发送列名、类型族与无值结构统计；建议仍需人工批准。</p></div>
          <div><strong>全国省份舆情</strong><p>先规则提取，只有歧义项调用模型；事件省份、发布者省份与地理范围分别归档，Agent 只能提案。</p></div>
          <div><strong>严格 HanLP 索引</strong><p>canonical 写入后由 projector 严格调用 HanLP；服务异常时保持待投影并退避，不写降级分词索引。</p></div>
          <div><strong>向量检索</strong><p>{embeddingProviders.length > 0 ? 'Embedding worker 已配置；正文 chunk 会发送给所选 Embedding Provider。' : '未配置 Embedding provider；PG/全文检索不受影响。'}</p></div>
        </div>
      </Panel> : null}
      {revealTarget ? (
        <ProviderSecretRevealModal
          token={token}
          target={revealTarget}
          onClose={() => setRevealTarget(null)}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  )
}

function agentProviderSetting(agent, kind) {
  const configured = agent.settings?.[kind]
  const runtimeProviders = kind === 'chat' ? agent.chat : agent.embeddings
  return {
    source: configured?.source === 'database' ? 'database' : 'environment',
    revision: configured?.revision ?? null,
    providers: Array.isArray(configured?.providers)
      ? configured.providers
      : Array.isArray(runtimeProviders) ? runtimeProviders : [],
  }
}

function mergeProviderStatus(configured, runtime) {
  const liveById = new Map((Array.isArray(runtime) ? runtime : []).map((provider) => [provider.id, provider]))
  return configured.map((provider, index) => {
    const live = liveById.get(provider.id) || {}
    return {
      ...provider,
      priority: provider.priority ?? index + 1,
      keyConfigured: provider.keyConfigured ?? live.keyConfigured,
      circuit: live.circuit,
    }
  })
}

function AgentProviderPanel({
  kind, title, subtitle, setting, providers, canEdit, onSave,
  onTest, testingProvider, providerTests, onReveal, llmSequences = [], proxySequences = [], proxyEndpoints = [],
  chatProviders = [], chatProviderSource = 'environment', inheritedEmbeddingProviders = [],
  embeddingCapabilities = null,
}) {
  const sourceLabel = setting.source === 'database' ? '数据库' : '环境变量'
  const [editor, setEditor] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [migrationRevision, setMigrationRevision] = useState(null)
  const [migrationKeys, setMigrationKeys] = useState({})
  const [confirmEnvironment, setConfirmEnvironment] = useState(false)
  const [savingAction, setSavingAction] = useState(null)
  const [error, setError] = useState(null)
  const editorHeadingRef = useRef(null)

  useEffect(() => {
    if (editor) editorHeadingRef.current?.focus()
  }, [editor?.mode, editor?.originalId])

  const drafts = providers.map((provider, index) => providerDraft(provider, index, kind))

  const persist = async (nextDrafts, source = 'database', revision = setting.revision ?? 0) => {
    const normalized = source === 'database'
      ? normalizeProviderDrafts(nextDrafts, {
        kind,
        setting,
        initialProviders: drafts,
        chatProviders,
        chatProviderSource,
        embeddingCapabilities,
      })
      : []
    return onSave({
      source,
      expectedRevision: revision,
      providers: normalized,
    })
  }

  const startCreate = () => {
    const draft = blankProvider(providers.length, kind)
    if (kind === 'embedding' && providers[0]) {
      draft.model = String(providers[0].model || '')
      draft.dimensions = String(providers[0].dimensions || '')
    }
    setEditor({ mode: 'create', originalId: null, openingRevision: setting.revision ?? 0, draft })
    setMigrationOpen(false)
    setPendingDelete(null)
    setConfirmEnvironment(false)
    setError(null)
  }

  const startEdit = (provider, index) => {
    setEditor({
      mode: 'edit',
      originalId: provider.id,
      openingRevision: setting.revision ?? 0,
      draft: providerDraft(provider, index, kind),
    })
    setMigrationOpen(false)
    setPendingDelete(null)
    setConfirmEnvironment(false)
    setError(null)
  }

  const startMigration = () => {
    setMigrationOpen(true)
    setMigrationRevision(setting.revision ?? 0)
    setEditor(null)
    setPendingDelete(null)
    setConfirmEnvironment(false)
    setError(null)
  }

  const saveEditor = async (event) => {
    event.preventDefault()
    if (!editor) return
    const nextDrafts = editor.mode === 'create'
      ? [...drafts, editor.draft]
      : drafts.map((provider) => provider.id === editor.originalId ? editor.draft : provider)
    setSavingAction('editor')
    setError(null)
    try {
      await persist(nextDrafts, 'database', editor.openingRevision)
      setEditor(null)
    } catch (saveError) {
      setEditor((current) => current ? {
        ...current,
        draft: { ...current.draft, apiKey: '' },
      } : current)
      setError(saveError)
    } finally {
      setSavingAction(null)
    }
  }

  const deleteProvider = async (providerId) => {
    const references = llmSequences.filter((sequence) => (
      sequence.kind === kind && Array.isArray(sequence.providerIds) && sequence.providerIds.includes(providerId)
    ))
    const embeddingReferences = kind === 'chat' ? inheritedEmbeddingProviders.filter((provider) => (
      providerConnection(provider).mode === INHERIT_CHAT_CONNECTION
      && providerConnection(provider).providerId === providerId
    )) : []
    if (references.length > 0 || embeddingReferences.length > 0) {
      const reasons = [
        references.length > 0
          ? `Sequence ${references.map((sequence) => sequence.displayName || sequence.sequenceKey).join('、')}`
          : null,
        embeddingReferences.length > 0
          ? `Embedding Provider ${embeddingReferences.map((provider) => provider.displayName || provider.id).join('、')}`
          : null,
      ].filter(Boolean).join('；')
      setError(new Error(`请先解除 ${reasons} 对 ${providerId} 的引用。`))
      setPendingDelete(null)
      return
    }
    setSavingAction(`delete:${providerId}`)
    setError(null)
    try {
      await persist(drafts.filter((provider) => provider.id !== providerId))
      if (editor?.originalId === providerId) setEditor(null)
      setPendingDelete(null)
    } catch (saveError) {
      setError(saveError)
    } finally {
      setSavingAction(null)
    }
  }

  const migrateToDatabase = async (event) => {
    event.preventDefault()
    setSavingAction('migration')
    setError(null)
    try {
      await persist(drafts.map((provider) => ({
        ...provider,
        apiKey: provider.authMode === 'none' ? '' : String(migrationKeys[provider.id] || ''),
      })), 'database', migrationRevision ?? setting.revision ?? 0)
      setMigrationKeys({})
      setMigrationOpen(false)
      setMigrationRevision(null)
    } catch (saveError) {
      setMigrationKeys({})
      setError(saveError)
    } finally {
      setSavingAction(null)
    }
  }

  const switchToEnvironment = async () => {
    setSavingAction('environment')
    setError(null)
    try {
      await persist([], 'environment')
      setEditor(null)
      setConfirmEnvironment(false)
    } catch (saveError) {
      setError(saveError)
    } finally {
      setSavingAction(null)
    }
  }

  const databaseManaged = setting.source === 'database'
  const busy = Boolean(savingAction)
  const actions = canEdit ? (
    databaseManaged ? <>
      <button className="qp-button qp-button--ghost" type="button" disabled={busy}
        onClick={() => { setConfirmEnvironment(true); setEditor(null); setMigrationOpen(false); setError(null) }}>
        切回环境变量
      </button>
      <button className="qp-button qp-button--outline" type="button" disabled={busy || providers.length >= 32} onClick={startCreate}>
        <Plus size={16} aria-hidden="true" />新建 Provider
      </button>
    </> : (
      <button className="qp-button qp-button--outline" type="button" disabled={busy}
        onClick={providers.length > 0 ? startMigration : startCreate}>
        <Database size={16} aria-hidden="true" />{providers.length > 0 ? '迁移到数据库管理' : '新建 Provider'}
      </button>
    )
  ) : null

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      actions={actions}
    >
      <div className="mih-agent-chain-meta">
        <span>配置来源 <strong>{sourceLabel}</strong><code>{setting.source}</code></span>
        <span>Revision <code>{setting.revision ?? '—'}</code></span>
        {!canEdit ? <span>权限 <strong>只读</strong></span> : null}
      </div>
      <p className="mih-agent-provider-source-note">
        Provider 记录不会自动成为系统默认。实际服务和默认绑定仅由显式 LLM Sequence 决定；只使用一个 Provider 时，请创建只包含该 Provider 的单项 Sequence。
      </p>
      {!databaseManaged ? <p className="mih-agent-provider-source-note">
        当前 Provider 由部署环境只读注入；连接测试仍可使用。迁移到数据库后才能逐条新建、编辑、删除和绑定 Proxy。
      </p> : null}
      {confirmEnvironment ? <div className="mih-agent-provider-confirm" role="alert">
        <Warning size={18} aria-hidden="true" />
        <div>
          <strong>确认切回部署环境？</strong>
          <p>切换会清除数据库保存的本类 Provider 密钥，之后由环境变量接管；数据库中的在线配置将不再提供服务。</p>
        </div>
        <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={() => setConfirmEnvironment(false)}>取消</button>
        <button className="qp-button qp-button--danger" type="button" disabled={busy} onClick={switchToEnvironment}>
          {savingAction === 'environment' ? '正在切换' : '确认切回'}
        </button>
      </div> : null}
      {error ? <div className="mih-agent-provider-error"><ErrorState error={error} /></div> : null}
      <ProviderTable
        providers={providers}
        kind={kind}
        revision={setting.revision}
        canTest={canEdit}
        canManage={canEdit && databaseManaged}
        onTest={onTest}
        testingProvider={testingProvider}
        providerTests={providerTests}
        onReveal={onReveal}
        onEdit={startEdit}
        onDeleteRequest={(providerId) => { setPendingDelete(providerId); setEditor(null); setError(null) }}
        onDeleteCancel={() => setPendingDelete(null)}
        onDeleteConfirm={deleteProvider}
        pendingDelete={pendingDelete}
        savingAction={savingAction}
        source={setting.source}
        llmSequences={llmSequences}
        chatProviders={chatProviders}
        inheritedEmbeddingProviders={inheritedEmbeddingProviders}
        embeddingCapabilities={embeddingCapabilities}
      />
      {migrationOpen ? <ProviderMigrationEditor
        kind={kind}
        providers={providers}
        keys={migrationKeys}
        busy={busy}
        onChange={(providerId, apiKey) => setMigrationKeys((current) => ({ ...current, [providerId]: apiKey }))}
        onCancel={() => { setMigrationOpen(false); setMigrationRevision(null); setMigrationKeys({}); setError(null) }}
        onSubmit={migrateToDatabase}
      /> : null}
      {editor ? <ProviderEditor
        kind={kind}
        editor={editor}
        proxySequences={proxySequences}
        proxyEndpoints={proxyEndpoints}
        chatProviders={chatProviders}
        chatProviderSource={chatProviderSource}
        embeddingCapabilities={embeddingCapabilities}
        setting={setting}
        busy={savingAction === 'editor'}
        headingRef={editorHeadingRef}
        onChange={(patch) => setEditor((current) => ({
          ...current,
          draft: { ...current.draft, ...patch },
        }))}
        onCancel={() => { setEditor(null); setError(null) }}
        onSubmit={saveEditor}
      /> : null}
    </Panel>
  )
}

function formatAssertionValue(value) {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return '—' }
}

function AgentPipelinePanel({ pipeline, canEdit, busy, onAction, token }) {
  const [rate, setRate] = useState(String(pipeline.itemsPerMinute || 12))
  useEffect(() => setRate(String(pipeline.itemsPerMinute || 12)), [pipeline.itemsPerMinute])

  const key = pipeline.pipelineKey
  const tasks = pipeline.tasks || {}
  const assertions = pipeline.assertions || {}
  const recent = Array.isArray(pipeline.recentAssertions) ? pipeline.recentAssertions : []
  const pipelineBusy = typeof busy === 'string' && busy.startsWith(`${key}:`)

  const updateStatus = (status) => onAction(
    key,
    `status-${status}`,
    () => adminApi.updateAgentPipeline(token, key, {
      expectedRevision: pipeline.revision,
      status,
    }),
    status === 'active' ? 'Agent 分析管线已启用' : 'Agent 分析管线已暂停；现有任务和证据均已保留',
  )

  const saveRate = (event) => {
    event.preventDefault()
    const itemsPerMinute = Number(rate)
    if (!Number.isInteger(itemsPerMinute) || itemsPerMinute < 1 || itemsPerMinute > 60) return
    onAction(
      key,
      'rate',
      () => adminApi.updateAgentPipeline(token, key, {
        expectedRevision: pipeline.revision,
        itemsPerMinute,
      }),
      `Agent 分析速率已更新为每分钟 ${itemsPerMinute} 条`,
    )
  }

  return (
    <Panel
      title={pipeline.displayName || key}
      subtitle="规则先行、模型只处理歧义；事件省份、发布者省份和地理范围分别保存；派生断言不是人工待办"
      actions={<>
        <StatusBadge
          status={pipeline.status === 'active' ? 'active' : 'disabled'}
          label={pipeline.status === 'active' ? '分析中' : '已暂停'}
        />
        {canEdit ? pipeline.status === 'active' ? (
          <button className="qp-button qp-button--ghost" type="button" disabled={pipelineBusy} onClick={() => updateStatus('paused')}>
            <Pause size={16} aria-hidden="true" />暂停
          </button>
        ) : (
          <button className="qp-button qp-button--primary" type="button" disabled={pipelineBusy} onClick={() => updateStatus('active')}>
            <Play size={16} aria-hidden="true" />启用
          </button>
        ) : null}
      </>}
    >
      <div className="mih-agent-chain-meta">
        <span>Pipeline <code>{key}</code></span>
        <span>Revision <code>{pipeline.revision}</code></span>
        <span>分析版本 <code>{pipeline.analysisVersion}</code></span>
        <span>规则 / Taxonomy <code>{pipeline.ruleVersion}</code><code>{pipeline.taxonomyVersion}</code></span>
        <span>全局并发 <strong>{pipeline.maxInFlight || 1}</strong></span>
      </div>
      <div className="mih-metric-grid mih-agent-pipeline-metrics">
        <MetricCard icon={ArrowClockwise} label="待处理" value={formatNumber(tasks.pending || 0)} hint={tasks.oldestPendingAt ? `最早 ${formatDate(tasks.oldestPendingAt)}` : '当前无积压'} tone={tasks.pending ? 'warning' : 'success'} />
        <MetricCard icon={Play} label="处理中" value={formatNumber(tasks.running || 0)} hint="数据库租约与 owner fence" tone={tasks.running ? 'info' : 'primary'} />
        <MetricCard icon={Database} label="已完成" value={formatNumber(tasks.succeeded || 0)} hint={`总任务 ${formatNumber(tasks.total || 0)}`} tone="success" />
        <MetricCard icon={Brain} label="未采纳派生断言" value={formatNumber(assertions.proposed || 0)} hint={`source 事实断言 ${formatNumber(assertions.accepted || 0)}`} tone="primary" />
        <MetricCard icon={Warning} label="失败隔离" value={formatNumber(tasks.dead || 0)} hint={`已淘汰旧版本 ${formatNumber(tasks.superseded || 0)}`} tone={tasks.dead ? 'danger' : 'primary'} />
      </div>
      <p className="mih-preview-provenance">断言按字段计数，一条新闻会产生多条；<code>proposed</code> 是未写入 formal 省份流的规则/Agent 证据，当前没有逐条人工审批入口，不需要清空该数字。</p>
      {canEdit ? (
        <form className="mih-agent-pipeline-controls" onSubmit={saveRate}>
          <label>
            <span>全局处理速率（条/分钟）</span>
            <input className="qp-input" type="number" min="1" max="60" step="1" value={rate}
              onChange={(event) => setRate(event.target.value)} disabled={pipelineBusy} />
          </label>
          <button className="qp-button qp-button--outline" type="submit" disabled={pipelineBusy || Number(rate) === pipeline.itemsPerMinute}>保存限速</button>
          <button className="qp-button qp-button--ghost" type="button" disabled={pipelineBusy}
            onClick={() => onAction(key, 'materialize', () => adminApi.materializeAgentPipeline(token, key), '已核对当前记录并补齐缺失分析任务')}>
            <ArrowClockwise size={16} aria-hidden="true" />补齐当前积压
          </button>
          {tasks.dead > 0 ? (
            <button className="qp-button qp-button--ghost" type="button" disabled={pipelineBusy}
              onClick={() => onAction(key, 'retry-dead', () => adminApi.retryDeadAgentPipeline(token, key), '失败隔离任务已重新排队')}>
              <ArrowClockwise size={16} aria-hidden="true" />重试失败任务
            </button>
          ) : null}
          <small>默认每分钟 12 条、全局单并发；暂停不影响固定源同步、严格 HanLP 索引或 Hub 可用性。</small>
        </form>
      ) : null}
      <DataTable label={`${pipeline.displayName || key} 最近分类证据`}>
        <thead><tr><th>字段</th><th>建议值</th><th>方法</th><th>置信度</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>
          {recent.map((item) => <tr key={item.assertionId}>
            <td><code>{item.fieldKey}</code></td>
            <td><code>{formatAssertionValue(item.proposedValue)}</code></td>
            <td>{item.method}{item.providerId ? <small>{item.providerId} · {item.model}</small> : null}</td>
            <td>{Math.round(Number(item.confidence || 0) * 100)}%</td>
            <td><StatusBadge status={item.status === 'accepted' ? 'active' : item.status === 'proposed' ? 'pending' : item.status} label={item.status === 'accepted' ? 'source fact' : item.status === 'proposed' ? '派生证据' : item.status} /></td>
            <td>{formatDate(item.createdAt)}</td>
          </tr>)}
          {recent.length === 0 ? <tr><td colSpan="6" className="mih-agent-provider-empty">尚无分析证据；管线默认暂停，启用前可先测试对话 Provider。</td></tr> : null}
        </tbody>
      </DataTable>
    </Panel>
  )
}

function providerTestKey(kind, provider, revision) {
  return JSON.stringify([
    kind,
    provider.id,
    revision,
    provider.connection || { mode: DEDICATED_CONNECTION },
    provider.baseUrl,
    provider.model,
    provider.dimensions ?? null,
  ])
}

function ProviderTable({
  providers, kind, revision, canTest, canManage, onTest, testingProvider, providerTests,
  onReveal, onEdit, onDeleteRequest, onDeleteCancel, onDeleteConfirm,
  pendingDelete, savingAction, source, llmSequences = [], chatProviders = [],
  inheritedEmbeddingProviders = [], embeddingCapabilities = null,
}) {
  const showActions = canTest || canManage
  return (
    <DataTable label={`${kind === 'chat' ? '对话' : 'Embedding'} Provider Catalog`}>
      <thead><tr><th>Catalog 顺序</th><th>Provider</th><th>模型</th><th>连接来源</th><th>Endpoint</th><th>Proxy</th><th>状态</th><th>凭据</th><th>熔断</th>{showActions ? <th>操作</th> : null}</tr></thead>
      <tbody>
        {providers.map((provider, index) => {
          const connection = providerConnection(provider, kind)
          const inherited = kind === 'embedding' && connection.mode === INHERIT_CHAT_CONNECTION
          const chatSource = inherited
            ? chatProviders.find((candidate) => candidate.id === connection.providerId)
            : null
          const capability = kind === 'chat'
            ? embeddingConnectionCapability(provider, embeddingCapabilities)
            : embeddingModelCapability(provider, provider.model, embeddingCapabilities)
          const testKey = providerTestKey(kind, provider, revision)
          const test = providerTests?.[testKey]
          const testDisabled = provider.connectionReady === false
            || (provider.authMode !== 'none' && !provider.keyConfigured)
          const deleting = pendingDelete === provider.id
          const sequenceReferences = llmSequences.filter((sequence) => (
            sequence.kind === kind && Array.isArray(sequence.providerIds) && sequence.providerIds.includes(provider.id)
          ))
          const embeddingReferences = kind === 'chat' ? inheritedEmbeddingProviders.filter((embeddingProvider) => (
            providerConnection(embeddingProvider).mode === INHERIT_CHAT_CONNECTION
            && providerConnection(embeddingProvider).providerId === provider.id
          )) : []
          const deleteDisabled = sequenceReferences.length > 0 || embeddingReferences.length > 0
            || (kind === 'embedding' && providers.length <= 1)
          const deleteHint = sequenceReferences.length > 0
            ? `先从 Sequence ${sequenceReferences.map((sequence) => sequence.displayName || sequence.sequenceKey).join('、')} 中移除`
            : embeddingReferences.length > 0
              ? `先解除 Embedding Provider ${embeddingReferences.map((embeddingProvider) => embeddingProvider.displayName || embeddingProvider.id).join('、')} 的继承`
            : kind === 'embedding' && providers.length <= 1
              ? 'Embedding Catalog 必须保留至少一个 Provider；可改为停用'
              : ''
          return <tr key={provider.id}>
            <td><strong>序号 {index + 1}</strong><small>排序值 {provider.priority}</small></td>
            <td><strong>{provider.displayName || provider.id}</strong><small><code>{provider.id}</code></small>{capability ? <small title={capability.reason}>{kind === 'chat' ? 'Embedding 连接' : '能力'}：{embeddingCapabilityLabel(capability.status)}</small> : null}</td>
            <td><code>{provider.model}</code><small>{provider.protocol || 'openai-compatible'}{kind === 'embedding' ? ` · ${provider.dimensions || '—'} dimensions` : ''}</small></td>
            <td>{inherited ? <><strong>继承 Chat</strong><small>{chatSource?.displayName || connection.providerId} · <code>{connection.providerId}</code></small></> : <><strong>独立配置</strong><small>连接与凭据由本条维护</small></>}</td>
            <td><code>{provider.baseUrl || '—'}</code><small>{provider.timeoutMs ? `${provider.timeoutMs} ms` : 'timeout 未知'} · {provider.authMode || 'bearer'}</small></td>
            <td>{inherited ? <><strong>跟随 Chat Provider</strong><small><code>{provider.proxySequenceKey || chatSource?.proxySequenceKey || '继承 Hub 应用出网策略'}</code></small></> : <code>{provider.proxySequenceKey || '继承 Hub 应用出网策略'}</code>}</td>
            <td><StatusBadge
              status={provider.enabled === false || provider.connectionReady === false ? 'disabled' : 'active'}
              label={provider.enabled === false ? '停用' : provider.connectionReady === false ? '父连接不可用' : '启用'} /></td>
            <td>{provider.authMode === 'none' ? (
              <StatusBadge status="active" label="无需密钥" />
            ) : (
              <><StatusBadge status={provider.keyConfigured ? 'active' : 'suspended'} label={provider.keyConfigured ? '已配置' : '缺失'} />{inherited ? <small>来自 Chat · {chatSource?.displayName || connection.providerId}</small> : null}</>
            )}</td>
            <td>{provider.circuit ? (
              <StatusBadge
                status={provider.circuit === 'closed' ? 'active' : provider.circuit === 'open' ? 'suspended' : 'pending'}
                label={{ closed: '正常', degraded: '有失败', open: '已熔断' }[provider.circuit] || provider.circuit} />
            ) : '—'}</td>
            {showActions ? <td><div className="mih-agent-provider-actions">
              {canTest ? <>
                <button
                  className="qp-button qp-button--outline"
                  type="button"
                  disabled={testDisabled || Boolean(testingProvider) || Boolean(savingAction)}
                  onClick={() => onTest(kind, provider.id, testKey)}
                  aria-label={`测试 ${provider.displayName || provider.id} 连接`}
                >
                  <Plugs size={15} aria-hidden="true" />
                  {testingProvider === testKey ? '测试中' : '测试'}
                </button>
                {test ? <small role="status">{test.ok ? `${test.latencyMs} ms · 成功` : '最近失败'}</small> : null}
                {source === 'database' && !inherited && provider.authMode !== 'none' && provider.keyConfigured ? (
                  <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(testingProvider) || Boolean(savingAction)} onClick={() => onReveal?.(provider)}>
                    <Key size={15} aria-hidden="true" />查看 Key
                  </button>
                ) : inherited && provider.authMode !== 'none' ? <small>Key 由 Chat Provider 管理</small> : null}
              </> : null}
              {canManage ? deleting ? <div className="mih-agent-provider-delete-confirm" role="group" aria-label={`确认删除 ${provider.displayName || provider.id}`}>
                <button className="qp-button qp-button--danger" type="button"
                  disabled={Boolean(savingAction)} onClick={() => onDeleteConfirm(provider.id)}>
                  {savingAction === `delete:${provider.id}` ? '删除中' : '确认删除'}
                </button>
                <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(savingAction)} onClick={onDeleteCancel}>取消</button>
              </div> : <>
                {sequenceReferences.length > 0 ? <small className="mih-agent-provider-reference">
                  被 {sequenceReferences.map((sequence) => sequence.displayName || sequence.sequenceKey).join('、')} 引用；请先移出 Sequence
                </small> : null}
                {embeddingReferences.length > 0 ? <small className="mih-agent-provider-reference">
                  被 Embedding Provider {embeddingReferences.map((embeddingProvider) => embeddingProvider.displayName || embeddingProvider.id).join('、')} 继承；请先解除引用
                </small> : null}
                <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(savingAction)} onClick={() => onEdit(provider, index)}>
                  <PencilSimple size={15} aria-hidden="true" />编辑
                </button>
                <button className="qp-button qp-button--ghost mih-agent-provider-delete" type="button"
                  disabled={Boolean(savingAction) || deleteDisabled}
                  title={deleteHint}
                  onClick={() => onDeleteRequest(provider.id)}>
                  <Trash size={15} aria-hidden="true" />删除
                </button>
              </> : null}
            </div></td> : null}
          </tr>
        })}
        {providers.length === 0 ? <tr><td colSpan={showActions ? 10 : 9} className="mih-agent-provider-empty">尚未配置 Provider</td></tr> : null}
      </tbody>
    </DataTable>
  )
}

function providerDraft(provider, index, kind) {
  const connection = providerConnection(provider, kind)
  return {
    id: String(provider.id || ''),
    displayName: String(provider.displayName || provider.id || ''),
    baseUrl: String(provider.baseUrl || ''),
    model: String(provider.model || ''),
    protocol: provider.protocol || 'openai-compatible',
    proxySequenceKey: provider.proxySequenceKey || '',
    timeoutMs: String(provider.timeoutMs || 60_000),
    dimensions: kind === 'embedding' ? String(provider.dimensions || '') : '',
    enabled: provider.enabled !== false,
    priority: String(provider.priority ?? (index + 1) * 10),
    authMode: provider.authMode || 'bearer',
    keyConfigured: provider.authMode !== 'none' && provider.keyConfigured === true,
    originalId: String(provider.id || ''),
    originalBaseUrl: String(provider.baseUrl || ''),
    apiKey: '',
    clearKey: false,
    connectionMode: connection.mode,
    originalConnectionMode: connection.mode,
    inheritChatProviderId: connection.mode === INHERIT_CHAT_CONNECTION ? connection.providerId : '',
  }
}

function blankProvider(index, kind) {
  const draft = providerDraft({ priority: (index + 1) * 10, enabled: true, authMode: 'bearer' }, index, kind)
  if (kind === 'embedding') draft.connectionMode = ''
  return draft
}

function vectorSignatures(providers) {
  const activeProviders = providers.filter((provider) => provider.enabled !== false)
  const signatureProviders = activeProviders.length > 0 ? activeProviders : providers
  return [...new Set(signatureProviders
    .map((provider) => `${String(provider.model).trim()}::${String(provider.dimensions).trim()}`))]
    .sort()
}

function normalizeProviderDrafts(providers, {
  kind, setting, initialProviders, chatProviders = [], chatProviderSource = 'environment',
  embeddingCapabilities = null,
}) {
  if (providers.length > 32) throw new Error('每个 Catalog 最多可保存 32 个 Provider。')
  const ids = providers.map((provider) => provider.id.trim())
  if (ids.some((id) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))) {
    throw new Error('Provider ID 必须以小写字母或数字开头，且只能包含小写字母、数字、点、下划线和连字符。')
  }
  if (new Set(ids).size !== ids.length) throw new Error('Provider ID 不能重复。')

  if (kind === 'embedding' && initialProviders.length > 0) {
    if (providers.length === 0) {
      throw new Error('已有 Embedding Catalog 不能删除为空；如需暂停，请保留 Provider 并设为停用。')
    }
    if (JSON.stringify(vectorSignatures(initialProviders)) !== JSON.stringify(vectorSignatures(providers))) {
      throw new Error('Embedding 模型或 dimensions 不能直接修改；请先完成受控 reindex 流程。')
    }
  }

  const normalized = providers.map((provider) => {
    const id = provider.id.trim()
    const displayName = provider.displayName.trim() || id
    const baseUrl = provider.baseUrl.trim()
    const model = provider.model.trim()
    const timeoutMs = Number(provider.timeoutMs)
    const priority = Number(provider.priority)
    let dimensions = Number(provider.dimensions)
    const apiKey = provider.apiKey.trim()
    if (!displayName || displayName.length > 120) throw new Error(`${id} 的显示名称不能为空且不能超过 120 个字符。`)
    if (!model) throw new Error(`${id} 必须填写模型。`)
    if (!Number.isInteger(priority) || priority < 0 || priority > 10_000) {
      throw new Error(`${id} 的优先级必须是 0–10000 的整数。`)
    }
    if (kind === 'embedding' && (!Number.isInteger(dimensions) || dimensions < 1)) {
      throw new Error(`${id} 的 Embedding 维度必须是正整数。`)
    }
    const inherited = kind === 'embedding' && provider.connectionMode === INHERIT_CHAT_CONNECTION
    if (kind === 'embedding' && ![DEDICATED_CONNECTION, INHERIT_CHAT_CONNECTION].includes(provider.connectionMode)) {
      throw new Error(`${id} 必须明确选择独立配置或一个 Chat Provider；不会自动选择第一条。`)
    }
    if (inherited) {
      const parentId = String(provider.inheritChatProviderId || '').trim()
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(parentId)) {
        throw new Error(`${id} 必须选择一个可继承的 Chat Provider。`)
      }
      if (chatProviderSource !== 'database') {
        throw new Error(`${id} 不能继承环境变量管理的 Chat Provider；请先迁移 Chat Catalog 到数据库。`)
      }
      const parent = chatProviders.find((candidate) => candidate.id === parentId)
      if (!parent) throw new Error(`${id} 引用的 Chat Provider ${parentId} 不存在。`)
      const capability = embeddingModelCapability(parent, model, embeddingCapabilities)
      if (capability.status === 'unsupported') {
        throw new Error(`${id} 不能继承 ${parentId}：${capability.reason}`)
      }
      const catalogDimensions = Number(capability.defaultDimensions)
      if (Number.isInteger(catalogDimensions) && catalogDimensions > 0) dimensions = catalogDimensions
      return {
        id,
        displayName,
        model,
        dimensions,
        enabled: provider.enabled,
        priority,
        connection: { mode: INHERIT_CHAT_CONNECTION, providerId: parentId },
      }
    }
    if (kind === 'embedding') {
      const capability = embeddingModelCapability(provider, model, embeddingCapabilities)
      if (capability.status === 'unsupported') {
        throw new Error(`${id} 的连接不支持 Embedding：${capability.reason}`)
      }
      const catalogDimensions = Number(capability.defaultDimensions)
      if (Number.isInteger(catalogDimensions) && catalogDimensions > 0) dimensions = catalogDimensions
    }
    if (!baseUrl) throw new Error(`${id} 必须填写 Base URL。`)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new Error(`${id} 的超时必须是 1000–300000 ms 的整数。`)
    }
    const sameCredentialIdentity = provider.keyConfigured && provider.originalId === id
      && (kind !== 'embedding' || (
        provider.originalConnectionMode === DEDICATED_CONNECTION
        && provider.connectionMode === DEDICATED_CONNECTION
      ))
    if (setting.source === 'environment' && provider.enabled && provider.authMode === 'bearer' && !apiKey) {
      throw new Error(`迁移 ${id} 时必须重新输入 API Key；浏览器不会读取环境变量密钥。`)
    }
    if (setting.source === 'database' && provider.enabled && provider.authMode === 'bearer'
      && !sameCredentialIdentity && !apiKey && !provider.clearKey) {
      throw new Error(`${id} 是新的凭据身份，启用前必须填写 API Key。`)
    }
    if (setting.source === 'database' && sameCredentialIdentity && provider.authMode === 'bearer'
      && provider.baseUrl.trim() !== provider.originalBaseUrl && !apiKey && !provider.clearKey) {
      throw new Error(`${id} 修改 Base URL 后必须重新输入 API Key，或明确清除旧密钥。`)
    }
    return {
      id,
      displayName,
      baseUrl,
      model,
      protocol: kind === 'embedding' ? 'openai-compatible' : provider.protocol,
      proxySequenceKey: provider.proxySequenceKey || null,
      timeoutMs,
      ...(kind === 'embedding' ? { dimensions } : {}),
      enabled: provider.enabled,
      priority,
      authMode: provider.authMode,
      ...(kind === 'embedding' ? { connection: { mode: DEDICATED_CONNECTION } } : {}),
      ...(provider.authMode !== 'none' && provider.clearKey ? { clearApiKey: true } : {}),
      ...(provider.authMode !== 'none' && !provider.clearKey && apiKey ? { apiKey } : {}),
    }
  })
  normalized.sort((left, right) => left.priority - right.priority)
  return normalized
}

function ProviderEditor({
  kind, editor, proxySequences, proxyEndpoints, chatProviders = [], chatProviderSource = 'environment',
  embeddingCapabilities = null, setting, busy, headingRef, onChange, onCancel, onSubmit,
}) {
  const provider = editor.draft
  const isEmbedding = kind === 'embedding'
  const headingId = `agent-provider-editor-${kind}`
  const connectionValue = !isEmbedding
    ? DEDICATED_CONNECTION
    : provider.connectionMode === INHERIT_CHAT_CONNECTION
      ? `${INHERIT_CHAT_OPTION_PREFIX}${provider.inheritChatProviderId}`
      : provider.connectionMode === DEDICATED_CONNECTION ? DEDICATED_CONNECTION : ''
  const inheritedChat = provider.connectionMode === INHERIT_CHAT_CONNECTION
    ? chatProviders.find((candidate) => candidate.id === provider.inheritChatProviderId)
    : null
  const chatInheritanceAvailable = chatProviderSource === 'database'
  const effectiveConnectionProvider = inheritedChat || provider
  const effectiveEmbeddingCapability = isEmbedding && provider.connectionMode
    ? embeddingModelCapability(effectiveConnectionProvider, provider.model, embeddingCapabilities)
    : null
  const inheritedConnectionInvalid = isEmbedding && provider.connectionMode === INHERIT_CHAT_CONNECTION
    && (!chatInheritanceAvailable || !inheritedChat || effectiveEmbeddingCapability?.status === 'unsupported')
  const dedicatedConnectionInvalid = isEmbedding && provider.connectionMode === DEDICATED_CONNECTION
    && effectiveEmbeddingCapability?.status === 'unsupported'
  const sourceUnselected = isEmbedding && !provider.connectionMode
  const modelDefaultDimensions = isEmbedding
    ? embeddingDefaultDimensions(effectiveConnectionProvider, provider.model, embeddingCapabilities)
    : null
  const enabledProxyKeys = new Set(proxyEndpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => endpoint.proxyKey))
  const proxyOptions = [
    { value: '', label: '不设专属 · 继承 Hub 应用策略', description: '默认继续继承部署时观测到的 Docker daemon 代理；也可由 Hub 策略显式改为 Pod/Node 系统出网。' },
    ...proxySequences.map((sequence) => ({
      value: sequence.sequenceKey,
      label: sequence.displayName,
      description: Array.isArray(sequence.proxyKeys) && sequence.proxyKeys.some((proxyKey) => enabledProxyKeys.has(proxyKey))
        ? `${sequence.proxyKeys.filter((proxyKey) => enabledProxyKeys.has(proxyKey)).length} 个已启用 endpoint${sequence.directFallback ? ' + Pod/Node 系统出网 fallback' : ''}`
        : '没有已启用 endpoint，不能绑定',
      disabled: sequence.enabled === false || !Array.isArray(sequence.proxyKeys)
        || !sequence.proxyKeys.some((proxyKey) => enabledProxyKeys.has(proxyKey)),
    })),
  ]
  if (provider.proxySequenceKey && !proxyOptions.some((option) => option.value === provider.proxySequenceKey)) {
    proxyOptions.push({ value: provider.proxySequenceKey, label: `${provider.proxySequenceKey}（当前绑定）` })
  }
  const connectionOptions = isEmbedding ? [
    {
      value: DEDICATED_CONNECTION,
      label: '独立配置',
      description: '单独维护 Endpoint、凭据、超时和 Proxy。',
    },
    { group: true, value: 'chat-provider-group', label: '继承 Chat Provider' },
    ...chatProviders.map((chatProvider) => {
      const capability = embeddingConnectionCapability(chatProvider, embeddingCapabilities)
      return {
        value: `${INHERIT_CHAT_OPTION_PREFIX}${chatProvider.id}`,
        label: chatProvider.displayName || chatProvider.id,
        description: `${embeddingCapabilityLabel(capability.status)} · ${capability.reason}`,
        disabled: !chatInheritanceAvailable || capability.status === 'unsupported',
      }
    }),
  ] : []

  const changeConnection = (value) => {
    if (value === DEDICATED_CONNECTION) {
      onChange({
        connectionMode: DEDICATED_CONNECTION,
        inheritChatProviderId: '',
        keyConfigured: false,
        apiKey: '',
        clearKey: false,
      })
      return
    }
    if (!value.startsWith(INHERIT_CHAT_OPTION_PREFIX)) return
    const providerId = value.slice(INHERIT_CHAT_OPTION_PREFIX.length)
    const chatProvider = chatProviders.find((candidate) => candidate.id === providerId)
    const defaultDimensions = embeddingDefaultDimensions(chatProvider, provider.model, embeddingCapabilities)
    onChange({
      connectionMode: INHERIT_CHAT_CONNECTION,
      inheritChatProviderId: providerId,
      apiKey: '',
      clearKey: false,
      ...(defaultDimensions ? { dimensions: String(defaultDimensions) } : {}),
    })
  }

  const changeEmbeddingModel = (model) => {
    const defaultDimensions = embeddingDefaultDimensions(effectiveConnectionProvider, model, embeddingCapabilities)
    onChange({ model, ...(defaultDimensions ? { dimensions: String(defaultDimensions) } : {}) })
  }

  const effectiveAuthMode = inheritedChat?.authMode || provider.authMode
  const effectiveKeyConfigured = inheritedChat
    ? inheritedChat.authMode === 'none' || inheritedChat.keyConfigured === true
    : provider.keyConfigured
  return (
    <section className="mih-agent-provider-editor mih-agent-provider-editor--inline" aria-labelledby={headingId}>
      <header>
        <div>
          <h3 id={headingId} ref={headingRef} tabIndex="-1">
            {editor.mode === 'create' ? `新建${isEmbedding ? ' Embedding' : ' Chat'} Provider` : `编辑 ${provider.displayName || provider.id}`}
          </h3>
          {effectiveAuthMode === 'none' ? (
            <StatusBadge status="active" label="无需密钥" />
          ) : (
            <StatusBadge status={effectiveKeyConfigured ? 'active' : 'suspended'} label={effectiveKeyConfigured ? '密钥已配置' : '需要密钥'} />
          )}
        </div>
        <p>{setting.source === 'environment'
          ? '保存后会将此 Catalog 切换为数据库管理。'
          : '只编辑当前条目；保存时仍以 revision 保护整个 Catalog。'}</p>
      </header>
      <form id={`agent-provider-${kind}`} onSubmit={onSubmit}>
        <div className="mih-agent-provider-editor__grid">
          {isEmbedding ? <DropdownField
            label="连接与凭据来源"
            value={connectionValue}
            onChange={changeConnection}
            options={connectionOptions}
            required
            placeholder="请选择；不会自动选择第一条 Chat Provider"
            hint={chatInheritanceAvailable
              ? '继承时复用 Chat Provider 的 Endpoint、协议、凭据、超时和 Proxy；Embedding 只保存自己的模型与维度。'
              : 'Chat Catalog 仍由环境变量注入；请先在 Chat Provider 区迁移到数据库管理，才能创建继承关系。'}
            className="mih-agent-provider-editor__wide"
            disabled={busy}
          /> : null}
          {sourceUnselected ? <p className="mih-agent-provider-capability-warning mih-agent-provider-editor__wide" role="status">
            <Warning size={17} aria-hidden="true" />请明确选择独立配置或一个 Chat Provider；系统不会自动使用 Catalog 第一条。
          </p> : null}
          {isEmbedding && !chatInheritanceAvailable ? <p className="mih-agent-provider-capability-warning mih-agent-provider-editor__wide" role="status">
            <Warning size={17} aria-hidden="true" />继承选项暂不可用：Chat Provider 仍由环境变量管理。先迁移 Chat Catalog；独立 Embedding 配置不受影响。
          </p> : null}
          <Field label="Provider ID" hint={editor.mode === 'edit' ? '创建后不可修改；如需更名，请新建 Provider 并迁移 Sequence' : ''}>
            <input className="qp-input" required maxLength="64" pattern="[a-z0-9][a-z0-9._-]{0,63}"
              disabled={busy || editor.mode === 'edit'} value={provider.id} onChange={(event) => onChange({ id: event.target.value })} />
          </Field>
          <Field label="显示名称"><input className="qp-input" required maxLength="120" disabled={busy} value={provider.displayName} onChange={(event) => onChange({ displayName: event.target.value })} /></Field>
          <Field label={isEmbedding ? 'Embedding 模型' : '模型'}><input className="qp-input" required maxLength="200" disabled={busy} value={provider.model} onChange={(event) => isEmbedding ? changeEmbeddingModel(event.target.value) : onChange({ model: event.target.value })} /></Field>
          {!isEmbedding ? <DropdownField label="调用协议" value={provider.protocol}
            onChange={(protocol) => onChange({ protocol })} options={PROVIDER_PROTOCOL_OPTIONS} disabled={busy} /> : null}
          <Field label="Catalog 排序值" hint="仅决定目录顺序；保存时按数值从小到大排序，不设置系统默认"><input className="qp-input" type="number" min="0" max="10000" step="1" required disabled={busy} value={provider.priority} onChange={(event) => onChange({ priority: event.target.value })} /></Field>
          {isEmbedding ? <Field label="Dimensions" hint={modelDefaultDimensions
            ? `当前 Router 不发送 dimensions 参数；${provider.model} 使用默认返回维度 ${modelDefaultDimensions}。`
            : '未知或自建网关请填写预期返回维度，并以连接测试结果为准；改变向量空间前必须 reindex。'}>
            <input className="qp-input" type="number" min="1" step="1" required
              disabled={busy || Boolean(modelDefaultDimensions)} value={modelDefaultDimensions || provider.dimensions}
              onChange={(event) => onChange({ dimensions: event.target.value })} />
          </Field> : null}
          {isEmbedding && provider.connectionMode === INHERIT_CHAT_CONNECTION ? (
            <section className={`mih-agent-provider-inheritance mih-agent-provider-editor__wide${inheritedConnectionInvalid ? ' is-invalid' : ''}`}
              role={inheritedConnectionInvalid ? 'alert' : 'status'} aria-live="polite">
              {inheritedChat ? <>
                <header><strong>继承 {inheritedChat.displayName || inheritedChat.id}</strong><StatusBadge
                  status={effectiveEmbeddingCapability.status === 'supported' ? 'active' : effectiveEmbeddingCapability.status === 'unsupported' ? 'suspended' : 'pending'}
                  label={embeddingCapabilityLabel(effectiveEmbeddingCapability.status)} /></header>
                <p>{!chatInheritanceAvailable
                  ? 'Chat Catalog 仍由环境变量管理；请先迁移到数据库管理。'
                  : effectiveEmbeddingCapability.reason}</p>
                <dl>
                  <div><dt>Endpoint</dt><dd><code>{inheritedChat.baseUrl || '未报告'}</code></dd></div>
                  <div><dt>协议</dt><dd>{inheritedChat.protocol || 'openai-compatible'}</dd></div>
                  <div><dt>凭据</dt><dd>{effectiveAuthMode === 'none' ? '无需认证' : effectiveKeyConfigured ? 'Chat Provider 已配置' : 'Chat Provider 缺少 Key'}</dd></div>
                  <div><dt>超时</dt><dd>{inheritedChat.timeoutMs ? `${inheritedChat.timeoutMs} ms` : '未报告'}</dd></div>
                  <div><dt>Proxy</dt><dd><code>{inheritedChat.proxySequenceKey || '继承 Hub 应用出网策略'}</code></dd></div>
                </dl>
              </> : <><strong>继承来源已不存在</strong><p>请重新选择 Chat Provider；当前配置不能保存。</p></>}
            </section>
          ) : null}
          {isEmbedding && provider.connectionMode === DEDICATED_CONNECTION && effectiveEmbeddingCapability ? (
            <section className={`mih-agent-provider-inheritance mih-agent-provider-editor__wide${dedicatedConnectionInvalid ? ' is-invalid' : ''}`}
              role={dedicatedConnectionInvalid ? 'alert' : 'status'} aria-live="polite">
              <header><strong>Embedding 能力目录</strong><StatusBadge
                status={effectiveEmbeddingCapability.status === 'supported' ? 'active' : effectiveEmbeddingCapability.status === 'unsupported' ? 'suspended' : 'pending'}
                label={embeddingCapabilityLabel(effectiveEmbeddingCapability.status)} /></header>
              <p>{effectiveEmbeddingCapability.reason}{embeddingCapabilities?.revision ? ` · Catalog revision ${embeddingCapabilities.revision}` : ''}</p>
            </section>
          ) : null}
          {isEmbedding && effectiveEmbeddingCapability?.status === 'probe-required' ? <p className="mih-agent-provider-capability-warning mih-agent-provider-editor__wide" role="status">
            <Warning size={17} aria-hidden="true" />{effectiveEmbeddingCapability.reason} 可以保存，但加入业务 Sequence 前必须执行 Embedding 连接测试。
          </p> : null}
          {(!isEmbedding || provider.connectionMode === DEDICATED_CONNECTION) ? <>
            <Field label="Base URL" className="mih-agent-provider-editor__wide" hint="修改后必须重新输入密钥或明确清除旧密钥">
              <input className="qp-input" type="url" required disabled={busy} value={provider.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => {
                const baseUrl = event.target.value
                const defaultDimensions = isEmbedding
                  ? embeddingDefaultDimensions({ ...provider, baseUrl }, provider.model, embeddingCapabilities)
                  : null
                onChange({ baseUrl, ...(defaultDimensions ? { dimensions: String(defaultDimensions) } : {}) })
              }} />
            </Field>
            <Field label="超时（ms）"><input className="qp-input" type="number" min="1000" max="300000" step="1" required disabled={busy} value={provider.timeoutMs} onChange={(event) => onChange({ timeoutMs: event.target.value })} /></Field>
            <DropdownField label="认证方式" value={provider.authMode}
              onChange={(authMode) => onChange({ authMode, ...(authMode === 'none' ? { apiKey: '', clearKey: false } : {}) })}
              options={PROVIDER_AUTH_OPTIONS} disabled={busy} />
            <DropdownField label="Provider Proxy" hint="兼容绑定；未指定时继承 Hub 应用出网策略。该策略默认继承部署时观测到的 Docker daemon 代理，也可显式选择 Pod/Node 系统出网。" value={provider.proxySequenceKey}
              onChange={(proxySequenceKey) => onChange({ proxySequenceKey })} options={proxyOptions} disabled={busy} />
            <Field label="API Key" className="mih-agent-provider-editor__wide"
              hint={setting.source === 'environment' && provider.authMode === 'bearer'
                ? '迁移时必须重新输入；环境变量密钥不会进入浏览器'
                : '始终不回显；留空保留当前密钥'}>
              <input className="qp-input" type="password" autoComplete="new-password" maxLength="8192"
                value={provider.apiKey} disabled={busy || provider.clearKey || provider.authMode === 'none'}
                onChange={(event) => onChange({ apiKey: event.target.value })} />
            </Field>
          </> : null}
        </div>
        <footer>
          <div className="mih-agent-provider-options">
            <label><input type="checkbox" checked={provider.enabled} disabled={busy} onChange={(event) => onChange({ enabled: event.target.checked })} />启用 Provider</label>
            {(!isEmbedding || provider.connectionMode === DEDICATED_CONNECTION) && provider.authMode !== 'none' && provider.keyConfigured ? <label className="mih-agent-provider-clear">
              <input type="checkbox" checked={provider.clearKey} disabled={busy}
                onChange={(event) => onChange({ clearKey: event.target.checked, apiKey: '' })} />明确清除已保存密钥
            </label> : null}
          </div>
          <div className="mih-page-actions">
            <button className="qp-button qp-button--ghost" type="button" onClick={onCancel} disabled={busy}>取消</button>
            <button className="qp-button qp-button--primary" type="submit" disabled={busy || sourceUnselected || inheritedConnectionInvalid || dedicatedConnectionInvalid}>
              {busy ? '正在保存' : editor.mode === 'create' ? '创建 Provider' : '保存修改'}
            </button>
          </div>
        </footer>
      </form>
    </section>
  )
}

function ProviderMigrationEditor({ kind, providers, keys, busy, onChange, onCancel, onSubmit }) {
  const headingId = `agent-provider-migration-${kind}`
  return (
    <section className="mih-agent-provider-migration" aria-labelledby={headingId}>
      <header>
        <div>
          <h3 id={headingId}>迁移到数据库管理</h3>
          <p>Provider 元数据来自当前环境；这里只收集启用的 Bearer Provider 密钥，然后一次性切换，避免半迁移状态。</p>
        </div>
      </header>
      <form onSubmit={onSubmit}>
        <DataTable label={`${kind === 'chat' ? '对话' : 'Embedding'} Provider 迁移密钥`}>
          <thead><tr><th>Provider</th><th>Endpoint / 模型</th><th>迁移凭据</th></tr></thead>
          <tbody>{providers.map((provider) => {
            const needsKey = provider.enabled !== false && provider.authMode !== 'none'
            return <tr key={provider.id}>
              <td><strong>{provider.displayName || provider.id}</strong><small><code>{provider.id}</code></small></td>
              <td><code>{provider.baseUrl}</code><small>{provider.model}</small></td>
              <td>{provider.authMode === 'none' ? <StatusBadge status="active" label="无需密钥" /> : (
                <label className="mih-agent-provider-migration__key">
                  <span>{needsKey ? 'API Key（必填）' : 'API Key（启用前填写）'}</span>
                  <input className="qp-input" type="password" autoComplete="new-password" maxLength="8192"
                    required={needsKey} disabled={busy} value={keys[provider.id] || ''}
                    onChange={(event) => onChange(provider.id, event.target.value)} />
                </label>
              )}</td>
            </tr>
          })}</tbody>
        </DataTable>
        <div className="mih-agent-provider-migration__actions">
          <p><Key size={16} aria-hidden="true" />保存后密钥不会再次在列表或普通接口中返回。</p>
          <div className="mih-page-actions">
            <button className="qp-button qp-button--ghost" type="button" onClick={onCancel} disabled={busy}>取消</button>
            <button className="qp-button qp-button--primary" type="submit" disabled={busy}>
              {busy ? '正在迁移' : '迁移并切换到数据库'}
            </button>
          </div>
        </div>
      </form>
    </section>
  )
}

function ProviderSecretRevealModal({ token, target, onClose, onUnauthorized }) {
  const [adminToken, setAdminToken] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const reveal = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setApiKey('')
    try {
      const result = await adminApi.revealAgentProviderKey(
        token,
        target.kind,
        target.provider.id,
        adminToken,
      )
      setApiKey(result.apiKey)
      setAdminToken('')
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`查看 ${target.provider.displayName || target.provider.id} Key`}
      description="这是唯一会返回明文 Key 的内部接口；需要重新输入 Hub Admin Token，响应禁止缓存。"
      onClose={onClose}
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭并清除</button>}>
      {!apiKey ? <form className="mih-agent-secret-reveal" onSubmit={reveal}>
        <Field label="重新输入 Admin Token" hint="Launcher Token 不能查看模型密钥。">
          <input className="qp-input" type="password" autoComplete="off" value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)} autoFocus required />
        </Field>
        {error ? <ErrorState error={error} /> : null}
        <button className="qp-button qp-button--primary" type="submit" disabled={busy || !adminToken}>
          <Key size={16} />{busy ? '正在验证' : '验证并显示'}
        </button>
      </form> : <div className="mih-agent-secret-reveal">
        <Field label="API Key" hint="关闭窗口后即从组件状态中清除；请不要截图或粘贴到日志。">
          <input className="qp-input mih-mono" type="text" readOnly value={apiKey} autoComplete="off" />
        </Field>
        <button className="qp-button qp-button--outline" type="button"
          onClick={() => navigator.clipboard?.writeText(apiKey)}><Key size={16} />复制到剪贴板</button>
      </div>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export function RetrievalPage({ token, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.retrieval(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)

  const search = async (event) => {
    event.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    try {
      setResults(await adminApi.semanticSearch(token, { query: query.trim(), size: 10 }))
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setSearching(false)
    }
  }

  const status = state.data || {}

  return (
    <>
      <PageHeading
        eyebrow="CHUNKING / EMBEDDING / HYBRID SEARCH"
        title="检索管线"
        description="切分 → 向量化 → 投影，三段独立重启。向量存在 PostgreSQL 里，所以重建索引不需要再付一次模型费用。"
        loading={state.loading}
        onRefresh={state.refresh}
      />

      <div className="mih-metric-grid mih-metric-grid--compact">
        <MetricCard label="待切分记录" value={formatNumber(status.records_pending_chunks ?? 0)} />
        <MetricCard label="待向量化" value={formatNumber(status.chunks_pending_embedding ?? 0)} />
        <MetricCard label="待写入索引" value={formatNumber(status.chunks_pending_projection ?? 0)} />
        <MetricCard label="投影隔离" value={formatNumber(status.chunks_projection_failed ?? 0)} />
        <MetricCard label="切片总数" value={formatNumber(status.chunks_total ?? 0)} />
      </div>

      {(status.chunks_projection_failed ?? 0) > 0 ? (
        <p className="mih-inline-warning">
          <Warning size={16} aria-hidden="true" />
          {formatNumber(status.chunks_projection_failed)} 个切片因永久分词或索引错误已隔离；修正源内容使 revision 更新后会重新进入严格 HanLP 投影。
        </p>
      ) : null}

      {status.mixedEmbeddingModels ? (
        // Vectors from different models are not comparable; recall degrades
        // silently, so this is surfaced rather than left in a log line.
        <p className="mih-inline-warning">
          <Warning size={16} aria-hidden="true" />
          语料中存在多个 embedding 模型的向量。不同模型的向量空间不可比，召回会静默下降——需要用统一模型重建。
        </p>
      ) : null}

      <Panel title="混合检索" subtitle="BM25 与 kNN 各自取候选，再用 RRF 按排名融合（不混合原始分数）">
        <form onSubmit={search} className="mih-inline-form">
          <input className="qp-input" placeholder="输入检索词" value={query}
            onChange={(event) => setQuery(event.target.value)} />
          <button className="qp-button" type="submit" disabled={searching}>
            <MagnifyingGlass size={16} aria-hidden="true" /> {searching ? '检索中…' : '检索'}
          </button>
        </form>

        {results?.degraded ? (
          <p className="mih-inline-warning">
            <Warning size={16} aria-hidden="true" /> {results.degraded}
          </p>
        ) : null}

        {results ? (
          results.items.length === 0 ? (
            <EmptyState icon={MagnifyingGlass} title="没有匹配结果" />
          ) : (
            <ol className="mih-result-list">
              {results.items.map((item) => (
                <li key={`${item.recordId}:${item.chunkIndex}`}>
                  <div className="mih-result-list__meta">
                    <code>{item.platform}</code>
                    <span>RRF {item.rrfScore}</span>
                    <span>{item.retrievers?.join(' + ')}</span>
                    <span>{formatDate(item.eventTime)}</span>
                  </div>
                  <strong>{item.title || '(无标题)'}</strong>
                  <p>{item.content}</p>
                  {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a> : null}
                </li>
              ))}
            </ol>
          )
        ) : null}
      </Panel>
    </>
  )
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export function BackfillPage({ token, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.backfill(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [busy, setBusy] = useState(false)

  if (state.loading && !state.data) return <LoadingState label="正在读取回填状态" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const platforms = state.data?.platforms || {}

  const start = async (platform) => {
    setBusy(true)
    try {
      const result = await adminApi.startBackfill(token, { platform })
      notify?.(result.alreadyScheduled ? `${platform} 的回填已在队列中` : `${platform} 回填已排入队列`, 'success')
      state.refresh()
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="NIGHT-ALL BACKFILL"
        title="历史数据回填"
        description="从 Night-All 已采集的存量内容增量拉取。去重由唯一约束保证，重跑一次已完成的回填没有副作用。"
        loading={state.loading}
        onRefresh={state.refresh}
      />
      <Panel title="平台游标" subtitle="游标在页面写入成功之后才保存；崩溃会重放那一页而不是跳过它">
        <DataTable>
          <thead><tr><th>平台</th><th>状态</th><th>已处理</th><th>更新时间</th><th>最近错误</th><th /></tr></thead>
          <tbody>
            {Object.entries(platforms).map(([platform, cursor]) => (
              <tr key={platform}>
                <td><code>{platform}</code></td>
                <td><StatusBadge status={cursor?.status || 'idle'} /></td>
                <td>{formatNumber(Number(cursor?.processed_count ?? 0))}</td>
                <td>{cursor?.updated_at ? formatDate(cursor.updated_at) : '—'}</td>
                <td>{cursor?.last_error ? <span className="mih-inline-warning">{cursor.last_error}</span> : '—'}</td>
                <td>
                  <button className="qp-button qp-button--ghost" type="button" disabled={busy}
                    onClick={() => start(platform)}>开始 / 继续</button>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Panel>
    </>
  )
}
