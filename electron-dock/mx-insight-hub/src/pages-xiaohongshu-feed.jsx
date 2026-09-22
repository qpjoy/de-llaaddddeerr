import { XiaohongshuConsole } from './xiaohongshu-console.jsx'
import { FeedRuler } from './feed-ruler.jsx'
import { useDemoAccess, useDemoIdentity, DemoAccessNotice } from './demo-credentials.jsx'
import { requestUuid } from './request-id.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageSquare } from '@phosphor-icons/react'
import { adminApi, publicDataApi } from './api.js'
import { DropdownField, ErrorState, Field, Modal } from './components.jsx'
import { mergeNotes, nativeNotePage, storedNote, claimNoteOpenRequest, mergeNoteDetail } from './xiaohongshu-feed.js'

export function BusinessImage({ url, enabled, alt, className }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url, enabled])
  let safe = false
  try { const parsed = new URL(url); safe = parsed.protocol === 'https:' && !parsed.username && !parsed.password } catch { /* no image */ }
  return enabled && safe && !failed ? <img className={className} src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="mih-xhs-image-placeholder"><ImageSquare size={32} aria-label="图片未加载" /><small>{!enabled ? '图片显示已关闭' : !safe ? '暂无图片地址' : '图片加载失败，可在详情中重试'}</small></span>
}

