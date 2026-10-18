import { lazy, Suspense, useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, LoadingState } from './components.jsx'
import { PagedItems } from './paged-items.jsx'
import { ProviderAdmission } from './provider-admission.jsx'

const OperationControls = lazy(() => import('./pages-external-platforms.jsx').then(module => ({
  default: ({ operations, ...props }) => <module.ExternalPlatformOperationControlPanel operations={module.normalizeOperations({ operations })} {...props} />,
})))
const BaiduIpSettings = lazy(() => import('./pages-external-platforms.jsx').then(module => ({ default: module.BaiduIpPlatformDetail })))
const referenceUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
const STATUS = { active: '启用', paused: '暂停', disabled: '停用', shadow: '校验', canary: '灰度', unavailable: '未就绪', unknown: '状态未提供' }
const PRICE_STATUS = { select_consumer: '选择调用者后显示', plan_unavailable: '未取得有效套餐', contract: '合同单价', account_default: '账户默认费率', billing_disabled: '未启用实际扣费', subscription: '按订阅权益计量' }
const operationKey = operation => operation.operationKey || operation.operation
const priceEntries = operation => Object.entries(operation.priceBook?.endpointPrices || {}).map(([endpoint, value]) => [endpoint, value && typeof value === 'object' ? value.unitCostMinor ?? value.priceMinor ?? null : value])
const price = (value, currency) => {
  if (value == null || !currency || !Number.isFinite(Number(value))) return '价格未提供'
  try {
    const digits = new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
    return `${currency} ${(Number(value) / (10 ** digits)).toLocaleString('zh-CN', { maximumFractionDigits: 8 })}`
  } catch { return `${currency} ${value} 最小货币单位` }
}

export function ProductManagementPanel({ token, path, label, onUnauthorized, notify, providerKey, onSaved }) {
  const [consumerId, setConsumerId] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')
  const identity = `${path}:${consumerId}`
  const [state, setState] = useState({ identity: '', data: null, error: null, loading: true })
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision(value => value + 1)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ identity, data: null, error: null, loading: true })
    adminApi.productManagement(token, { path, ...(consumerId ? { consumerId } : {}) }, { signal: controller.signal }).then(data => {
      if (active) setState({ identity, data, error: null, loading: false })
    }).catch(error => {
      if (!active) return
      setState({ identity, data: null, error, loading: false })
      if (error.status === 401) onUnauthorized?.(error)
    })
    return () => { active = false; controller.abort() }
  }, [token, path, consumerId, revision, onUnauthorized])
  const current = state.identity === identity
  const data = current ? state.data : null
  const loading = !current || state.loading
  const provider = data?.providers?.find(row => row.key === (providerKey || selectedProvider)) || (!providerKey ? data?.providers?.[0] : null)
  return <div className="mih-product-management-workspace" aria-label={`${label}接口与费用配置`}>
    <header className="mih-product-management-heading"><div><h3>接口、限速与价格</h3><p>直接管理本产品对应的运行配置。读取和保存配置不会发起数据查询。</p></div>
      <button className="qp-button qp-button--outline" type="button" disabled={loading} onClick={refresh}>{loading ? '读取中…' : '刷新管理配置'}</button></header>
    {current && state.error ? <ErrorState error={state.error} onRetry={refresh} /> : null}
    {loading ? <LoadingState label="正在读取接口、价格与限速配置" /> : null}
    {data ? <>
      <section className="qp-panel mih-panel" aria-label="下游套餐执行价">
        <div className="mih-product-management-heading"><div><h3>下游当前套餐价格</h3><p>按所选调用者查看当前执行价；同一调用者的 Key 共用套餐。以实际发送时的有效价格为准。</p></div>
          <a className="qp-button qp-button--outline" href={`#/plans${consumerId ? `?consumerId=${encodeURIComponent(consumerId)}` : ''}`}>管理套餐与调价 ↗</a></div>
        <DropdownField label="查看价格的调用者" value={consumerId} onChange={setConsumerId} options={[{ value: '', label: '请选择调用者' }, ...(data.consumers || []).map(row => ({ value: row.id, label: row.name || row.id, description: `租户 ${row.tenantId} · ${row.id}` }))]} />
        {data.customer ? <p>当前调用者：{data.customer.name} · 套餐版本 <code>{data.customer.planVersionId || '未分配'}</code> · 计费模式 {data.customer.billingMode || '未提供'}</p> : null}
        <PagedItems key={consumerId} items={data.customerPrices || []} text={row => `${row.label} ${row.meterKey} ${(row.paths || []).join(' ')}`} label="下游计价接口">
          {rows => <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>业务接口 / 计价项</th><th>执行单价</th><th>计价依据</th></tr></thead><tbody>{rows.map(({ entry: row }) => <tr key={row.meterKey}>
            <td><strong>{row.label}</strong><small><code>{row.meterKey}</code></small>{(row.paths || []).map(path => <small key={path}><code>{path}</code></small>)}</td>
            <td>{['select_consumer', 'plan_unavailable', 'subscription'].includes(row.status) ? PRICE_STATUS[row.status] : <>{price(row.unitPriceMinor, row.currency)} / {row.billingUnit === 'ip' ? 'IP' : '业务请求'}{row.unitPriceMinor != null ? <small>{row.unitPriceMinor} 最小货币单位</small> : null}</>}</td>
            <td>{PRICE_STATUS[row.status] || row.status}{row.multiplierPpm != null ? <small>合同倍率 {row.multiplierPpm / 1000000}</small> : null}{row.configuredUnitPriceMinor != null ? <small>配置价 {price(row.configuredUnitPriceMinor, row.currency)}</small> : null}</td>
          </tr>)}</tbody></table></div>}
        </PagedItems>
        {!data.customerPrices?.length ? <p>此产品没有已登记的单次请求计价项。订阅、存量服务或其他计费口径以当前产品合同为准。</p> : null}
      </section>
      {data.providers?.length ? <section aria-label="供应商配置">
        {!providerKey ? <DropdownField label="管理供应商" value={provider?.key || ''} onChange={setSelectedProvider} options={data.providers.map(row => ({ value: row.key, label: row.label || row.key }))} /> : null}
        {provider ? <ProviderManagement key={`${token}:${provider.key}`} {...{ token, provider, onUnauthorized, notify }} onSaved={() => { refresh(); onSaved?.() }} /> : <p>当前产品未返回此供应商的管理配置。</p>}
      </section> : <p>此产品当前没有可配置的供应商接口；可继续使用下方的产品专用管理工具。</p>}
      {data.notes?.length ? <details className="mih-product-management-notes"><summary>计量与配置说明</summary>{data.notes.map((note, index) => <p key={index}>{note}</p>)}</details> : null}
      <p className="qp-muted">读取时间：{data.observedAt ? new Date(data.observedAt).toLocaleString('zh-CN', { hour12: false }) : '未提供'}。供应商采购按上游调用计量，下游价格按业务请求或 IP 计量；一次业务请求可能包含多次上游调用，各币种独立展示。</p>
    </> : null}
  </div>
}

