import { useCallback, useMemo, useState } from 'react'
import {
  Archive,
  ClockCounterClockwise,
  Database,
  FileText,
  Stack,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
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
  // The catalog endpoint deliberately omits body/raw/extensions. A list page
  // must not turn record samples into an accidental bulk-content export.
  return record.title || record.externalId || record.id || '未命名记录'
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
  const load = useCallback(() => adminApi.dataCenter(token, {
    datasetId: datasetId || undefined,
    platform: platform || undefined,
    objectType: objectType || undefined,
    pageSize: 50,
  }), [token, datasetId, platform, objectType])
  const state = useRemoteData(load, onUnauthorized)

  const data = state.data || {}
  const datasets = asArray(data.datasets)
  const records = asArray(data.records)
  const stats = data.stats || {}
  const platforms = useMemo(() => [...new Set(datasets.flatMap((dataset) => asArray(dataset.platforms)))].sort(), [datasets])
  const objectTypes = useMemo(() => [...new Set(datasets.flatMap((dataset) => asArray(dataset.objectTypes)))].sort(), [datasets])

  if (state.loading && !state.data) return <LoadingState label="正在读取 canonical 数据目录" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading
        eyebrow="CANONICAL DATA / LINEAGE / PROJECTION"
        title="数据中心"
        description="以 PostgreSQL canonical current truth 为准查看数据集和记录；Elasticsearch 只是可重建的搜索投影。"
        loading={state.loading}
        onRefresh={state.refresh}
      />

      <div className="mih-metric-grid">
        <MetricCard icon={Stack} label="数据集" value={formatNumber(stats.datasetCount || datasets.length)} hint="按 dataset_id 聚合" />
        <MetricCard icon={Database} label="当前记录" value={formatNumber(stats.activeRecordCount || 0)} hint="排除 tombstone" />
        <MetricCard icon={ClockCounterClockwise} label="历史修订" value={formatNumber(stats.revisionCount || 0)} hint="可追溯版本" />
        <MetricCard icon={Archive} label="已删除记录" value={formatNumber(stats.deletedRecordCount || 0)} hint="保留删除证据" tone={stats.deletedRecordCount ? 'warning' : 'primary'} />
      </div>

      <Panel title="筛选" subtitle="数据集筛选同时作用于下方记录样例">
        <div className="mih-filter-bar">
          <Field label="Dataset">
            <select className="qp-select" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
              <option value="">全部数据集</option>
              {datasets.map((dataset) => <option value={dataset.datasetId} key={dataset.datasetId}>{dataset.datasetId}</option>)}
            </select>
          </Field>
          <Field label="平台">
            <select className="qp-select" value={platform} onChange={(event) => setPlatform(event.target.value)}>
              <option value="">全部平台</option>
              {platforms.map((value) => <option value={value} key={value}>{value}</option>)}
            </select>
          </Field>
          <Field label="对象类型">
            <select className="qp-select" value={objectType} onChange={(event) => setObjectType(event.target.value)}>
              <option value="">全部类型</option>
              {objectTypes.map((value) => <option value={value} key={value}>{value}</option>)}
            </select>
          </Field>
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
                  <td><button className="qp-button qp-button--ghost" type="button" onClick={() => setDatasetId(dataset.datasetId)}>查看记录</button></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Panel>
      ) : (
        <EmptyState icon={Stack} title="还没有 canonical 数据" description="先从外部数据源导入或运行已配置的业务清洗任务。" />
      )}

      <Panel title="最近记录" subtitle={`最多显示 ${formatNumber(data.pageSize || 50)} 条 PostgreSQL current truth；原始副本和敏感 extensions 不在此页展开`}>
        {records.length ? (
          <DataTable label="canonical 最近记录">
            <thead><tr><th>记录</th><th>Dataset</th><th>平台 / 类型</th><th>版本</th><th>时间</th><th>状态</th></tr></thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td><strong title={recordTitle(record)}>{recordTitle(record).slice(0, 96)}</strong><small>{record.externalId || record.id}</small></td>
                  <td><code className="mih-source-label">{record.datasetId}</code></td>
                  <td>{record.platform}<small>{record.objectType}{record.contentType ? ` · ${record.contentType}` : ''}</small></td>
                  <td>r{formatNumber(record.currentRevision || 1)}</td>
                  <td>{formatDate(record.eventTime || record.collectedAt)}</td>
                  <td><StatusBadge status={record.deletedAt ? 'disabled' : 'active'} label={record.deletedAt ? '已删除' : '当前'} /></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <EmptyState icon={FileText} title="当前筛选没有记录" description="调整 Dataset、平台或对象类型后重试。" />
        )}
      </Panel>
    </>
  )
}
