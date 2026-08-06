import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Brain,
  Database,
  FileArrowUp,
  MagnifyingGlass,
  Plugs,
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

  const sources = state.data || []

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
          <DataTable>
            <thead>
              <tr><th>标识</th><th>名称</th><th>类型</th><th>Dataset</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td><code>{source.sourceKey}</code></td>
                  <td>{source.displayName}</td>
                  <td>{source.sourceKind === 'file' ? '文件' : '数据库'}</td>
                  <td><code>{source.datasetId}</code></td>
                  <td><StatusBadge status={source.status} /></td>
                  <td>
                    <button className="qp-button qp-button--ghost" type="button" onClick={() => setSelected(source)}>
                      映射与导入
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
        <SourceDetailModal token={token} source={selected} notify={notify} onClose={() => setSelected(null)} />
      ) : null}
    </>
  )
}

function CreateSourceModal({ token, notify, onClose, onCreated }) {
  const [form, setForm] = useState({ sourceKey: '', displayName: '', sourceKind: 'file', platform: 'external' })
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await adminApi.createSource(token, form)
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
      description="标识用于所有后续操作，注册后不建议更改。"
      onClose={onClose}
      footer={
        <>
          <button className="qp-button qp-button--ghost" type="button" onClick={onClose}>取消</button>
          <button className="qp-button" type="submit" form="create-source" disabled={submitting}>
            {submitting ? '注册中…' : '注册'}
          </button>
        </>
      }
    >
      <form id="create-source" onSubmit={submit} className="mih-form mih-form--grid">
        <Field label="标识" hint="小写字母、数字与连字符，例如 weekly-report">
          <input className="qp-input" value={form.sourceKey} required
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
        {error ? <ErrorState error={error} /> : null}
      </form>
    </Modal>
  )
}

function SourceDetailModal({ token, source, notify, onClose }) {
  const load = useCallback(() => adminApi.sourceMappings(token, source.sourceKey), [token, source.sourceKey])
  const mappings = useRemoteData(load, null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  // One hidden file input serves both actions, so it has to know which one
  // opened it. Without this the import button silently ran a preview.
  const intentRef = useRef('preview')

  const activeMapping = useMemo(
    () => (mappings.data || []).find((mapping) => mapping.approved),
    [mappings.data],
  )

  const runPreview = async (file) => {
    setBusy(true)
    try {
      setPreview(await adminApi.previewImport(token, source.sourceKey, file))
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

  return (
    <Modal title={source.displayName} description={`标识 ${source.sourceKey} · dataset ${source.datasetId}`} size="large" onClose={onClose}
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button>}>

      <Panel title="字段映射" subtitle="创建时未批准；批准之后才能用于导入">
        {mappings.loading ? <LoadingState /> : null}
        {(mappings.data || []).length === 0 ? (
          <EmptyState icon={Plugs} title="还没有映射" description="先上传一个样例文件生成建议映射。" />
        ) : (
          <DataTable>
            <thead><tr><th>版本</th><th>来源</th><th>模型</th><th>状态</th><th /></tr></thead>
            <tbody>
              {(mappings.data || []).map((mapping) => (
                <tr key={mapping.id}>
                  <td>v{mapping.version}</td>
                  <td>{{ manual: '手动', agent: 'Agent 建议', inferred: '规则推断' }[mapping.origin] || mapping.origin}</td>
                  <td><code>{mapping.agentModel || '—'}</code></td>
                  <td><StatusBadge status={mapping.approved ? 'active' : 'pending'} label={mapping.approved ? '已批准' : '待批准'} /></td>
                  <td>
                    {mapping.approved ? null : (
                      <button className="qp-button qp-button--ghost" type="button" disabled={busy}
                        onClick={() => approve(mapping.version)}>批准</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <Panel
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
        {preview ? (
          <>
            <div className="mih-metric-grid mih-metric-grid--compact">
              <MetricCard label="行数" value={formatNumber(preview.rowCount)} />
              <MetricCard label="列数" value={formatNumber(preview.columns.length)} />
              <MetricCard label="未映射列" value={formatNumber(preview.unmappedColumns.length)}
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
      </Panel>
    </Modal>
  )
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