function ProviderManagement({ token, provider, onSaved, onUnauthorized, notify }) {
  const [controls, setControls] = useState(false)
  const operations = provider.operations || []
  return <div className="mih-product-management-provider">
    <section className="qp-panel mih-panel" aria-label={`${provider.label}接口与采购价格`}>
      <header className="mih-product-management-heading"><div><h3>{provider.label || provider.key} · 运行接口与采购价格</h3><p>运行价目用于采购预算估算，可能向上取整；官方参考价保留原始小数和日期。两者都不代表本次实扣，未提供价格不等于免费。</p></div><a className="qp-button qp-button--ghost" href={`#/external-platforms?provider=${encodeURIComponent(provider.key)}`}>凭据、出口与调用证据 ↗</a></header>
      {provider.error ? <ErrorState error={new Error(provider.error.message)} /> : null}
      <PagedItems items={operations} text={row => `${row.label} ${operationKey(row)} ${(row.paths || []).join(' ')}`} label="供应商接口">
        {rows => <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>接口</th><th>运行状态</th><th>运行采购估值 / 上游调用</th><th>官方参考价 / 上游调用</th><th>运行价格证据</th></tr></thead><tbody>{rows.map(({ entry: row }) => <tr key={operationKey(row)}>
          <td><strong>{row.label || operationKey(row)}</strong><small><code>{operationKey(row)}</code></small>{(row.paths || []).map(path => <small key={path}><code>{path}</code></small>)}</td>
          <td>{STATUS[row.effectiveState] || row.effectiveState || '状态未提供'}<small>期望：{STATUS[row.desiredState] || row.desiredState || '未提供'}</small>{row.blockers?.length ? <small>{row.blockers.map(blocker => typeof blocker === 'string' ? blocker : blocker.message || blocker.code).join('；')}</small> : null}</td>
          <td>{priceEntries(row).length ? priceEntries(row).map(([endpoint, value]) => <div key={endpoint}><strong>{price(value, row.priceBook?.currency)}</strong><small><code>{endpoint}</code>{value != null ? ` · ${value} 最小货币单位` : ''}</small></div>) : '采购价格未提供'}</td>
          <td>{row.procurementReferences?.length ? row.procurementReferences.map((reference, index) => <div key={`${reference.endpointKey}:${index}`}><strong>{reference.currency} {reference.unitPrice}</strong><small><code>{reference.endpointKey}</code></small><small>观察日期 {reference.observedAt || '未提供'}</small>{referenceUrl(reference.sourceUrl) ? <a href={referenceUrl(reference.sourceUrl)} target="_blank" rel="noreferrer">价格来源 ↗</a> : <small>来源未提供</small>}<small>已存快照 · 实扣未核验</small></div>) : '官方参考价未提供'}</td>
          <td>{row.priceBook?.ready === true ? '已就绪' : '待复核'}<small>价格表版本 {row.priceBook?.version ?? '未提供'}</small><small>{row.priceBook?.pricingAsOf || '价格日期未提供'}</small>{Object.hasOwn(row, 'publicPriceMinor') && row.publicPriceMinor === null ? <small>官网面议 · 禁止调用</small> : null}</td>
        </tr>)}</tbody></table></div>}
      </PagedItems>
    </section>
    {provider.admission ? <ProviderAdmission key={`${provider.key}:${provider.admission.revision}`} policy={provider.admission} label={provider.label || provider.key} {...{ token, onSaved, onUnauthorized, notify }} /> : <p>此渠道使用产品专用准入规则，未提供通用并发和 RPM 设置。</p>}
    {provider.key === 'baidu-ip' ? <Suspense fallback={<LoadingState label="正在读取百度 IP 渠道设置" />}><BaiduIpSettings embedded {...{ token, onUnauthorized, notify }} /></Suspense> : null}
    {operations.length ? <details className="mih-product-management-controls" onToggle={event => { if (event.currentTarget.open) setControls(true) }}><summary>管理接口启停与采购价目</summary>
      {controls ? <Suspense fallback={<LoadingState label="正在加载接口配置表单" />}><OperationControls {...{ token, operations, onSaved, onUnauthorized, notify }} provider={provider.key} /></Suspense> : null}
    </details> : null}
  </div>
}
