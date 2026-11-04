import { useCallback, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, PageHeading, useRemoteData } from './components.jsx'
import { ROUTE_PROVIDER_NAMES as providers, currentRouteStrategy, routeStrategies, routeStrategyLabel } from './ecommerce-route-strategies.js'
const candidateLabel = candidate => `${providers[candidate.provider] || candidate.provider} · ${candidate.channel || candidate.upstreamPath}`

export function DefaultRouteForm({ token, row, onSaved }) {
  const strategies = routeStrategies(row.candidates)
  const [choice, setChoice] = useState((currentRouteStrategy(row) ?? strategies[0])?.value || '')
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const strategy = strategies.find(item => item.value === choice) || null
  const mode = strategy?.mode || 'fixed'
  const candidateFor = id => row.candidates.find(candidate => candidate.id === id)
  async function save(event) {
    event.preventDefault()
    if (busy || !strategy) return
    setBusy(true); setError(null)
    try {
      await adminApi.updateEcommerceRoute(token, row.marketplace, { mode: strategy.mode, adapterId: strategy.adapterId,
        fallbackAdapterId: strategy.fallbackAdapterId, expectedRevision: row.revision, reason })
      onSaved()
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }
  return <form onSubmit={save}>
    <DropdownField label={row.switchable ? '路由策略' : '固定供应商'} value={choice} onChange={setChoice} disabled={busy}
      options={strategies.map(item => ({ value: item.value, label: item.label }))} />
    {strategy ? <p>{mode === 'priority'
      ? <>先由 <strong>{candidateLabel(candidateFor(strategy.adapterId))}</strong> 执行；它不可用（熔断、未配置凭据、操作未启用、未审核采购价、限流）或明确拒绝且未计费（余额不足、鉴权失败、未订阅、配额用尽等）时，同一请求自动改由 <strong>{candidateLabel(candidateFor(strategy.fallbackAdapterId))}</strong> 执行一次。已计费、结果未知或响应无法解析时不切换，避免重复付费。</>
      : <>只使用 <strong>{candidateLabel(candidateFor(strategy.adapterId))}</strong>；它不可用时直接返回失败，不调用其他供应商。</>}</p> : null}
    <Field label="变更原因"><input className="qp-input" required maxLength={1000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：JustOne 余额不足，改为优先 RapidAPI、失败切 JustOne" /></Field>
    <p>配置版本 {row.revision} · {row.reason || '初始路由'}。新配置只影响新的采集；已有游标可由任一兼容供应商续页，原幂等请求继续原样重放。下游合同与返回结构不变，调用方看不到供应商。</p>
    {error ? <ErrorState error={error} /> : null}
    <button className="qp-button qp-button--primary" disabled={busy || !reason.trim() || !row.revision || !strategy}>{busy ? '保存中…' : '保存路由'}</button>
    {!row.revision ? <p>需先安装路由配置迁移。</p> : null}
  </form>
}

export function EcommerceRoutingPage({ token, query, setQuery, onUnauthorized }) {
  const load = useCallback(() => adminApi.ecommerceRouting(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const selected = query.get('marketplace') || 'taobao'
  const row = remote.data?.items?.find(item => item.marketplace === selected)
  return <>
    <PageHeading title="电商平台与上游接口" description="查看各平台统一商品搜索的供应商路由，以及平台专用接口。" loading={remote.loading} onRefresh={remote.refresh} />
    <section className="qp-panel mih-panel" style={{ display: 'block', padding: 20, minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
      {remote.error ? <ErrorState error={remote.error} /> : null}
      {!remote.data && !remote.error ? <p role="status">正在读取电商接口目录…</p> : null}
      {remote.data ? <DropdownField label="电商平台" value={selected} onChange={value => setQuery({ domain: 'ecommerce', marketplace: value })}
        options={remote.data.items.map(item => ({ value: item.marketplace, label: item.label }))} /> : null}
      {row ? <>
        <h2>{row.label}</h2>
        <h3>统一商品搜索 · 供应商路由</h3>
        {row.defaultRoute ? <>
          {!row.configurationValid && row.revision ? <p role="alert">已保存的路由不可用；新采集已阻止。请选择兼容供应商并保存修复。</p> : null}
          <p>当前方式：<strong>{routeStrategyLabel(row)}</strong></p>
          <p>{row.mode === 'priority' ? '主用' : '供应商'}：<strong>{providers[row.defaultRoute.provider] || row.defaultRoute.provider}</strong> · {row.defaultRoute.channel}</p>
          {row.fallbackRoute ? <p>备用：<strong>{providers[row.fallbackRoute.provider]}</strong> · {row.fallbackRoute.channel}</p> : null}
          <p>上游接口：<code>{row.defaultRoute.upstreamPath}</code> · 适配器 <code>{row.defaultRoute.adapter}</code> · <code>{row.defaultRoute.adapterVersion}</code></p>
          <p>下游合同：<code>{row.defaultRoute.contractVersion}</code>（各供应商返回同一商品结构、排序、筛选与分页）</p>
          {!row.switchable ? <p>目前只有一个兼容供应商，只能固定使用。其他供应商需先完成同一商品结构、筛选与分页适配，才会出现在这里。</p>
            : <p>可选供应商 {row.candidates.length} 个，可固定其一，或设置优先顺序（任一方向）。RapidAPI 通道需先用 Hub 的 RapidAPI Key 订阅对应 listing，并在「上游供应商 → RapidAPI」审核该平台的采购价、启用操作；未就绪时作为主用会把请求交给备用（不计费），作为备用则切换时同样返回失败。</p>}
          <DefaultRouteForm key={`${row.marketplace}:${row.revision}`} token={token} row={row} onSaved={remote.refresh} />
        </> : <p>尚无统一商品搜索适配器。{row.endpoints.length ? '下列接口按各自合同调用。' : '尚无可调用的电商接口合同。'}</p>}
        <h3>平台专用接口 · {row.endpoints.length} 项</h3>
        {row.marketplace === 'kuaishou_ec' ? <p>购物榜单与品牌榜单使用子分类参数，没有商品关键词搜索或分页参数；不把榜单条目当作统一商品列表。</p> : null}
        <div className="qp-table-wrap mih-table-wrap" style={{ maxWidth: '100%', overflowX: 'auto' }}><table className="qp-table mih-table"><thead><tr><th>接口 / 供应商</th><th>上游路径</th><th>适配状态</th><th>管理</th></tr></thead>
          <tbody>{row.endpoints.map(endpoint => <tr key={endpoint.key}>
            <td>{endpoint.summary}<br /><strong>{providers[endpoint.provider] || endpoint.provider}</strong></td>
            <td><code>{endpoint.upstreamPath}</code></td><td>原生合同 · 固定供应商 · 不替代统一商品搜索</td>
            <td><a className="qp-button qp-button--ghost qp-button--sm" href={`#/data-products/ecommerce-treasure-box?endpoint=${encodeURIComponent(endpoint.key)}`}>接口调试</a><br /><a className="qp-button qp-button--ghost qp-button--sm" href={`#/external-platforms?provider=${encodeURIComponent(endpoint.provider)}`}>启用与采购配置</a></td>
          </tr>)}</tbody></table></div>
        <p>目录不代表已启用。实际调用仍检查当前 Key 授权、操作状态、采购价格和余额；浏览目录不发起采集。</p>
      </> : remote.data ? <p>未找到该电商平台。</p> : null}
    </section>
  </>
}
