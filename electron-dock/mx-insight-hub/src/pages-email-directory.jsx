// Data product "邮箱库" (文件数据集): 接口调试 · 产品展示 · 接入指南 · 管理.
import { useEffect, useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { formatDate } from './components.jsx'
import { useDemoAccessSnapshot } from './demo-credentials.jsx'
import { FileDatasetFailure, FileDatasetPage, exact, fileDatasetErrorMessage } from './file-dataset-page.jsx'

const DATASET = 'email-directory'
const MODES = [
  ['email', '邮箱是否在库', '输入完整邮箱，例如 name@example.com'],
  ['prefix', '前缀', '@ 前部分的开头，至少 3 个字符'],
  ['domain', '域名下全部', '输入域名，例如 example.com'],
  ['contains', '片段', '@ 前部分包含的片段，至少 4 个字符'],
  ['fuzzy', '近似拼写', '@ 前部分，4–64 个字符，按相似度排序'],
]
const MATCH_LABELS = { exact: '原样相等', case_insensitive: '忽略大小写', prefix: '前缀', domain: '域名', contains: '片段', similar: '近似' }

function Experience({ apiKey }) {
  const access = useDemoAccessSnapshot()
  const [metadata, setMetadata] = useState(null), [metaError, setMetaError] = useState(null)
  const [mode, setMode] = useState('email'), [query, setQuery] = useState(''), [domain, setDomain] = useState('')
  const [mask, setMask] = useState(false)
  const [busy, setBusy] = useState(false), [pages, setPages] = useState([]), [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    setMetadata(null); setMetaError(null)
    if (apiKey) publicDataApi.fileDatasetMetadata(apiKey, DATASET)
      .then(response => { if (active) setMetadata(response.payload?.data) })
      .catch(failure => { if (active) setMetaError(failure) })
    return () => { active = false }
  }, [apiKey])
  const filterable = ['prefix', 'contains', 'fuzzy'].includes(mode)
  const run = async after => {
    if (!apiKey || !query.trim()) return
    setBusy(true); setError(null)
    try {
      const body = {
        mode, query: query.trim(), limit: 20,
        ...(filterable && domain.trim() ? { domain: domain.trim() } : {}),
        ...(after ? { after } : {}),
        ...(mask ? { reveal: false } : {}),
      }
      const response = await publicDataApi.fileDatasetSearch(apiKey, DATASET, body)
      const page = response.payload?.data
      setPages(current => after ? [...current, page] : [page])
    } catch (failure) {
      if (!after) setPages([])
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const reset = () => { setPages([]); setError(null) }
  const submit = event => { event.preventDefault(); run(null) }
  const version = metadata?.version
  const last = pages.at(-1)
  const items = pages.flatMap(page => page.items)
  const failure = error || (!pages.length && metaError)
  const message = fileDatasetErrorMessage(failure, access, DATASET)
  const current = MODES.find(([key]) => key === mode)
  return <div className="mih-tue">
    <section className="qp-panel">
      <div><h2>查找邮箱</h2>{!metaError ? <p className="mih-tue-muted">{!apiKey ? '请先在页面顶部选择调用 Key。'
        : version ? `数据版本 v${version.id} · ${exact(version.addresses)} 个邮箱 · 发布于 ${formatDate(version.publishedAt)}`
          : metadata ? '邮箱库尚未发布版本。' : '正在读取数据版本…'}</p> : null}</div>
      <form className="mih-tue-composer" onSubmit={submit}>
        <div className="mih-tue-segment" role="group" aria-label="查询方式">
          {MODES.map(([key, label]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => { setMode(key); reset() }}>{label}</button>)}
        </div>
        <div className="mih-tue-row">
          <label className="qp-field mih-tue-query"><span className="qp-field__label">{current[1]}</span>
            <input className="qp-input" value={query} maxLength={320} autoComplete="off" spellCheck={false}
              placeholder={current[2]} onChange={event => setQuery(event.target.value)} /></label>
          {filterable ? <label className="qp-field"><span className="qp-field__label">邮箱域名（可选）</span>
            <input className="qp-input" value={domain} placeholder="gmail.com" onChange={event => setDomain(event.target.value)} /></label> : null}
          <label className="qp-field" style={{ flex: '0 0 auto' }}><span className="qp-field__label">邮箱显示</span>
            <span><input type="checkbox" checked={mask} disabled={!apiKey || busy}
              onChange={event => { setMask(event.target.checked); reset() }} /> 隐藏部分邮箱</span></label>
          <button className="qp-button qp-button--primary" type="submit" disabled={!apiKey || busy || !query.trim()}>
            <MagnifyingGlass size={16} aria-hidden="true" />{busy ? '查询中…' : '查询'}</button>
        </div>
        <p className="mih-tue-muted">精确、前缀与域名列表毫秒级返回，域名列表可逐页翻到底；片段与近似查询范围太宽时直接提示补充条件。每次查询按 Key 计量，查询内容不留存明文。</p>
      </form>
    </section>
    <FileDatasetFailure failure={failure} message={message} />
    {pages.length ? <section className="qp-panel">
      <div className="mih-tue-row" style={{ justifyContent: 'space-between' }}>
        <h3>{items.length ? `${items.length} 条结果${last.meta.truncated && !last.meta.nextCursor ? '（已达上限，可补充条件缩小范围）' : ''}` : '没有找到匹配'}</h3>
        <span className="mih-tue-muted">v{last.meta.datasetVersion} · {last.meta.tookMs} ms{last.meta.revealed ? ' · 已显示完整邮箱' : ' · 邮箱已脱敏'}</span>
      </div>
      {items.length ? <div className="mih-tue-scroll"><table className="mih-tue-table"><thead><tr>
        <th>邮箱</th><th>域名</th><th>匹配</th><th className="num">来源记录</th>
      </tr></thead><tbody>
        {items.map((item, index) => <tr key={`${item.email}-${index}`}>
          <td><code>{item.email}</code></td><td>{item.domain}</td>
          <td><span className="mih-tue-match" data-type={item.matchType}>{MATCH_LABELS[item.matchType] || item.matchType}{item.similarity !== undefined ? ` ${item.similarity}` : ''}</span></td>
          <td className="num">{item.sourceRecords}</td>
        </tr>)}
      </tbody></table></div> : null}
      {last.meta.nextCursor ? <div className="mih-page-actions"><button className="qp-button qp-button--ghost" type="button" disabled={busy}
        onClick={() => run(last.meta.nextCursor)}>{busy ? '读取中…' : '下一页'}</button></div> : null}
      <p className="mih-tue-muted">{last.meta.note}</p>
    </section> : null}
  </div>
}

const GUIDE = <>
  <p>在调用者和 Key 上开通数据域 <code>email_directory</code> 和查询权限 <code>email.directory.search</code> 后即可查询。历史动态范围 Key 需先在 API Keys 中调整权限。</p>
  <p>调用：<code>POST /api/v1/data/email-directory/search</code>，mode 为 email / prefix / domain / contains / fuzzy。前缀至少 3 个字符，片段与近似至少 4 个字符（都只匹配 @ 前部分，可另传 <code>domain</code> 过滤）；范围太宽返回 <code>422 query_too_broad</code>，忙时返回 <code>503 email_directory_busy</code>。</p>
  <p><code>domain</code> 模式列出某个域名下的全部邮箱：每页最多 50 条，把返回的 <code>meta.nextCursor</code> 作为下一次的 <code>after</code> 即可翻页，任意深度都只读一段索引。</p>
  <p>省略 <code>reveal</code> 默认返回完整邮箱，传 <code>reveal: false</code> 返回脱敏结果。结果来自已发布的来源文件，不代表邮箱当前可用。</p>
</>

export function EmailDirectoryPage(props) {
  return <FileDatasetPage datasetKey={DATASET} Experience={Experience} guide={GUIDE} {...props}
    intro="查某个邮箱是否在库、按 @ 前部分的前缀或片段找候选、列出某个域名下的全部邮箱。数据来自已发布的文件数据集版本，查询不触发实时采集。" />
}
