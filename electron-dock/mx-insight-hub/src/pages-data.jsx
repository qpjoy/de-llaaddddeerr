import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  Brain,
  Database,
  FileArrowUp,
  Key,
  MagnifyingGlass,
  Pause,
  Play,
  Plugs,
  Table,
  Warning,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
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
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [telegramOpen, setTelegramOpen] = useState(false)

  if (state.loading && !state.data) return <LoadingState label="正在加载外部数据源" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const sources = asList(state.data)
  const genericSources = sources.filter((source) => !TELEGRAM_MONITOR_SOURCE_KEYS.has(source.sourceKey))

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

      <TelegramPipelineCard
        pipeline={telegramPipeline.data}
        loading={telegramPipeline.loading}
        error={telegramPipeline.error}
        onOpen={() => setTelegramOpen(true)}
        onRetry={telegramPipeline.refresh}
      />

      {genericSources.length === 0 ? (
        <EmptyState
          icon={Database}
          title="还没有注册通用数据源"
          description="Telegram monitor 已作为固定业务任务单独管理；这里可继续注册文件或其他只读 PostgreSQL 数据源。"
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
                    <strong>{source.sourceKind === 'file' ? '文件上传' : `${source.connection?.host || '数据库'}:${source.connection?.port || 5432}`}</strong>
                    <small className="mih-source-label">{source.sourceKind === 'database' ? `${source.connection?.schema || 'public'}.${source.connection?.table || '—'}` : 'xlsx / csv / jsonl / txt'}</small>
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

const TELEGRAM_MONITOR_SOURCE_KEYS = new Set([
  'telegram-monitor-chats',
  'telegram-monitor-messages',
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
          <span>只读会话：{data.source?.readOnly ? '是' : '否'}</span>
          <span>数据库 owner：{data.permissions.isDatabaseOwner ? '是' : '否'}</span>
          <span>superuser：{data.permissions.isSuperuser ? '是' : '否'}</span>
          {!data.permissions.canPrepare ? <small>执行时请使用下方一次性 source owner / DDL 账号；不会替换已保存的只读连接。</small> : null}
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
            <p>如果已保存的 <code>mx_data</code> 是只读账号，请在下面临时输入 source owner / DDL 账号。临时账号只用于本次请求，不保存、不回填，也不会由接口返回；留空则使用已保存连接。准备成功后，运行期仍使用已保存的只读连接。</p>
          </div>
        </div>
        <div className="mih-form mih-form--grid mih-telegram-prepare__credentials">
          <Field label="一次性迁移用户名（可选）" hint="source owner / 具备 ALTER、CREATE、TRIGGER 权限">
            <input className="qp-input" autoComplete="off" value={migrationUsername} onChange={(event) => setMigrationUsername(event.target.value)} />
          </Field>
          <Field label="一次性迁移密码（可选）" hint="请求结束立即从页面状态清除">
            <input className="qp-input" type="password" autoComplete="new-password" value={migrationPassword} onChange={(event) => setMigrationPassword(event.target.value)} />
          </Field>
        </div>
        {credentialsIncomplete ? <p className="mih-telegram-prepare__field-error">一次性迁移用户名和密码必须同时填写，或同时留空。</p> : null}
        <div className="mih-telegram-prepare__confirm">
          <Field label="输入业务标识以二次确认" hint={<code>telegram-monitor</code>}>
            <input className="qp-input" value={confirmation} autoComplete="off" spellCheck="false" onChange={(event) => setConfirmation(event.target.value)} />
          </Field>
          <button className="qp-button qp-button--danger" type="submit" disabled={!canPrepare || credentialsIncomplete || confirmation !== 'telegram-monitor'}
            title={!configured ? '先验证并保存共享连接' : !connectionConsistent ? '先统一两个固定任务的连接' : !pausedAndDrained ? '请先安全暂停并等待运行批次排空' : ''}>
            {submitting ? '正在准备源库…' : ready ? '重新核验并修复源库' : '一次性准备源库'}
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
  for (const key of ['items', 'sources']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

function CreateSourceModal({ token, notify, onClose, onCreated }) {
  const [form, setForm] = useState({
    sourceKey: '', displayName: '', sourceKind: 'file', datasetId: '', platform: 'external', objectType: 'record',
    host: '', port: '5432', database: '', username: '', password: '', sslMode: 'require',
    schema: 'public', table: '', cursorColumn: '', idColumn: '', syncIntervalSeconds: '300',
  })
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const body = {
        sourceKey: form.sourceKey.trim(), displayName: form.displayName.trim(), sourceKind: form.sourceKind,
        ...(form.datasetId.trim() ? { datasetId: form.datasetId.trim() } : {}),
        platform: form.platform.trim() || 'external', objectType: form.objectType.trim() || 'record',
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
      description="数据库连接随数据源直接保存；包括明文密码在内的连接信息仅 Admin Token 管理面可见。"
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
        <Field label="类型">
          <select className="qp-input" value={form.sourceKind}
            onChange={(event) => setForm({ ...form, sourceKind: event.target.value })}>
            <option value="file">文件上传（xlsx / csv / jsonl / txt）</option>
            <option value="database">只读 PostgreSQL 拉取</option>
          </select>
        </Field>
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
        {error ? <ErrorState error={error} /> : null}
      </form>
    </Modal>
  )
}

function SourceDetailModal({ token, source, onUnauthorized, notify, onClose, onSourceChanged }) {
  const managedByPipeline = TELEGRAM_MONITOR_SOURCE_KEYS.has(source.sourceKey)
  const [currentSource, setCurrentSource] = useState(source)
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
  const [preview, setPreview] = useState(null)
  const [useAgentPreview, setUseAgentPreview] = useState(false)
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

  const runPreview = async (file) => {
    setBusy(true)
    try {
      setPreview(await adminApi.previewImport(token, source.sourceKey, file, { useAgent: useAgentPreview }))
    } catch (error) {
      notify?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveSuggestion = async () => {
    const fieldMap = preview?.suggestion?.fieldMap || preview?.inferredFieldMap
    setBusy(true)
    try {
      const created = await adminApi.createMapping(token, source.sourceKey, {
        fieldMap,
        origin: preview?.suggestion?.origin || 'inferred',
        agentModel: preview?.suggestion?.model,
      })
      notify?.(`映射 v${created.version} 已创建，待批准`, 'success')
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
      await adminApi.approveMapping(token, source.sourceKey, version)
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
          <EmptyState icon={Plugs} title="还没有映射" description={currentSource.sourceKind === 'file' ? '先上传一个样例文件生成建议映射。' : '根据探测到的字段创建一个版本化 fieldMap。'} />
        ) : (
          <DataTable label="字段映射版本">
            <thead><tr><th>版本</th><th>来源</th><th>模型</th><th>状态</th><th>创建时间</th><th /></tr></thead>
            <tbody>
              {(mappings.data || []).map((mapping) => (
                <tr key={mapping.id}>
                  <td>v{mapping.version}</td>
                  <td>{{ manual: '手动', agent: 'Agent 建议', inferred: '规则推断' }[mapping.origin] || mapping.origin}</td>
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
        title="上传"
        subtitle={activeMapping ? `将使用已批准的映射 v${activeMapping.version}` : '尚无已批准映射，只能预览'}
        actions={
          <>
            <input ref={fileRef} type="file" hidden accept=".xlsx,.xlsm,.csv,.tsv,.jsonl,.ndjson,.txt,.md"
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
        }
      >
        <label className={`mih-agent-consent${agentAvailable ? '' : ' is-disabled'}`}>
          <input type="checkbox" checked={useAgentPreview} disabled={!agentAvailable || busy}
            onChange={(event) => setUseAgentPreview(event.target.checked)} />
          <span>
            <strong>使用 Agent 增强映射建议（显式授权）</strong>
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
        {preview ? (
          <>
            <div className="mih-metric-grid mih-metric-grid--compact">
              <MetricCard icon={Table} label="行数" value={formatNumber(preview.rowCount)} />
              <MetricCard icon={Database} label="列数" value={formatNumber(preview.columns.length)} />
              <MetricCard icon={Warning} label="未映射列" value={formatNumber(preview.unmappedColumns.length)}
                hint="这些列会进入 extensions" tone={preview.unmappedColumns.length > 0 ? 'warning' : 'primary'} />
            </div>
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
                : 'Hub 本地规则推断'}
            </p>
            <pre className="mih-code-block">{JSON.stringify(preview.suggestion?.fieldMap || preview.inferredFieldMap, null, 2)}</pre>
            <div className="mih-page-actions">
              <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={saveSuggestion}>
                保存为新映射版本
              </button>
              <button className="qp-button" type="button" disabled={busy || !activeMapping}
                onClick={() => { intentRef.current = 'import'; fileRef.current?.click() }}>
                {activeMapping ? '选择文件并导入' : '需要先批准映射'}
              </button>
            </div>
          </>
        ) : (
          <EmptyState icon={FileArrowUp} title="选择一个样例文件"
            description="预览会显示列、行数、推断映射和前几行的映射结果，不会写入任何数据。" />
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

export function AgentPage({ token, onUnauthorized }) {
  const load = useCallback(() => adminApi.agent(token), [token])
  const state = useRemoteData(load, onUnauthorized)

  if (state.loading && !state.data) return <LoadingState label="正在读取模型链路" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const agent = state.data || {}
  const chain = agent.chat || []
  const embeddings = agent.embeddings || []

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
          description="设置 MX_INSIGHT_AGENT_PROVIDERS 后启用。未配置时映射建议回退到规则推断，功能不中断。" />
      ) : (
        <Panel title="对话模型链路" subtitle="按顺序降级；400/422 不降级，因为换个 provider 会一样失败">
          <ProviderTable providers={chain} />
        </Panel>
      )}
      {embeddings.length > 0 ? (
        <Panel title="Embedding 链路" subtitle={`维度 ${agent.embeddingDimensions ?? '未配置'}；链路内所有模型必须同维度`}>
          <ProviderTable providers={embeddings} />
        </Panel>
      ) : null}
      <Panel title="当前接线边界" subtitle="模型已配置不等于所有数据源都在执行智能清洗">
        <div className="mih-agent-scope-grid">
          <div><strong>文件映射建议</strong><p>已接线，但只在管理员预览时显式勾选；仅发送列名，建议仍需人工批准。</p></div>
          <div><strong>数据库 / Telegram 清洗</strong><p>使用确定性、版本化 mapping。逐行分类能力尚未接入，不会静默把源数据发送给模型。</p></div>
          <div><strong>向量检索</strong><p>{embeddings.length > 0 ? 'Embedding worker 已配置，可生成独立 chunk 索引。' : '未配置 Embedding provider；PG/全文检索不受影响。'}</p></div>
          <div><strong>建议的下一步</strong><p>只把 schema drift 或拒绝行副本送入隔离队列，并记录模型、prompt、数据范围、费用和人工结论。</p></div>
        </div>
      </Panel>
    </>
  )
}

function ProviderTable({ providers }) {
  return (
    <DataTable>
      <thead><tr><th>顺序</th><th>Provider</th><th>模型</th><th>凭据</th><th>熔断</th></tr></thead>
      <tbody>
        {providers.map((provider, index) => (
          <tr key={provider.id}>
            <td>{index === 0 ? '首选' : `降级 ${index}`}</td>
            <td><code>{provider.id}</code></td>
            <td><code>{provider.model}</code></td>
            <td><StatusBadge status={provider.keyConfigured ? 'active' : 'suspended'}
              label={provider.keyConfigured ? '已配置' : '缺失'} /></td>
            <td><StatusBadge
              status={provider.circuit === 'closed' ? 'active' : provider.circuit === 'open' ? 'suspended' : 'pending'}
              label={{ closed: '正常', degraded: '有失败', open: '已熔断' }[provider.circuit]} /></td>
          </tr>
        ))}
      </tbody>
    </DataTable>
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
