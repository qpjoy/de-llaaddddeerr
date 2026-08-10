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
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)

  if (state.loading && !state.data) return <LoadingState label="正在加载外部数据源" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const sources = asList(state.data)

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

      {sources.length === 0 ? (
        <EmptyState
          icon={Database}
          title="还没有注册外部数据源"
          description="注册后可以上传 xlsx / csv / jsonl / txt，或配置一个只读的 PostgreSQL 拉取源。"
        />
      ) : (
        <Panel title="已注册数据源" subtitle="每个源有独立的 dataset，不会与 Night-All 语料混合">
          <DataTable label="外部数据源列表">
            <thead>
              <tr><th>标识</th><th>名称</th><th>来源</th><th>Dataset / 平台</th><th>同步策略</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {sources.map((source) => (
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
  const mappingMutationBlocked = currentSource.sourceKind === 'database' && (
    isDraining || sync.loading || Boolean(sync.error)
  )

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
    <Modal title={currentSource.displayName} description={`标识 ${currentSource.sourceKey} · dataset ${currentSource.datasetId}`} size="xlarge" onClose={onClose}
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

      <Panel title="字段映射" subtitle="创建时未批准；批准之后才能用于导入">
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
                    {mapping.approved ? null : <button className="qp-button qp-button--ghost" type="button" disabled={busy || mappingMutationBlocked}
                      title={mappingMutationBlocked ? '确认同步游标 idle 后再批准' : ''} onClick={() => approve(mapping.version)}>批准</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        {currentSource.sourceKind === 'database' ? (
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
  onEdit, onCancelEdit, onSave, onStatus, onSync, onTest, onPreview, onResetCheckpoint,
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
      <Panel title="数据库源控制" subtitle="暂停会等待当前批次在安全边界收口，不会中断已开始的源库查询或写入"
        actions={
          <>
            {source.status === 'active' ? (
              <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={() => onStatus('paused')}>
                <Pause size={16} /> {statusTransition === 'paused' ? '正在等待批次边界…' : '安全暂停'}
              </button>
            ) : (
              <button className="qp-button qp-button--ghost" type="button" disabled={busy || !canActivate}
                title={isDraining ? '正在等待当前批次收口' : canActivate ? '' : '需先解决探测问题并批准映射'}
                onClick={() => onStatus('active')}><Play size={16} /> {statusTransition === 'active' ? '正在启用…' : '启用'}</button>
            )}
            <button className="qp-button qp-button--ghost" type="button"
              disabled={busy || source.status !== 'paused' || isDraining || sync.loading || Boolean(sync.error)}
              title={isDraining ? '当前批次收口后才能修改连接配置' : ''} onClick={onEdit}>编辑配置</button>
            <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onTest}>测试连接</button>
            <button className="qp-button" type="button" disabled={busy || source.status !== 'active'} onClick={onSync}><ArrowClockwise size={16} /> 立即同步</button>
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
        <p className="mih-inline-warning"><Key size={16} aria-hidden="true" />连接信息随数据源管理，密码以明文回填；本页面和对应接口仅允许 Admin Token 会话访问。</p>
        {editing ? (
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
        {source.status === 'paused' && !isDraining && !sync.loading && !sync.error ? (
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
