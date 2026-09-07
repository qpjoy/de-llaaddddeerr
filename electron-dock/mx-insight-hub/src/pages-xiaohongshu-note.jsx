import { useEffect, useMemo, useState } from 'react'
import {
  ArrowSquareOut,
  ClockCounterClockwise,
  Hash,
  ImageSquare,
  LinkSimple,
  Scroll,
  Sparkle,
  SpinnerGap,
  User,
} from '@phosphor-icons/react'
import { publicDataApi, publicDocsHref } from './api.js'
import { ErrorState, Field, PageHeading } from './components.jsx'
import { productMediaLoader } from './product-media-loader.js'

const DELIVERY_OPTIONS = [
  { value: 'cache_first', label: '智能交付 · 缓存优先' },
  { value: 'cache_only', label: '只读 Hub 存量' },
  { value: 'refresh', label: '重新采集 · 可能产生上游成本' },
]
const PENDING_REQUEST_KEY = 'mx-insight-hub.xiaohongshu-note.pending.v1'
const AMBIGUOUS_CODES = new Set([
  'external_platform_outcome_unknown',
  'request_outcome_unknown',
  'upstream_outcome_unknown',
  'external_platform_persistence_unknown',
])

function readPendingRequest() {
  if (typeof window === 'undefined') return null
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PENDING_REQUEST_KEY) || 'null')
    if (!value || typeof value !== 'object'
      || !/^xhs-[0-9a-f-]{36}$/u.test(value.idempotencyKey || '')
      || !value.body || value.body.deliveryMode !== 'refresh') return null
    return value
  } catch {
    return null
  }
}

function rememberPendingRequest(value) {
  window.sessionStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify(value))
}

function clearPendingRequest() {
  try { window.sessionStorage.removeItem(PENDING_REQUEST_KEY) } catch { /* best effort */ }
}

function sameRequest(left, right) {
  return left?.platform === right?.platform && left?.url === right?.url && left?.deliveryMode === right?.deliveryMode
}

function formatDate(value) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN')
}

function metricEntries(metrics = {}) {
  return [
    ['点赞', metrics.liked],
    ['收藏', metrics.collected],
    ['评论', metrics.comments],
    ['分享', metrics.shared],
  ].filter(([, value]) => value != null)
}

function RelayImage({ apiKey, requestId, mediaIndex = 0, className = '', alt = '', showPlaceholder = false }) {
  const [source, setSource] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setSource(null)
    setFailed(false)
    if (!apiKey || !requestId) return undefined
    const controller = new AbortController()
    let objectUrl = null
    productMediaLoader.load(() => publicDataApi.socialPostImage(apiKey, {
      requestId,
      mediaIndex,
    }, { signal: controller.signal }), { signal: controller.signal }).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setSource(objectUrl)
    }).catch((error) => {
      if (!controller.signal.aborted && error?.name !== 'AbortError') setFailed(true)
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [apiKey, mediaIndex, requestId])
  if (source) return (
    <img
      className={className}
      src={source}
      alt={alt}
      onError={() => {
        URL.revokeObjectURL(source)
        setSource(null)
        setFailed(true)
      }}
    />
  )
  return showPlaceholder ? (
    <span className="mih-xhs-image-placeholder" role="img" aria-label={failed ? `${alt}暂不可用` : `${alt}加载中`}>
      <ImageSquare size={30} />
      <small>{failed ? '暂不可用' : '加载中'}</small>
    </span>
  ) : null
}

