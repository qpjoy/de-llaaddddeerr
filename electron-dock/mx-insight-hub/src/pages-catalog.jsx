import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ClockCounterClockwise,
  Database,
  FileText,
  MagnifyingGlass,
  Stack,
  WarningCircle,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { canConfirmSearchReindex } from './search-reindex-confirmation.js'
import {
  EmptyState,
  DropdownField,
  ErrorState,
  LoadingState,
  MetricCard,
  Modal,
  PageHeading,
  Pagination,
  StatusBadge,
  formatDate,
  formatNumber,
  useRemoteData,
} from './components.jsx'

function Panel({ title, subtitle, children }) {
  return (
    <section className="qp-panel mih-panel">
      <header className="mih-panel__header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
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

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function recordTitle(record) {
  return record.title || record.externalId || record.id || '未命名记录'
}

function recordPage(value, fallbackPageSize = 50) {
  const pageInfo = value?.pageInfo || value?.pagination || {}
  const items = Array.isArray(value)
    ? value
    : asArray(value?.items).length > 0
      ? value.items
      : asArray(value?.records)
  const nextCursor = pageInfo.nextCursor ?? value?.nextCursor ?? null
  const numericValue = (candidate, { minimum = 0 } = {}) => {
    if (candidate == null) return null
    const number = Number(candidate)
    return Number.isSafeInteger(number) && number >= minimum ? number : null
  }
  return {
    items,
    page: numericValue(pageInfo.page ?? value?.page, { minimum: 1 }),
    pageSize: numericValue(pageInfo.pageSize ?? value?.pageSize, { minimum: 1 }) ?? fallbackPageSize,
    hasMore: Boolean(pageInfo.hasMore ?? value?.hasMore ?? nextCursor),
    nextCursor,
    total: numericValue(pageInfo.total ?? value?.total),
    totalPages: numericValue(pageInfo.totalPages ?? value?.totalPages, { minimum: 1 }),
    maxDirectPage: numericValue(pageInfo.maxDirectPage ?? value?.maxDirectPage, { minimum: 1 }),
  }
}

function highlightValues(record, field) {
  const highlight = record?.highlight || record?.highlights || {}
  const fields = field === 'title'
    ? ['title', 'titleHanlp']
    : field === 'body'
      ? ['body', 'bodyHanlp']
      : [field]
  return fields.flatMap((name) => {
    const value = highlight[name]
    return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []
  })
}

function highlightedParts(value) {
  const chunks = String(value).split(/(<(?:em|mark)>[\s\S]*?<\/(?:em|mark)>)/giu)
  return chunks.filter(Boolean).map((chunk, index) => {
    const marked = /^<(?:em|mark)>/iu.test(chunk)
    const text = chunk.replace(/<\/?[^>]+>/gu, '')
    return marked ? <mark key={index}>{text}</mark> : <span key={index}>{text}</span>
  })
}

function HighlightedValue({ values, fallback }) {
  if (!values.length) return fallback
  return values.map((value, index) => (
    <span key={index}>{index > 0 ? ' … ' : ''}{highlightedParts(value)}</span>
  ))
}

function searchFact(item, index) {
  if (item == null) return null
  if (typeof item !== 'object') {
    const value = String(item).trim()
    return value ? { key: `${index}:${value}`, title: value, technical: true } : null
  }
  const title = item.label || item.name || item.id || item.branch || item.field || `配置 ${index + 1}`
  const summary = item.summary || item.description || item.purpose || null
  const fields = asArray(item.fields).filter(Boolean)
  const metadata = [
    item.analyzer ? `index analyzer: ${item.analyzer}` : null,
    item.searchAnalyzer ? `search analyzer: ${item.searchAnalyzer}` : null,
    fields.length ? `fields: ${fields.join(', ')}` : null,
  ].filter(Boolean)
  return { key: item.id || item.branch || `${index}:${title}`, title, summary, metadata }
}

function SearchFactList({ items, emptyLabel }) {
  const facts = asArray(items).map(searchFact).filter(Boolean)
  if (!facts.length) return <p className="qp-search-lab__empty">{emptyLabel}</p>
  return (
    <ul className="qp-search-lab__facts">
      {facts.map((fact) => (
        <li key={fact.key}>
          {fact.technical ? <code>{fact.title}</code> : <strong>{fact.title}</strong>}
          {fact.summary ? <span>{fact.summary}</span> : null}
          {fact.metadata?.length ? <small>{fact.metadata.join(' · ')}</small> : null}
        </li>
      ))}
    </ul>
  )
}

function JsonSample({ value, emptyLabel }) {
  if (value == null) return <p className="qp-search-lab__empty">{emptyLabel}</p>
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return <pre className="qp-code-block"><code>{text}</code></pre>
}

function SearchLab({ capabilities, selectedProfile, execution, recordsMode, query, safeSample }) {
  const analysis = execution?.queryAnalysis && typeof execution.queryAnalysis === 'object'
    ? execution.queryAnalysis
    : {}
  const hasQueryAnalysis = Boolean(execution?.queryAnalysis && typeof execution.queryAnalysis === 'object')
  const tokens = asArray(analysis.tokens).filter((value) => value != null && String(value).trim())
  const matchedBranches = asArray(execution?.matchedBranches).filter(Boolean)
  const backend = analysis.backendUsed || analysis.backend || null
  const mode = execution?.mode || recordsMode || null
  const appliedProfile = execution?.appliedProfile || execution?.profile?.id || null
  const availableRepresentations = asArray(capabilities.indexRepresentations)
  const activeRepresentations = asArray(execution?.profile?.indexRepresentations).length
    ? execution.profile.indexRepresentations
    : selectedProfile?.indexRepresentations
  const indexRepresentations = asArray(activeRepresentations).length
    ? activeRepresentations.map((representation) => {
      if (typeof representation !== 'string') return representation
      return availableRepresentations.find((candidate) => candidate?.id === representation) || representation
    })
    : availableRepresentations
  const queryPlan = asArray(execution?.queryPlan).length
    ? execution.queryPlan
    : asArray(execution?.profile?.queryPlan).length
      ? execution.profile.queryPlan
      : selectedProfile?.queryPlan
  const sample = execution?.sample && typeof execution.sample === 'object'
    ? execution.sample
    : safeSample && typeof safeSample === 'object'
      ? { response: safeSample }
      : {}
  const desiredIndexSchema = capabilities.indexSchema || null
  const activeIndexSchema = capabilities.activeIndexSchema || null
  const readinessKnown = typeof capabilities.ready === 'boolean'

  return (
    <details className="qp-search-lab">
      <summary>
        <span className="qp-search-lab__title">
          <strong>Search Lab</strong>
          <small>HanLP/presegmented 是中文主通道；CJK zh-recall 仅作低权重补充</small>
        </span>
        <span className="qp-search-lab__badges" aria-label="当前搜索状态">
          {selectedProfile?.id ? <span className="qp-tag qp-tag--primary">requested {selectedProfile.id}</span> : null}
          {appliedProfile && appliedProfile !== selectedProfile?.id
            ? <span className="qp-tag qp-tag--danger">applied {appliedProfile}</span>
            : null}
          {desiredIndexSchema ? <span className="qp-tag">target {desiredIndexSchema}</span> : null}
          {readinessKnown ? <span className="qp-tag">active {activeIndexSchema || 'unavailable'}</span> : null}
          {capabilities.ready === true ? <span className="qp-tag qp-tag--success">projection ready</span> : null}
          {capabilities.ready === false ? <span className="qp-tag qp-tag--danger">target schema pending</span> : null}
          {mode ? <span className="qp-tag">{mode}</span> : null}
          {backend ? <span className="qp-tag qp-tag--success">{backend}</span> : null}
          {analysis.degraded ? <span className="qp-tag qp-tag--danger">已降级</span> : null}
        </span>
      </summary>
      <div className="qp-search-lab__body">
        {readinessKnown ? (
          <section className="qp-search-lab__readiness" data-ready={capabilities.ready ? 'true' : 'false'}
            role="status" aria-live="polite">
            <strong>{capabilities.ready ? '搜索投影已就绪' : '目标索引尚未激活'}</strong>
            <span>
              active {activeIndexSchema || 'unavailable'} → target {desiredIndexSchema || '未公布'}。
              {capabilities.ready
                ? ' 当前索引支持全部已声明的搜索表示。'
                : ' 标记为 ready 的兼容 profile 仍可使用；仅下拉中禁用的 profile 需要等待目标索引。'}
            </span>
            {capabilities.readinessError ? <code>{capabilities.readinessError}</code> : null}
          </section>
        ) : null}
        <div className="qp-search-lab__grid">
          <section>
            <h3>索引表示（只读）</h3>
            <SearchFactList items={indexRepresentations} emptyLabel="当前服务端未公布索引表示。" />
          </section>
          <section>
            <h3>查询计划</h3>
            <SearchFactList items={queryPlan} emptyLabel="当前 profile 未公布查询计划。" />
          </section>
        </div>

        <section className="qp-search-lab__analysis" aria-labelledby="mih-query-analysis-title">
          <div className="qp-search-lab__section-heading">
            <h3 id="mih-query-analysis-title">本次 Query analysis · tokens</h3>
            {query ? (
              <span className="qp-search-lab__execution" role="status" aria-live="polite">
                requestedProfile={execution?.requestedProfile || selectedProfile?.id || '服务端默认'}
                {appliedProfile ? ` · appliedProfile=${appliedProfile}` : ''}
                {` · backendUsed=${hasQueryAnalysis ? backend || 'null' : '未提供'}`}
                {` · degraded=${hasQueryAnalysis ? String(Boolean(analysis.degraded)) : '未提供'}`}
                {` · errorCode=${hasQueryAnalysis ? analysis.errorCode || 'null' : '未提供'}`}
                {Number.isFinite(analysis.tokenCount) ? ` · tokenCount=${analysis.tokenCount}` : ''}
                {analysis.truncated ? ' · tokens truncated' : ''}
              </span>
            ) : null}
          </div>
          {!query ? <p className="qp-search-lab__empty">输入关键词并搜索后显示实际 tokens 与分词后端。</p> : tokens.length ? (
            <div className="qp-chip-list" role="list" aria-label="查询分词结果">
              {tokens.map((value, index) => <span role="listitem" key={`${index}:${value}`}>{String(value)}</span>)}
            </div>
          ) : (
            <p className="qp-search-lab__empty">
              {mode && /postgres/iu.test(mode)
                ? 'PostgreSQL fallback 不提供 Elasticsearch query tokens。'
                : hasQueryAnalysis && analysis.tokenCount === 0 && backend == null
                  ? '此 profile 不需要分词，服务端返回空 tokens。'
                  : '本次响应未提供 query tokens。'}
            </p>
          )}
          {matchedBranches.length ? (
            <div className="qp-chip-list" role="list" aria-label="本页命中的查询分支">
              {matchedBranches.map((value) => <span role="listitem" key={value}>matched: {value}</span>)}
            </div>
          ) : null}
        </section>

        <div className="qp-search-lab__samples">
          <section>
            <h3>公共 API 请求样例</h3>
            <JsonSample value={sample.request} emptyLabel="当前服务端未提供公共请求样例。" />
          </section>
          <section>
            <h3>公共安全响应样例</h3>
            <JsonSample value={sample.response} emptyLabel="当前服务端未提供经公共 allowlist 投影的响应样例。" />
          </section>
        </div>
      </div>
    </details>
  )
}

const ACTIVE_REINDEX_STATUSES = new Set(['queued', 'running'])

/**
 * Cycle the time column between newest, oldest and relevance.
 *
 * Relevance is only offered while a keyword query is active, because without
 * one every row scores the same and the option would just be a third way to
 * produce the default order.
 */
function nextSort(sort, query) {
  if (sort === 'newest') return 'oldest'
  if (sort === 'oldest') return query ? 'relevance' : 'newest'
  return 'newest'
}

function sortGlyph(sort) {
  if (sort === 'newest') return ' ↓'
  if (sort === 'oldest') return ' ↑'
  return ' ≡'
}

function sortLabel(sort) {
  if (sort === 'newest') return '从新到旧'
  if (sort === 'oldest') return '从旧到新'
  return '按相关性'
}

function sortHint(sort) {
  return `当前${sortLabel(sort)}，点击切换排序`
}

function reindexStatus(status) {
  if (status === 'succeeded') return { badge: 'active', label: '已完成' }
  if (status === 'failed') return { badge: 'down', label: '失败' }
  if (status === 'running') return { badge: 'degraded', label: '运行中' }
  if (status === 'queued') return { badge: 'unknown', label: '排队中' }
  return { badge: 'unknown', label: status || '尚未运行' }
}

function reindexProgress(operation) {
  const explicit = operation?.progress == null ? null : Number(operation.progress)
  if (explicit != null && Number.isFinite(explicit)) {
    return Math.min(100, Math.max(0, explicit <= 1 ? explicit * 100 : explicit))
  }
  const processed = Number(operation?.processed)
  const total = Number(operation?.total)
  if (Number.isFinite(processed) && Number.isFinite(total) && total > 0) {
    return Math.min(100, Math.max(0, processed / total * 100))
  }
  return null
}

function reindexIssue(issue) {
  if (typeof issue === 'string') return { message: issue }
  return issue && typeof issue === 'object' ? issue : { message: String(issue || '未知问题') }
}

function SearchReindexControl({ token, onUnauthorized, onReindexed }) {
  const load = useCallback(() => adminApi.searchReindex(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const preflight = state.data?.preflight || {}
  const operation = state.data?.operation || null
  const blockers = asArray(preflight.blockers).map(reindexIssue)
  const warnings = asArray(preflight.warnings).map(reindexIssue)
  const active = ACTIVE_REINDEX_STATUSES.has(operation?.status)
  const needsBackendAck = preflight.requiresBackendAcknowledgement === true
  const [backendAcknowledged, setBackendAcknowledged] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const startupRebuild = preflight.startupRebuild === true

  const toggleStartupRebuild = async () => {
    setToggling(true)
    setSubmitError(null)
    try {
      await adminApi.setSearchStartupRebuild(token, !startupRebuild)
      await state.refresh()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setSubmitError(error)
    } finally {
      setToggling(false)
    }
  }

  const cancelRebuild = async () => {
    setCancelling(true)
    setSubmitError(null)
    try {
      await adminApi.cancelSearchReindex(token)
      await state.refresh()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setSubmitError(error)
    } finally {
      setCancelling(false)
    }
  }
  const status = reindexStatus(operation?.status)
  const progress = reindexProgress(operation)
  const logs = asArray(operation?.logs).slice(-100)
  const canStart = preflight.ready === true && blockers.length === 0 && !active && !state.loading && !submitting

  useEffect(() => {
    if (!active || state.loading) return undefined
    const timer = window.setTimeout(state.refresh, 2_000)
    return () => window.clearTimeout(timer)
  }, [active, state.loading, state.refresh])

  const closeConfirmation = () => {
    if (submitting) return
    setConfirmationOpen(false)
    setConfirmation('')
    setBackendAcknowledged(false)
    setSubmitError(null)
  }

  const confirmationReady = canConfirmSearchReindex({
    confirmation,
    requiresBackendAcknowledgement: needsBackendAck,
    backendAcknowledged,
  })

  const start = async (event) => {
    event.preventDefault()
    if (!canStart || !confirmationReady) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const updated = await adminApi.startSearchReindex(token, needsBackendAck ? preflight.expectedBackend : null)
      state.setData(updated)
      setConfirmationOpen(false)
      setConfirmation('')
      setBackendAcknowledged(false)
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setSubmitError(error)
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (operation?.status !== 'succeeded') return
    onReindexed?.()
  }, [onReindexed, operation?.id, operation?.status])

  const buttonTitle = active
    ? '已有搜索索引重建正在运行'
    : blockers[0]?.message || (preflight.ready === false ? '前置检查未通过' : '')

  return (
    <Panel title="搜索索引重建" subtitle="从 PostgreSQL canonical truth 严格重建 Elasticsearch 投影；单任务运行，投影首轮快照完成后原子切换对应读别名">
      {state.loading && !state.data ? <LoadingState label="正在执行搜索重建前置检查" /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {state.data ? (
        <div className="mih-search-reindex">
          <dl className="mih-search-reindex__facts">
            <div>
              <dt>前置检查</dt>
              <dd><StatusBadge status={preflight.ready ? 'ready' : 'not_ready'} label={preflight.ready ? '可以执行' : '存在阻断'} /></dd>
            </div>
            <div>
              <dt>分词后端</dt>
              <dd>
                <code>{preflight.expectedBackend || '未公布'}</code>
                {/* What the live index is made of, which is not always what this
                    runtime is configured to produce. */}
                <small>{preflight.activeBackend
                  ? preflight.activeBackend === preflight.expectedBackend
                    ? `当前索引同为 ${preflight.activeBackend}`
                    : `当前索引由 ${preflight.activeBackend} 构建`
                  : '当前索引来源未记录'}</small>
              </dd>
            </div>
            <div>
              <dt>索引 Schema</dt>
              <dd><code>{preflight.sourceIndexSchema || 'unavailable'} → {preflight.targetIndexSchema || '未公布'}</code></dd>
            </div>
            <div>
              <dt>最近任务</dt>
              <dd><StatusBadge status={status.badge} label={status.label} /></dd>
            </div>
          </dl>

          <div className="mih-search-reindex__switch">
            <label>
              <input type="checkbox" checked={startupRebuild} disabled={toggling}
                onChange={toggleStartupRebuild} />
              <span>projector 重启时自动全量重建</span>
            </label>
            {/* Off is the safe default: a restart should serve, not embark on
                hours of work. The outbox keeps the projection fresh either way;
                only re-segmenting existing records needs this pass. */}
            <small>{startupRebuild
              ? '已开启：每次 projector 重启都会先重放全部 canonical 记录，期间持有全局重建锁。'
              : '已关闭：projector 重启后只校对索引与别名，随即开始服务并消费 outbox；全量重建改由本页手动触发。'}</small>
          </div>

          {preflight.projectorRequired === false ? (
            <p className="mih-search-reindex__note">
              Admin 后台直接运行严格重建器，不依赖 <code>mx-insight-hub-projector</code> Ready 副本。
            </p>
          ) : null}

          {blockers.length ? (
            <section className="mih-search-reindex__issues mih-search-reindex__issues--danger" role="alert">
              <strong>前置检查未通过</strong>
              <ul>{blockers.map((issue, index) => (
                <li key={`${issue.code || 'blocker'}:${index}`}>
                  <span>{issue.message}</span>
                  {issue.code ? <code>{issue.code}</code> : null}
                  {issue.action ? <small>{issue.action}</small> : null}
                </li>
              ))}</ul>
            </section>
          ) : null}
          {warnings.length ? (
            <section className="mih-search-reindex__issues" role="status">
              <strong>执行提示</strong>
              <ul>{warnings.map((issue, index) => (
                <li key={`${issue.code || 'warning'}:${index}`}>
                  <span>{issue.message}</span>
                  {issue.action ? <small>{issue.action}</small> : null}
                </li>
              ))}</ul>
            </section>
          ) : null}

          {operation ? (
            <section className="mih-search-reindex__operation" aria-live="polite">
              <header>
                <div>
                  <strong>{status.label} · {operation.phase || '等待阶段信息'}</strong>
                  <small>{operation.id ? `任务 ${operation.id}` : '任务 ID 未公布'}</small>
                </div>
                <span>{operation.startedAt ? `开始 ${formatDate(operation.startedAt)}` : '等待开始'}</span>
              </header>
              <div className={`mih-search-reindex__progress${progress == null && active ? ' is-indeterminate' : ''}`}>
                <i style={progress == null ? undefined : { width: `${progress}%` }} />
              </div>
              <p>
                已处理 {formatNumber(operation.processed || 0)}
                {operation.total != null
                  ? ` / ${formatNumber(operation.total)}`
                  : active ? ' 条 · 总量统计中' : ' 条'}
                {progress != null ? ` · ${Math.round(progress)}%` : ''}
                {operation.finishedAt ? ` · 结束 ${formatDate(operation.finishedAt)}` : ''}
              </p>
              {operation.status === 'failed' ? (
                <div className="mih-search-reindex__failure" role="alert">
                  <strong>{operation.errorMessage || '搜索索引重建失败'}</strong>
                  {operation.errorCode ? <code>{operation.errorCode}</code> : null}
                </div>
              ) : null}
              <div className="mih-search-reindex__logs" aria-label="重建任务日志">
                {logs.length ? logs.map((entry, index) => {
                  const value = typeof entry === 'string' ? { message: entry } : entry || {}
                  return <p key={`${value.at || index}:${index}`}>
                    {value.at ? <time>{formatDate(value.at)}</time> : null}
                    {value.level ? <span>{value.level}</span> : null}
                    <code>{value.message || JSON.stringify(value)}</code>
                  </p>
                }) : <p><code>{active ? '等待服务器运行日志…' : '该任务没有运行日志。'}</code></p>}
              </div>
            </section>
          ) : null}

          <div className="mih-search-reindex__actions">
            <span>
              {active ? '运行期间不能再次提交；页面会自动刷新状态。' : canStart ? '前置检查通过，可以开始重建。' : '解决阻断项后刷新前置检查。'}
            </span>
            {active ? (
              <button className="qp-button qp-button--danger" type="button" disabled={cancelling}
                title="在下一个批次边界停止；已写入的文档保持不变，别名不会切到半成品索引"
                onClick={cancelRebuild}>{cancelling ? '正在请求停止…' : '停止重建'}</button>
            ) : null}
            <button className="qp-button qp-button--ghost" type="button" disabled={state.loading || submitting}
              onClick={state.refresh}>{state.loading ? '检查中…' : '重新检查'}</button>
            <button className="qp-button" type="button" disabled={!canStart} title={buttonTitle}
              onClick={() => {
                setConfirmation('')
                setBackendAcknowledged(false)
                setSubmitError(null)
                setConfirmationOpen(true)
              }}>
              {active ? '重建运行中…' : '开始严格重建'}
            </button>
          </div>
        </div>
      ) : null}

      {confirmationOpen ? (
        <Modal title="确认重建搜索索引" description="此操作会读取全部 canonical 数据并产生显著的 PostgreSQL、HanLP 与 Elasticsearch 负载。"
          onClose={closeConfirmation}
          footer={<>
            <button className="qp-button qp-button--ghost" type="button" disabled={submitting} onClick={closeConfirmation}>取消</button>
            <button className="qp-button qp-button--danger" type="submit" form="mih-search-reindex-confirm"
              disabled={submitting || !confirmationReady}>
              {submitting ? '正在提交…' : '确认并开始'}
            </button>
          </>}>
          <form id="mih-search-reindex-confirm" className="mih-search-reindex__confirm" onSubmit={start}>
            <div className="mih-confirm-copy">
              <WarningCircle size={22} weight="duotone" aria-hidden="true" />
              <p>canonical 数据不会被修改。失败时请根据任务阶段和日志确认是否已有某个投影完成别名切换。</p>
            </div>
            {/* Strict verification proves the tokens match the configured
                backend; it cannot know the configuration was intended. Saying
                which index this produces is what catches a silent downgrade. */}
            {needsBackendAck ? (
              <label className="mih-confirm-acknowledge">
                <input type="checkbox" checked={backendAcknowledged}
                  onChange={(event) => setBackendAcknowledged(event.target.checked)} />
                <span>
                  本次重建将产出 <code>{preflight.expectedBackend}</code> 分词的索引，而不是 HanLP
                  {preflight.activeBackend && preflight.activeBackend !== preflight.expectedBackend
                    ? `（当前索引由 ${preflight.activeBackend} 构建）` : ''}。
                  检索质量会明显下降，且需要再跑一次完整重建才能恢复。我确认要这样做。
                </span>
              </label>
            ) : null}
            <label className="qp-field">
              <span className="qp-field__label">输入 <code>REINDEX</code> 以确认</span>
              <input className="qp-input" autoFocus autoComplete="off" spellCheck="false" value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)} />
            </label>
            {submitError ? <ErrorState error={submitError} /> : null}
          </form>
        </Modal>
      ) : null}
    </Panel>
  )
}

/**
 * Read-only view over PostgreSQL canonical truth.
 *
 * Source management explains how bytes enter the Hub; this page explains what
 * the Hub currently owns. Keeping those questions separate also prevents an
 * Elasticsearch outage from making the catalog look empty: counts and samples
 * come from PostgreSQL, while ES remains a rebuildable serving projection.
 */
export function DataCenterPage({ token, onUnauthorized }) {
  const [datasetId, setDatasetId] = useState('')
  const [platform, setPlatform] = useState('')
  const [objectType, setObjectType] = useState('')
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [searchProfile, setSearchProfile] = useState('')
  const [page, setPage] = useState(1)
  const [cursor, setCursor] = useState(null)
  // Newest-first by default. Relevance stays reachable, but it has to be asked
  // for: ranked rows under a 时间 column are indistinguishable from unsorted ones.
  const [sort, setSort] = useState('newest')
  const [cursorHistory, setCursorHistory] = useState([])
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const pageSize = 50

  const loadCatalog = useCallback(() => adminApi.dataCenter(token, { pageSize: 1 }), [token])
  const state = useRemoteData(loadCatalog, onUnauthorized)
  const data = state.data || {}
  const datasets = asArray(data.datasets)
  const searchCapabilities = data.searchCapabilities && typeof data.searchCapabilities === 'object'
    ? data.searchCapabilities
    : {}
  const searchProfiles = asArray(searchCapabilities.profiles)
    .filter((profile) => profile && typeof profile.id === 'string' && profile.id.trim())
  const defaultSearchProfile = searchCapabilities.defaultProfile
    || searchProfiles.find((profile) => profile.default)?.id
    || searchProfiles[0]?.id
    || ''
  const readySearchProfiles = searchProfiles.filter((profile) => profile.ready !== false)
  const fallbackSearchProfile = readySearchProfiles.find((profile) => profile.id === defaultSearchProfile)?.id
    || readySearchProfiles[0]?.id
    || ''
  const requestedProfileMetadata = searchProfiles.find((profile) => profile.id === searchProfile)
  const effectiveSearchProfile = requestedProfileMetadata && requestedProfileMetadata.ready !== false
    ? requestedProfileMetadata.id
    : fallbackSearchProfile
  const selectedSearchProfile = searchProfiles.find((profile) => profile.id === effectiveSearchProfile) || null
  const requestedSearchProfile = query ? effectiveSearchProfile : ''
  const loadRecords = useCallback(async () => {
    const filters = {
      q: query || undefined,
      datasetId: datasetId || undefined,
      platform: platform || undefined,
      objectType: objectType || undefined,
      searchProfile: requestedSearchProfile || undefined,
      sort,
      pageSize,
      cursor: cursor || undefined,
      page: cursor ? undefined : page,
    }
    try {
      return await adminApi.dataCenterRecords(token, filters)
    } catch (error) {
      // A rolling deployment can briefly pair the new console with the legacy
      // catalog endpoint. Keep first-page browsing usable until the API catches up.
      if (error?.status !== 404 || cursor) throw error
      const legacy = await adminApi.dataCenter(token, filters)
      const normalizedQuery = query.toLocaleLowerCase()
      const records = asArray(legacy?.records).filter((record) => !normalizedQuery || [
        record.title, record.externalId, record.id,
      ].some((value) => String(value || '').toLocaleLowerCase().includes(normalizedQuery)))
      return {
        items: records,
        mode: 'legacy-postgres',
        pageInfo: { pageSize: legacy?.pageSize || pageSize, hasMore: false, nextCursor: null },
      }
    }
  }, [cursor, datasetId, objectType, page, platform, query, requestedSearchProfile, searchRevision, token])
  const recordsState = useRemoteData(loadRecords, onUnauthorized)
  const refreshAfterReindex = useCallback(() => {
    state.refresh()
    recordsState.refresh()
  }, [recordsState.refresh, state.refresh])

  const recordsPage = recordPage(recordsState.data, pageSize)
  const records = recordsPage.items
  const searchExecution = recordsState.data?.searchExecution && typeof recordsState.data.searchExecution === 'object'
    ? recordsState.data.searchExecution
    : null
  // `data.sample` is accepted only as a rolling-contract compatibility shape.
  // The server contract guarantees that it has already passed the public
  // allowlist; this UI never derives a public sample from an admin record.
  const safeSearchSample = recordsState.data?.sample ?? null
  const currentPage = recordsPage.page ?? cursorHistory.length + 1
  const numberedPagination = recordsPage.page != null
    && recordsPage.total != null
    && recordsPage.totalPages != null
  const stats = data.stats || {}
  const platforms = useMemo(() => [...new Set(datasets.flatMap((dataset) => asArray(dataset.platforms)))].sort(), [datasets])
  const objectTypes = useMemo(() => [...new Set(datasets.flatMap((dataset) => asArray(dataset.objectTypes)))].sort(), [datasets])
  const searchProfileOptions = searchProfiles.length
    ? searchProfiles.map((profile) => ({
      value: profile.id,
      label: `${profile.label || profile.id}${profile.id === defaultSearchProfile || profile.default ? '（默认）' : ''}${profile.ready === false ? `（未就绪${profile.requiredIndexSchema ? `：需 ${profile.requiredIndexSchema}` : ''}）` : ''}`,
      disabled: profile.ready === false,
    }))
    : [{
      value: defaultSearchProfile,
      label: defaultSearchProfile ? `${defaultSearchProfile}（服务端默认）` : '服务端默认（兼容模式）',
    }]

  const resetPagination = () => {
    setPage(1)
    setCursor(null)
    setCursorHistory([])
  }

  useEffect(() => {
    if (!searchProfile || searchProfile === effectiveSearchProfile) return
    setSearchProfile(effectiveSearchProfile)
    resetPagination()
  }, [effectiveSearchProfile, searchProfile])

  const changeFilter = (setter) => (value) => {
    setter(value)
    resetPagination()
  }

  const changeSearchProfile = (value) => {
    setSearchProfile(value)
    resetPagination()
  }

  const search = (event) => {
    event.preventDefault()
    setQuery(queryDraft.trim())
    resetPagination()
    setSearchRevision((revision) => revision + 1)
  }

  const nextPage = () => {
    if (numberedPagination) {
      const lastPage = Math.min(recordsPage.totalPages, recordsPage.maxDirectPage ?? recordsPage.totalPages)
      if (currentPage < lastPage) setPage(currentPage + 1)
      return
    }
    if (!recordsPage.nextCursor) return
    setCursorHistory((history) => [...history, cursor])
    setCursor(recordsPage.nextCursor)
  }

  const previousPage = () => {
    if (numberedPagination) {
      if (currentPage > 1) setPage(currentPage - 1)
      return
    }
    if (cursorHistory.length === 0) return
    const previous = cursorHistory.at(-1)
    setCursorHistory((history) => history.slice(0, -1))
    setCursor(previous)
  }

  const changeRecordsPage = (nextPageNumber) => {
    if (numberedPagination) {
      setCursor(null)
      setCursorHistory([])
      setPage(nextPageNumber)
      return
    }
    if (nextPageNumber === currentPage - 1) previousPage()
    if (nextPageNumber === currentPage + 1) nextPage()
  }

  if (state.loading && !state.data) return <LoadingState label="正在读取 canonical 数据目录" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading
        eyebrow="CANONICAL DATA / LINEAGE / PROJECTION"
        title="数据中心"
        description="以 PostgreSQL canonical current truth 为准查看数据集和记录；Elasticsearch 只是可重建的搜索投影。"
        loading={state.loading || recordsState.loading}
        onRefresh={() => { state.refresh(); recordsState.refresh() }}
      />

      <div className="mih-metric-grid">
        <MetricCard icon={Stack} label="数据集" value={formatNumber(stats.datasetCount ?? datasets.length)} hint="按 dataset_id 聚合" />
        <MetricCard icon={Database} label="当前记录" value={formatNumber(stats.activeRecordCount ?? 0)} hint="排除 tombstone" />
        <MetricCard icon={ClockCounterClockwise} label="历史修订" value={formatNumber(stats.revisionCount ?? 0)} hint="可追溯版本" />
        <MetricCard icon={Archive} label="已删除记录" value={formatNumber(stats.deletedRecordCount ?? 0)} hint="源端 tombstone；Hub 保留证据而非物理删除" tone={stats.deletedRecordCount ? 'warning' : 'primary'} />
      </div>

      <SearchReindexControl token={token} onUnauthorized={onUnauthorized} onReindexed={refreshAfterReindex} />

      <Panel title="检索与筛选" subtitle="浏览与游标分页走 PostgreSQL；关键词搜索优先 Elasticsearch、故障时回退 PostgreSQL，详情始终回读完整 canonical record">
        <form className="mih-data-center-search" onSubmit={search}>
          <label className="qp-field mih-data-center-search__query">
            <span className="qp-field__label">记录搜索</span>
            <span className="mih-search-input">
              <MagnifyingGlass size={17} aria-hidden="true" />
              <input className="qp-input" value={queryDraft} placeholder="标题、正文或 external ID"
                onChange={(event) => setQueryDraft(event.target.value)} />
            </span>
          </label>
          <button className="qp-button" type="submit" disabled={recordsState.loading}>搜索</button>
          {query ? <button className="qp-button qp-button--ghost" type="button" onClick={() => {
            setQueryDraft('')
            setQuery('')
            resetPagination()
          }}>清除搜索</button> : null}
        </form>
        <div className="mih-filter-bar">
          <DropdownField label="Dataset" value={datasetId} onChange={changeFilter(setDatasetId)} options={[
            { value: '', label: '全部数据集' },
            ...datasets.map((dataset) => ({ value: dataset.datasetId, label: dataset.datasetId })),
          ]} />
          <DropdownField label="平台" value={platform} onChange={changeFilter(setPlatform)} options={[
            { value: '', label: '全部平台' },
            ...platforms.map((value) => ({ value, label: value })),
          ]} />
          <DropdownField label="对象类型" value={objectType} onChange={changeFilter(setObjectType)} options={[
            { value: '', label: '全部类型' },
            ...objectTypes.map((value) => ({ value, label: value })),
          ]} />
          <DropdownField label="搜索策略" value={effectiveSearchProfile} onChange={changeSearchProfile}
            disabled={!searchProfiles.length} options={searchProfileOptions} />
        </div>
        {selectedSearchProfile?.summary ? (
          <p className="mih-search-profile-summary" role="status" aria-live="polite">
            <span className="qp-tag qp-tag--primary">
              {selectedSearchProfile.id === defaultSearchProfile || selectedSearchProfile.default ? 'API 默认' : '本次选择'}
            </span>
            <strong>{selectedSearchProfile.label || selectedSearchProfile.id}</strong>
            <span>{selectedSearchProfile.summary}</span>
          </p>
        ) : null}
        {[...new Set([
          selectedSearchProfile?.warning,
          searchExecution?.warning,
          query && !searchExecution?.warning
            && /postgres/iu.test(searchExecution?.mode || recordsState.data?.mode || '')
            ? 'Elasticsearch 当前不可用，本次搜索已回退 PostgreSQL substring/trigram；所选 Elasticsearch profile 未完整应用。'
            : null,
        ].filter(Boolean))].map((warning) => (
          <div className="mih-inline-warning" role="status" aria-live="polite" key={warning}>
            <WarningCircle size={18} weight="duotone" aria-hidden="true" />
            <span>{warning}</span>
          </div>
        ))}
        <SearchLab capabilities={searchCapabilities} selectedProfile={selectedSearchProfile}
          execution={searchExecution} recordsMode={recordsState.data?.mode} query={query}
          safeSample={safeSearchSample} />
      </Panel>

      {datasets.length ? (
        <Panel title="数据集合" subtitle={`${formatNumber(datasets.length)} 个 canonical dataset`}>
          <DataTable label="数据集目录">
            <thead><tr><th>Dataset</th><th>平台 / 类型</th><th>当前记录</th><th>修订</th><th>最近采集</th><th /></tr></thead>
            <tbody>
              {datasets.map((dataset) => (
                <tr key={dataset.datasetId}>
                  <td><strong>{dataset.datasetId}</strong><small>{asArray(dataset.contentTypes).join(' · ') || '未声明 content type'}</small></td>
                  <td>{asArray(dataset.platforms).join(' · ') || '—'}<small>{asArray(dataset.objectTypes).join(' · ') || '—'}</small></td>
                  <td>{formatNumber(dataset.activeRecordCount || 0)}<small>{dataset.deletedRecordCount ? `${formatNumber(dataset.deletedRecordCount)} 条 tombstone` : '无 tombstone'}</small></td>
                  <td>{formatNumber(dataset.revisionCount || 0)}</td>
                  <td>{formatDate(dataset.lastCollectedAt || dataset.lastEventAt)}</td>
                  <td><button className="qp-button qp-button--ghost" type="button" onClick={() => {
                    setDatasetId(dataset.datasetId)
                    resetPagination()
                  }}>查看记录</button></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Panel>
      ) : (
        <EmptyState icon={Stack} title="还没有 canonical 数据" description="先从外部数据源导入或运行已配置的业务清洗任务。" />
      )}

      <Panel title="Canonical records" subtitle={`服务端分页 · 第 ${formatNumber(currentPage)}${recordsPage.totalPages != null ? ` / ${formatNumber(recordsPage.totalPages)}` : ''} 页 · 本页 ${formatNumber(records.length)} 条${recordsPage.total != null ? ` / 共 ${formatNumber(recordsPage.total)} 条` : ''}`}>
        {recordsState.error ? <ErrorState error={recordsState.error} onRetry={recordsState.refresh} /> : null}
        {!recordsState.error && recordsState.loading && !recordsState.data ? <LoadingState label="正在读取 canonical records" /> : null}
        {!recordsState.error && records.length ? (
          <DataTable label="canonical records">
            <thead><tr>
              <th>记录</th><th>Dataset</th><th>平台 / 类型</th><th>版本</th>
              <th>
                <button className="mih-sort-toggle" type="button"
                  onClick={() => { setSort(nextSort(sort, query)); setPage(1); setCursor(null) }}
                  title={sortHint(sort)}
                  aria-label={`时间排序：${sortLabel(sort)}，点击切换`}>
                  时间<span aria-hidden="true">{sortGlyph(sort)}</span>
                </button>
              </th>
              <th>状态</th><th />
            </tr></thead>
            <tbody>
              {records.map((record) => {
                const titleHighlights = highlightValues(record, 'title')
                const bodyHighlights = highlightValues(record, 'body')
                const snippet = record.snippet || record.bodySnippet
                  || (record.body ? `${String(record.body).slice(0, 220)}${String(record.body).length > 220 ? '…' : ''}` : null)
                return <tr key={record.id}>
                  <td className="mih-record-cell">
                    <strong title={recordTitle(record)}><HighlightedValue values={titleHighlights} fallback={recordTitle(record).slice(0, 96)} /></strong>
                    {(bodyHighlights.length || snippet) ? <p><HighlightedValue values={bodyHighlights} fallback={snippet} /></p> : null}
                    <small>{record.externalId || record.id}</small>
                  </td>
                  <td><code className="mih-source-label">{record.datasetId}</code></td>
                  <td>{record.platform}<small>{record.objectType}{record.contentType ? ` · ${record.contentType}` : ''}</small></td>
                  <td>r{formatNumber(record.currentRevision || 1)}</td>
                  <td>{formatDate(record.eventTime || record.collectedAt)}</td>
                  <td><StatusBadge status={record.deletedAt ? 'disabled' : 'active'} label={record.deletedAt ? '已删除' : '当前'} /></td>
                  <td><button className="qp-button qp-button--ghost" type="button" onClick={() => setSelectedRecord(record)}>查看完整记录</button></td>
                </tr>
              })}
            </tbody>
          </DataTable>
        ) : null}
        {!recordsState.error && !recordsState.loading && records.length === 0 ? (
          <EmptyState icon={FileText} title="当前搜索与筛选没有记录" description="调整关键词、Dataset、平台或对象类型后重试。" />
        ) : null}
        {!recordsState.error && recordsState.data ? (
          <Pagination page={currentPage} pageSize={recordsPage.pageSize} total={recordsPage.total}
            totalPages={recordsPage.totalPages} maxDirectPage={recordsPage.maxDirectPage}
            hasMore={numberedPagination
              ? recordsPage.hasMore && (recordsPage.maxDirectPage == null || currentPage < recordsPage.maxDirectPage)
              : recordsPage.hasMore && Boolean(recordsPage.nextCursor)}
            loading={recordsState.loading} onPageChange={changeRecordsPage}
            label="canonical records 分页" />
        ) : null}
      </Panel>

      {selectedRecord ? (
        <Modal title={recordTitle(selectedRecord)}
          description={`Admin canonical truth · ${selectedRecord.datasetId} · ${selectedRecord.platform} · ${selectedRecord.objectType}`}
          size="xlarge" onClose={() => setSelectedRecord(null)}
          footer={<button className="qp-button qp-button--ghost" type="button" onClick={() => setSelectedRecord(null)}>关闭</button>}>
          <div className="mih-record-detail">
            {highlightValues(selectedRecord, 'title').length || highlightValues(selectedRecord, 'body').length ? (
              <article className="mih-record-highlight">
                <strong>Elasticsearch highlight</strong>
                {highlightValues(selectedRecord, 'title').map((value, index) => <p key={`title:${index}`}>{highlightedParts(value)}</p>)}
                {highlightValues(selectedRecord, 'body').map((value, index) => <p key={`body:${index}`}>{highlightedParts(value)}</p>)}
              </article>
            ) : null}
            {selectedRecord.body != null ? (
              <article className="mih-record-body">
                <strong>完整正文</strong>
                <pre>{String(selectedRecord.body)}</pre>
              </article>
            ) : null}
            <article className="mih-record-json">
              <strong>完整 canonical JSON</strong>
              <pre className="mih-code-block">{JSON.stringify(selectedRecord, null, 2)}</pre>
            </article>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
