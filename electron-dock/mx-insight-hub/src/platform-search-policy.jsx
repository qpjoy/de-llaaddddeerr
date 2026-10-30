import { useCallback, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, PageHeading, formatDate, useRemoteData } from './components.jsx'
import { EcommerceRoutingPage } from './ecommerce-routing.jsx'
import { strategySearchLink, FACEBOOK_STRATEGY_MODE_LABELS } from './strategy-search-model.js'

const REASONS = { quota_exhausted: '可用套餐额度已用尽', quota_unknown: '额度待核实', rate_limited: '短时限流', recovery_probe: '等待本次检查结果' }
const PLATFORM_LABELS = { facebook: 'Facebook', xiaohongshu: '小红书', weibo: '微博', douyin: '抖音', kuaishou: '快手',
  bilibili: '哔哩哔哩', zhihu: '知乎', wechat_mp: '微信公众号', wechat_search: '微信搜一搜', tiktok: 'TikTok',
  twitter: 'Twitter / X', instagram: 'Instagram', youtube: 'YouTube', reddit: 'Reddit', linkedin: 'LinkedIn', telegram: 'Telegram' }

export function FacebookSearchPolicyForm({ token, row, onSaved, notify, allowedModes }) {
  const [mode, setMode] = useState(row.mode)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const modes = Object.keys(FACEBOOK_STRATEGY_MODE_LABELS).filter(mode => !allowedModes || allowedModes.includes(mode))
  async function save(event) {
    event.preventDefault()
    if (busy || !modes.includes(mode)) return
    setBusy(true); setError(null)
    try {
      await adminApi.updatePlatformSearchPolicy(token, 'facebook', { mode, expectedRevision: row.revision, reason })
      onSaved(); notify?.('Facebook 搜索策略已保存')
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  async function requestCheck() {
    if (busy || !reason.trim()) return
    setBusy(true); setError(null)
    try {
      await adminApi.requestFacebookQuotaCheck(token, { expectedObservedAt: row.observed_at, reason })
      onSaved(); notify?.('已允许下一条业务请求检查一次，有效期 5 分钟；尚未发送请求')
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <form onSubmit={save} className="mih-page mih-strategy-facebook-form">
    <DropdownField label="策略方式" value={mode} disabled={busy} onChange={setMode}
      options={modes.map(value => ({ value, label: FACEBOOK_STRATEGY_MODE_LABELS[value] }))} />
    <p className="mih-strategy-draft-policy">{mode === 'auto'
      ? '待保存策略：新搜索优先使用 RapidAPI 套餐额度，额度不可用时按现有规则转 JustOne。仅已确认 429 可在派发后进入保底；400、超时与结果未知不会自动重试。'
      : mode === 'paused' ? '待保存策略：暂停新的 Facebook 搜索，保留额度与历史请求记录。'
        : `待保存策略：仅使用 ${mode === 'rapidapi' ? 'RapidAPI' : 'JustOne'}，另一供应商不作为保底。`}</p>
    <div className="mih-strategy-quota-observation">
      <strong>RapidAPI 供应商额度</strong>
      <p>最近响应头：剩余 {row.supplier_remaining ?? '未知'} / 套餐 {row.supplier_limit ?? '未知'} 次。观测时间：{row.supplier_observed_at ? formatDate(row.supplier_observed_at) : '尚无新版本观测'}。</p>
      <p>扣除预留与未决占用后的可用次数：{row.available_included ?? '未知'}。{REASONS[row.availability_reason] || '按策略选路'}。</p>
      <p>供应商重置时间：{row.reset_at ? formatDate(row.reset_at) : '未知'}；{row.next_recovery_check_at ? `下次可随业务请求检查：${formatDate(row.next_recovery_check_at)}` : row.rapid_available ? '可随业务请求调用' : '等待供应商证据或手动允许一次检查'}。</p>
      <p>本地历史计数（含预留）：{row.used ?? '未记录'}，仅用于审计，不作为月度调用上限。</p>
    </div>
    <details className="mih-strategy-quota-settings"><summary>额度核对与一次性检查</summary>
      <p>每次调用以供应商的 Requests 响应头更新额度。重置时间到期后由下一条真实业务请求检查一次；不按每月扣费日或固定小时数探测，不自动补足套餐额度。缺少可信响应头时保留未决占用。</p>
      <p>填写下方原因后，可允许下一条 Facebook 业务请求尝试一次 RapidAPI（可能产生超额费用）。许可 5 分钟内有效，使用后即失效；不会立即发送请求，也不会跳过授权、余额、熔断或已有分页保护。</p>
      <button className="qp-button" type="button" onClick={requestCheck}
        disabled={busy || !reason.trim() || !['auto', 'rapidapi'].includes(row.mode) || !row.observed_at
          || new Date(row.lease_until).getTime() > Date.now() || new Date(row.manual_check_until).getTime() > Date.now()}>
        允许下一条请求检查一次（可能计费）
      </button>
      {row.manual_check_until ? <p>最近检查许可截止：{formatDate(row.manual_check_until)}</p> : null}
    </details>
    <Field label="修改原因"><input className="qp-input" required maxLength={1000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} placeholder="记录此次策略调整的原因" /></Field>
    {error ? <ErrorState error={error} /> : null}
    <div><button className="qp-button qp-button--primary" disabled={busy || !modes.includes(mode) || !reason.trim()}>{busy ? '保存中…' : '保存 Facebook 搜索策略'}</button><span className="qp-muted"> 当前修订 #{row.revision}</span></div>
  </form>
}

export function DataPlatformsPage(props) {
  const ecommerce = props.query.get('domain') === 'ecommerce'
  return <>
    <nav className="mih-source-section-tabs" aria-label="数据平台类型">
      <button type="button" aria-pressed={!ecommerce} onClick={() => props.setQuery({ domain: 'social' })}>内容平台</button>
      <button type="button" aria-pressed={ecommerce} onClick={() => props.setQuery({ domain: 'ecommerce' })}>电商平台</button>
    </nav>
    {ecommerce ? <EcommerceRoutingPage {...props} /> : <SocialDataPlatformsPage {...props} />}
  </>
}

function SocialDataPlatformsPage({ token, query, setQuery, onUnauthorized }) {
  const load = useCallback(() => adminApi.platformSearchPolicies(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const selected = query.get('platform') || 'facebook'
  const row = remote.data?.items?.find(row => row.platform === selected)
  return <>
    <PageHeading title="数据平台" description="查看内容平台目录和治理入口；搜索接口的供应商配置已归入“策略搜索”数据产品。" loading={remote.loading} onRefresh={remote.refresh} />
    <section className="qp-panel mih-panel" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div style={{ padding: 16 }}>
        {remote.error ? <ErrorState error={remote.error} /> : null}
        {!remote.data && !remote.error ? <p>加载平台目录…</p> : null}
        {remote.data?.items?.length ? <DropdownField label="数据平台" value={selected} onChange={value => setQuery({ platform: value })}
          options={remote.data.items.map(item => ({ value: item.platform, label: PLATFORM_LABELS[item.platform] || item.platform }))} /> : null}
        {row ? <>
          <h2>{PLATFORM_LABELS[row.platform] || row.platform}</h2>
          <p>目录编号：{row.catalog_key}</p>
          <p>关键词搜索、账号内容与账号资料的路由分别展示在“策略搜索”。接口迁移与供应商可用性按业务能力独立判断。</p>
          <p><a className="qp-button qp-button--primary" href={strategySearchLink(row.platform)}>打开 {PLATFORM_LABELS[row.platform] || row.platform} 搜索策略 →</a></p>
          <p><a href="#/source-catalog">平台覆盖与治理目录 ↗</a> · <a href="#/external-platforms">供应商凭据、运行状态与采购配置 ↗</a></p>
          <p>账号、评论及其他非搜索能力继续遵循各自接口与平台授权；本页不提供统一覆盖这些能力的供应商开关。</p>
        </> : remote.data ? <p>{remote.data.items?.length ? '未找到所选数据平台。' : '尚未安装平台策略迁移。'}</p> : null}
        <details><summary>全部内容平台目录</summary><div className="qp-table-wrap mih-table-wrap" style={{ maxWidth: '100%', overflowX: 'auto' }}><table className="qp-table mih-table">
          <thead><tr><th>数据平台</th><th>目录编号</th><th>搜索业务接口</th></tr></thead>
          <tbody>{(remote.data?.items || []).map(item => <tr key={item.platform}><td><button className="qp-button qp-button--ghost" type="button" onClick={() => setQuery({ platform: item.platform })}>{PLATFORM_LABELS[item.platform] || item.platform}</button></td><td>{item.catalog_key}</td><td><a href={strategySearchLink(item.platform)}>查看策略 →</a></td></tr>)}</tbody>
        </table></div></details>
      </div>
    </section>
  </>
}
