import { useCallback, useState } from 'react'
import { ChartBar, CaretDown } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, LoadingState, MetricCard, useRemoteData } from './components.jsx'
import { STRATEGY_SEARCH_INTERFACES } from './strategy-search-model.js'

const metrics = [
  { key: 'newObjects', label: '新增对象', note: '首次建立的对象' },
  { key: 'updatedObjects', label: '有更新的对象', note: '窗口内按对象去重' },
  { key: 'contentRevisions', label: '新增内容版本', note: '不含首次版本' },
  { key: 'observations', label: '入库观测', note: '保留的来源观测条数' },
  { key: 'observedObjects', label: '被观测对象', note: '窗口内按对象去重' },
]
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '未提供'
const objectType = value => ({ post: '内容', profile: '账号资料', message: '消息', article: '文章' }[value] || value)

export function StrategyDataStatistics({ token, onUnauthorized, interfaceId }) {
  const [visited, setVisited] = useState(false)
  return <details className="qp-panel mih-panel mih-strategy-data-statistics" onToggle={event => { if (event.currentTarget.open) setVisited(true) }}>
    <summary><ChartBar size={22} weight="duotone" aria-hidden="true" /><span><strong>数据入库看板</strong><small>查看按实际入库日期记录的新增、更新与观测证据</small></span><CaretDown size={18} aria-hidden="true" /></summary>
    {visited ? <StrategyDataStatisticsPanel {...{ token, onUnauthorized, interfaceId }} /> : null}
  </details>
}

function StrategyDataStatisticsPanel({ token, onUnauthorized, interfaceId }) {
  const [days, setDays] = useState(7), [metric, setMetric] = useState('newObjects')
  const load = useCallback(() => adminApi.strategySearchDataStatistics(token, days), [token, days])
  const remote = useRemoteData(load, onUnauthorized)
  const data = remote.data?.data || remote.data
  const rows = (data?.items || []).filter(item => item.interface === interfaceId)
  const selectedMetric = metrics.find(item => item.key === metric)
  const interfaceLabel = STRATEGY_SEARCH_INTERFACES.find(item => item.id === interfaceId)?.label || interfaceId
  return <div className="mih-strategy-data-statistics-body">
    <header><div><h3>实际入库与版本变化</h3><p>调用次数、返回条数、入库观测和新增对象分别统计；只读这些证据不会重新采集。</p></div><div className="mih-page-actions">
      <DropdownField label="统计范围" value={String(days)} onChange={value => setDays(Number(value))} disabled={remote.loading} options={[7, 14, 31].map(value => ({ value: String(value), label: `最近 ${value} 天` }))} />
      <button className="qp-button qp-button--outline" type="button" disabled={remote.loading} onClick={remote.refresh}>{remote.loading ? '读取中…' : '刷新入库统计'}</button></div></header>
    {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
    {!data && remote.loading ? <LoadingState label="正在读取已保存的入库证据" /> : null}
    {data?.available === false ? <div className="mih-strategy-readonly"><strong>当前没有可统计的持久化入库证据</strong><p>{data.reason || '当前部署尚不支持此统计；不会将缺失证据显示为零。'}</p></div> : data?.available === true ? <>
      <p>{data.fromDay} 至 {data.throughDay} · {data.timeZone || 'Asia/Shanghai'} · 今日数据尚未完整</p>
      <div><h4>本窗口全部策略接口</h4><p>对象计数在整个窗口去重；下面逐日或分组数据不能相加重建这些总数。</p></div>
      <div className="mih-strategy-data-metrics">{metrics.map(item => <MetricCard key={item.key} icon={ChartBar} label={item.label} value={count(data.summary?.[item.key])} hint={item.note} />)}</div>
      <div className="mih-strategy-data-table-heading"><div><h4>{interfaceLabel} · 每日入库</h4><p>按平台与对象类型展示；日期为实际入库日，供应商返回或原文发布日期不作为入库日期。</p></div>
        <DropdownField label="每日指标" value={metric} onChange={setMetric} options={metrics.map(item => ({ value: item.key, label: item.label }))} /></div>
      <div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table"><thead><tr><th>平台</th><th>对象类型</th><th>本窗口{selectedMetric.label}</th>{(data.days || []).map(day => <th key={day}>{day.slice(5)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${row.interface}:${row.platform}:${row.objectType}:${index}`}><td>{row.platform === 'unspecified' ? '未指定平台' : row.platform}</td><td>{objectType(row.objectType)}</td><td>{count(row.total?.[metric])}</td>{(data.days || []).map(day => <td key={day}>{count(row.daily?.find(point => point.day === day)?.[metric])}</td>)}</tr>)}</tbody>
      </table></div>
      {!rows.length ? <p>此窗口未找到与当前业务接口关联的入库证据；不据此推断接口没有调用或没有返回内容。</p> : null}
    </> : null}
    {data?.notes?.length ? <div className="mih-strategy-usage-boundary">{data.notes.slice(0, 2).map((note, index) => <p key={index}>{note}</p>)}</div> : null}
    {data?.processing ? <div className="mih-strategy-data-processing"><strong>处理队列</strong><p>{data.processing.available === false ? data.processing.reason || '当前没有可准确归属到这些接口的队列统计，待处理和失败数量暂不显示。' : '处理状态以服务端提供的独立证据为准。'}</p></div> : null}
    {data?.notes?.length > 2 ? <details><summary>更多统计口径</summary><div className="mih-strategy-usage-notes">{data.notes.slice(2).map((note, index) => <p key={index}>{note}</p>)}</div></details> : null}
    <a href="#/data-center">查看数据中心中的记录、版本与来源证据 ↗</a>
  </div>
}
