import { useCallback, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, Field, PageHeading, formatDate, useRemoteData } from './components.jsx'

const MODES = { auto: '自动：RapidAPI → JustOne', rapidapi: '仅 RapidAPI', justone: '仅 JustOne', paused: '暂停搜索', existing: '沿用现有路由' }
const REASONS = { quota_exhausted: '额度已用尽', rate_limited: '短时限流', recovery_probe: '等待恢复确认' }
const PLATFORM_LABELS = { facebook: 'Facebook', xiaohongshu: '小红书', weibo: '微博', douyin: '抖音', kuaishou: '快手',
  bilibili: '哔哩哔哩', zhihu: '知乎', wechat_mp: '微信公众号', wechat_search: '微信搜一搜', tiktok: 'TikTok',
  twitter: 'Twitter / X', instagram: 'Instagram', youtube: 'YouTube', reddit: 'Reddit', linkedin: 'LinkedIn', telegram: 'Telegram' }

function FacebookForm({ token, row, onSaved, notify }) {
  const [mode, setMode] = useState(row.mode)
  const [limit, setLimit] = useState(row.monthly_limit)
  const [interval, setInterval] = useState(row.probe_interval_hours)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function save(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      await adminApi.updatePlatformSearchPolicy(token, 'facebook', { mode, monthlyLimit: Number(limit),
        probeIntervalHours: Number(interval), expectedRevision: row.revision, reason })
      onSaved(); notify?.('Facebook 搜索策略已保存')
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <form onSubmit={save} className="mih-page">
    <h3>Raw Search · 上游选路</h3>
    <div className="mih-external-two-column">
      <Field label="上游供应商"><select aria-label="上游供应商" className="qp-input" value={mode} disabled={busy} onChange={e => setMode(e.target.value)}>
        {Object.entries(MODES).filter(([key]) => key !== 'existing').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></Field>
      <Field label="RapidAPI 每周期调用上限"><input className="qp-input" type="number" min="1" max="1000000" required value={limit} disabled={busy} onChange={e => setLimit(e.target.value)} /></Field>
      <Field label="重置时间未知时，恢复探测间隔（小时）"><input className="qp-input" type="number" min="24" max="744" required value={interval} disabled={busy} onChange={e => setInterval(e.target.value)} /></Field>
      <Field label="修改原因"><input className="qp-input" required maxLength={1000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} placeholder="记录此次调整的原因" /></Field>
    </div>
    <p>已预留调用：{row.used ?? 0}；供应商剩余额度：{row.remaining ?? '尚未返回'}。{REASONS[row.availability_reason] || '按策略选路'}。</p>
    <p>额度重置：{row.reset_at ? formatDate(row.reset_at) : '未知，等待供应商响应'}；下次可尝试：{row.blocked_until ? formatDate(row.blocked_until) : '可随业务请求尝试'}。</p>
    <p>恢复探测使用到期后的第一条实际业务请求，每次只放行一次；结果确认仍有额度后恢复。未知周期的探测可能计费。分页继续使用原渠道，无法继续时需要重新搜索。</p>
    {error ? <ErrorState error={error} /> : null}
    <div><button className="qp-button qp-button--primary" disabled={busy || !reason.trim()}>{busy ? '保存中…' : '保存平台策略'}</button></div>
  </form>
}

export function DataPlatformsPage({ token, query, setQuery, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.platformSearchPolicies(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const selected = query.get('platform') || 'facebook'
  const row = remote.data?.items?.find(row => row.platform === selected)
  return <>
    <PageHeading title="数据平台" description="按 Facebook、小红书、微博等内容平台管理接入服务与默认上游。" loading={remote.loading} onRefresh={remote.refresh} />
    <section className="qp-panel mih-panel" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div style={{ padding: 16 }}>
        {remote.error ? <ErrorState error={remote.error} /> : null}
        {!remote.data && !remote.error ? <p>加载策略…</p> : null}
        {remote.data?.items?.length ? <Field label="数据平台"><select aria-label="数据平台" className="qp-input" value={selected} onChange={e => setQuery({ platform: e.target.value })}>
          {remote.data.items.map(item => <option key={item.platform} value={item.platform}>{PLATFORM_LABELS[item.platform] || item.platform}</option>)}
        </select></Field> : null}
        {row ? <>
          <h2>{PLATFORM_LABELS[row.platform] || row.platform}</h2>
          <p>目录编号：{row.catalog_key}</p>
          {row.platform === 'facebook' ? <>
            <p>帖子搜索由 Hub 处理。默认优先使用 RapidAPI 周期额度，再使用 JustOne；也可在此固定选择一个供应商。业务请求使用已保存的策略。</p>
            <FacebookForm key={`${row.platform}:${row.revision}`} {...{ token, notify, row }} onSaved={remote.refresh} />
            <p><a href="#/external-platforms?provider=rapidapi">RapidAPI 凭据与采购配置</a> · <a href="#/external-platforms?provider=justone">JustOne 凭据与采购配置</a></p>
            <details><summary>服务接口与兼容关系</summary>
              <p><code>/api/v1/night-all/search/raw</code> 与 <code>/api/v1/search/raw</code> 返回 raw 合同；<code>/api/v1/data/search</code> 返回统一内容合同。三个入口共用 Facebook 搜索处理器与本页策略。</p>
              <p>正文保持完整；没有独立标题的帖子不从首句生成标题。搜索结果异步写入 canonical，已存数据查询不会再次采集。Facebook 账号和 crawl 操作仍沿用原有链路。</p>
            </details>
          </> : <p>此平台沿用现有接口与路由。当前可配置的 Raw Search 供应商策略仅开放 Facebook。</p>}
        </> : remote.data ? <p>{remote.data.items?.length ? '未找到所选数据平台。' : '尚未安装平台策略迁移。'}</p> : null}
        <details><summary>全部数据平台与当前路由</summary><div className="qp-table-wrap mih-table-wrap" style={{ maxWidth: '100%', overflowX: 'auto' }}><table className="qp-table mih-table">
          <thead><tr><th>数据平台</th><th>目录编号</th><th>上游策略</th></tr></thead>
          <tbody>{(remote.data?.items || []).map(item => <tr key={item.platform}><td><button className="qp-button qp-button--ghost" type="button" onClick={() => setQuery({ platform: item.platform })}>{PLATFORM_LABELS[item.platform] || item.platform}</button></td><td>{item.catalog_key}</td><td>{MODES[item.mode]}</td></tr>)}</tbody>
        </table></div></details>
      </div>
    </section>
  </>
}
