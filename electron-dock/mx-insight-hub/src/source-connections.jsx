import { useCallback, useMemo, useState } from 'react'
import { Database, FlowArrow, MagnifyingGlass, Stack } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField, EmptyState, ErrorState, LoadingState, MetricCard, Modal, Pagination, formatDate, useRemoteData } from './components.jsx'

const MODES = { live: '实时接口', compatibility: '历史兼容', stored: '清洗入库' }
const options = values => [{ value: '', label: '全部' }, ...values.map(value => ({ value, label: value }))]
const SOURCE_STATUS = { active: '已启用', paused: '已暂停', draft: '草稿', disabled: '未启用', retired: '已退役', not_registered: '未登记' }

export function useSourceConnections(token, onUnauthorized) {
  const load = useCallback(() => adminApi.sourceConnections(token), [token])
  return useRemoteData(load, onUnauthorized)
}

export function SourceConnectionsPanel({ state, initialProvider = '' }) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState('')
  const [provider, setProvider] = useState(initialProvider)
  const [product, setProduct] = useState('')
  const [keywordOnly, setKeywordOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState(null)
  const rows = state.data?.routes || []
  const providers = [...new Set(rows.map(row => row.sourceProviderLabel))].sort()
  const products = [...new Set(rows.map(row => row.product))].sort()
  const filtered = useMemo(() => rows.filter(row => (!mode || row.mode === mode)
    && (!provider || row.sourceProviderLabel === provider)
    && (!product || row.product === product)
    && (!keywordOnly || row.keywordSearch)
    && [row.platformLabel, row.platform, row.product, row.sourceLabel, row.operation, row.path, ...row.datasets]
      .join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [rows, mode, provider, product, keywordOnly, query])
  const totalPages = Math.max(1, Math.ceil(filtered.length / 10))
  const currentPage = Math.min(page, totalPages)
  const update = setter => value => { setter(value); setPage(1) }
  const summary = state.data?.summary

  return <section className="mih-source-connections" aria-label="已实现接入与查询路径">
    {summary ? <div className="mih-metric-grid">
      <MetricCard icon={FlowArrow} label="已实现接口 / 清洗路径" value={summary.routes} hint="代码合同清单 · 非实时健康" />
      <MetricCard icon={Stack} label="关联活动目录条目" value={summary.catalogEntries} hint="按稳定目录 ID 关联 · 不改人工覆盖状态" />
      <MetricCard icon={MagnifyingGlass} label="支持关键词的路径" value={summary.keywordRoutes} hint="含兼容搜索和入库检索 · 未聚合执行" />
      <MetricCard icon={Database} label="已登记清洗输入" value={summary.registeredInputs} hint="来自当前 Hub · 登记不代表清洗成功" />
    </div> : null}
    <section className="qp-panel mih-source-connection-list">
      <header className="mih-source-connection-toolbar">
        <div><h2>已实现接入与查询路径</h2><p>同一平台可有多个来源。默认路径按操作和请求形状确定，列表顺序不改变实际路由。</p></div>
        <button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={state.loading} onClick={state.refresh}>刷新接入清单</button>
      </header>
      <div className="mih-connection-controls">
        <label className="qp-field"><span className="qp-field__label">搜索平台、产品或接口</span><input className="qp-input" value={query} onChange={event => update(setQuery)(event.target.value)} placeholder="小红书 / telegram / 商品" /></label>
        <DropdownField label="数据来源" value={provider} options={options(providers)} onChange={update(setProvider)} />
        <DropdownField label="数据产品" value={product} options={options(products)} onChange={update(setProduct)} />
        <DropdownField label="接入方式" value={mode} options={[{ value: '', label: '全部方式' }, ...Object.entries(MODES).map(([value, label]) => ({ value, label }))]} onChange={update(setMode)} />
        <label className="mih-connection-checkbox"><input type="checkbox" checked={keywordOnly} onChange={event => update(setKeywordOnly)(event.target.checked)} />仅显示关键词搜索</label>
      </div>
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {state.loading && !state.data ? <LoadingState label="读取本地接入合同与清洗登记" /> : null}
      {state.data ? <>
        <div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table mih-connection-table"><thead><tr><th>平台 / 产品</th><th>数据来源</th><th>查询能力</th><th>现行默认路径与边界</th><th>证据</th></tr></thead><tbody>
          {filtered.slice((currentPage - 1) * 10, currentPage * 10).map(row => <tr key={row.id}>
            <td><strong>{row.platformLabel}</strong><small>{row.product}</small><small>{row.platform}</small></td>
            <td><strong>{row.sourceProviderLabel}</strong><small>{MODES[row.mode]}</small>{row.inputs.length ? <small>{row.inputs.filter(input => input.registered).length} / {row.inputs.length} 输入已登记</small> : <small>运行状态未探测</small>}</td>
            <td><span className="qp-tag">{row.keywordSearch ? '关键词检索' : '专用参数查询'}</span><small>{row.label || row.operation}</small></td>
            <td>{row.defaultRule}</td>
            <td><button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => setDetail(row)}>查看路径</button></td>
          </tr>)}
        </tbody></table></div>
        {!filtered.length ? <EmptyState icon={MagnifyingGlass} title="暂无已核对的接入路径" description="目录线索不代表接口已实现；例如新闻分类不能证明每个新闻站点均可实时搜索。" /> : null}
        <Pagination page={currentPage} pageSize={10} total={filtered.length} totalPages={totalPages} hasMore={currentPage < totalPages} onPageChange={setPage} label="接入路径分页" />
      </> : null}
      <div className="mih-connection-notes"><p>此页只读 Hub 本地元数据，不探测上游、不采集、不计费。接口实现、清洗登记、数据覆盖、运行健康分别核验。</p><p>清单核对：{state.data?.reviewedAt || '—'} · 本地登记读取：{formatDate(state.data?.generatedAt)} · <a href="#/external-platforms">上游调用次数、成本与策略</a> · <a href="#/sources">清洗任务与数据流向</a></p></div>
    </section>
    {detail ? <Modal title={`${detail.platformLabel} · ${detail.product}`} size="large" onClose={() => setDetail(null)} footer={<button type="button" className="qp-button qp-button--primary" onClick={() => setDetail(null)}>关闭</button>}>
      <div className="mih-form mih-connection-detail"><p>{detail.defaultRule}</p><h3>现有 Hub 接口</h3><code>{detail.path}</code><p>操作：{detail.operation} · {detail.keywordSearch ? '支持关键词' : '须按专用合同提交参数'}</p>
        <h3>数据流向</h3><p>{detail.sourceProviderLabel} → {detail.mode === 'stored' ? '清洗 → Hub 已存数据' : 'Hub 受控接口与交付证据'} → {detail.product}</p>
        <p>{detail.datasets.length ? detail.datasets.join('、') : '使用专用交付合同；不宣称进入共享全文检索。'}</p>
        {detail.inputs.length ? <ul>{detail.inputs.map(input => <li key={input.key}>{input.key}：{SOURCE_STATUS[input.status] || input.status}</li>)}</ul> : null}
        <h3>权限与证据</h3><p>调用仍使用原 API Key 的平台、操作和合同授权；目录可见不等于数据可读。文档与产品分组不新增授权。</p><p>实现依据：<code>{detail.evidence}</code></p><p>运行健康、可读记录数与上游账单未在此推测。</p>
      </div>
    </Modal> : null}
  </section>
}
