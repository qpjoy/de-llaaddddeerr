import { useCallback, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, PageHeading, useRemoteData } from './components.jsx'
const providers = { justone: 'JustOne', tikhub: 'TikHub' }

function DefaultRouteForm({ token, row, onSaved }) {
  const [adapterId, setAdapterId] = useState(row.configurationValid ? row.defaultRoute.id : row.candidates[0]?.id || '')
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  async function save(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      await adminApi.updateEcommerceRoute(token, row.marketplace, { adapterId, expectedRevision: row.revision, reason })
      onSaved()
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }
  return <form onSubmit={save}>
    <DropdownField label="默认适配接口" value={adapterId} onChange={setAdapterId} disabled={busy}
      options={row.candidates.map(candidate => ({ value: candidate.id, label: `${providers[candidate.provider]} · ${candidate.upstreamPath}` }))} />
    <Field label="变更原因"><input className="qp-input" required maxLength={1000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} placeholder="记录选择此接口的原因" /></Field>
    <p>配置版本 {row.revision} · {row.reason || '初始路由'}。默认配置用于新搜索；已有游标沿用原适配器，原幂等请求继续重放。</p>
    {error ? <ErrorState error={error} /> : null}
    <button className="qp-button qp-button--primary" disabled={busy || !reason.trim() || !row.revision}>{busy ? '保存中…' : '保存默认路由'}</button>
    {!row.revision ? <p>需先安装路由配置迁移。</p> : null}
  </form>
}

export function EcommerceRoutingPage({ token, query, setQuery, onUnauthorized }) {
  const load = useCallback(() => adminApi.ecommerceRouting(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const selected = query.get('marketplace') || 'taobao'
  const row = remote.data?.items?.find(item => item.marketplace === selected)
  return <>
    <PageHeading title="电商平台与上游接口" description="查看各平台的统一适配器、当前默认上游和平台专用接口。" loading={remote.loading} onRefresh={remote.refresh} />
    <section className="qp-panel mih-panel" style={{ display: 'block', padding: 20, minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
      {remote.error ? <ErrorState error={remote.error} /> : null}
      {!remote.data && !remote.error ? <p role="status">正在读取电商接口目录…</p> : null}
      {remote.data ? <DropdownField label="电商平台" value={selected} onChange={value => setQuery({ domain: 'ecommerce', marketplace: value })}
        options={remote.data.items.map(item => ({ value: item.marketplace, label: item.label }))} /> : null}
      {row ? <>
        <h2>{row.label}</h2>
        <h3>统一商品搜索 · 默认路由</h3>
        {row.defaultRoute ? <>
          {!row.configurationValid && row.revision ? <p role="alert">已保存的默认接口不可用；新采集已阻止。请选择兼容适配器并保存修复。</p> : null}
          <p>上游供应商：<strong>{providers[row.defaultRoute.provider] || row.defaultRoute.provider}</strong></p>
          <p>适配接口：<code>{row.defaultRoute.upstreamPath}</code></p>
          <p>适配器：<code>{row.defaultRoute.adapter}</code> · <code>{row.defaultRoute.adapterVersion}</code></p>
          <p>下游合同：<code>{row.defaultRoute.contractVersion}</code></p>
          <p>当前只有一个兼容适配器，暂无可切换的默认接口。平台专用版本需完成字段、筛选和分页适配后，才能作为默认路由候选。</p>
          <DefaultRouteForm key={`${row.marketplace}:${row.revision}`} token={token} row={row} onSaved={remote.refresh} />
        </> : <p>尚无统一商品搜索适配器。{row.endpoints.length ? '下列接口按各自合同调用。' : '尚无可调用的电商接口合同。'}</p>}
        <h3>平台专用接口 · {row.endpoints.length} 项</h3>
        {row.marketplace === 'kuaishou_ec' ? <p>购物榜单与品牌榜单使用子分类参数，没有商品关键词搜索或分页参数；不把榜单条目当作统一商品列表。</p> : null}
        <div className="qp-table-wrap mih-table-wrap" style={{ maxWidth: '100%', overflowX: 'auto' }}><table className="qp-table mih-table"><thead><tr><th>接口 / 供应商</th><th>上游路径</th><th>适配状态</th><th>管理</th></tr></thead>
          <tbody>{row.endpoints.map(endpoint => <tr key={endpoint.key}>
            <td>{endpoint.summary}<br /><strong>{providers[endpoint.provider] || endpoint.provider}</strong></td>
            <td><code>{endpoint.upstreamPath}</code></td><td>原生合同 · 不替代统一商品搜索</td>
            <td><a className="qp-button qp-button--ghost qp-button--sm" href={`#/data-products/ecommerce-treasure-box?endpoint=${encodeURIComponent(endpoint.key)}`}>接口调试</a><br /><a className="qp-button qp-button--ghost qp-button--sm" href={`#/external-platforms?provider=${encodeURIComponent(endpoint.provider)}`}>启用与采购配置</a></td>
          </tr>)}</tbody></table></div>
        <p>目录不代表已启用。实际调用仍检查当前 Key 授权、操作状态、采购价格和余额；浏览目录不发起采集。</p>
      </> : remote.data ? <p>未找到该电商平台。</p> : null}
    </section>
  </>
}