function NoteScroll({ result, apiKey }) {
  const item = result?.payload?.data?.item
  const requestId = result?.evidence?.requestId || result?.payload?.requestId
  if (!item) {
    return (
      <div className="mih-xhs-empty">
        <Scroll size={56} weight="duotone" aria-hidden="true" />
        <strong>画卷尚未展开</strong>
        <p>输入一条官方小红书笔记链接，Hub 会优先读取缓存；需要时才调用外部数据能力。</p>
      </div>
    )
  }
  const media = (Array.isArray(item.media) ? item.media : [])
    .filter((entry) => entry?.type === 'image' && entry.url)
    .slice(0, 20)
  return (
    <article className="mih-xhs-scroll">
      <header>
        <span className="mih-xhs-seal">小红书</span>
        <div>
          <small>{item.externalId}</small>
          <h2>{item.title || '无标题笔记'}</h2>
        </div>
        {item.url ? <a href={item.url} target="_blank" rel="noreferrer" aria-label="打开原笔记"><ArrowSquareOut size={18} /></a> : null}
      </header>
      {media.length ? (
        <div className="mih-xhs-gallery" aria-label={`笔记图片，共 ${media.length} 张`}>
          {media.map((_, mediaIndex) => (
            <figure key={mediaIndex}>
              <RelayImage
                className="mih-xhs-note-image"
                apiKey={apiKey}
                requestId={requestId}
                mediaIndex={mediaIndex}
                alt={`笔记图片 ${mediaIndex + 1}`}
                showPlaceholder
              />
              <figcaption>{mediaIndex + 1} / {media.length}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      <p className="mih-xhs-body">{item.text || '该笔记没有可展示的正文。'}</p>
      {item.tags?.length ? (
        <div className="mih-xhs-tags" aria-label="笔记标签">
          {item.tags.map((tag) => <span key={tag}><Hash size={13} />{tag}</span>)}
        </div>
      ) : null}
      <dl className="mih-xhs-facts">
        <div><dt><User size={15} />作者</dt><dd>{item.author?.name || item.author?.id || '未知'}</dd></div>
        <div><dt><ClockCounterClockwise size={15} />发布时间</dt><dd>{formatDate(item.publishedAt)}</dd></div>
        {metricEntries(item.metrics).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{Number(value).toLocaleString('zh-CN')}</dd></div>)}
      </dl>
      <footer>
        <span>{result.evidence?.sourceMode || item.platform}</span>
        <span>采集于 {formatDate(result.evidence?.capturedAt || item.collectedAt)}</span>
      </footer>
    </article>
  )
}

export function XiaohongshuNotePage({ notify }) {
  const [apiKey, setApiKey] = useState('')
  const [url, setUrl] = useState('')
  const [deliveryMode, setDeliveryMode] = useState('cache_first')
  const [result, setResult] = useState(null)
  const [history, setHistory] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const requestLabel = useMemo(() => DELIVERY_OPTIONS.find((entry) => entry.value === deliveryMode)?.label, [deliveryMode])

  const submit = async (event) => {
    event.preventDefault()
    if (!apiKey.trim() || !url.trim() || busy) return
    setBusy(true)
    setError(null)
    let liveIdentity = null
    try {
      const requestedBody = { platform: 'xiaohongshu', url: url.trim(), deliveryMode }
      const pending = readPendingRequest()
      let retryOfRequestId = null
      if (pending) {
        try {
          const statusResponse = await publicDataApi.requestByIdempotencyKey(apiKey.trim(), pending.idempotencyKey)
          const status = statusResponse.payload?.data
          if (status?.status === 'committed') {
            const recovered = await publicDataApi.xiaohongshuNote(
              apiKey.trim(), pending.body, { idempotencyKey: pending.idempotencyKey },
            )
            clearPendingRequest()
            setResult(recovered)
            const recoveredItem = recovered.payload?.data?.item
            if (recoveredItem) {
              setHistory((current) => [{ item: recoveredItem, evidence: recovered.evidence }, ...current.filter((entry) => entry.item.id !== recoveredItem.id)].slice(0, 20))
            }
            notify?.('已安全恢复上一次请求结果，本次没有重复调用上游', 'success')
            return
          }
          if (status?.status === 'reserved') {
            throw Object.assign(new Error('上一次实时请求仍在处理中；为避免重复计费，本次未再次调用。'), { code: 'request_in_progress' })
          }
          if (status?.status === 'unknown') {
            if (!sameRequest(pending.body, requestedBody)) {
              throw Object.assign(new Error('上一次请求结果仍未知；请先用原链接完成一次受控重试。'), { code: 'request_outcome_unknown' })
            }
            retryOfRequestId = status.id
          } else {
            clearPendingRequest()
          }
        } catch (recoveryError) {
          if (recoveryError?.status === 404 && recoveryError?.code === 'request_not_found') {
            clearPendingRequest()
          } else {
            throw recoveryError
          }
        }
      }
      const idempotencyKey = deliveryMode === 'refresh' ? `xhs-${crypto.randomUUID()}` : null
      liveIdentity = idempotencyKey ? { idempotencyKey, body: requestedBody } : null
      if (liveIdentity) rememberPendingRequest(liveIdentity)
      const response = await publicDataApi.xiaohongshuNote(
        apiKey.trim(),
        requestedBody,
        idempotencyKey ? { idempotencyKey, retryOfRequestId } : {},
      )
      if (liveIdentity) clearPendingRequest()
      setResult(response)
      const item = response.payload?.data?.item
      if (item) {
        setHistory((current) => [{ item, evidence: response.evidence }, ...current.filter((entry) => entry.item.id !== item.id)].slice(0, 20))
      }
      notify?.(`笔记已通过${requestLabel}返回`, 'success')
    } catch (caught) {
      // A customer API key is intentionally isolated from the Launcher/Admin
      // session. Its 401 must never sign the operator out of the console.
      if (liveIdentity && caught?.status != null && caught.status > 0
        && !AMBIGUOUS_CODES.has(caught?.code)) clearPendingRequest()
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="DATA PRODUCT / XIAOHONGSHU NOTE"
        title="小红书笔记画卷"
        description="输入官方笔记链接，查看正文、作者、互动量与标签；API Key 仅保存在当前页面内存。"
      >
        <a className="qp-button qp-button--outline" href={publicDocsHref()} target="_blank" rel="noreferrer">查看开放 API</a>
      </PageHeading>
      <div className="mih-xhs-workbench">
        <form className="qp-panel mih-xhs-controls" onSubmit={submit}>
          <div className="mih-xhs-panel-title"><Sparkle size={19} /><div><strong>展开一篇笔记</strong><small>平台与能力必须同时授权</small></div></div>
          <Field label="开放能力 API Key" hint="需要 xiaohongshu 与 social.posts.resolve；不会写入浏览器存储。">
            <input className="qp-input" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="mih_live_…" required />
          </Field>
          <Field label="笔记链接">
            <div className="mih-xhs-input"><LinkSimple size={18} /><input className="qp-input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.xiaohongshu.com/explore/…" maxLength={2048} required /></div>
          </Field>
          <Field label="交付策略">
            <select className="qp-input" value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value)}>
              {DELIVERY_OPTIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
          </Field>
          <button className="qp-button qp-button--primary mih-xhs-submit" type="submit" disabled={busy || !apiKey.trim() || !url.trim()}>
            {busy ? <SpinnerGap className="mih-spin" size={18} /> : <Scroll size={18} />}
            {busy ? '正在展开画卷' : '获取笔记内容'}
          </button>
          {error ? <ErrorState error={error} /> : null}
        </form>

        <section className="mih-xhs-canvas" aria-live="polite"><NoteScroll result={result} apiKey={apiKey.trim()} /></section>

        <aside className="qp-panel mih-xhs-history">
          <div className="mih-xhs-panel-title"><ClockCounterClockwise size={19} /><div><strong>本次会话历史</strong><small>{history.length} 篇 · 不落浏览器存储</small></div></div>
          {history.length ? history.map((entry) => (
            <button key={entry.item.id} type="button" onClick={() => setResult({ payload: { data: { item: entry.item } }, evidence: entry.evidence })}>
              {entry.item.media?.[0]?.url
                ? <RelayImage apiKey={apiKey.trim()} requestId={entry.evidence?.requestId} alt="历史笔记封面" showPlaceholder />
                : <ImageSquare size={28} />}
              <span><strong>{entry.item.title || '无标题笔记'}</strong><small>{entry.item.author?.name || entry.item.externalId}</small></span>
            </button>
          )) : <p className="mih-xhs-history-empty">成功获取的笔记会出现在这里；Hub 的长期历史由异步 canonical ingest 保存。</p>}
        </aside>
      </div>
    </>
  )
}
