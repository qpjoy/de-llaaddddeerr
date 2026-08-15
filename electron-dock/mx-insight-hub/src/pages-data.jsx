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
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [telegramOpen, setTelegramOpen] = useState(false)
  const [telegramSqliteOpen, setTelegramSqliteOpen] = useState(false)

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
        eyebrow="EXTERNAL SOURCES / MAPPING / IMPORT"
        title="外部数据源"
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

      {genericSources.length === 0 ? (
        <EmptyState
          icon={Database}
          title="还没有注册通用数据源"
          description="Telegram monitor 与 SQLite API 已作为固定业务任务单独管理；这里可继续注册文件或其他只读 PostgreSQL 数据源。"
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
        />
      ) : null}
      {telegramSqliteOpen && telegramSqlitePipeline.data ? (
        <TelegramSqlitePipelineModal
          token={token}
          pipeline={telegramSqlitePipeline.data}
          loading={telegramSqlitePipeline.loading}
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
      {selected ? (
        <SourceDetailModal
          token={token}
          source={selected}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setSelected(null)}
          onSourceChanged={(source) => { setSelected(source); state.refresh() }}
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

function telegramTaskSourceKey(task) {
  if (typeof task?.source === 'string') return task.source
  return task?.source?.sourceKey || task?.sourceKey || ''
}

function telegramPipelineIsRunning(pipeline) {
  return pipeline?.status === 'draining' || (pipeline?.tasks || []).some((task) => (
    ['running', 'draining'].includes(String(task?.cursor?.status || task?.latestRun?.status || '').toLowerCase())
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

function TelegramSqlitePipelineModal({
  token, pipeline, loading, onUnauthorized, notify, onClose, onRefresh, onPipelineChanged,
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
  const [resetConfirmation, setResetConfirmation] = useState('')
  const warnings = sqlitePipelineIssueMessages(pipeline.warnings, pipeline.strategy?.warnings)
  const progressTasks = Array.isArray(progress.data) ? progress.data : progress.data?.tasks || []
  const connectionEditable = !running && !['active', 'draining'].includes(pipeline.status)

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
          <button className="qp-button" type="button" disabled={Boolean(busyAction) || pipeline.status !== 'active'} onClick={runSync}>
            <ArrowClockwise size={16} />{busyAction === 'sync' ? '正在提交…' : '立即同步'}
          </button>
        </div>
      </div>

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
  const cursorStatus = task.cursor?.status || latest?.status || task.source?.status || 'idle'
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
}) {
  const initialConnection = pipeline.connection || pipeline.tasks?.[0]?.source?.connection || {}
  const configured = telegramPipelineConfigured(pipeline)
  const connectionConsistent = telegramConnectionConsistent(pipeline)
  const scheduleConsistent = telegramScheduleConsistent(pipeline)
  const [form, setForm] = useState(() => ({
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
        connection: {
          host: form.host.trim(),
          port: Number(form.port),
          database: form.database.trim(),
          username: form.username.trim(),
          password: form.password,
          sslMode: form.sslMode,
        },
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
          <button className="qp-button" type="button" disabled={Boolean(busyAction) || pipeline.status !== 'active'} onClick={runSync}>
            <ArrowClockwise size={16} />{busyAction === 'sync' ? '正在提交…' : '立即同步'}
          </button>
        </div>
      </div>

      <Panel title="源库与调度" subtitle="只填写一次连接；Hub 会验证只读权限，并把同一连接应用到两个固定输入表">
        <p className="mih-inline-warning"><Key size={16} aria-hidden="true" />连接与明文密码仅 Admin Token 管理面可读取和修改，不需要额外 Provider Key。</p>
        <form className="mih-form mih-form--grid mih-telegram-config" onSubmit={save}>
          <Field label="主机"><input className="qp-input" required value={form.host} placeholder="127.0.0.1" onChange={(event) => setForm({ ...form, host: event.target.value })} /></Field>
          <Field label="端口"><input className="qp-input" type="number" min="1" max="65535" required value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></Field>
          <Field label="数据库"><input className="qp-input" required value={form.database} placeholder="night_all" onChange={(event) => setForm({ ...form, database: event.target.value })} /></Field>
          <Field label="用户名"><input className="qp-input" required autoComplete="off" value={form.username} placeholder="mx_data" onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field>
          <Field label="密码" hint="明文保存，仅 Admin Token 接口返回"><input className="qp-input" type="text" required autoComplete="off" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
          <Field label="SSL 模式">
            <select className="qp-input" value={form.sslMode} onChange={(event) => setForm({ ...form, sslMode: event.target.value })}>
              <option value="disable">disable（同机或受控内网）</option><option value="require">require</option>
              <option value="verify-ca">verify-ca</option><option value="verify-full">verify-full</option>
            </select>
          </Field>
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
          <TelegramPreparationTable key={table.role || table.table} table={table} contract={data.contract} />
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

function TelegramPreparationTable({ table, contract }) {
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
  const checks = [
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

function CreateSourceModal({ token, onUnauthorized, notify, onClose, onCreated }) {
  const [form, setForm] = useState({
    sourceKey: '', displayName: '', sourceKind: 'file', datasetId: '', platform: 'external', objectType: 'record',
    fileMode: 'upload', serverPath: '', preferredRuleKey: '',
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
          host: form.host.trim(), port: Number(form.port), database: form.database.trim(),
          username: form.username.trim(), password: form.password, sslMode: form.sslMode,
          schema: form.schema.trim() || 'public', table: form.table.trim(),
          ...(form.cursorColumn.trim() ? { cursorColumn: form.cursorColumn.trim() } : {}),
          ...(form.idColumn.trim() ? { idColumn: form.idColumn.trim() } : {}),
        }
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
            <Field label="SSL 模式">
              <select className="qp-input" value={form.sslMode}
                onChange={(event) => setForm({ ...form, sslMode: event.target.value })}>
                <option value="disable">disable（同机或受控内网）</option>
                <option value="require">require</option>
                <option value="verify-ca">verify-ca</option>
                <option value="verify-full">verify-full</option>
              </select>
            </Field>
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

function SourceDetailModal({ token, source, onUnauthorized, notify, onClose, onSourceChanged }) {
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
}) {
  const [draft, setDraft] = useState(() => ({
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
      syncIntervalSeconds: Number(draft.syncIntervalSeconds),
      connection: {
        host: draft.host.trim(), port: Number(draft.port), database: draft.database.trim(),
        username: draft.username.trim(), password: draft.password, sslMode: draft.sslMode,
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
          <div><dt>连接地址</dt><dd><code>{source.connection?.host || '—'}:{source.connection?.port || 5432}</code></dd></div>
          <div><dt>数据库 / 用户</dt><dd><code>{source.connection?.database || '—'} / {source.connection?.username || '—'}</code></dd></div>
          <div><dt>密码</dt><dd><code>{source.connection?.password || '—'}</code><small>仅 Admin Token 管理面可见</small></dd></div>
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
            <Field label="主机"><input className="qp-input" required value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} /></Field>
            <Field label="端口"><input className="qp-input" type="number" min="1" max="65535" required value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} /></Field>
            <Field label="数据库"><input className="qp-input" required value={draft.database} onChange={(event) => setDraft({ ...draft, database: event.target.value })} /></Field>
            <Field label="用户名"><input className="qp-input" required autoComplete="off" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></Field>
            <Field label="密码" hint="明文保存并仅向 Admin Token 管理接口返回">
              <input className="qp-input" type="text" required autoComplete="off" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
            </Field>
            <Field label="SSL 模式">
              <select className="qp-input" value={draft.sslMode} onChange={(event) => setDraft({ ...draft, sslMode: event.target.value })}>
                <option value="disable">disable（同机或受控内网）</option>
                <option value="require">require</option>
                <option value="verify-ca">verify-ca</option>
                <option value="verify-full">verify-full</option>
              </select>
            </Field>
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

export function AgentPage({ token, session, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.agent(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [editingKind, setEditingKind] = useState(null)

  if (state.loading && !state.data) return <LoadingState label="正在读取模型链路" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const agent = state.data || {}
  const chatSetting = agentProviderSetting(agent, 'chat')
  const embeddingSetting = agentProviderSetting(agent, 'embedding')
  const chatProviders = mergeProviderStatus(chatSetting.providers, agent.chat)
  const embeddingProviders = mergeProviderStatus(embeddingSetting.providers, agent.embeddings)
  const canEdit = session?.kind === 'admin-token'

  const saveSetting = async (kind, body) => {
    try {
      const updated = await adminApi.updateAgentProviders(token, kind, body)
      state.setData({
        ...agent,
        settings: { ...agent.settings, [kind]: updated },
      })
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

  return (
    <>
      <PageHeading
        eyebrow="MODEL PROVIDERS / FAILOVER"
        title="中心 Agent"
        description="数组顺序即降级顺序。熔断打开表示该 provider 连续失败后被暂时跳过——没有它，一个挂掉的首选会让每个请求都先付满超时。"
        loading={state.loading}
        onRefresh={state.refresh}
      />
      {!agent.available ? (
        <EmptyState icon={Brain} title="未配置模型 provider"
          description={canEdit
            ? '可在下方配置 Provider。未配置时映射建议回退到规则推断，Hub 与现有联网功能不中断。'
            : '未配置时映射建议回退到规则推断，Hub 与现有联网功能不中断。'} />
      ) : null}
      <AgentProviderPanel
        kind="chat"
        title="对话模型链路"
        subtitle="按优先级降级；400/422 不降级，因为换个 provider 会一样失败"
        setting={chatSetting}
        providers={chatProviders}
        canEdit={canEdit}
        onEdit={() => setEditingKind('chat')}
      />
      <AgentProviderPanel
        kind="embedding"
        title="Embedding 链路"
        subtitle={`当前运行维度 ${agent.embeddingDimensions ?? '未配置'}；链路内所有模型必须同维度`}
        setting={embeddingSetting}
        providers={embeddingProviders}
        canEdit={canEdit}
        onEdit={() => setEditingKind('embedding')}
      />
      <Panel title="当前接线边界" subtitle="模型已配置不等于所有数据源都在执行智能清洗">
        <div className="mih-agent-scope-grid">
          <div><strong>文件映射建议</strong><p>已接线，但只在管理员预览时显式勾选；仅发送列名，建议仍需人工批准。</p></div>
          <div><strong>数据库 / Telegram 清洗</strong><p>使用确定性、版本化 mapping。逐行分类能力尚未接入，不会静默把源数据发送给模型。</p></div>
          <div><strong>向量检索</strong><p>{embeddingProviders.length > 0 ? 'Embedding worker 已配置，可生成独立 chunk 索引。' : '未配置 Embedding provider；PG/全文检索不受影响。'}</p></div>
          <div><strong>建议的下一步</strong><p>只把 schema drift 或拒绝行副本送入隔离队列，并记录模型、prompt、数据范围、费用和人工结论。</p></div>
        </div>
      </Panel>
      {editingKind ? (
        <ProviderSettingsModal
          kind={editingKind}
          setting={editingKind === 'chat' ? chatSetting : embeddingSetting}
          onClose={() => setEditingKind(null)}
          onSave={(body) => saveSetting(editingKind, body)}
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

function AgentProviderPanel({ kind, title, subtitle, setting, providers, canEdit, onEdit }) {
  const sourceLabel = setting.source === 'database' ? '数据库' : '环境变量'
  return (
    <Panel
      title={title}
      subtitle={subtitle}
      actions={canEdit ? (
        <button className="qp-button qp-button--outline" type="button" onClick={onEdit}>
          <PencilSimple size={16} aria-hidden="true" />编辑配置
        </button>
      ) : null}
    >
      <div className="mih-agent-chain-meta">
        <span>配置来源 <strong>{sourceLabel}</strong><code>{setting.source}</code></span>
        <span>Revision <code>{setting.revision ?? '—'}</code></span>
        {!canEdit ? <span>权限 <strong>只读</strong></span> : null}
      </div>
      <ProviderTable providers={providers} kind={kind} />
    </Panel>
  )
}

function ProviderTable({ providers, kind }) {
  return (
    <DataTable label={`${kind === 'chat' ? '对话' : 'Embedding'} Provider 链`}>
      <thead><tr><th>优先级</th><th>Provider</th><th>模型</th><th>Endpoint</th><th>状态</th><th>凭据</th><th>熔断</th></tr></thead>
      <tbody>
        {providers.map((provider, index) => (
          <tr key={provider.id}>
            <td><strong>{index === 0 ? '首选' : `降级 ${index}`}</strong><small>priority {provider.priority}</small></td>
            <td><code>{provider.id}</code></td>
            <td><code>{provider.model}</code>{kind === 'embedding' ? <small>{provider.dimensions || '—'} dimensions</small> : null}</td>
            <td><code>{provider.baseUrl || '—'}</code><small>{provider.timeoutMs ? `${provider.timeoutMs} ms` : 'timeout 未知'} · {provider.authMode || 'bearer'}</small></td>
            <td><StatusBadge status={provider.enabled === false ? 'disabled' : 'active'} label={provider.enabled === false ? '停用' : '启用'} /></td>
            <td>{provider.authMode === 'none' ? (
              <StatusBadge status="active" label="无需密钥" />
            ) : (
              <StatusBadge status={provider.keyConfigured ? 'active' : 'suspended'} label={provider.keyConfigured ? '已配置' : '缺失'} />
            )}</td>
            <td>{provider.circuit ? (
              <StatusBadge
                status={provider.circuit === 'closed' ? 'active' : provider.circuit === 'open' ? 'suspended' : 'pending'}
                label={{ closed: '正常', degraded: '有失败', open: '已熔断' }[provider.circuit] || provider.circuit} />
            ) : '—'}</td>
          </tr>
        ))}
        {providers.length === 0 ? <tr><td colSpan="7" className="mih-agent-provider-empty">尚未配置 Provider</td></tr> : null}
      </tbody>
    </DataTable>
  )
}

function providerDraft(provider, index, kind) {
  return {
    id: String(provider.id || ''),
    baseUrl: String(provider.baseUrl || ''),
    model: String(provider.model || ''),
    timeoutMs: String(provider.timeoutMs || 60_000),
    dimensions: kind === 'embedding' ? String(provider.dimensions || '') : '',
    enabled: provider.enabled !== false,
    priority: String(provider.priority ?? (index + 1) * 10),
    authMode: provider.authMode || 'bearer',
    keyConfigured: provider.keyConfigured === true,
    originalBaseUrl: String(provider.baseUrl || ''),
    apiKey: '',
    clearKey: false,
  }
}

function blankProvider(index, kind) {
  return providerDraft({ priority: (index + 1) * 10, enabled: true, authMode: 'bearer' }, index, kind)
}

function vectorSignatures(providers) {
  const activeProviders = providers.filter((provider) => provider.enabled !== false)
  const signatureProviders = activeProviders.length > 0 ? activeProviders : providers
  return [...new Set(signatureProviders
    .map((provider) => `${String(provider.model).trim()}::${String(provider.dimensions).trim()}`))]
    .sort()
}

function ProviderSettingsModal({ kind, setting, onClose, onSave }) {
  const initialProviders = useMemo(
    () => setting.providers.map((provider, index) => providerDraft(provider, index, kind)),
    [kind, setting],
  )
  const [providers, setProviders] = useState(initialProviders)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [targetSource, setTargetSource] = useState(setting.source === 'environment' ? 'database' : setting.source)
  const isEmbedding = kind === 'embedding'
  const initialVectorSignatures = isEmbedding ? vectorSignatures(initialProviders) : []
  const nextVectorSignatures = isEmbedding ? vectorSignatures(providers) : []
  const removedExistingEmbeddingChain = isEmbedding && initialProviders.length > 0 && providers.length === 0
  const embeddingChanged = isEmbedding
    && initialProviders.length > 0
    && (removedExistingEmbeddingChain
      || JSON.stringify(initialVectorSignatures) !== JSON.stringify(nextVectorSignatures))
  const databaseTarget = targetSource === 'database'
  const blockedEmbeddingChange = databaseTarget && embeddingChanged

  const patchProvider = (index, patch) => {
    setProviders((current) => current.map((provider, providerIndex) => (
      providerIndex === index ? { ...provider, ...patch } : provider
    )))
    setError(null)
  }

  const addProvider = () => {
    setProviders((current) => [...current, blankProvider(current.length, kind)])
    setError(null)
  }

  const removeProvider = (index) => {
    setProviders((current) => current.filter((_, providerIndex) => providerIndex !== index))
    setError(null)
  }

  const changeTargetSource = (source) => {
    setTargetSource(source)
    if (source === 'environment') {
      setProviders((current) => current.map((provider) => ({ ...provider, apiKey: '', clearKey: false })))
    }
    setError(null)
  }

  const submit = async (event) => {
    event.preventDefault()
    setError(null)
    const normalized = []
    if (databaseTarget) {
      const ids = providers.map((provider) => provider.id.trim())
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        setError(new Error('Provider ID 必须填写且不能重复。'))
        return
      }
      if (setting.source === 'environment' && providers.some((provider) => (
        provider.authMode === 'bearer' && !provider.apiKey.trim()
      ))) {
        setError(new Error('首次从环境变量迁移到数据库时，每个 Bearer Provider 都必须重新输入密钥。'))
        return
      }
      const unsafeBaseUrlChange = providers.find((provider) => (
        setting.source === 'database'
        && provider.authMode === 'bearer'
        && provider.keyConfigured
        && provider.baseUrl.trim() !== provider.originalBaseUrl
        && !provider.apiKey.trim()
        && !provider.clearKey
      ))
      if (unsafeBaseUrlChange) {
        setError(new Error(`${unsafeBaseUrlChange.id.trim() || 'Provider'} 修改 Base URL 后必须重新输入密钥，或明确清除旧密钥。`))
        return
      }
      if (embeddingChanged) {
        setError(new Error(removedExistingEmbeddingChain
          ? '已有 Embedding 链不能删除为空；如需暂停，请保留原 Provider 条目并全部停用。'
          : 'Embedding 模型或 dimensions 不能在此处直接修改；请先完成受控 reindex 流程。'))
        return
      }
      for (const provider of providers) {
        const timeoutMs = Number(provider.timeoutMs)
        const priority = Number(provider.priority)
        const dimensions = Number(provider.dimensions)
        if (!provider.baseUrl.trim() || !provider.model.trim()) {
          setError(new Error(`${provider.id.trim()} 必须填写 Base URL 和模型。`))
          return
        }
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
          setError(new Error(`${provider.id.trim()} 的超时必须是 1000–300000 ms 的整数。`))
          return
        }
        if (!Number.isInteger(priority) || priority < 0 || priority > 10_000) {
          setError(new Error(`${provider.id.trim()} 的优先级必须是 0–10000 的整数。`))
          return
        }
        if (isEmbedding && (!Number.isInteger(dimensions) || dimensions < 1)) {
          setError(new Error(`${provider.id.trim()} 的 Embedding 维度必须是正整数。`))
          return
        }
        normalized.push({
          id: provider.id.trim(),
          baseUrl: provider.baseUrl.trim(),
          model: provider.model.trim(),
          timeoutMs,
          ...(isEmbedding ? { dimensions } : {}),
          enabled: provider.enabled,
          priority,
          authMode: provider.authMode,
          ...(provider.clearKey ? { clearApiKey: true } : {}),
          ...(!provider.clearKey && provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {}),
        })
      }
      normalized.sort((left, right) => left.priority - right.priority)
    }

    setSaving(true)
    try {
      await onSave({ source: targetSource, expectedRevision: setting.revision ?? null, providers: normalized })
      setProviders((current) => current.map((provider) => ({ ...provider, apiKey: '', clearKey: false })))
      onClose()
    } catch (saveError) {
      setProviders((current) => current.map((provider) => ({ ...provider, apiKey: '' })))
      setError(saveError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`编辑${kind === 'chat' ? '对话' : ' Embedding'} Provider`}
      description={`当前来源：${setting.source} · Revision ${setting.revision ?? '—'}。保存使用 expectedRevision 防止覆盖并发修改。`}
      size="xlarge"
      onClose={onClose}
      footer={<>
        <button className="qp-button qp-button--ghost" type="button" onClick={onClose} disabled={saving}>取消</button>
        <button className="qp-button qp-button--primary" type="submit" form={`agent-provider-${kind}`} disabled={saving || blockedEmbeddingChange}>
          {saving ? '正在保存' : targetSource === 'environment' ? '切回环境变量' : '保存 Provider 链'}
        </button>
      </>}
    >
      <form id={`agent-provider-${kind}`} className="mih-agent-provider-form" onSubmit={submit}>
        <Field
          label="目标配置来源"
          className="mih-agent-source-choice"
          hint="数据库配置可在线更新；环境变量由部署注入。"
        >
          <select className="qp-input" value={targetSource} onChange={(event) => changeTargetSource(event.target.value)} disabled={saving}>
            <option value="database">数据库（可在线更新）</option>
            <option value="environment">环境变量（由部署管理）</option>
          </select>
        </Field>
        {targetSource === 'environment' ? (
          <div className="mih-inline-warning">
            <Warning size={17} aria-hidden="true" />
            切回后将读取部署环境中的 Provider 配置；本操作不会修改环境变量。环境配置有变化时仍需重新部署服务。
          </div>
        ) : null}
        {databaseTarget && setting.source === 'environment' ? (
          <div className="mih-inline-warning">
            <Key size={17} aria-hidden="true" />
            环境变量中的密钥不会自动复制到数据库。首次保存时，每个 Bearer Provider 都必须重新输入密钥。
          </div>
        ) : null}
        {databaseTarget && isEmbedding ? (
          <div className="mih-inline-warning">
            <Warning size={17} aria-hidden="true" />
            Embedding 模型与 dimensions 决定向量空间。修改前必须安排完整 reindex，不能直接复用已有向量。
          </div>
        ) : null}
        {blockedEmbeddingChange ? (
          <div className="mih-inline-warning">
            <Warning size={17} aria-hidden="true" />
            {removedExistingEmbeddingChain
              ? '已有 Embedding 链不能删除为空。保存已禁用；如需暂停向量生成，请保留原 Provider 条目并全部设为停用。'
              : '检测到既有 Embedding 模型或 dimensions 签名变化，保存已禁用。请通过受控 reindex 流程完成变更。'}
          </div>
        ) : null}
        {error ? <ErrorState error={error} /> : null}
        {databaseTarget ? <div className="mih-agent-provider-list">
          {providers.map((provider, index) => (
            <article className="mih-agent-provider-editor" key={index}>
              <header>
                <div>
                  <span>{index === 0 ? '首选 Provider' : `降级 Provider ${index}`}</span>
                  {provider.authMode === 'none' ? (
                    <StatusBadge status="active" label="无需密钥" />
                  ) : (
                    <StatusBadge status={provider.keyConfigured ? 'active' : 'suspended'} label={provider.keyConfigured ? '密钥已配置' : '密钥缺失'} />
                  )}
                </div>
                <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`删除 Provider ${index + 1}`} onClick={() => removeProvider(index)} disabled={saving}>
                  <Trash size={17} aria-hidden="true" />
                </button>
              </header>
              <div className="mih-agent-provider-editor__grid">
                <Field label="Provider ID"><input className="qp-input" required maxLength="64" pattern="[a-z0-9][a-z0-9._-]{0,63}" value={provider.id} onChange={(event) => patchProvider(index, { id: event.target.value })} /></Field>
                <Field label="模型"><input className="qp-input" required maxLength="200" value={provider.model} onChange={(event) => patchProvider(index, { model: event.target.value })} /></Field>
                <Field label="Base URL" className="mih-agent-provider-editor__wide" hint="修改后必须重新输入密钥或明确清除旧密钥"><input className="qp-input" type="url" required value={provider.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => patchProvider(index, { baseUrl: event.target.value })} /></Field>
                <Field label="超时（ms）"><input className="qp-input" type="number" min="1000" max="300000" step="1" required value={provider.timeoutMs} onChange={(event) => patchProvider(index, { timeoutMs: event.target.value })} /></Field>
                <Field label="优先级" hint="保存时按数值从小到大排序"><input className="qp-input" type="number" min="0" max="10000" step="1" required value={provider.priority} onChange={(event) => patchProvider(index, { priority: event.target.value })} /></Field>
                {isEmbedding ? <Field label="Dimensions" hint="改变后必须 reindex"><input className="qp-input" type="number" min="1" step="1" required value={provider.dimensions} onChange={(event) => patchProvider(index, { dimensions: event.target.value })} /></Field> : null}
                <Field label="认证方式"><select className="qp-input" value={provider.authMode} onChange={(event) => patchProvider(index, { authMode: event.target.value })}><option value="bearer">Bearer Token</option><option value="none">无需认证</option></select></Field>
                <Field
                  label="API Key"
                  className="mih-agent-provider-editor__wide"
                  hint={setting.source === 'environment' && provider.authMode === 'bearer'
                    ? '必须重新输入；环境变量密钥不会自动迁移'
                    : '始终不回显；留空保留现有密钥'}
                >
                  <input
                    className="qp-input"
                    type="password"
                    autoComplete="new-password"
                    maxLength="8192"
                    value={provider.apiKey}
                    disabled={provider.clearKey || provider.authMode === 'none'}
                    onChange={(event) => patchProvider(index, { apiKey: event.target.value })}
                  />
                </Field>
              </div>
              <footer>
                <label><input type="checkbox" checked={provider.enabled} onChange={(event) => patchProvider(index, { enabled: event.target.checked })} />启用 Provider</label>
                <label className="mih-agent-provider-clear"><input type="checkbox" checked={provider.clearKey} onChange={(event) => patchProvider(index, { clearKey: event.target.checked, apiKey: '' })} />明确清除已保存密钥</label>
              </footer>
            </article>
          ))}
          {providers.length === 0 ? <p className="mih-agent-provider-empty">此链为空；保存后对应能力将保持确定性降级。</p> : null}
        </div> : null}
        {databaseTarget ? (
          <button className="qp-button qp-button--outline" type="button" onClick={addProvider} disabled={saving}>
            <Plus size={16} aria-hidden="true" />添加 Provider
          </button>
        ) : null}
      </form>
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
        <MetricCard label="切片总数" value={formatNumber(status.chunks_total ?? 0)} />
      </div>

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
