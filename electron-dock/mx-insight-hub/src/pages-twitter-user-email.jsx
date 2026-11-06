// Data product "Twitter 用户邮箱" (文件数据集): 接口调试 · 产品展示 · 接入指南 · 管理.
import { useEffect, useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { formatDate } from './components.jsx'
import { useDemoAccessSnapshot } from './demo-credentials.jsx'
import { FileDatasetFailure, FileDatasetPage, exact, fileDatasetErrorMessage } from './file-dataset-page.jsx'

const DATASET = 'twitter-user-email'
const MODES = [
  ['username', '用户名查邮箱', '输入完整用户名，例如 JohnSmith'],
  ['email', '邮箱查用户名', '输入完整邮箱，例如 name@example.com'],
  ['prefix', '前缀', '至少 3 个字符'],
  ['contains', '片段', '至少 4 个字符'],
  ['fuzzy', '近似拼写', '4–64 个字符，按相似度排序'],
]
const MATCH_LABELS = { exact: '原样相等', case_insensitive: '忽略大小写', prefix: '前缀', contains: '片段', similar: '近似' }

function Experience({ apiKey }) {
  const access = useDemoAccessSnapshot()
  const [metadata, setMetadata] = useState(null), [metaError, setMetaError] = useState(null)
  const [mode, setMode] = useState('username'), [query, setQuery] = useState(''), [field, setField] = useState('username')
  const [domain, setDomain] = useState(''), [maskEmail, setMaskEmail] = useState(false)
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    setMetadata(null); setMetaError(null); setMaskEmail(false)
    if (apiKey) publicDataApi.twitterUserEmailMetadata(apiKey)
      .then(response => { if (active) setMetadata(response.payload?.data) })
      .catch(failure => { if (active) setMetaError(failure) })
    return () => { active = false }
  }, [apiKey])
  const partial = ['prefix', 'contains', 'fuzzy'].includes(mode)
  const submit = async event => {
    event.preventDefault()
    if (!apiKey || !query.trim()) return
    setBusy(true); setError(null)
    try {
      const body = { mode, query: query.trim(), limit: 20, ...(partial ? { field } : {}), ...(domain.trim() && mode !== 'email' ? { domain: domain.trim() } : {}), ...(maskEmail ? { reveal: false } : {}) }
      const response = await publicDataApi.twitterUserEmailSearch(apiKey, body)
      setResult(response.payload?.data)
    } catch (failure) {
      setResult(null); setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const version = metadata?.version
  const failure = error || (!result && metaError)
  const message = fileDatasetErrorMessage(failure, access, DATASET)
  return <div className="mih-tue">
    <section className="qp-panel">
      <div className="mih-tue-row" style={{ justifyContent: 'space-between' }}>
        <div><h2>查找用户名与邮箱</h2>{!metaError ? <p className="mih-tue-muted">{!apiKey ? '请先在页面顶部选择调用 Key。'
          : version ? `数据版本 v${version.id} · ${exact(version.mappings)} 条映射 · 发布于 ${formatDate(version.publishedAt)}`
            : metadata ? '字典尚未发布版本。' : '正在读取数据版本…'}</p> : null}</div>
      </div>
      <form className="mih-tue-composer" onSubmit={submit}>
        <div className="mih-tue-segment" role="group" aria-label="查询方式">
          {MODES.map(([key, label]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => { setMode(key); setResult(null); setError(null) }}>{label}</button>)}
        </div>
        <div className="mih-tue-row">
          <label className="qp-field mih-tue-query"><span className="qp-field__label">{MODES.find(([key]) => key === mode)[1]}</span>
            <input className="qp-input" value={query} maxLength={320} autoComplete="off" spellCheck={false}
              placeholder={MODES.find(([key]) => key === mode)[2]} onChange={event => setQuery(event.target.value)} /></label>
          {partial ? <label className="qp-field"><span className="qp-field__label">匹配字段</span>
            <select className="qp-input" value={field} onChange={event => setField(event.target.value)}>
              <option value="username">用户名</option><option value="email_local">邮箱 @ 前部分</option>
            </select></label> : null}
          {mode !== 'email' ? <label className="qp-field"><span className="qp-field__label">邮箱域名（可选）</span>
            <input className="qp-input" value={domain} placeholder="gmail.com" onChange={event => setDomain(event.target.value)} /></label> : null}
          <label className="qp-field" style={{ flex: '0 0 auto' }}><span className="qp-field__label">邮箱显示</span>
            <span><input type="checkbox" checked={maskEmail} disabled={!apiKey || busy}
              onChange={event => { setMaskEmail(event.target.checked); setResult(null); setError(null) }} /> 隐藏部分邮箱</span></label>
          <button className="qp-button qp-button--primary" type="submit" disabled={!apiKey || busy || !query.trim()}>
            <MagnifyingGlass size={16} aria-hidden="true" />{busy ? '查询中…' : '查询'}</button>
        </div>
        <p className="mih-tue-muted">精确与前缀查询毫秒级返回；片段与近似查询范围太宽时会直接提示补充条件，不会长时间等待。每次查询按 Key 计量，查询内容不留存明文。</p>
      </form>
    </section>
    <FileDatasetFailure failure={failure} message={message} />
    {result ? <section className="qp-panel">
      <div className="mih-tue-row" style={{ justifyContent: 'space-between' }}>
        <h3>{result.items.length ? `${result.items.length} 条结果${result.meta.truncated ? '（已达上限，可补充条件缩小范围）' : ''}` : '没有找到匹配'}</h3>
        <span className="mih-tue-muted">v{result.meta.datasetVersion} · {result.meta.tookMs} ms{result.meta.revealed ? ' · 已显示完整邮箱' : ' · 邮箱已脱敏'}</span>
      </div>
      {result.items.length ? <div className="mih-tue-scroll"><table className="mih-tue-table"><thead><tr>
        <th>用户名</th><th>邮箱</th><th>匹配</th><th className="num">来源记录</th>
      </tr></thead><tbody>
        {result.items.map((item, index) => <tr key={`${item.username}-${item.email}-${index}`}>
          <td><code>{item.username}</code></td><td><code>{item.email}</code></td>
          <td><span className="mih-tue-match" data-type={item.matchType}>{MATCH_LABELS[item.matchType] || item.matchType}{item.similarity !== undefined ? ` ${item.similarity}` : ''}</span></td>
          <td className="num">{item.sourceRecords}</td>
        </tr>)}
      </tbody></table></div> : null}
      <p className="mih-tue-muted">{result.meta.note}</p>
    </section> : null}
  </div>
}

const GUIDE = <>
  <p>在调用者和 Key 上开通数据域 <code>twitter_user_email</code> 和查询权限 <code>twitter.user_email.search</code> 后即可查询完整邮箱。历史动态范围 Key 需先在 API Keys 中调整权限。</p>
  <p>调用：<code>POST /api/v1/data/twitter-user-email/search</code>，mode 为 username / email / prefix / contains / fuzzy。前缀至少 3 个字符，片段与近似至少 4 个字符；范围太宽返回 <code>422 query_too_broad</code>，忙时返回 <code>503 twitter_user_email_busy</code>。本接口没有分页游标，单次最多 50 条，请用更具体的条件缩小范围。</p>
  <p>省略 <code>reveal</code> 默认返回完整邮箱。传 <code>reveal: false</code> 可获取脱敏结果。完整邮箱查看计入访问审计。</p>
  <p>结果是来源文件记录的关联。近似命中只表示候选关联。</p>
</>

export function TwitterUserEmailPage(props) {
  return <FileDatasetPage datasetKey={DATASET} Experience={Experience} guide={GUIDE} {...props}
    intro="按用户名查邮箱、按邮箱反查用户名，或用片段与近似拼写找候选。数据来自已发布的字典版本，查询不触发实时采集。" />
}
