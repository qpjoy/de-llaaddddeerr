import { useEffect, useRef, useState } from 'react'
import { ArrowClockwise, DownloadSimple, MagnifyingGlass } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { DropdownField } from './components.jsx'
import { DemoCredentialRecheck } from './demo-credentials.jsx'
import { IP_RISK_STATES, ipRiskHistorySummary, riskTone, riskValue, riskTime } from './ip-risk-view.js'

export function IpRiskHistoryPanel({ apiKey, enabled, revision, active, busy, onOpen, onExport }) {
  const [draft, setDraft] = useState(''), [state, setState] = useState(''), [level, setLevel] = useState('')
  const [filter, setFilter] = useState({ q: '', state: '', level: '' }), [refresh, setRefresh] = useState(0)
  const [cursors, setCursors] = useState([null]), [page, setPage] = useState(0)
  const [data, setData] = useState(null), [error, setError] = useState(null), [loading, setLoading] = useState(false)
  const previousRevision = useRef(revision)
  const cursor = cursors[page]
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision
      setCursors([null]); setPage(0); setRefresh(value => value + 1)
    }
  }, [revision])
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setError(null)
    if (!enabled || !apiKey) { setLoading(false); return () => controller.abort() }
    setLoading(true)
    publicDataApi.ipRiskHistory(apiKey, { ...filter, limit: 10, cursor: cursor || undefined }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result.payload) })
      .catch(failure => { if (!controller.signal.aborted) setError(failure) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [apiKey, enabled, filter, cursor, refresh])
  const rows = (data?.items || []).map(ipRiskHistorySummary)
  const levels = [...new Set([level, ...rows.map(row => row.profile?.risk_level)].filter(Boolean))]
  const reload = () => { setCursors([null]); setPage(0); setRefresh(value => value + 1) }
  return <section className="qp-panel mih-ip-history" aria-label="历史查询记录">
    <header><div><h2>历史查询记录</h2><p>按当前调用身份保存；刷新或重新登录后仍可回看。查看历史不会重新查询，也不计入调用次数。</p></div><div className="mih-ip-actions">
      <button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={loading || !enabled} onClick={reload}><ArrowClockwise size={16} aria-hidden="true" />刷新历史</button>
      <button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={!rows.length} onClick={() => onExport(rows)}><DownloadSimple size={16} aria-hidden="true" />导出本页概要</button>
    </div></header>
    {data?.storage === 'memory' ? <p className="is-warning">当前为内存演示环境：页面刷新可恢复，服务重启会清空；正式环境使用数据库保存。</p> : null}
    <form className="mih-ip-history-filters mih-ip-history-search" onSubmit={event => { event.preventDefault(); setFilter({ q: draft.trim(), state, level }); reload() }}>
      <input aria-label="搜索历史记录" className="qp-input" type="search" maxLength={100} placeholder="搜索 IP、代理、标签、请求或批次编号" value={draft} onChange={event => setDraft(event.target.value)} />
      <DropdownField label="历史数据状态" value={state} options={[{ value: '', label: '全部状态' }, { value: 'success', label: '查询成功' }, { value: 'partial', label: '部分数据' }, { value: 'no_data', label: '暂无数据' }, { value: 'unknown', label: '待核对 / 处理中' }, { value: 'error', label: '失败 / 未派发' }]} onChange={setState} />
      <DropdownField label="历史风险等级" value={level} options={[{ value: '', label: '全部等级' }, ...levels.map(value => ({ value, label: value }))]} onChange={setLevel} />
      <button className="qp-button qp-button--outline" disabled={loading || !enabled}><MagnifyingGlass size={16} aria-hidden="true" />搜索历史</button>
    </form>
    {!enabled ? <p>请选择已授权的调用身份以查看历史。</p> : loading ? <p role="status">正在读取已保存的查询记录…</p> : error ? <div role="alert"><p>历史记录加载失败，不能据此判断记录为空。{error.status === 404 ? '请确认服务端已更新历史查询接口。' : error.message}</p><DemoCredentialRecheck /></div> : <>
      <div className="qp-table-wrap"><table className="qp-table mih-table mih-ip-table"><thead><tr><th>IP / 输入序号</th><th>数据状态</th><th>风险等级</th><th>风险评分</th><th>代理类型</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={(row.requestId && active?.requestId === row.requestId) || (row.batchId && active?.batchId === row.batchId && active?.index === row.index) ? 'is-selected' : ''}>
        <td><strong>{row.ip || (row.kind === 'batch' ? '未完成批次' : 'IP 未留存')}</strong>{row.batchId ? <small>{row.index >= 0 ? `批次第 ${row.index + 1} 项` : '原批次结果尚未完整保存'}</small> : null}<small><code>{row.requestId || row.batchId}</code></small></td>
        <td><span className={`mih-ip-badge is-${IP_RISK_STATES[row.status].tone}`}>{IP_RISK_STATES[row.status].label}</span></td><td className={`is-${riskTone(row.profile?.risk_level)}`}>{riskValue(row.profile?.risk_level)}</td><td>{riskValue(row.profile?.risk_score)}</td><td>{riskValue(row.profile?.proxy_type)}</td><td>{riskTime(row.createdAt)}</td>
        <td><button type="button" className="qp-button qp-button--ghost qp-button--sm" disabled={busy || !row.available} aria-label={`回看 ${row.ip || '批次'} 第 ${row.index + 1} 项`} onClick={() => onOpen(row)}>回看画像</button></td>
      </tr>)}</tbody></table></div>
      {!rows.length ? <p role="status">{filter.q || filter.state || filter.level ? '没有匹配的历史记录，请调整筛选。' : '当前调用身份尚无已保存记录。'}</p> : null}
      <nav className="mih-ip-history-pagination" aria-label="历史记录分页"><span>第 {page + 1} 页 · 本页 {rows.length} 项</span><button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={page === 0} onClick={() => setPage(value => value - 1)}>历史上一页</button><button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={!data?.nextCursor} onClick={() => { setCursors(value => [...value.slice(0, page + 1), data.nextCursor]); setPage(value => value + 1) }}>历史下一页</button></nav>
    </>}
  </section>
}
