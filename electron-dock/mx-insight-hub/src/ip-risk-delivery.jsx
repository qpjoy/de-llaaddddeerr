import { useCallback, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, LoadingState, useRemoteData } from './components.jsx'

const names = { 'legacy-v1': 'v1 · ipsearch', 'baidu-v2': '百度 v2 · 网页接口' }

export function IpRiskDeliverySettings({ token }) {
  const load = useCallback(() => adminApi.commerceDelivery(token), [token])
  const state = useRemoteData(load)
  const [channel, setChannel] = useState(null), [error, setError] = useState(null)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  async function save() {
    if (busy || !channel) return
    setBusy(true); setError(null); setNotice('')
    try {
      const saved = await adminApi.commerceSaveDelivery(token, { channel, revision: state.data.revision })
      state.setData({ ...state.data, ...saved }); setChannel(null)
      setNotice(`已切换为 ${names[saved.channel]}，新查询将使用此渠道。`)
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }
  return <section className="qp-panel mih-panel mih-ip-delivery">
    <h2>产品交付渠道</h2>
    <p>切换空间订阅的新查询渠道，已有订阅、调用次数与历史结果保持不变。</p>
    {error || state.error ? <ErrorState error={error || state.error} /> : null}
    {state.data ? <>
      <p><strong>当前交付：{names[state.data.channel]}</strong></p>
      <DropdownField label="IP 风险画像交付渠道" value={channel || state.data.channel} disabled={busy}
        options={Object.entries(names).map(([value, label]) => ({ value, label, description: state.data.channels?.find(c => c.id === value)?.ready ? '配置就绪' : '配置未就绪' }))}
        onChange={value => { setChannel(value); setNotice('') }} />
      <p>百度 v2 就是已接入的网页查询服务，无需 API Key 或其他凭据。启停与限流在<a href="#/external-platforms?provider=baidu-ip">上游供应商</a>管理；v1 保留原 ipsearch 配置。</p>
      <button className="qp-button qp-button--primary" disabled={busy || !channel || channel === state.data.channel} onClick={save}>{busy ? '保存中…' : '保存交付渠道'}</button>
      {notice ? <p role="status">{notice}</p> : null}
    </> : <LoadingState />}
  </section>
}
