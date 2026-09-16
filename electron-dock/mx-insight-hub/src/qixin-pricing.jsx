import { useState } from 'react'
import { DropdownField, Field } from './components.jsx'
import { BILLING_FEATURES, compileBillingComponents } from '../shared/billing-composition.mjs'

export function QixinPricingAdjustment({ onApply, busy, currency, component }) {
  const [mode, setMode] = useState('original')
  const [percent, setPercent] = useState('20')
  const feature = BILLING_FEATURES.find(item => item.key === 'qixin')
  const numeric = /^\d+(\.\d{1,2})?$/.test(percent) ? Number(percent) : NaN
  const ppm = mode === 'original' ? 1_000_000 : mode === 'markup'
    ? Math.round((100 + numeric) * 10_000) : Math.round(numeric * 10_000)
  const valid = Number.isSafeInteger(ppm) && ppm >= 0 && ppm <= 100_000_000
    && (mode !== 'discount' || numeric <= 100) && currency === 'CNY'
  const apply = () => {
    if (!valid || busy) return
    const source = { type: 'feature', key: 'qixin', version: feature.version, multiplierPpm: ppm }
    onApply(source, compileBillingComponents([source], [], currency).entries)
  }
  return <section className="qp-panel mih-form" aria-label="启信宝统一调价">
    <strong>启信宝真实价格套餐 · {feature.entries.length} 项</strong>
    <p>官网标价采集于 {new Date(feature.pricingAsOf).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}，CNY 元/次。14 项面议接口不可调用，不加入套餐。
      <a href={feature.source} target="_blank" rel="noreferrer">查看官方价目表</a></p>
    <div className="mih-form mih-form--grid">
      <DropdownField label="启信宝调价方式" value={mode} onChange={value => { setMode(value); setPercent(value === 'discount' ? '90' : '20') }}
        disabled={busy} options={[{ value: 'original', label: '官网原价' }, { value: 'markup', label: '原价加百分比' }, { value: 'discount', label: '按原价打折' }]} />
      {mode !== 'original' ? <Field label={mode === 'markup' ? '加价百分比（%）' : '原价百分比（90 = 九折）'}>
        <input className="qp-input" inputMode="decimal" value={percent} disabled={busy} onChange={event => setPercent(event.target.value)} />
      </Field> : null}
    </div>
    <p>{valid ? `预览：官网 ¥3.00 → 基础价 ¥${(Number((300n * BigInt(ppm) + 999999n) / 1000000n) / 100).toFixed(2)}/次。` : '请输入有效百分比；启信宝套餐仅支持 CNY。'}
      不足一分向上取整，免费接口仍为 0；成交价还会应用当前租户或套餐默认倍率。</p>
    <p>{component ? `本草案启信宝来源倍率：${(component.multiplierPpm ?? 1000000) / 1000000}×。` : '尚未追加启信宝费率。'}重新应用会覆盖草案中的启信宝价格，保留其他接口费率。</p>
    <button type="button" className="qp-button qp-button--outline" disabled={!valid || busy} onClick={apply}>应用启信宝费率到草案</button>
  </section>
}
