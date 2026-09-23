import { useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field } from './components.jsx'
import { PagedItems } from './paged-items.jsx'

export function ProcurementTemplate({ token, provider, operations, onSaved, onUnauthorized, notify }) {
  const prices = [...new Set(operations.flatMap(op => Object.values(op.priceBook.endpointPrices || {})).filter(value => value > 0))]
  const priced = operations.find(op => op.priceBook.currency)
  const [draft, setDraft] = useState({ currency: priced?.priceBook.currency || 'CNY', pricingAsOf: '',
    unitCostMinor: prices.length === 1 ? String(prices[0]) : '', monthlyBudgetMinor: '', monthlySubsidyBudgetMinor: '', reason: '' })
  const [selected, setSelected] = useState(operations.map(op => op.operationKey))
  const [overrides, setOverrides] = useState([])
  const [history, setHistory] = useState(null)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    adminApi.pricingTemplate(token, provider).then(value => { if (active) setHistory(value) }).catch(error => { if (active) setError(error) })
    return () => { active = false }
  }, [token, provider])
  const update = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setPreview(null); setResult(null) }
  const useTemplate = () => {
    const spec = history?.templates?.[0]?.spec
    if (!spec) return
    setDraft(current => ({ ...current, ...Object.fromEntries(['currency','pricingAsOf','unitCostMinor','monthlyBudgetMinor','monthlySubsidyBudgetMinor'].map(key => [key, String(spec[key])])) }))
    setPreview(null)
  }
  const submit = async (apply = false) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const value = await adminApi.pricingTemplate(token, provider, {
        ...draft, unitCostMinor: Number(draft.unitCostMinor), monthlyBudgetMinor: Number(draft.monthlyBudgetMinor),
        monthlySubsidyBudgetMinor: Number(draft.monthlySubsidyBudgetMinor), operationKeys: selected, overrideExisting: overrides,
        ...(apply ? { previewToken: preview.previewToken } : { dryRun: true }),
      })
      if (!apply) setPreview(value)
      else {
        setResult(value); setPreview(null)
        notify?.(`已应用 ${value.applied.length} 项，保留或跳过 ${value.skipped.length} 项`, value.skipped.some(row => row.reason !== 'existing_exception_preserved') ? 'warning' : 'success')
        setHistory(await adminApi.pricingTemplate(token, provider))
        onSaved?.()
      }
    } catch (error) { setError(error); if (error.status === 401) onUnauthorized?.(error); if (apply) setPreview(null) }
    finally { setBusy(false) }
  }
  const complete = selected.length > 0 && draft.pricingAsOf && draft.reason.trim() && draft.unitCostMinor !== '' && draft.monthlyBudgetMinor !== '' && draft.monthlySubsidyBudgetMinor !== ''
  return <section className="qp-panel mih-panel mih-commercial-panel" id="external-price-book" aria-label="采购基础方案">
    <h2>采购基础方案与接口例外</h2>
    <p>一次维护，跨客户复用。默认保留现有独立价格；采用基础方案的操作随显式发布更新，单独修改过的操作保留为例外。运行开关保持原状。</p>
    <button className="qp-button qp-button--outline qp-button--sm" disabled={busy || !history?.templates?.length} onClick={useTemplate}>复用最新基础方案{history?.templates?.[0] ? ` v${history.templates[0].version}` : ''}</button>
    <div className="mih-external-operation-price-grid">
      <DropdownField label="币种" value={draft.currency} onChange={value => update('currency', value)} options={['CNY','USD'].map(value => ({ value, label: value }))} disabled={busy} />
      <Field label="定价证据日期"><input className="qp-input" type="date" value={draft.pricingAsOf.slice(0,10)} onChange={event => update('pricingAsOf',event.target.value)} disabled={busy} /></Field>
      {[['unitCostMinor','单次采购价（最小货币单位）'],['monthlyBudgetMinor','月度采购预算（最小货币单位）'],['monthlySubsidyBudgetMinor','月度补贴预算（最小货币单位）']].map(([key,label]) => <Field key={key} label={label}><input className="qp-input" type="number" min={key==='unitCostMinor'?1:0} step="1" value={draft[key]} onChange={event => update(key,event.target.value)} disabled={busy} /></Field>)}
      <Field label="变更原因"><input className="qp-input" value={draft.reason} maxLength={1000} onChange={event => update('reason',event.target.value)} disabled={busy} /></Field>
    </div>
    <p>价格和预算以原币种保存；CNY / USD 的 1 个最小货币单位分别为 ¥0.01 / US$0.01。新增接口需核验合同后选择适用范围。</p>
    <details><summary>适用范围与独立价格 · 已选 {selected.length} 项</summary><PagedItems items={operations} text={op => `${op.label} ${op.operationKey}`} label="采购操作">{visible => <div>{visible.map(({entry: op}) => <div key={op.operationKey} className="mih-page-actions">
      <label><input type="checkbox" disabled={busy} checked={selected.includes(op.operationKey)} onChange={event => { setSelected(current => event.target.checked ? [...current, op.operationKey] : current.filter(key => key !== op.operationKey)); setOverrides(current => current.filter(key => key !== op.operationKey)); setPreview(null) }} />{op.label}</label>
      {Object.values(op.priceBook.endpointPrices || {}).some(value => Number.isSafeInteger(value) && value >= 0) ? <label><input type="checkbox" disabled={busy || !selected.includes(op.operationKey)} checked={overrides.includes(op.operationKey)} onChange={event => { setOverrides(current => event.target.checked ? [...current, op.operationKey] : current.filter(key => key !== op.operationKey)); setPreview(null) }} />将此独立价格改为基础方案</label> : <span>待配置采购价</span>}
    </div>)}</div>}</PagedItems></details>
    {error ? <ErrorState error={error} /> : null}
    {preview ? <div role="status"><h3>变更预览</h3><p>将更新 {preview.rows.filter(row => row.action === 'apply').length} 项，保留 {preview.rows.filter(row => row.action === 'preserve').length} 项独立配置。客户套餐与运行开关不变。</p>
      <PagedItems items={preview.rows} text={row => row.label} label="采购变更">{visible => <ul>{visible.map(({entry: row}) => <li key={row.operationKey} style={{ overflowWrap: 'anywhere' }}>{row.label} · {row.action === 'apply' ? '采用基础方案' : '保留独立配置'} · {row.desiredState}<small>原价 {row.previous.currency || '—'} {JSON.stringify(row.previous.endpointPrices)} → {row.action === 'apply' ? `${draft.currency} ${draft.unitCostMinor} / endpoint` : '不变'}</small></li>)}</ul>}</PagedItems>
    </div> : null}
    {result ? <p role="status">已应用 {result.applied.length} 项；{result.skipped.length} 项保留或未完成。{result.skipped.map(row => `${row.operationKey}: ${row.reason}`).join('；')}</p> : null}
    <div className="mih-page-actions"><button className="qp-button qp-button--outline" disabled={busy || !complete} onClick={() => submit()}>预览变更</button><button className="qp-button qp-button--primary" disabled={busy || !preview || !preview.rows.some(row => row.action === 'apply')} onClick={() => submit(true)}>{busy ? '处理中…' : '发布并应用预览方案'}</button></div>
  </section>
}
