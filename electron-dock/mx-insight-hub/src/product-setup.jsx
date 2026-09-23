import { useState } from 'react'
import { PRODUCT_BUNDLES, XIAOHONGSHU_CAPABILITIES } from '../shared/product-catalog.mjs'
import { BILLING_FEATURES } from '../shared/billing-composition.mjs'
import { adminApi } from './api.js'
import { DropdownField, ErrorState } from './components.jsx'
import { PagedItems } from './paged-items.jsx'

export function ProductSetup({ token, data, currentPlan, rates, billing, onRefresh, onAssign, onPrice, assigning }) {
  const [productKey, setProductKey] = useState('xiaohongshu')
  const [planId, setPlanId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const product = PRODUCT_BUNDLES.find(row => row.key === productKey)
  const grants = data.configuration?.grants || [], capabilities = data.configuration?.capabilityGrants || []
  const missingPlatforms = product.platforms.filter(scope => !grants.includes(scope))
  const missingCapabilities = product.capabilities.filter(scope => !capabilities.includes(scope))
  const ready = new Map((data.configuration?.availableCapabilities || []).map(row => [row.capability, row.ready]))
  const feature = BILLING_FEATURES.find(row => row.key === product.featureKey)
  const meters = feature.entries
  const pricedCount = meters.filter(entry => rates.some(rate => rate.meterKey === entry.meterKey)).length
  const plans = (data.plans?.catalog || []).filter(row => row.status === 'active' && row.versionStatus === 'published' && row.key !== 'legacy-unmetered')
  const chosen = plans.find(row => row.versionId === planId)
  async function grant() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      // Re-read before each explicit batch; existing scope limits are never copied
      // from a product template. A retry only resumes the missing scopes.
      const current = await adminApi.platforms(token, { tenantId: data.tenantId, consumerId: data.consumerId })
      const input = { tenantId: data.tenantId, consumerId: data.consumerId, enabled: true }
      for (const scope of product.platforms.filter(scope => !current.grants.includes(scope))) await adminApi.updatePlatform(token, scope, input)
      for (const scope of product.capabilities.filter(scope => !current.capabilityGrants.includes(scope))) await adminApi.updateCapability(token, scope, input)
    } catch (error) { setError(error) }
    finally { setBusy(false); onRefresh() }
  }
  return <section className="qp-panel mih-panel mih-commercial-panel" aria-label="产品开通工作台">
    <h2>产品开通工作台</h2><p>为当前调用者选择产品、复用套餐，再检查原 Key 范围。现有 Key 和其他业务保持原配置。</p>
    <DropdownField label="数据产品" value={productKey} onChange={setProductKey} disabled={busy} options={PRODUCT_BUNDLES.map(row => ({ value: row.key, label: row.name }))} />
    <div className="mih-form mih-form--grid">
      <div><h3>1 · 产品权限</h3><p>{missingPlatforms.length + missingCapabilities.length ? `缺少 ${missingPlatforms.length} 项平台、${missingCapabilities.length} 项操作授权` : '调用者已具备本产品权限'}</p>
        <button className="qp-button qp-button--outline" disabled={busy || !data.consumerId || !(missingPlatforms.length + missingCapabilities.length)} onClick={grant}>{busy ? '正在开通…' : '开通缺少的产品权限'}</button>
        <p>只增加本产品缺少的授权；现有 Key 不自动扩权。部分失败后可重新点击继续。</p>
      </div>
      <div><h3>2 · 复用客户套餐</h3><p>当前 {currentPlan?.name || '未分配'}{currentPlan ? ` v${currentPlan.version}` : ''} · 本产品已配置 {pricedCount}/{meters.length} 项价格</p>
        <DropdownField label="已有套餐版本" value={planId} onChange={setPlanId} disabled={busy || assigning} options={[{ value: '', label: '选择已发布版本' }, ...plans.map(row => ({ value: row.versionId, label: `${row.name} · v${row.version}` }))]} />
        {chosen ? <p>分配会替换当前调用者的整份套餐：包含 {chosen.priceBook?.entries.length || 0} 项价格。请核对其他业务价格与额度。</p> : null}
        <div className="mih-page-actions"><button className="qp-button qp-button--outline" disabled={busy || assigning || !chosen || chosen.versionId === currentPlan?.versionId} onClick={() => onAssign(chosen)}>分配所选套餐</button>
          <button className="qp-button qp-button--outline" disabled={busy || currentPlan?.priceBook && currentPlan.priceBook.currency !== feature.currency} onClick={() => onPrice(product.featureKey)}>追加产品费率到草稿</button></div>
      </div>
      <div><h3>3 · 检查 Key 与服务</h3><p>计费状态：{({ enforced: '已启用', shadow: '仅试算', disabled: '未启用' })[billing.profile?.mode] || '未启用'}。同一调用者的 Key 共用已分配价格。</p>
        <a className="qp-button qp-button--outline" href={`#/api-keys?tenantId=${encodeURIComponent(data.tenantId)}&consumerId=${encodeURIComponent(data.consumerId)}`}>检查或签发 Key</a>
        <ul>{product.capabilities.map(scope => <li key={scope}>{XIAOHONGSHU_CAPABILITIES.find(row => row.key === scope)?.label || scope} · {ready.has(scope) ? ready.get(scope) ? '服务就绪' : '服务未就绪' : '运行状态未核验'}</li>)}</ul>
      </div>
    </div>
    {error ? <ErrorState error={error} /> : null}
    <details><summary>查看本产品生效价格 · 接口价格优先，其余使用租户默认价</summary><PagedItems items={meters} text={entry => entry.meterKey} label="产品费率">{visible => <div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table"><thead><tr><th>业务</th><th>当前单次价格</th><th>状态</th></tr></thead><tbody>{visible.map(({entry}) => {
      const override = rates.find(row => row.meterKey === entry.meterKey)
      const rate = override || { unitPriceMinor: billing.profile?.defaultUnitPriceMinor ?? 0, currency: billing.profile?.defaultCurrency || 'CNY' }
      return <tr key={entry.meterKey}><td>{XIAOHONGSHU_CAPABILITIES.find(row => row.key === entry.meterKey)?.label || entry.meterKey}</td><td>{rate ? `${rate.currency || currentPlan?.priceBook?.currency} ${(rate.unitPriceMinor / 100).toFixed(2)}` : '0.00'}</td><td>{!override ? '租户默认价' : rate.unitPriceMinor === 0 ? '接口明确免费' : '套餐接口价'}{billing.profile?.mode === 'enforced' ? '' : ' · 尚未扣费'}</td></tr>
    })}</tbody></table></div>}</PagedItems></details>
  </section>
}