function NoteDetail({ item, apiKey, images, onImagesChange, NoteScroll, DeliveryEvidence, saved, onClose }) {
  const [result, setResult] = useState(saved.result || null)
  const [imageRevision, setImageRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(saved.error || null)
  const identity = useRef(saved.identity || null)
  const lock = useRef(false)
  const resolveIssues = useDemoAccess('social.posts.resolve')
  const analyticsIssues = useDemoAccess('social.posts.analytics')
  const commentIssues = useDemoAccess('social.comments.list')
  const [research, setResearch] = useState(saved.research || {})
  const [researchError, setResearchError] = useState(saved.researchError || null)
  const [commentSort, setCommentSort] = useState(saved.commentSort || 'latest')
  const researchRequests = useRef(saved.researchRequests || new Map())
  saved.researchRequests = researchRequests.current
  const requestResearch = async (endpoint, cursor = null, fresh = false) => {
    if (lock.current || !apiKey.trim() || (endpoint === 'note_detail' ? analyticsIssues : commentIssues).length) return
    const body = { note_id: item.externalId, ...(endpoint === 'note_comments' ? { sort: commentSort, ...(cursor ? { cursor } : {}) } : {}) }
    const fingerprint = JSON.stringify([endpoint, body])
    if (fresh) researchRequests.current.delete(fingerprint)
    const idempotencyKey = researchRequests.current.get(fingerprint) || `xhs-research-${requestUuid()}`
    researchRequests.current.set(fingerprint, idempotencyKey)
    lock.current = true; setBusy(true); setResearchError(null); saved.researchError = null
    try {
      const response = await publicDataApi.xiaohongshuResearch(apiKey.trim(), endpoint, body, { idempotencyKey })
      // Replaying the same page replaces it instead of duplicating comments.
      const pages = endpoint === 'note_comments' ? { ...(cursor ? saved.research?.commentPages : {}), [fingerprint]: response.payload.data.items } : saved.research?.commentPages
      const next = { ...saved.research, [endpoint]: response, commentPages: pages }
      saved.research = next
      if (alive.current) setResearch(next)
    } catch (failure) { saved.researchError = failure; if (alive.current) setResearchError(failure) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const url = item.url || `https://www.xiaohongshu.com/explore/${item.externalId}`
  const resolve = async (deliveryMode = 'cache_first') => {
    if (lock.current || !apiKey.trim() || resolveIssues.length) return
    lock.current = true; setBusy(true); setError(null)
    try {
      identity.current ||= { key: `xhs-detail-${requestUuid()}`, deliveryMode }
      saved.identity = identity.current
      const response = await publicDataApi.xiaohongshuNote(apiKey.trim(), { platform: 'xiaohongshu', url, deliveryMode: identity.current.deliveryMode }, { idempotencyKey: identity.current.key })
      if (alive.current) { setResult(response); setImageRevision(value => value + 1) }
      identity.current = null; saved.identity = null; saved.result = response; saved.error = null
    } catch (failure) { saved.error = failure; if (alive.current) setError(failure) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  // Opening a card is the user's request. Claim it before dispatch so Strict
  // Mode, credential renewal and reopening never initiate another paid call.
  useEffect(() => {
    const operation = claimNoteOpenRequest(saved, { apiKey, analyticsIssues, resolveIssues })
    if (operation === 'note_detail') void requestResearch('note_detail')
    if (operation === 'resolve') void resolve()
  }, [apiKey, saved, analyticsIssues.length, resolveIssues.length])
  const analytics = research.note_detail?.payload?.data?.item
  const displayed = mergeNoteDetail(result?.payload?.data?.item || item, research.note_detail?.payload)
  const primary = saved.openOperation || (!analyticsIssues.length ? 'note_detail' : 'resolve')
  const primaryIssues = primary === 'note_detail' ? analyticsIssues : resolveIssues
  const primaryError = primary === 'note_detail' ? researchError : error
  const primaryResult = primary === 'note_detail' ? research.note_detail : result
  const refresh = () => primary === 'note_detail'
    ? requestResearch('note_detail', null, Boolean(primaryResult) && !primaryError)
    : resolve(primaryResult && !primaryError ? 'live_only' : 'cache_first')
  return <Modal title={item.title || '笔记详情'} size="xlarge" closeOnBackdrop={false} closeOnEscape={false} busy={busy} onClose={onClose} footer={<button className="qp-button" disabled={busy} onClick={onClose}>关闭</button>}>
    <div className="mih-xhs-detail-actions mih-xhs-detail-toolbar">
      <span role="status">{busy ? '正在加载…' : primaryResult ? '详情已加载' : '当前已存笔记'}</span>
      <button className="qp-button qp-button--outline qp-button--sm" disabled={busy || !apiKey.trim() || !!primaryIssues.length} onClick={() => void refresh()}>{primaryError ? '重试详情' : primaryResult ? '刷新详情' : '加载详情'}</button>
      <small>{primary === 'note_detail' ? '按套餐计费 · 新查询建议间隔至少 5 秒' : '缓存优先，采集按套餐计费'}</small>
    </div>
    {!apiKey.trim() ? <p role="status">正在等待调用身份。</p> : primaryIssues.length && !primaryResult ? <p role="status">当前详情服务不可用，先展示已存内容。可在下方“更多操作与请求记录”中查看原因。</p> : null}
    {error ? <ErrorState error={error} /> : null}
    {researchError ? <ErrorState error={researchError} /> : null}
    {research.note_detail && !analytics ? <p role="status">本次未返回详情，保留已存内容。</p> : null}
    <NoteScroll key={imageRevision} result={{ payload: { data: { item: displayed } } }} apiKey={apiKey} mediaEnabled={images} directImages />
    <details className="mih-xhs-detail-options"><summary>更多操作与请求记录</summary>
      <div className="mih-xhs-detail-actions"><label><input type="checkbox" checked={images} onChange={event => onImagesChange(event.target.checked)} /> 显示笔记图片</label>
        <button className="qp-button qp-button--outline qp-button--sm" disabled={!images} onClick={() => setImageRevision(value => value + 1)}>重新加载图片</button></div>
      <section aria-label="正文与标签"><h3>正文与标签</h3>
        <DemoAccessNotice operation="social.posts.resolve" />
        <button className="qp-button qp-button--outline" disabled={busy || !apiKey.trim() || !!resolveIssues.length} onClick={() => void resolve()}>{error ? '重试正文请求' : '补充完整正文与标签'}</button>
        {result || error ? <DeliveryEvidence evidence={result?.evidence} error={error} /> : null}
      </section>
      <section aria-label="详情与阅读量"><h3>详情与阅读量</h3>
        <p>新查询建议间隔至少 5 秒，按套餐计费。未提供的结构化标签保留已有结果。</p>
        <DemoAccessNotice operation="social.posts.analytics" />
        <button className="qp-button qp-button--outline" disabled={busy || !apiKey.trim() || !!analyticsIssues.length} onClick={() => void requestResearch('note_detail', null, !!research.note_detail && !researchError)}>{research.note_detail ? '刷新阅读量' : '获取详情与阅读量'}</button>
        {research.note_detail ? <DeliveryEvidence evidence={research.note_detail.evidence} /> : null}
      </section>
    </details>
    <section className="qp-panel mih-xhs-comments" aria-label="笔记评论"><h3>笔记评论</h3>
      {commentIssues.length ? <details><summary>评论暂不可用 · 查看原因</summary><DemoAccessNotice operation="social.comments.list" /></details> : <>
        <div className="mih-xhs-detail-actions"><DropdownField label="评论排序" disabled={busy} value={commentSort} options={[{ value: 'latest', label: '最新' }, { value: 'hot', label: '最热' }]} onChange={value => { saved.commentSort = value; setCommentSort(value); const next = { ...research, note_comments: null, commentPages: {} }; saved.research = next; setResearch(next) }} />
          <button className="qp-button qp-button--outline" disabled={busy || !apiKey.trim()} onClick={() => void requestResearch('note_comments')}>加载评论</button>
          {research.note_comments?.payload?.data?.nextCursor ? <button className="qp-button qp-button--outline" disabled={busy} onClick={() => void requestResearch('note_comments', research.note_comments.payload.data.nextCursor)}>下一页评论</button> : null}
          <small>每页按套餐计费</small>
        </div>
        {Object.values(research.commentPages || {}).flat().map(comment => <Comment key={comment.id} comment={comment} />)}
        {research.note_comments ? <><p>{research.note_comments.payload.data.hasMore === false ? '已无后续评论。' : research.note_comments.payload.data.nextCursor ? '可加载下一页。' : '暂无后续分页信息。'}</p><details><summary>评论请求记录</summary><DeliveryEvidence evidence={research.note_comments.evidence} /></details></> : null}
      </>}
    </section>
  </Modal>
}

function Comment({ comment }) {
  return <article className="qp-panel"><strong>{comment.author?.name || '匿名用户'}</strong><small> · 点赞 {comment.liked ?? '未提供'} · 回复 {comment.replyCount ?? '未提供'}</small><p style={{ whiteSpace: 'pre-wrap' }}>{comment.text}</p>{comment.replies?.map(reply => <Comment key={reply.id} comment={reply} />)}</article>
}

export function XiaohongshuFeed({ token, session, apiKey, NoteScroll, DeliveryEvidence }) {
  const identity = useDemoIdentity()
  const details = useRef({ identity, notes: new Map() })
  if (details.current.identity !== identity) details.current = { identity, notes: new Map() }
  const detailState = id => {
    if (!details.current.notes.has(id)) details.current.notes.set(id, {})
    return details.current.notes.get(id)
  }
  const isAdmin = session?.kind === 'admin-token'
  const [view, setView] = useState('api')
  const [listPage, setListPage] = useState(1)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('search_notes')
  const [sortType, setSortType] = useState('popularity_descending')
  const [timeFilter, setTimeFilter] = useState('不限')
  const operation = kind === 'search_notes' ? 'social.posts.search' : 'social.users.posts'
  const accessIssues = useDemoAccess(operation, true)
  const [selector, setSelector] = useState('')
  const [pageSize, setPageSize] = useState('10')
  const [images, setImages] = useState(true)
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
  const lastAcquire = useRef(0)
  const historyScrollIntent = useRef(false)
  const scope = `${identity}|${kind}|${selector}|${sortType}|${timeFilter}`
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
      if (!after) { setListPage(1); if (viewport.current) viewport.current.scrollTop = 0 }
      return items
    } catch (failure) { if (epoch === historyEpoch.current) setError(failure) }
    finally { if (epoch === historyEpoch.current) { historyBusy.current = false; setLoading(false) } }
  }, [isAdmin, token, query, pageSize, identity])
  useEffect(() => {
    historyEpoch.current += 1; historyBusy.current = false; historyScrollIntent.current = false; setListPage(1); setRows([]); setCursor(null); setSelected(null)
    const timer = setTimeout(() => void load(), 250)
    return () => { clearTimeout(timer); historyEpoch.current += 1 }
  }, [load])
  useEffect(() => {
    overflow.current = []; pending.current = null; setNext(undefined); setArmed(false); setAcquireError(null); setEvidence(null)
  }, [scope])

  const present = () => {
    setListPage(1)
    const items = overflow.current.splice(0, Number(pageSize))
    setRows(previous => mergeNotes(items, previous))
    if (viewport.current) viewport.current.scrollTop = 0
  }
  const acquire = async () => {
    if (accessIssues.length || liveBusy.current || historyBusy.current || !apiKey.trim() || !selector.trim()) return
    if (Date.now() - lastAcquire.current < 800) return
    lastAcquire.current = Date.now()
    if (overflow.current.length) { present(); return }
    if (next === null) return
    const ownScope = scope
    const body = next || (kind === 'search_notes'
      ? { keyword: selector.trim(), page: 1, sort_type: sortType, time_filter: timeFilter, note_type: '普通笔记' }
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
    if (view !== 'mobile' || !armed || acquireError || Date.now() - lastPull.current < 1500) return
    lastPull.current = Date.now(); void acquire()
  }
  const more = () => { if (cursor && !loading && !error) void load(cursor) }
  const changeView = value => { historyScrollIntent.current = false; setView(value) }

  const totalPages = Math.max(1, Math.ceil(rows.length / Number(pageSize)))
  const currentPage = Math.min(listPage, totalPages)
  const changeListPage = async direction => {
    const target = currentPage + direction
    if (target > totalPages) {
      if (!cursor || loading || historyBusy.current) return
      const items = await load(cursor)
      if (!items?.length) return
    }
    setListPage(target)
    if (viewport.current) viewport.current.scrollTop = 0
  }

  return <section className={`mih-commerce-manager mih-xhs-browser ${view === 'list' ? 'mih-xhs-list-view' : ''}`}>
    <nav className="mih-source-section-tabs mih-xhs-view-tabs" aria-label="笔记展示方式"><button aria-pressed={view === 'api'} onClick={() => changeView('api')}>接口调试</button><button aria-pressed={view === 'list'} onClick={() => changeView('list')}>列表视图</button><button aria-pressed={view === 'mobile'} onClick={() => changeView('mobile')}>Mobile 视图</button></nav>
    <div className="mih-api-console-tab" hidden={view !== 'api'}><XiaohongshuConsole apiKey={apiKey} admin={session?.platformAdmin === true} /></div>
    <aside className="qp-panel mih-commerce-filters" style={view === 'api' ? { display: 'none' } : undefined}>
      <h2>笔记列表</h2>
      <p>{isAdmin ? '读取 Hub 已存笔记；列表按页浏览，Mobile 上划加载历史。点击笔记直接加载详情。' : '使用当前账户查询笔记，点击卡片查看正文、图片和标签。'}</p>
      {isAdmin ? <><Field label="查找 Hub 已存笔记"><input className="qp-input" value={query} onChange={event => setQuery(event.target.value)} maxLength={500} /></Field>
        <button className="qp-button qp-button--outline" disabled={loading || acquiring} onClick={() => void load()}>刷新 Hub 历史</button></> : null}
      <DropdownField label="每批展示数量" value={pageSize} onChange={setPageSize} options={['10', '20', '50'].map(value => ({ value, label: `${value} 篇` }))} />
      <label><input type="checkbox" checked={images} onChange={event => setImages(event.target.checked)} /> 加载原始图片</label><small>默认显示已有图片；只读取图片链接，不重新调用笔记采集接口。图片服务费用未知，可关闭显示。</small>
      <hr /><h3>查询笔记</h3>
      <DropdownField label="查询方式" value={kind} disabled={acquiring} onChange={setKind} options={[{ value: 'search_notes', label: '关键词搜索 · 图文笔记' }, { value: 'get_user_posted_notes', label: '用户笔记列表' }]} />
      <Field label={kind === 'search_notes' ? '查询关键词' : '用户 ID / 主页分享链接'}><input className="qp-input" value={selector} disabled={acquiring} onChange={event => setSelector(event.target.value)} maxLength={500} /></Field>
      {kind === 'search_notes' ? <><DropdownField label="笔记排序" value={sortType} disabled={acquiring} onChange={setSortType} options={[{ value: 'popularity_descending', label: '最热 · 按点赞' }, { value: 'time_descending', label: '最新' }, { value: 'comment_descending', label: '评论最多' }, { value: 'general', label: '综合' }]} /><DropdownField label="发布时间" value={timeFilter} disabled={acquiring} onChange={setTimeFilter} options={['不限', '一天内', '一周内', '半年内'].map(value => ({ value, label: value }))} /><p>按关键词与互动排序发现热门笔记，不代表全站热榜。点击笔记加载详情，评论按需展开。</p></> : null}
      <p>每页查询计为一次调用，费用以当前套餐为准；最多查询 15 页。</p>
      <DemoAccessNotice operation={operation} compatibility />
      <label><input type="checkbox" checked={armed} disabled={accessIssues.length > 0 || acquiring || !apiKey.trim() || !selector.trim()} onChange={event => setArmed(event.target.checked)} /> 允许下拉采集下一页（可能计费）</label>
      <button className="qp-button qp-button--primary" disabled={accessIssues.length > 0 || acquiring || loading || !apiKey.trim() || !selector.trim() || (next === null && !overflow.current.length)} onClick={() => void acquire()}>{acquiring ? '正在获取…' : acquireError ? '重试同一请求' : next === undefined ? '查询第一页' : '获取下一批笔记'}</button>
      {next === null ? <p>本次查询列表已结束，或已达 15 页上限。</p> : null}
      {acquireError ? <ErrorState error={acquireError} /> : null}
      {evidence ? <p>交付：{evidence.sourceMode || '未知'}<br />请求：{evidence.requestId}<br />查询结果已返回，历史记录稍后更新。</p> : null}
    </aside>
    <div className="mih-commerce-phone-wrap mih-xhs-phone-navigation" style={view === 'api' ? { display: 'none' } : undefined}><div className="mih-commerce-phone">
      <header><span>MX · 小红书笔记</span><strong>笔记画卷</strong><small>{rows.length} 篇已加载</small></header>
      <div className="mih-commerce-phone-actions"><span>{armed ? '下拉采集下一页' : '下拉采集未开启'}</span><span>{isAdmin ? '上划读取 Hub 历史' : '本次查询结果'}</span></div>
      <div className="mih-commerce-phone-feed" ref={viewport} tabIndex={0} aria-label="小红书笔记列表" aria-busy={loading} onKeyDown={event => { if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) historyScrollIntent.current = true }}
        onScroll={() => { const node = viewport.current; if (view === 'mobile' && historyScrollIntent.current && node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 160) { historyScrollIntent.current = false; more() } }}
        onWheel={event => { historyScrollIntent.current = event.deltaY > 0; if (event.deltaY < 0 && viewport.current.scrollTop <= 0) { wheel.current -= event.deltaY; if (wheel.current >= 140) { wheel.current = 0; pull() } } else wheel.current = 0 }}
        onTouchStart={event => { historyScrollIntent.current = true; touch.current = viewport.current.scrollTop <= 0 ? event.touches[0].clientY : null }}
        onTouchEnd={event => { if (touch.current != null && event.changedTouches[0].clientY - touch.current >= 80) pull(); touch.current = null }} onTouchCancel={() => { touch.current = null }}>
        {error ? <ErrorState error={error} /> : null}
        {view === 'list' ? <>
          <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>笔记</th><th>作者</th><th>标签</th><th>操作</th></tr></thead><tbody>
            {rows.slice((currentPage - 1) * Number(pageSize), currentPage * Number(pageSize)).map(item => <tr key={item.externalId || item.id}>
              <td><button className="mih-xhs-list-title" onClick={() => setSelected(item)}><span><BusinessImage url={item.media?.[0]?.url} enabled={images} alt={item.title || '笔记封面'} /></span><strong>{item.title || '无标题笔记'}</strong></button></td>
              <td>{item.author?.name || '作者未知'}</td><td>{item.tags?.join('、') || '—'}</td><td><button className="qp-button qp-button--outline qp-button--sm" onClick={() => setSelected(item)}>查看详情</button></td>
            </tr>)}
          </tbody></table></div>
          <div className="mih-xhs-list-pages"><button className="qp-button qp-button--outline" disabled={currentPage <= 1 || loading} onClick={() => void changeListPage(-1)}>上一页</button><span>{currentPage} / {totalPages}{cursor ? '+' : ''} · {rows.length} 篇已加载</span><button className="qp-button qp-button--outline" disabled={loading || (currentPage >= totalPages && !cursor)} onClick={() => void changeListPage(1)}>{loading ? '正在加载…' : '下一页'}</button></div>
        </> : <>
        <div className="mih-commerce-grid">{rows.map((item, index) => <article data-feed-index={index} className="mih-commerce-card" key={item.externalId || item.id}><button className="mih-commerce-card-open" onClick={() => setSelected(item)}>
          <div className="mih-commerce-card-image"><BusinessImage url={item.media?.[0]?.url} enabled={images} alt={item.title || '笔记封面'} /></div>
          <strong>{item.title || '无标题笔记'}</strong>{item.media?.length ? <small>{item.media.length} 张图片 · 点击查看全部</small> : null}<small>{item.author?.name || '作者未知'}</small><span>{item.tags?.map(tag => `#${tag}`).join(' ') || '点击查看正文与标签'}</span>
        </button></article>)}</div>
        </>}
        {!loading && !error && !rows.length ? <p className="mih-commerce-message">暂无笔记。可查询关键词列表，或在下方输入笔记链接。</p> : null}
        {view === 'mobile' ? <div className="mih-xhs-history-status">{loading ? <span role="status">正在读取 Hub 历史…</span> : cursor ? <button className="qp-button qp-button--outline" onClick={more}>加载更多 Hub 历史</button> : rows.length ? <p>Hub 历史已加载完毕</p> : null}</div> : null}
      </div>
    </div>{view === 'mobile' ? <FeedRuler viewport={viewport} count={rows.length} pageSize={Number(pageSize)} onNavigate={() => { historyScrollIntent.current = false; wheel.current = 0; touch.current = null; lastPull.current = Date.now() }} /> : null}</div>
    {selected ? <NoteDetail key={selected.externalId || selected.id} item={selected} apiKey={apiKey} images={images} onImagesChange={setImages} NoteScroll={NoteScroll} DeliveryEvidence={DeliveryEvidence} saved={detailState(selected.externalId || selected.id)} onClose={() => setSelected(null)} /> : null}
  </section>
}
