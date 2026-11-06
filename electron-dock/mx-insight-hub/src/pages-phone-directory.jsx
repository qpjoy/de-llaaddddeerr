// Data product "手机号库" (文件数据集): 接口调试 · 产品展示 · 接入指南 · 管理.
import { useEffect, useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { formatDate } from './components.jsx'
import { useDemoAccessSnapshot } from './demo-credentials.jsx'
import { FileDatasetFailure, FileDatasetPage, exact, fileDatasetErrorMessage } from './file-dataset-page.jsx'

const DATASET = 'phone-directory'
const MODES = [
  ['exact', '号码是否在库', '含国家码的完整号码，例如 +1 415 555 0123'],
  ['prefix', '国家码 / 区号', '号码开头，至少 4 位（含国家码），例如 +1 415'],
  ['suffix', '尾号', '号码末尾，至少 4 位，例如 0123'],
]
const MATCH_LABELS = { exact: '完整号码', prefix: '开头', suffix: '尾号' }

function Experience({ apiKey }) {
  const access = useDemoAccessSnapshot()
  const [metadata, setMetadata] = useState(null), [metaError, setMetaError] = useState(null)
  const [mode, setMode] = useState('exact'), [query, setQuery] = useState(''), [mask, setMask] = useState(false)
  const [busy, setBusy] = useState(false), [pages, setPages] = useState([]), [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    setMetadata(null); setMetaError(null)
    if (apiKey) publicDataApi.fileDatasetMetadata(apiKey, DATASET)
      .then(response => { if (active) setMetadata(response.payload?.data) })
      .catch(failure => { if (active) setMetaError(failure) })
    return () => { active = false }
  }, [apiKey])
  const run = async after => {
    if (!apiKey || !query.trim()) return
    setBusy(true); setError(null)
    try {
      const body = { mode, query: query.trim(), limit: 20, ...(after ? { after } : {}), ...(mask ? { reveal: false } : {}) }
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
  const version = metadata?.version
  const last = pages.at(-1)
  const items = pages.flatMap(page => page.items)
  const failure = error || (!pages.length && metaError)
  const message = fileDatasetErrorMessage(failure, access, DATASET)
  const current = MODES.find(([key]) => key === mode)
  return <div className="mih-tue">
    <section className="qp-panel">
      <div><h2>查找手机号</h2>{!metaError ? <p className="mih-tue-muted">{!apiKey ? '请先在页面顶部选择调用 Key。'
        : version ? `数据版本 v${version.id} · ${exact(version.numbers)} 个号码 · 发布于 ${formatDate(version.publishedAt)}`
          : metadata ? '手机号库尚未发布版本。' : '正在读取数据版本…'}</p> : null}</div>
      <form className="mih-tue-composer" onSubmit={event => { event.preventDefault(); run(null) }}>
        <div className="mih-tue-segment" role="group" aria-label="查询方式">
          {MODES.map(([key, label]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => { setMode(key); reset() }}>{label}</button>)}
        </div>
        <div className="mih-tue-row">
          <label className="qp-field mih-tue-query"><span className="qp-field__label">{current[1]}</span>
            <input className="qp-input" value={query} maxLength={64} inputMode="tel" autoComplete="off" spellCheck={false}
              placeholder={current[2]} onChange={event => setQuery(event.target.value)} /></label>
          <label className="qp-field" style={{ flex: '0 0 auto' }}><span className="qp-field__label">号码显示</span>
            <span><input type="checkbox" checked={mask} disabled={!apiKey || busy}
              onChange={event => { setMask(event.target.checked); reset() }} /> 隐藏中间位</span></label>
          <button className="qp-button qp-button--primary" type="submit" disabled={!apiKey || busy || !query.trim()}>
            <MagnifyingGlass size={16} aria-hidden="true" />{busy ? '查询中…' : '查询'}</button>
        </div>
        <p className="mih-tue-muted">号码按国际格式（+国家码…）保存，输入可带空格、-、括号和点。三种查询都走索引，毫秒级返回；开头与尾号可逐页翻到底。每次查询按 Key 计量，查询内容不留存明文。</p>
      </form>
    </section>
    <FileDatasetFailure failure={failure} message={message} />
    {pages.length ? <section className="qp-panel">
      <div className="mih-tue-row" style={{ justifyContent: 'space-between' }}>
        <h3>{items.length ? `${items.length} 个号码` : '没有找到匹配'}</h3>
        <span className="mih-tue-muted">v{last.meta.datasetVersion} · {last.meta.tookMs} ms{last.meta.revealed ? ' · 已显示完整号码' : ' · 号码已脱敏'}</span>
      </div>
      {items.length ? <div className="mih-tue-scroll"><table className="mih-tue-table"><thead><tr>
        <th>号码</th><th>匹配</th><th className="num">来源记录</th>
      </tr></thead><tbody>
        {items.map((item, index) => <tr key={`${item.phone}-${index}`}>
          <td><code>{item.phone}</code></td>
          <td><span className="mih-tue-match" data-type={item.matchType === 'exact' ? 'exact' : undefined}>{MATCH_LABELS[item.matchType] || item.matchType}</span></td>
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
  <p>在调用者和 Key 上开通数据域 <code>phone_directory</code> 和查询权限 <code>phone.directory.search</code> 后即可查询。历史动态范围 Key 需先在 API Keys 中调整权限。</p>
  <p>调用：<code>POST /api/v1/data/phone-directory/search</code>，mode 为 exact / prefix / suffix。号码按 E.164 保存（国家码在前，返回时带 +）；查询可带 +、空格、-、括号和点。开头至少 4 位（含国家码），尾号至少 4 位。</p>
  <p>prefix 与 suffix 每页最多 50 条，把返回的 <code>meta.nextCursor</code> 作为下一次的 <code>after</code> 即可翻页。不提供号码片段搜索：数字只有 10 种，片段无法有效缩小范围。</p>
  <p>省略 <code>reveal</code> 默认返回完整号码，传 <code>reveal: false</code> 返回脱敏结果。结果来自已发布的来源文件，不代表号码当前在用。</p>
</>

export function PhoneDirectoryPage(props) {
  return <FileDatasetPage datasetKey={DATASET} Experience={Experience} guide={GUIDE} {...props}
    intro="查某个号码是否在库、按国家码或区号列出号码、按尾号查找。数据来自已发布的文件数据集版本，查询不触发实时采集。" />
}
