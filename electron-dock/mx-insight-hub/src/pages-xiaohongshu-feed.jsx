import { requestUuid } from './request-id.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageSquare } from '@phosphor-icons/react'
import { adminApi, publicDataApi } from './api.js'
import { DropdownField, ErrorState, Field, Modal } from './components.jsx'
import { mergeNotes, nativeNotePage, storedNote } from './xiaohongshu-feed.js'

function BusinessImage({ url, enabled, alt }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  let safe = false
  try { const parsed = new URL(url); safe = parsed.protocol === 'https:' && !parsed.username && !parsed.password } catch { /* no image */ }
  return enabled && safe && !failed ? <img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <ImageSquare size={32} aria-label="图片未加载" />
}

function NoteDetail({ item, apiKey, images, NoteScroll, onSelectLink, onClose }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const identity = useRef(null)
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const url = item.url || `https://www.xiaohongshu.com/explore/${item.externalId}`
  const resolve = async () => {
    if (lock.current || !apiKey.trim()) return
    lock.current = true; setBusy(true); setError(null)
    try {
      identity.current ||= `xhs-detail-${requestUuid()}`
      const response = await publicDataApi.xiaohongshuNote(apiKey.trim(), { platform: 'xiaohongshu', url, deliveryMode: 'cache_first' }, { idempotencyKey: identity.current })
      if (alive.current) setResult(response)
    } catch (failure) { if (alive.current) setError(failure) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <Modal title={item.title || '笔记详情'} size="xlarge" onClose={onClose} footer={<button className="qp-button" onClick={onClose}>关闭</button>}>
    <p>{item.bodyCompleteness === 'provider_preview' ? '列表预览可能不含完整正文和标签。' : '展示当前 Hub 已存版本，完整性以采集结果为准。'} 获取完整详情优先读缓存，必要时采集，可能计费。</p>
    <button className="qp-button qp-button--primary" disabled={busy || !apiKey.trim()} onClick={() => void resolve()}>{busy ? '正在读取详情…' : error ? '重试同一详情请求' : '获取完整正文与标签'}</button>
    <button className="qp-button qp-button--ghost" onClick={() => { onSelectLink(url); onClose() }}>带入链接解析表单</button>
    {error ? <ErrorState error={error} /> : null}
    {result?.evidence ? <p>交付：{result.evidence.sourceMode} · Request ID：{result.evidence.requestId}</p> : null}
    <NoteScroll result={result || { payload: { data: { item: { ...item, media: [] } } } }} apiKey={apiKey} mediaEnabled={images} />
    {!result ? <div className="mih-xhs-gallery">{item.media?.map((media, index) => <figure key={index}><BusinessImage url={media.url} enabled={images} alt={`笔记媒体 ${index + 1}`} /></figure>)}</div> : null}
  </Modal>
}

export function XiaohongshuFeed({ token, session, apiKey, onSelectLink, NoteScroll }) {
  const isAdmin = session?.kind === 'admin-token'
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('search_notes')
  const [selector, setSelector] = useState('')
  const [pageSize, setPageSize] = useState('10')
  const [images, setImages] = useState(false)
  const [rows, setRows] = useState([])
  const [cursor, setCursor] = useState(null)
  const [next, setNext] = useState(undefined)
  const [loading, setLoading] = useState(false)
  const [acquiring, setAcquiring] = useState(false)
  const [error, setError] = useState(null)
  const [acquireError, setAcquireError] = useState(null)
  const [evidence, setEvidence] = useState(null)
  const [selected, setSelected] = useState(null)
  const [armed, setArmed] = useState(false)
  const historyEpoch = useRef(0)
  const historyBusy = useRef(false)
  const liveBusy = useRef(false)
  const pending = useRef(null)
  const overflow = useRef([])
  const viewport = useRef(null)
  const touch = useRef(null)
  const wheel = useRef(0)
  const lastPull = useRef(0)
  const scope = `${apiKey}|${kind}|${selector}`
  const currentScope = useRef(scope)
  currentScope.current = scope

  const load = useCallback(async (after = null) => {
    if (!isAdmin || historyBusy.current) return
    const epoch = historyEpoch.current
    historyBusy.current = true; setLoading(true); setError(null)
    try {
      const result = await adminApi.dataCenterRecords(token, { platform: 'xiaohongshu', datasetId: 'social.posts.v1', objectType: 'post', q: query, sort: 'newest', pageSize, ...(after ? { cursor: after } : {}) })
      if (epoch !== historyEpoch.current) return
      if (!Array.isArray(result.items) || !result.pageInfo) throw new Error('Hub 历史响应格式不正确')
      const items = result.items.map(storedNote)
      setRows(previous => after ? mergeNotes(previous, items) : items)
      setCursor(result.pageInfo.nextCursor || null)
    } catch (failure) { if (epoch === historyEpoch.current) setError(failure) }
    finally { if (epoch === historyEpoch.current) { historyBusy.current = false; setLoading(false) } }
  }, [isAdmin, token, query, pageSize])
  useEffect(() => {
    historyEpoch.current += 1; historyBusy.current = false; setRows([]); setCursor(null); setSelected(null)
    const timer = setTimeout(() => void load(), 250)
    return () => { clearTimeout(timer); historyEpoch.current += 1 }
  }, [load])
  useEffect(() => {
    overflow.current = []; pending.current = null; setNext(undefined); setArmed(false); setAcquireError(null); setEvidence(null)
  }, [scope])
  // Identity changes must also discard live results and open detail content.
  useEffect(() => { setRows([]); setSelected(null); void load() }, [apiKey])

  const present = () => {
    const items = overflow.current.splice(0, Number(pageSize))
    setRows(previous => mergeNotes(items, previous))
    if (viewport.current) viewport.current.scrollTop = 0
  }
  const acquire = async () => {
    if (liveBusy.current || historyBusy.current || !apiKey.trim() || !selector.trim()) return
    if (overflow.current.length) { present(); return }
    if (next === null) return
    const ownScope = scope
    const body = next || (kind === 'search_notes'
      ? { keyword: selector.trim(), page: 1, sort_type: 'time_descending', note_type: '普通笔记' }
      : /^[0-9a-f]{24}$/i.test(selector.trim()) ? { user_id: selector.trim() } : { share_text: selector.trim() })
    // Failed or ambiguous delivery retains exactly the same identity. There is
    // no timer retry and a gesture never retries a failed paid operation.
    liveBusy.current = true; setAcquiring(true); setAcquireError(null)
    try {
      const identity = pending.current || { body, key: `xhs-feed-${requestUuid()}` }
      pending.current = identity
      const response = await publicDataApi.xiaohongshuNative(apiKey.trim(), kind, identity.body, { idempotencyKey: identity.key })
      if (ownScope !== currentScope.current) return
      const page = nativeNotePage(response.payload, kind, identity.body)
      overflow.current.push(...page.items); present(); setNext(page.next); setEvidence(response.evidence); pending.current = null
    } catch (failure) { if (ownScope === currentScope.current) { setAcquireError(failure); setArmed(false) } }
    finally { liveBusy.current = false; setAcquiring(false) }
  }
  const pull = () => {
    if (!armed || acquireError || Date.now() - lastPull.current < 1500) return
    lastPull.current = Date.now(); void acquire()
  }
  const more = () => { if (cursor && !loading && !error) void load(cursor) }

  return <section className="mih-commerce-manager mih-xhs-browser">
    <aside className="qp-panel mih-commerce-filters">
      <h2>笔记列表</h2>
      <p>{isAdmin ? '当前管理会话读取 Hub 已存笔记。上划加载历史，点击展开正文和标签。' : '使用下方 API Key 采集已授权笔记；跨租户管理历史仅管理员可读。'}</p>
      {isAdmin ? <><Field label="查找 Hub 已存笔记"><input className="qp-input" value={query} onChange={event => setQuery(event.target.value)} maxLength={500} /></Field>
        <button className="qp-button qp-button--outline" disabled={loading || acquiring} onClick={() => void load()}>刷新 Hub 历史</button></> : null}
      <DropdownField label="每批展示数量" value={pageSize} onChange={setPageSize} options={['10', '20', '50'].map(value => ({ value, label: `${value} 篇` }))} />
      <label><input type="checkbox" checked={images} onChange={event => setImages(event.target.checked)} /> 加载原始图片</label><small>图片从原链接读取，费用未知；默认不访问外部图片。</small>
      <hr /><h3>采集笔记</h3>
      <DropdownField label="采集来源" value={kind} disabled={acquiring} onChange={setKind} options={[{ value: 'search_notes', label: '关键词搜索 · 图文笔记' }, { value: 'get_user_posted_notes', label: '用户笔记列表' }]} />
      <Field label={kind === 'search_notes' ? '采集关键词' : '用户 ID / 主页分享链接'}><input className="qp-input" value={selector} disabled={acquiring} onChange={event => setSelector(event.target.value)} maxLength={500} /></Field>
      <p>使用上方统一选择的演示身份。需要小红书、App V2 兼容合同及相应搜索／用户笔记授权；每页独立计量，最多 15 页。</p>
      <label><input type="checkbox" checked={armed} disabled={acquiring || !apiKey.trim() || !selector.trim()} onChange={event => setArmed(event.target.checked)} /> 允许下拉采集下一页（可能计费）</label>
      <button className="qp-button qp-button--primary" disabled={acquiring || loading || !apiKey.trim() || !selector.trim() || (next === null && !overflow.current.length)} onClick={() => void acquire()}>{acquiring ? '正在获取…' : acquireError ? '重试同一请求' : next === undefined ? '采集第一页' : '获取下一批笔记'}</button>
      {next === null ? <p>本次上游列表已结束，或已达 15 页上限。</p> : null}
      {acquireError ? <ErrorState error={acquireError} /> : null}
      {evidence ? <p>交付：{evidence.sourceMode || '未知'}<br />请求：{evidence.requestId}<br />采集后异步进入 Hub 历史；未入库前不代表数据丢失。</p> : null}
    </aside>
    <div className="mih-commerce-phone-wrap"><div className="mih-commerce-phone">
      <header><span>MX · 小红书笔记</span><strong>笔记画卷</strong><small>{rows.length} 篇已加载</small></header>
      <div className="mih-commerce-phone-actions"><span>{armed ? '下拉采集下一页' : '下拉采集未开启'}</span><span>上划读取 Hub 历史</span></div>
      <div className="mih-commerce-phone-feed" ref={viewport} tabIndex={0} aria-label="小红书笔记列表"
        onScroll={() => { const node = viewport.current; if (node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 160) more() }}
        onWheel={event => { if (event.deltaY < 0 && viewport.current.scrollTop <= 0) { wheel.current -= event.deltaY; if (wheel.current >= 140) { wheel.current = 0; pull() } } else wheel.current = 0 }}
        onTouchStart={event => { touch.current = viewport.current.scrollTop <= 0 ? event.touches[0].clientY : null }}
        onTouchEnd={event => { if (touch.current != null && event.changedTouches[0].clientY - touch.current >= 80) pull(); touch.current = null }} onTouchCancel={() => { touch.current = null }}>
        {error ? <ErrorState error={error} /> : null}
        <div className="mih-commerce-grid">{rows.map(item => <article className="mih-commerce-card" key={item.externalId || item.id}><button className="mih-commerce-card-open" onClick={() => setSelected(item)}>
          <div className="mih-commerce-card-image"><BusinessImage url={item.media?.[0]?.url} enabled={images} alt={item.title || '笔记封面'} /></div>
          <strong>{item.title || '无标题笔记'}</strong><small>{item.author?.name || '作者未知'}</small><span>{item.tags?.map(tag => `#${tag}`).join(' ') || '点击查看正文与标签'}</span>
        </button></article>)}</div>
        {loading ? <p role="status">正在读取 Hub 历史…</p> : null}
        {!loading && !error && !rows.length ? <p className="mih-commerce-message">暂无笔记。可采集关键词列表，或在下方输入笔记链接。</p> : null}
        {cursor ? <button className="qp-button qp-button--outline" disabled={loading} onClick={more}>加载更多 Hub 历史</button> : rows.length ? <p>Hub 历史已加载完毕；上游续页请使用采集操作。</p> : null}
      </div>
    </div></div>
    {selected ? <NoteDetail key={selected.id} item={selected} apiKey={apiKey} images={images} NoteScroll={NoteScroll} onSelectLink={onSelectLink} onClose={() => setSelected(null)} /> : null}
  </section>
}
