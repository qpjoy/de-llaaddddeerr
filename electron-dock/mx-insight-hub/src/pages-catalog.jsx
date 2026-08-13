import { useCallback, useMemo, useState } from 'react'
import {
  Archive,
  ClockCounterClockwise,
  Database,
  FileText,
  MagnifyingGlass,
  Stack,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  EmptyState,
  DropdownField,
  ErrorState,
  LoadingState,
  MetricCard,
  Modal,
  PageHeading,
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
  return {
    items,
    pageSize: Number(pageInfo.pageSize ?? value?.pageSize ?? fallbackPageSize),
    hasMore: Boolean(pageInfo.hasMore ?? value?.hasMore ?? nextCursor),
    nextCursor,
    total: pageInfo.total ?? value?.total ?? null,
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
  const [cursor, setCursor] = useState(null)
  const [cursorHistory, setCursorHistory] = useState([])
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const pageSize = 50

  const loadCatalog = useCallback(() => adminApi.dataCenter(token, { pageSize: 1 }), [token])
  const state = useRemoteData(loadCatalog, onUnauthorized)
  const loadRecords = useCallback(async () => {
    const filters = {
      q: query || undefined,
      datasetId: datasetId || undefined,
      platform: platform || undefined,
      objectType: objectType || undefined,
      pageSize,
      cursor: cursor || undefined,
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
  }, [cursor, datasetId, objectType, platform, query, searchRevision, token])
  const recordsState = useRemoteData(loadRecords, onUnauthorized)

  const data = state.data || {}
  const datasets = asArray(data.datasets)
  const recordsPage = recordPage(recordsState.data, pageSize)
  const records = recordsPage.items
  const stats = data.stats || {}
  const platforms = useMemo(() => [...new Set(datasets.flatMap((dataset) => asArray(dataset.platforms)))].sort(), [datasets])
  const objectTypes = useMemo(() => [...new Set(datasets.flatMap((dataset) => asArray(dataset.objectTypes)))].sort(), [datasets])

  const resetPagination = () => {
    setCursor(null)
    setCursorHistory([])
  }

  const changeFilter = (setter) => (value) => {
    setter(value)
    resetPagination()
  }

  const search = (event) => {
    event.preventDefault()
    setQuery(queryDraft.trim())
    resetPagination()
    setSearchRevision((revision) => revision + 1)
  }

  const nextPage = () => {
    if (!recordsPage.nextCursor) return
    setCursorHistory((history) => [...history, cursor])
    setCursor(recordsPage.nextCursor)
  }

  const previousPage = () => {
    if (cursorHistory.length === 0) return
    const previous = cursorHistory.at(-1)
    setCursorHistory((history) => history.slice(0, -1))
    setCursor(previous)
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
        </div>
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

      <Panel title="Canonical records" subtitle={`服务端分页 · 第 ${formatNumber(cursorHistory.length + 1)} 页 · 本页 ${formatNumber(records.length)} 条${recordsPage.total != null ? ` / 共 ${formatNumber(recordsPage.total)} 条` : ''}`}>
        {recordsState.error ? <ErrorState error={recordsState.error} onRetry={recordsState.refresh} /> : null}
        {!recordsState.error && recordsState.loading && !recordsState.data ? <LoadingState label="正在读取 canonical records" /> : null}
        {!recordsState.error && records.length ? (
          <DataTable label="canonical records">
            <thead><tr><th>记录</th><th>Dataset</th><th>平台 / 类型</th><th>版本</th><th>时间</th><th>状态</th><th /></tr></thead>
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
          <footer className="mih-pagination" aria-label="canonical records 分页">
            <span>每页 {formatNumber(recordsPage.pageSize)} 条 · 第 {formatNumber(cursorHistory.length + 1)} 页</span>
            <div>
              <button className="qp-button qp-button--ghost" type="button" disabled={recordsState.loading || cursorHistory.length === 0}
                onClick={previousPage}>上一页</button>
              <button className="qp-button qp-button--ghost" type="button" disabled={recordsState.loading || !recordsPage.hasMore || !recordsPage.nextCursor}
                onClick={nextPage}>下一页</button>
            </div>
          </footer>
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
