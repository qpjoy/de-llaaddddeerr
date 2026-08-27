import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  Broadcast,
  ChatCircleText,
  CheckCircle,
  Clock,
  Database,
  Fire,
  GlobeHemisphereWest,
  Info,
  MagnifyingGlass,
  MapPin,
  MapTrifold,
  NewspaperClipping,
  Pulse,
  TelegramLogo,
  Users,
  Warning,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageHeading,
  StatusBadge,
  useRemoteData,
} from './components.jsx'

const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN')

function formatNumber(value, fallback = '—') {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? NUMBER_FORMATTER.format(number) : fallback
}

function formatDateTime(value, fallback = '时间未知') {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function windowFor(range, now = Date.now()) {
  const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30
  const to = new Date(now)
  const from = new Date(to.getTime() - hours * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

function readableError(error) {
  if (!error) return null
  return {
    title: error.message || '接口请求失败',
    detail: [error.code, error.requestId ? `Request ${error.requestId}` : null].filter(Boolean).join(' · '),
  }
}

function PageModeNotice({ demoMode, children }) {
  return (
    <div className={`mih-product-mode${demoMode ? ' is-demo' : ''}`}>
      {demoMode ? <Info size={17} weight="fill" aria-hidden="true" /> : <CheckCircle size={17} weight="fill" aria-hidden="true" />}
      <span>{demoMode ? '当前为本地演示数据，不代表生产环境已经接入。' : children}</span>
    </div>
  )
}

function CursorControls({ page, hasMore, loading, onPrevious, onNext, noun = '页' }) {
  return (
    <div className="mih-product-cursor" aria-label={`${noun}分页`}>
      <button className="qp-button qp-button--ghost qp-button--sm" type="button"
        disabled={loading || page <= 1} onClick={onPrevious}>
        <ArrowLeft size={15} aria-hidden="true" />上一{noun}
      </button>
      <span>第 {page} {noun}</span>
      <button className="qp-button qp-button--ghost qp-button--sm" type="button"
        disabled={loading || !hasMore} onClick={onNext}>
        下一{noun}<ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
  )
}

function telegramText(item) {
  return item?.text ?? item?.body ?? item?.summary ?? ''
}

function telegramMessageKey(item) {
  const dataset = item?.sourceDataset || item?.sourceScope || 'telegram'
  return `${dataset}:${item?.canonicalId || item?.id || `${item?.externalId || 'message'}:${item?.eventTime || item?.publishedAt || ''}`}`
}

function telegramChatSelector(item) {
  return item?.chatKey || item?.canonicalId || item?.externalId || item?.username || null
}

function telegramSourceLabel(value) {
  return value === 'monitor' ? 'Monitor' : value === 'sqlite' ? 'SQLite' : '合并'
}

function telegramKindLabel(value) {
  return value === 'channel' ? '频道' : value === 'group' ? '群组' : value === 'unknown' ? '未知类型' : '全部类型'
}

function visibilityEvidenceText(value) {
  if (!value) return '无可见性证据'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter(Boolean).join(' · ') || '无可见性证据'
  if (typeof value === 'object') {
    return [
      value.hasUsername ? '有用户名' : '无用户名',
      `链接类型 ${value.urlKind || 'unknown'}`,
      value.publicHandleUrl ? `handle ${value.publicHandleUrl}` : null,
    ].filter(Boolean).join(' · ')
  }
  return String(value)
}

function telegramSelectedDatasets(sourceScope, selected) {
  const datasets = sourceScope?.datasets || []
  return selected === 'all' ? datasets : datasets.filter((dataset) => dataset.includes(`.${selected}.`))
}

function TelegramMessage({ item, anchor = false }) {
  const author = item?.author?.name || item?.author?.username || item?.author?.id || '未知发送者'
  const text = telegramText(item)
  return (
    <article className={`mih-tg-message${anchor ? ' is-anchor' : ''}`}>
      <header>
        <span className="mih-tg-avatar" aria-hidden="true">{String(author).slice(0, 1).toUpperCase()}</span>
        <strong>{author}</strong>
        <time>{formatDateTime(item?.eventTime ?? item?.publishedAt)}</time>
        <span className="qp-tag">{item?.sourceDataset || telegramSourceLabel(item?.sourceScope)}</span>
        {anchor ? <span className="qp-tag">检索锚点</span> : null}
      </header>
      <div className="mih-tg-bubble">
        {text ? <p>{text}</p> : <p className="is-muted">[{item?.contentType || '媒体 / 服务消息'}，无原始可显示文本]</p>}
        {item?.relations?.replyToMessageId ? <small>回复消息 {item.relations.replyToMessageId}</small> : null}
        {item?.metrics?.views != null ? <small>{formatNumber(item.metrics.views)} 次查看</small> : null}
      </div>
    </article>
  )
}

const TELEGRAM_KINDS = new Set(['all', 'channel', 'group', 'unknown'])

function TelegramDirectoryPage({ kind = 'all', query, setQuery, token, onUnauthorized }) {
  const [sourceScope, setSourceScope] = useState('all')
  const requestedKind = TELEGRAM_KINDS.has(query?.get('kind')) ? query.get('kind') : kind
  const [kindFilter, setKindFilter] = useState(requestedKind)
  const title = `Telegram ${telegramKindLabel(kindFilter)}`
  const KindIcon = kindFilter === 'channel' ? Broadcast : kindFilter === 'group' ? Users : TelegramLogo
  const [directoryDraft, setDirectoryDraft] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [directoryCursors, setDirectoryCursors] = useState([null])
  const [directoryPage, setDirectoryPage] = useState(0)
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [messageItems, setMessageItems] = useState([])
  const [messagePageInfo, setMessagePageInfo] = useState(null)
  const [messageLoadingMore, setMessageLoadingMore] = useState(false)
  const [messageLoadMoreError, setMessageLoadMoreError] = useState(null)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchTarget, setSearchTarget] = useState('all')
  const [searchData, setSearchData] = useState(null)
  const [searchError, setSearchError] = useState(null)
  const [searching, setSearching] = useState(false)
  const [contextAnchor, setContextAnchor] = useState(null)
  const [contextData, setContextData] = useState(null)
  const [contextError, setContextError] = useState(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [beforeCount, setBeforeCount] = useState(10)
  const [afterCount, setAfterCount] = useState(10)
  const transcriptRef = useRef(null)
  const loadEarlierRef = useRef(null)
  const messageLoadingMoreRef = useRef(false)
  const messageGenerationRef = useRef(0)
  const interactionGenerationRef = useRef(0)
  const activeChatIdRef = useRef(selectedChatId)
  const pendingScrollRestoreRef = useRef(null)
  const initialScrollPendingRef = useRef(false)
  activeChatIdRef.current = selectedChatId

  useEffect(() => {
    setKindFilter(requestedKind)
  }, [requestedKind])

  const loadDirectory = useCallback(() => adminApi.dataProductTelegramChats(token, {
    sourceScope,
    kind: kindFilter,
    query: directoryQuery || undefined,
    pageSize: 30,
    cursor: directoryCursors[directoryPage] || undefined,
  }), [directoryCursors, directoryPage, directoryQuery, kindFilter, sourceScope, token])
  const directory = useRemoteData(loadDirectory, onUnauthorized)
  const directoryData = (directory.data?.sourceScope?.selected && directory.data.sourceScope.selected !== sourceScope)
    || (directory.data?.kind && directory.data.kind !== kindFilter)
    ? null
    : directory.data
  const directoryItems = useMemo(() => (directoryData?.items || []).filter(
    (item) => kindFilter === 'all' || (item.kind || 'unknown') === kindFilter,
  ), [directoryData, kindFilter])

  useEffect(() => {
    setDirectoryCursors([null])
    setDirectoryPage(0)
    setSelectedChatId(null)
  }, [kindFilter, sourceScope])

  useEffect(() => {
    const items = directoryItems
    if (!items.length) {
      setSelectedChatId(null)
      return
    }
    if (!selectedChatId || !items.some((item) => telegramChatSelector(item) === selectedChatId)) {
      setSelectedChatId(telegramChatSelector(items[0]))
    }
  }, [directoryItems, selectedChatId])

  const selectedChat = useMemo(
    () => directoryItems.find((item) => telegramChatSelector(item) === selectedChatId) || null,
    [directoryItems, selectedChatId],
  )

  const loadMessages = useCallback(() => selectedChatId
      ? adminApi.dataProductTelegramMessages(token, selectedChatId, {
        sourceScope,
        pageSize: 30,
      })
    : Promise.resolve({ items: [], pageInfo: { returnedCount: 0, hasMore: false, nextCursor: null } }),
  [selectedChatId, sourceScope, token])
  const messages = useRemoteData(loadMessages, onUnauthorized)

  useEffect(() => {
    messageGenerationRef.current += 1
    interactionGenerationRef.current += 1
    messageLoadingMoreRef.current = false
    pendingScrollRestoreRef.current = null
    setMessageItems([])
    setMessagePageInfo(null)
    setMessageLoadingMore(false)
    setMessageLoadMoreError(null)
    setSearching(false)
    setSearchData(null)
    setSearchError(null)
    setContextLoading(false)
    setContextAnchor(null)
    setContextData(null)
    setContextError(null)
  }, [selectedChatId, sourceScope])

  useEffect(() => {
    if (!messages.data) return
    setMessageItems(messages.data.items || [])
    setMessagePageInfo(messages.data.pageInfo || { returnedCount: 0, hasMore: false, nextCursor: null })
    setMessageLoadMoreError(null)
    initialScrollPendingRef.current = true
  }, [messages.data])

  useLayoutEffect(() => {
    const viewport = transcriptRef.current
    if (!viewport) return
    if (initialScrollPendingRef.current) {
      initialScrollPendingRef.current = false
      viewport.scrollTop = viewport.scrollHeight
      return
    }
    const previous = pendingScrollRestoreRef.current
    if (!previous) return
    pendingScrollRestoreRef.current = null
    viewport.scrollTop = previous.scrollTop + (viewport.scrollHeight - previous.scrollHeight)
  }, [messageItems])

  const loadEarlierMessages = useCallback(async () => {
    const nextCursor = messagePageInfo?.nextCursor
    if (
      !selectedChatId
      || !nextCursor
      || messageLoadingMoreRef.current
      || searching
      || searchData
      || contextData
    ) return

    const generation = messageGenerationRef.current
    const viewport = transcriptRef.current
    pendingScrollRestoreRef.current = viewport
      ? { scrollHeight: viewport.scrollHeight, scrollTop: viewport.scrollTop }
      : null
    messageLoadingMoreRef.current = true
    setMessageLoadingMore(true)
    setMessageLoadMoreError(null)
    try {
      const page = await adminApi.dataProductTelegramMessages(token, selectedChatId, {
        sourceScope,
        pageSize: 30,
        cursor: nextCursor,
      })
      if (generation !== messageGenerationRef.current) return
      const seen = new Set(messageItems.map(telegramMessageKey))
      const additions = (page.items || []).filter((item) => {
        const key = telegramMessageKey(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (additions.length) setMessageItems((current) => [...current, ...additions])
      setMessagePageInfo(page.pageInfo || { returnedCount: 0, hasMore: false, nextCursor: null })
      if (!additions.length) pendingScrollRestoreRef.current = null
    } catch (error) {
      if (generation !== messageGenerationRef.current) return
      pendingScrollRestoreRef.current = null
      if (error?.status === 401) onUnauthorized?.(error)
      setMessageLoadMoreError(error)
    } finally {
      if (generation === messageGenerationRef.current) {
        messageLoadingMoreRef.current = false
        setMessageLoadingMore(false)
      }
    }
  }, [contextData, messageItems, messagePageInfo?.nextCursor, onUnauthorized, searchData, searching, selectedChatId, sourceScope, token])

  useEffect(() => {
    const target = loadEarlierRef.current
    const viewport = transcriptRef.current
    if (
      !target
      || !viewport
      || !messagePageInfo?.hasMore
      || messageLoadMoreError
      || searching
      || searchData
      || contextData
      || typeof IntersectionObserver === 'undefined'
    ) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadEarlierMessages()
    }, { root: viewport, rootMargin: '160px 0px 0px', threshold: 0.01 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [contextData, loadEarlierMessages, messageLoadMoreError, messagePageInfo?.hasMore, searchData, searching])

  const submitDirectory = (event) => {
    event.preventDefault()
    setDirectoryCursors([null])
    setDirectoryPage(0)
    setDirectoryQuery(directoryDraft.trim())
  }

  const submitSearch = async (event) => {
    event.preventDefault()
    const query = searchDraft.trim()
    const activeChatId = activeChatIdRef.current
    const chatId = searchTarget === 'chat' ? activeChatId : null
    if (!query || (searchTarget === 'chat' && !chatId)) return
    const generation = interactionGenerationRef.current + 1
    interactionGenerationRef.current = generation
    messageGenerationRef.current += 1
    messageLoadingMoreRef.current = false
    pendingScrollRestoreRef.current = null
    setMessageLoadingMore(false)
    setMessageLoadMoreError(null)
    setSearching(true)
    setSearchData(null)
    setSearchError(null)
    setContextLoading(false)
    setContextAnchor(null)
    setContextData(null)
    setContextError(null)
    try {
      const data = await adminApi.searchDataProductTelegram(token, {
        query,
        ...(chatId ? { chatId } : {}),
        sourceScope,
        ...(searchTarget === 'all' ? { kind: kindFilter } : {}),
        pageSize: 20,
      })
      if (generation !== interactionGenerationRef.current || activeChatIdRef.current !== activeChatId) return
      setSearchData(data)
    } catch (error) {
      if (generation !== interactionGenerationRef.current || activeChatIdRef.current !== activeChatId) return
      if (error?.status === 401) onUnauthorized?.(error)
      setSearchError(error)
      setSearchData(null)
    } finally {
      if (generation === interactionGenerationRef.current && activeChatIdRef.current === activeChatId) {
        setSearching(false)
      }
    }
  }

  const openContext = async (item) => {
    const canonicalId = item?.canonicalId || item?.id
    if (!canonicalId) return
    const activeChatId = activeChatIdRef.current
    const generation = interactionGenerationRef.current + 1
    interactionGenerationRef.current = generation
    messageGenerationRef.current += 1
    messageLoadingMoreRef.current = false
    pendingScrollRestoreRef.current = null
    setMessageLoadingMore(false)
    setContextAnchor(canonicalId)
    setContextLoading(true)
    setContextData(null)
    setContextError(null)
    try {
      const data = await adminApi.dataProductTelegramContext(token, canonicalId, {
        sourceScope,
        before: beforeCount,
        after: afterCount,
      })
      if (generation !== interactionGenerationRef.current || activeChatIdRef.current !== activeChatId) return
      setContextData(data)
    } catch (error) {
      if (generation !== interactionGenerationRef.current || activeChatIdRef.current !== activeChatId) return
      if (error?.status === 401) onUnauthorized?.(error)
      setContextError(error)
      setContextData(null)
    } finally {
      if (generation === interactionGenerationRef.current && activeChatIdRef.current === activeChatId) {
        setContextLoading(false)
      }
    }
  }

  const transcript = contextData?.items
    ? contextData.items
    : [...messageItems].reverse()
  const demoMode = Boolean(directoryData?.demoMode || messages.data?.demoMode)
  const warningList = [
    ...(searchData?.warnings || []),
    ...(contextData?.warnings || []),
  ]
  const globalSearchActive = searchTarget === 'all' && Boolean(searching || searchData || searchError || contextData)
  const conversationTitle = globalSearchActive
    ? (contextData ? `上下文 · 会话 ${contextData.stream?.id || '待识别'}` : '全部 Telegram 会话检索')
    : (selectedChat?.title || '选择一个会话')
  const conversationDescription = globalSearchActive
    ? `${telegramSourceLabel(sourceScope)} · ${telegramKindLabel(kindFilter)} · 结果可能来自左侧当前会话之外`
    : (selectedChat
      ? `${selectedChat.sourceDataset || selectedChat.sourceScope || 'unknown'} · ${telegramKindLabel(selectedChat.kind || 'unknown')} · ${visibilityEvidenceText(selectedChat.visibilityEvidence)}`
      : '从左侧目录开始')
  const selectedDatasets = telegramSelectedDatasets(directoryData?.sourceScope, sourceScope)

  return (
    <div className="mih-product-page mih-product-page--telegram">
      <PageHeading
        eyebrow="DATA PRODUCTS / TELEGRAM"
        title={title}
        description="内部完整观察 Hub 已归档的 Telegram 会话；可切换 Monitor、SQLite 或合并口径，先载入最近 30 条并向上滚动读取历史。"
        loading={directory.loading || messages.loading || messageLoadingMore}
        onRefresh={() => {
          directory.refresh()
          messageGenerationRef.current += 1
          interactionGenerationRef.current += 1
          messageLoadingMoreRef.current = false
          pendingScrollRestoreRef.current = null
          setMessageLoadingMore(false)
          setMessageLoadMoreError(null)
          setSearching(false)
          setSearchData(null)
          setSearchError(null)
          setContextLoading(false)
          setContextAnchor(null)
          setContextData(null)
          setContextError(null)
          messages.refresh()
        }}
      >
        <StatusBadge status={directory.error ? 'down' : demoMode ? 'degraded' : 'ready'}
          label={directory.error ? '目录接口异常' : demoMode ? '本地演示' : '只读展示'} />
      </PageHeading>

      <PageModeNotice demoMode={demoMode}>内部展示不按公开性隐藏数据；类型与可见性证据只作为诊断字段展示，合并口径保留不同数据集中的原始记录。</PageModeNotice>

      <section className="mih-tg-scopebar qp-panel" aria-label="Telegram 数据观察口径">
        <div><span>来源口径</span><div className="mih-command-segmented">
          {[['all', '合并'], ['monitor', 'Monitor'], ['sqlite', 'SQLite']].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={sourceScope === value} onClick={() => setSourceScope(value)}>{label}</button>
          ))}
        </div></div>
        <div><span>会话类型</span><div className="mih-command-segmented">
          {[['all', '全部'], ['channel', '频道'], ['group', '群组'], ['unknown', '未知']].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={kindFilter === value} onClick={() => {
              setKindFilter(value)
              setQuery?.({ kind: value === 'all' ? null : value })
            }}>{label}</button>
          ))}
        </div></div>
        <div><span>检索范围</span><div className="mih-command-segmented">
          {[['all', '全部会话'], ['chat', '当前会话']].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={searchTarget === value}
              disabled={value === 'chat' && !selectedChatId}
              onClick={() => {
                if (value === searchTarget) return
                interactionGenerationRef.current += 1
                setSearching(false)
                setSearchData(null)
                setSearchError(null)
                setContextLoading(false)
                setContextData(null)
                setContextAnchor(null)
                setContextError(null)
                setSearchTarget(value)
              }}>{label}</button>
          ))}
        </div></div>
        <small>全部会话检索会覆盖当前来源与类型；当前会话用于精确核对单个聊天。</small>
      </section>

      <section className="mih-product-kpis" aria-label="Telegram 当前窗口概览">
        <article><KindIcon size={20} weight="duotone" /><span>当前目录</span><strong>{formatNumber(directoryData?.pageInfo?.returnedCount, '0')}</strong><small>{telegramKindLabel(kindFilter)} · 不做可见性过滤</small></article>
        <article><Users size={20} weight="duotone" /><span>会话成员</span><strong>{formatNumber(selectedChat?.memberCount)}</strong><small>{selectedChat?.title || '尚未选择会话'}</small></article>
        <article><ChatCircleText size={20} weight="duotone" /><span>消息窗口</span><strong>{formatNumber(transcript.length, '0')}</strong><small>业务时间优先，缺失时回退采集 / 入库时间</small></article>
        <article><Database size={20} weight="duotone" /><span>数据范围</span><strong>{telegramSourceLabel(sourceScope)}</strong><small>{selectedDatasets.join(' + ') || '等待接口返回当前数据集'}</small></article>
      </section>

      <section className="mih-tg-workbench">
        <aside className="qp-panel mih-tg-directory" aria-label={`${title}目录`}>
          <header>
            <div><TelegramLogo size={20} weight="fill" /><strong>内部会话目录</strong></div>
            <span>{directoryPage + 1}</span>
          </header>
          <form className="mih-product-search" onSubmit={submitDirectory}>
            <MagnifyingGlass size={17} aria-hidden="true" />
            <input value={directoryDraft} onChange={(event) => setDirectoryDraft(event.target.value)}
              placeholder="搜索会话名称、用户名或标识" aria-label={`搜索${title}`} />
            <button type="submit">查找</button>
          </form>
          <div className="mih-tg-directory__list qp-scrollbar">
            {directory.loading && !directory.data ? <LoadingState label="正在加载内部会话目录" /> : null}
            {directory.error ? <ErrorState error={directory.error} onRetry={directory.refresh} /> : null}
            {!directory.loading && !directory.error && !directoryItems.length ? (
              <EmptyState icon={TelegramLogo} title="当前口径没有已归档会话"
                description="可切换合并来源或全部类型；空结果表示对应数据集尚未收录，不代表被公开性规则隐藏。" />
            ) : null}
            {directoryItems.map((chat) => (
              <button className={`mih-tg-chat${selectedChatId === telegramChatSelector(chat) ? ' is-active' : ''}`}
                type="button" key={chat.chatKey || `${chat.sourceDataset || 'telegram'}:${chat.canonicalId || chat.externalId}`}
                onClick={() => setSelectedChatId(telegramChatSelector(chat))}>
                <span className="mih-tg-avatar"><KindIcon size={16} weight="fill" aria-hidden="true" /></span>
                <span><strong>{chat.title || chat.username || chat.externalId}</strong><small>{chat.sourceDataset || chat.sourceScope || 'unknown'} · {telegramKindLabel(chat.kind || 'unknown')} · {chat.username ? `@${chat.username.replace(/^@/, '')}` : '无用户名'}</small></span>
                <em>{chat.memberCount == null ? '—' : formatNumber(chat.memberCount)}</em>
              </button>
            ))}
          </div>
          <CursorControls page={directoryPage + 1} noun="页" loading={directory.loading}
            hasMore={Boolean(directoryData?.pageInfo?.hasMore)}
            onPrevious={() => setDirectoryPage((value) => Math.max(0, value - 1))}
            onNext={() => {
              const next = directoryData?.pageInfo?.nextCursor
              if (!next) return
              setDirectoryCursors((current) => [...current.slice(0, directoryPage + 1), next])
              setDirectoryPage((value) => value + 1)
            }} />
        </aside>

        <main className="qp-panel mih-tg-conversation">
          <header className="mih-tg-conversation__header">
            <div className="mih-tg-avatar mih-tg-avatar--large"><KindIcon size={21} weight="fill" aria-hidden="true" /></div>
            <div>
              <strong>{conversationTitle}</strong>
              <span>{conversationDescription}</span>
            </div>
            {!globalSearchActive && selectedChat?.url ? <a className="qp-button qp-button--ghost qp-icon-button" href={selectedChat.url}
              target="_blank" rel="noreferrer" aria-label="打开 Telegram 业务入口"><ArrowSquareOut size={17} /></a> : null}
          </header>
          <form className="mih-tg-search" onSubmit={submitSearch}>
            <MagnifyingGlass size={17} aria-hidden="true" />
            <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={searchTarget === 'chat' ? '在当前会话的已归档消息中搜索' : '在当前来源与类型的全部消息中搜索'}
              disabled={searchTarget === 'chat' && !selectedChatId}
              aria-label={searchTarget === 'chat' ? '搜索当前会话消息' : '搜索全部 Telegram 消息'} />
            <button className="qp-button qp-button--outline qp-button--sm" type="submit"
              disabled={(searchTarget === 'chat' && !selectedChatId) || !searchDraft.trim() || searching}>{searching ? '检索中' : '检索'}</button>
            {searchData || searchError ? <button className="qp-button qp-button--ghost qp-button--sm" type="button"
              onClick={() => {
                interactionGenerationRef.current += 1
                setSearching(false)
                setSearchData(null)
                setSearchError(null)
                setContextLoading(false)
                setContextData(null)
                setContextAnchor(null)
                setContextError(null)
              }}>返回消息</button> : null}
          </form>
          {searchError ? <div className="mih-tg-inline-state"><ErrorState error={searchError} /></div> : null}
          {searchData ? (
            <section className="mih-tg-search-results">
              <header><strong>{searchTarget === 'chat' ? '当前会话检索结果' : `${telegramKindLabel(kindFilter)}全局检索结果`}</strong><span>{searchData.pageInfo?.returnedCount || 0} 条 · {searchData.searchMode || 'unknown'}</span></header>
              {(searchData.items || []).length ? searchData.items.map((item) => (
                <button type="button" key={item.canonicalId || item.id} onClick={() => openContext(item)}>
                  <span><strong>{item.author?.name || '未知发送者'}</strong><time>{formatDateTime(item.eventTime)}</time></span>
                  <p>{telegramText(item) || `[${item.contentType || '非文本消息'}]`}</p>
                  <small>{item.sourceDataset || item.sourceScope || 'telegram'} · 会话 {item.relations?.chatId || '未知'} · 查看前 {beforeCount} / 后 {afterCount} 条已存上下文</small>
                </button>
              )) : <EmptyState icon={MagnifyingGlass} title="没有命中已归档消息"
                description={searchTarget === 'chat' ? '当前会话没有命中；可切换为全部会话继续检索。' : '可调整关键词、来源或会话类型；空结果不是接口故障。'} />}
            </section>
          ) : null}
          <div ref={transcriptRef} className="mih-tg-transcript qp-scrollbar" aria-label="会话消息窗口"
            aria-busy={messages.loading || messageLoadingMore || contextLoading}>
            {!contextData && !searchData && selectedChatId && !messages.loading && messageItems.length ? (
              <div ref={loadEarlierRef} className={`mih-tg-history-loader${messageLoadMoreError ? ' is-error' : ''}`}
                role={messageLoadMoreError ? 'alert' : 'status'} aria-live="polite">
                {messageLoadMoreError ? (
                  <>
                    <Warning size={16} weight="fill" aria-hidden="true" />
                    <span>更早消息加载失败：{messageLoadMoreError.message || '接口请求失败'}</span>
                    <button className="qp-button qp-button--ghost qp-button--sm" type="button"
                      onClick={loadEarlierMessages}>重试</button>
                  </>
                ) : messageLoadingMore ? (
                  <><span className="mih-tg-history-loader__pulse" aria-hidden="true" />正在加载更早消息…</>
                ) : messagePageInfo?.hasMore ? (
                  <button className="qp-button qp-button--ghost qp-button--sm" type="button"
                    onClick={loadEarlierMessages}>加载更多早期消息</button>
                ) : (
                  <span>已到当前 Hub 存储边界</span>
                )}
              </div>
            ) : null}
            {messages.loading && !messageItems.length && !contextData ? <LoadingState label="正在加载消息窗口" /> : null}
            {messages.error && !contextData ? <ErrorState error={messages.error} onRetry={messages.refresh} /> : null}
            {contextLoading ? <LoadingState label="正在还原锚点上下文" /> : null}
            {contextError ? <ErrorState error={contextError} /> : null}
            {!messages.loading && !messages.error && selectedChatId && !transcript.length ? (
              <EmptyState icon={ChatCircleText} title="该会话暂无已归档消息"
                description="会话存在不代表消息已经同步；请在右侧检查数据范围与管线状态。" />
            ) : null}
            {transcript.map((item, index) => (
              <TelegramMessage item={item} key={telegramMessageKey(item) || index}
                anchor={Boolean(contextData && index === contextData.anchorIndex)} />
            ))}
          </div>
          {!contextData ? (
            <div className="mih-tg-context-footer mih-tg-history-footer" role="status" aria-live="polite">
              <span>已加载 {formatNumber(messageItems.length, '0')} 条存储消息</span>
              <span>{messagePageInfo?.hasMore ? '向上滚动可继续加载' : messageItems.length ? '已到存储边界' : '等待消息数据'}</span>
            </div>
          ) : (
            <div className="mih-tg-context-footer">
              <span>当前为检索锚点上下文</span>
              <button className="qp-button qp-button--ghost qp-button--sm" type="button"
                onClick={() => {
                  interactionGenerationRef.current += 1
                  setContextLoading(false)
                  setContextData(null)
                  setContextAnchor(null)
                  setContextError(null)
                }}>关闭上下文</button>
            </div>
          )}
        </main>

        <aside className="qp-panel mih-product-diagnostics" aria-label="Telegram 数据诊断">
          <header><Pulse size={18} weight="duotone" /><strong>数据诊断</strong></header>
          <section>
            <span>可见性证据</span>
            <strong>展示但不参与过滤</strong>
            <small>{visibilityEvidenceText(selectedChat?.visibilityEvidence)}</small>
          </section>
          <section>
            <span>上下文窗口</span>
            <div className="mih-context-counts">
              <label>前<input type="number" min="0" max="50" value={beforeCount}
                onChange={(event) => setBeforeCount(Math.max(0, Math.min(50, Number(event.target.value) || 0)))} /></label>
              <label>后<input type="number" min="0" max="50" value={afterCount}
                onChange={(event) => setAfterCount(Math.max(0, Math.min(50, Number(event.target.value) || 0)))} /></label>
            </div>
            <small>每侧最多 50 条；缺业务时间的消息仍展示，但不能构造时间锚点上下文</small>
          </section>
          <section>
            <span>存储完整性</span>
            <strong>{contextData?.upstreamCompleteness?.status || (messagePageInfo ? (messagePageInfo.hasMore ? 'more-available' : 'stored-boundary') : 'unknown')}</strong>
            <small>{contextData
              ? `前侧更多 ${contextData.storedWindow?.hasMoreStoredBefore ? '是' : '否'} · 后侧更多 ${contextData.storedWindow?.hasMoreStoredAfter ? '是' : '否'}`
              : `普通会话已加载 ${formatNumber(messageItems.length, '0')} 条${messagePageInfo?.hasMore ? '，仍有更早消息' : ''}`}</small>
          </section>
          <section>
            <span>检索后端</span>
            <strong>{searchData?.searchMode || '未执行'}</strong>
            <small>ES 不可用时允许退化到 PG</small>
          </section>
          {warningList.map((warning) => <div className="mih-product-warning" key={warning.code || warning.message}>
            <Warning size={16} weight="fill" /><span><strong>{warning.code || 'warning'}</strong><small>{warning.message}</small></span>
          </div>)}
          {[directory.error, messages.error, messageLoadMoreError, searchError, contextError].filter(Boolean).map((error, index) => {
            const readable = readableError(error)
            return <div className="mih-product-warning is-danger" key={`${readable.title}-${index}`}><Warning size={16} weight="fill" /><span><strong>{readable.title}</strong><small>{readable.detail}</small></span></div>
          })}
          <footer>
            <Database size={15} /><span>{selectedDatasets.join(' · ') || `telegram.${sourceScope}.*`}</span>
          </footer>
        </aside>
      </section>
    </div>
  )
}

export function TelegramPage(props) {
  return <TelegramDirectoryPage {...props} />
}

function ProvincePicker({ regions, coverage, selectedCode, search, setSearch, onSelect, onClose }) {
  const counts = new Map((coverage?.provinces || coverage?.items || []).map((item) => [item.province?.code || item.code, item]))
  const visible = (regions || []).filter((region) => (
    !search || `${region.name}${region.officialName}${region.code}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  ))
  return (
    <Modal title="切换地区" description="地区目录固定展示 34 个省级行政区；数量与缺口来自当前时间窗的 coverage 接口。" onClose={onClose} size="xlarge">
      <div className="mih-province-picker__toolbar">
        <div className="mih-product-search"><MagnifyingGlass size={17} /><input autoFocus value={search}
          onChange={(event) => setSearch(event.target.value)} placeholder="搜索省份、简称或代码" aria-label="搜索地区" /></div>
        <span>当前：<strong>{regions.find((region) => region.code === selectedCode)?.name || selectedCode}</strong></span>
      </div>
      <div className="mih-province-grid">
        {visible.map((region) => {
          const datum = counts.get(region.code)
          const available = datum?.availableCount ?? datum?.available ?? datum?.count ?? datum?.formalCount ?? 0
          const problem = datum ? datum.meetsTarget === false : true
          return (
            <button className={`${selectedCode === region.code ? ' is-selected' : ''}${problem ? ' has-gap' : ''}`}
              type="button" key={region.code} onClick={() => onSelect(region.code)}>
              <span><strong>{region.name}</strong><small>{region.code}</small></span>
              <em>{formatNumber(available, '0')}</em>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

function OpinionListItem({ item, index, active, onSelect }) {
  return (
    <button type="button" className={`mih-opinion-item${active ? ' is-active' : ''}`} onClick={onSelect}>
      <span className="mih-opinion-rank">{String(index + 1).padStart(2, '0')}</span>
      <span className="mih-opinion-item__copy">
        <strong>{item.title || '无标题舆情记录'}</strong>
        <small>{item.origin?.name || item.origin?.platform || '来源待确认'} · {item.province?.name || '地区未分类'}</small>
      </span>
      <span className="mih-opinion-heat"><strong>{formatNumber(item.heatScore)}</strong><small>热度</small></span>
    </button>
  )
}

const OPINION_REASON_LABELS = {
  all: '全部 active current 数据',
  coverage_visible: '正式覆盖口径',
  hot_visible: '热点口径',
  missing_publication_state: '缺 publication state',
  not_formal_stage: '非 formal 阶段',
  not_formal_status: '非 formal 状态',
  missing_event_time: '缺事件时间',
  outside_window: '时间窗外',
  missing_province: '未归属省份 / 待总结',
  missing_heat: '缺热度分',
}

function OpinionRecordExplorer({ token, timeWindow, initialView, onClose, onUnauthorized }) {
  const [filters, setFilters] = useState(initialView.filters || { reason: initialView.reason || 'all' })
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [cursors, setCursors] = useState([null])
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const recordsRequestKey = JSON.stringify({
    ...timeWindow,
    cursor: cursors[page] || null,
    query: searchQuery || null,
    reason: filters.reason || 'all',
    stage: filters.stage || null,
    status: filters.status || null,
    province: filters.province || null,
    scope: filters.scope || null,
    time: filters.time || null,
    heat: filters.heat || null,
  })
  const loadRecords = useCallback(async () => ({
    ...await adminApi.dataProductPublicOpinionRecords(token, {
      ...timeWindow,
      pageSize: 40,
      cursor: cursors[page] || undefined,
      query: searchQuery || undefined,
      reason: filters.reason || 'all',
      stage: filters.stage || undefined,
      status: filters.status || undefined,
      province: filters.province || undefined,
      scope: filters.scope || undefined,
      time: filters.time || undefined,
      heat: filters.heat || undefined,
    }),
    __requestKey: recordsRequestKey,
  }), [cursors, filters, page, recordsRequestKey, searchQuery, timeWindow, token])
  const records = useRemoteData(loadRecords, onUnauthorized)
  const recordsData = records.data?.__requestKey === recordsRequestKey ? records.data : null

  useEffect(() => {
    setCursors([null])
    setPage(0)
    setSelectedId(null)
  }, [filters, searchQuery, timeWindow.from, timeWindow.to])

  useEffect(() => {
    const items = recordsData?.items || []
    if (!items.length) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) setSelectedId(items[0].id)
  }, [recordsData, selectedId])

  const detail = useRemoteData(useCallback(
    () => selectedId ? adminApi.dataProductPublicOpinionRecord(token, selectedId, timeWindow) : Promise.resolve(null),
    [selectedId, timeWindow, token],
  ), onUnauthorized)
  const detailMatchesWindow = detail.data?.window?.from === timeWindow.from
    && detail.data?.window?.to === timeWindow.to
  const selectedListItem = (recordsData?.items || []).find((item) => item.id === selectedId)
  const selected = selectedListItem
    ? (detail.data?.id === selectedId && detailMatchesWindow ? detail.data : selectedListItem)
    : null
  const setReason = (reason) => setFilters({ reason })
  const activeReason = filters.reason || 'all'

  return (
    <Modal title={`未展示数据观察 · ${initialView.label || OPINION_REASON_LABELS[activeReason]}`}
      description="直接查询当前 Hub 数据库；历史快照不参与本窗口计数。筛选结果保留诊断原因，供后续 Agent 归属与归纳。"
      onClose={onClose} size="xlarge"
      footer={<CursorControls page={page + 1} noun="页" loading={records.loading}
        hasMore={Boolean(recordsData?.pageInfo?.hasMore)}
        onPrevious={() => setPage((value) => Math.max(0, value - 1))}
        onNext={() => {
          const next = recordsData?.pageInfo?.nextCursor
          if (!next) return
          setCursors((current) => [...current.slice(0, page + 1), next])
          setPage((value) => value + 1)
        }} />}>
      <div className="mih-opinion-record-explorer">
        <div className="mih-opinion-record-filters" aria-label="未展示数据快速筛选">
          {['all', 'missing_province', 'missing_publication_state', 'not_formal_stage', 'not_formal_status', 'missing_event_time', 'outside_window', 'missing_heat'].map((reason) => (
            <button type="button" key={reason} aria-pressed={activeReason === reason} onClick={() => setReason(reason)}>
              {OPINION_REASON_LABELS[reason]}
            </button>
          ))}
        </div>
        <form className="mih-product-search mih-opinion-record-search" onSubmit={(event) => {
          event.preventDefault()
          setSearchQuery(searchDraft.trim())
        }}>
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input autoFocus value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="搜索标题、摘要、作者、来源或地区" aria-label="搜索未展示舆情数据" />
          <button type="submit">搜索</button>
          {searchQuery ? <button type="button" onClick={() => { setSearchDraft(''); setSearchQuery('') }}>清除</button> : null}
        </form>
        <div className="mih-opinion-record-browser">
          <aside className="mih-opinion-record-list qp-scrollbar">
            <header><strong>{OPINION_REASON_LABELS[activeReason] || activeReason}</strong><span>{formatNumber(recordsData?.pageInfo?.returnedCount, '0')} 条当前页</span></header>
            {records.loading && !recordsData ? <LoadingState label="正在查询当前数据" /> : null}
            {records.error ? <ErrorState error={records.error} onRetry={records.refresh} /> : null}
            {!records.loading && !records.error && !(recordsData?.items || []).length ? (
              <EmptyState icon={CheckCircle} title="该诊断条件当前没有记录" description="这是当前数据库返回的零结果，可切换筛选或时间范围。" />
            ) : null}
            {(recordsData?.items || []).map((item) => (
              <button type="button" key={item.id} className={selectedId === item.id ? 'is-active' : ''}
                onClick={() => setSelectedId(item.id)}>
                <strong>{item.title || '无标题记录'}</strong>
                <small>{item.source?.platform || item.source?.type || '来源未知'} · {item.provinceCode || item.geography?.locationLabel || '未归属'} · {formatDateTime(item.eventTime)}</small>
                <span>{(item.diagnostics?.reasons || []).map((reason) => OPINION_REASON_LABELS[reason] || reason).join(' · ') || '符合当前展示条件'}</span>
              </button>
            ))}
          </aside>
          <section className="mih-opinion-record-detail qp-scrollbar">
            {detail.loading && selectedId ? <LoadingState label="正在加载完整诊断" /> : null}
            {detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : null}
            {!selectedId && !detail.loading ? <EmptyState icon={NewspaperClipping} title="选择记录查看诊断" description="左侧可查看所有状态、未归属以及缺字段的数据。" /> : null}
            {selected ? <>
              <header><div><span className="qp-tag">{selected.sourceStage || 'stage unknown'}</span><span className="qp-tag">{selected.publicationStatus || 'status unknown'}</span></div><time>{formatDateTime(selected.eventTime)}</time></header>
              <h2>{selected.title || '无标题记录'}</h2>
              <p>{selected.summary || '当前记录没有摘要；仍保留用于内部诊断与后续 Agent 处理。'}</p>
              <dl>
                <div><dt>来源</dt><dd>{selected.source?.platform || selected.source?.type || '未知'}</dd></div>
                <div><dt>作者</dt><dd>{selected.authorName || '未知'}</dd></div>
                <div><dt>内容类型</dt><dd>{selected.contentType || '未知'}</dd></div>
                <div><dt>地域</dt><dd>{selected.provinceCode || selected.geography?.locationLabel || '未归属'}</dd></div>
                <div><dt>地域范围</dt><dd>{selected.geography?.scope || 'unknown'}</dd></div>
                <div><dt>热度</dt><dd>{formatNumber(selected.heatScore)}</dd></div>
                <div><dt>质量分</dt><dd>{formatNumber(selected.qualityScore)}</dd></div>
                <div><dt>采集时间</dt><dd>{formatDateTime(selected.collectedAt)}</dd></div>
              </dl>
              <div className="mih-opinion-record-reasons">
                <strong>未展示 / 待处理原因</strong>
                {(selected.diagnostics?.reasons || []).length ? selected.diagnostics.reasons.map((reason) => (
                  <span className="qp-tag" key={reason}>{OPINION_REASON_LABELS[reason] || reason}</span>
                )) : <span className="qp-tag qp-tag--success">当前无排除原因</span>}
                {(selected.qualityFlags || []).map((flag) => <span className="qp-tag" key={`quality:${flag}`}>质量：{flag}</span>)}
                {(selected.rejectionCodes || []).map((code) => <span className="qp-tag" key={`rejection:${code}`}>拒绝：{code}</span>)}
              </div>
              {selected.url ? <a className="qp-button qp-button--outline" href={selected.url} target="_blank" rel="noreferrer">打开业务来源<ArrowSquareOut size={16} /></a> : null}
            </> : null}
          </section>
        </div>
      </div>
    </Modal>
  )
}

export function PublicOpinionPage({ token, query, setQuery, onUnauthorized }) {
  const range = ['24h', '7d', '30d'].includes(query.get('range')) ? query.get('range') : '30d'
  const provinceCode = query.get('province') || 'CN-JS'
  const sort = query.get('sort') === 'latest' ? 'latest' : 'hot'
  const [provincePickerOpen, setProvincePickerOpen] = useState(false)
  const [provinceSearch, setProvinceSearch] = useState('')
  const [feedCursors, setFeedCursors] = useState([null])
  const [feedPage, setFeedPage] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [recordExplorer, setRecordExplorer] = useState(null)
  const [windowRevision, setWindowRevision] = useState(0)
  const timeWindow = useMemo(() => windowFor(range), [range, windowRevision])

  const regions = useRemoteData(useCallback(
    () => adminApi.dataProductPublicOpinionRegions(token), [token],
  ), onUnauthorized)
  const coverageRequestKey = `${timeWindow.from}:${timeWindow.to}`
  const coverage = useRemoteData(useCallback(async () => ({
    ...await adminApi.dataProductPublicOpinionCoverage(token, { ...timeWindow, targetPerProvince: 10 }),
    __requestKey: coverageRequestKey,
  }), [coverageRequestKey, timeWindow, token]), onUnauthorized)
  const feedRequestKey = JSON.stringify({
    ...timeWindow, provinceCode, sort, cursor: feedCursors[feedPage] || null,
  })
  const feed = useRemoteData(useCallback(async () => ({
    ...await adminApi.dataProductPublicOpinionProvince(token, provinceCode, {
      sort,
      ...timeWindow,
      pageSize: 30,
      cursor: feedCursors[feedPage] || undefined,
    }),
    __requestKey: feedRequestKey,
  }), [feedCursors, feedPage, feedRequestKey, provinceCode, sort, timeWindow, token]), onUnauthorized)
  const coverageData = coverage.data?.__requestKey === coverageRequestKey ? coverage.data : null
  const feedData = feed.data?.__requestKey === feedRequestKey ? feed.data : null
  const pipeline = useRemoteData(useCallback(
    () => adminApi.provinceOpinionPipeline(token), [token],
  ), onUnauthorized)
  const progress = useRemoteData(useCallback(
    () => adminApi.provinceOpinionPipelineProgress(token), [token],
  ), onUnauthorized)
  const quality = useRemoteData(useCallback(
    () => adminApi.provinceOpinionQualitySummary(token), [token],
  ), onUnauthorized)
  const funnelRequestKey = `${timeWindow.from}:${timeWindow.to}`
  const funnel = useRemoteData(useCallback(async () => ({
    ...await adminApi.dataProductPublicOpinionFunnel(token, timeWindow),
    __requestKey: funnelRequestKey,
  }), [funnelRequestKey, timeWindow, token]), onUnauthorized)

  useEffect(() => {
    setFeedCursors([null])
    setFeedPage(0)
    setSelectedId(null)
  }, [provinceCode, range, sort, timeWindow.from, timeWindow.to])

  useEffect(() => {
    const items = feedData?.items || []
    if (!items.length) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) setSelectedId(items[0].id)
  }, [feedData, selectedId])

  const detail = useRemoteData(useCallback(
    () => selectedId ? adminApi.dataProductPublicOpinionItem(token, selectedId) : Promise.resolve(null),
    [selectedId, token],
  ), onUnauthorized)
  const regionList = regions.data?.regions || []
  const selectedRegion = regionList.find((region) => region.code === provinceCode)
    || feedData?.province
    || { code: provinceCode, name: provinceCode }
  const coverageItems = coverageData?.provinces || coverageData?.items || []
  const selectedCoverage = coverageItems.find((item) => (item.province?.code || item.code) === provinceCode)
  const demoMode = Boolean(regions.data?.demoMode || coverageData?.demoMode || feedData?.demoMode)
  const pipelineIssues = [
    ...(pipeline.data?.configurationIssues || []),
    ...(progress.data?.issues || []),
  ]
  const qualityFormal = quality.data?.publication?.stages?.formal
    ?? quality.data?.formal ?? quality.data?.formalCount
  const qualityCandidate = quality.data?.publication?.stages?.candidate
    ?? quality.data?.candidate ?? quality.data?.candidateCount
  const qualityPending = quality.data?.publication?.statuses?.pending
    ?? quality.data?.pending ?? quality.data?.pendingCount
  const available = selectedCoverage?.availableCount ?? selectedCoverage?.available ?? selectedCoverage?.formalCount ?? feedData?.pageInfo?.returnedCount ?? 0
  const shortfall = selectedCoverage?.shortfall ?? Math.max(0, 10 - Number(available || 0))
  const detailItem = (feedData?.items || []).some((item) => item.id === selectedId)
    && detail.data?.id === selectedId ? detail.data : null
  const funnelData = funnel.data?.__requestKey === funnelRequestKey ? funnel.data : null
  const funnelStages = [
    {
      key: 'current', label: 'Current Active', count: funnelData?.canonical?.active,
      excluded: funnelData?.canonical?.deleted, action: { label: '全部 active current 数据', filters: { reason: 'all' } },
    },
    {
      key: 'coverage', label: '正式覆盖口径', count: funnelData?.visibility?.coverageVisible,
      excluded: Math.max(0, Number(funnelData?.canonical?.active || 0) - Number(funnelData?.visibility?.coverageVisible || 0)),
      action: { label: OPINION_REASON_LABELS.coverage_visible, filters: { reason: 'coverage_visible' } },
    },
    {
      key: 'hot', label: '热点可用口径', count: funnelData?.visibility?.hotVisible,
      excluded: Math.max(0, Number(funnelData?.visibility?.coverageVisible || 0) - Number(funnelData?.visibility?.hotVisible || 0)),
      action: { label: OPINION_REASON_LABELS.hot_visible, filters: { reason: 'hot_visible' } },
    },
  ]
  const funnelDimensions = [
    {
      key: 'publication', label: '有 Publication', count: funnelData?.publication?.withState,
      issues: [['missing_publication_state', funnelData?.reasons?.missingPublicationState]],
    },
    {
      key: 'time', label: '在时间窗内', count: funnelData?.time?.withinWindow,
      issues: [
        ['missing_event_time', funnelData?.reasons?.missingEventTime],
        ['outside_window', funnelData?.reasons?.outsideWindow],
      ],
    },
    {
      key: 'province', label: '已归属省份', count: funnelData?.geography?.withProvince,
      issues: [['missing_province', funnelData?.reasons?.missingProvince]],
    },
    {
      key: 'stage', label: 'Formal 阶段', count: funnelData?.publication?.stages?.formal,
      issues: [['not_formal_stage', funnelData?.reasons?.notFormalStage]],
    },
    {
      key: 'status', label: 'Formal 状态', count: funnelData?.publication?.statuses?.formal,
      issues: [['not_formal_status', funnelData?.reasons?.notFormalStatus]],
    },
    {
      key: 'heat', label: '已有热度分', count: funnelData?.heat?.withScore,
      issues: [['missing_heat', funnelData?.reasons?.missingHeat]],
    },
  ]
  const funnelReasons = [
    ['missingPublicationState', 'missing_publication_state'],
    ['notFormalStage', 'not_formal_stage'],
    ['notFormalStatus', 'not_formal_status'],
    ['missingEventTime', 'missing_event_time'],
    ['outsideWindow', 'outside_window'],
    ['missingProvince', 'missing_province'],
    ['missingHeat', 'missing_heat'],
  ]

  const refreshAll = () => {
    setFeedCursors([null])
    setFeedPage(0)
    setSelectedId(null)
    setWindowRevision((value) => value + 1)
    regions.refresh(); detail.refresh(); pipeline.refresh(); progress.refresh(); quality.refresh()
  }

  return (
    <div className="mih-product-page mih-product-page--opinion">
      <PageHeading eyebrow="DATA PRODUCTS / PUBLIC OPINION" title="全国舆情"
        description={`当前展示${selectedRegion.name}业务舆情，可切换省份、时间窗与排序，并把“无数据”和“接口异常”分开呈现。`}
        loading={feed.loading || coverage.loading} onRefresh={refreshAll}>
        <div className="mih-command-segmented" aria-label="舆情时间范围">
          {[['24h', '近24小时'], ['7d', '近7天'], ['30d', '近30天']].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={range === value} onClick={() => setQuery({ range: value })}>{label}</button>
          ))}
        </div>
        <button className="qp-button qp-button--outline" type="button" onClick={() => setProvincePickerOpen(true)}>
          <MapPin size={17} weight="fill" />{selectedRegion.name}<span className="mih-product-action-hint">切换地区</span>
        </button>
      </PageHeading>

      <PageModeNotice demoMode={demoMode}>这是内部完整观察：当前列表口径之外的数据不会隐藏，可从实时漏斗查看未归属、候选、缺时间和缺热度记录；历史快照只作参考，不参与当前计数。</PageModeNotice>

      <section className="mih-opinion-funnel qp-panel" aria-label="实时舆情数据漏斗">
        <header>
          <div><Pulse size={18} weight="duotone" /><span><strong>实时数据漏斗 / 质量剖面</strong><small>{funnelData?.window ? `${formatDateTime(funnelData.window.from)} — ${formatDateTime(funnelData.window.to)} · 主链为真实包含关系，下方质量维度并行统计` : '正在读取当前数据库'}</small></span></div>
          <button className="qp-button qp-button--outline qp-button--sm" type="button"
            onClick={() => setRecordExplorer({ label: OPINION_REASON_LABELS.missing_province, filters: { reason: 'missing_province' } })}>
            <MapPin size={15} />未归属 / 待总结
          </button>
        </header>
        {funnel.loading && !funnelData ? <LoadingState label="正在计算当前数据漏斗" /> : null}
        {funnel.error ? <ErrorState error={funnel.error} onRetry={funnel.refresh} /> : null}
        {funnelData ? <>
          <div className="mih-opinion-funnel__stages">
            {funnelStages.map((stage) => (
              <button type="button" key={stage.key} onClick={() => setRecordExplorer(stage.action)}
                aria-label={`查看${stage.label} ${formatNumber(stage.count, '0')} 条记录`}>
                <span>{stage.key.toUpperCase()}</span>
                <strong>{formatNumber(stage.count, '0')}</strong>
                <em>{stage.label}</em>
                <small>{stage.key === 'current'
                  ? `查看 active ${formatNumber(stage.count, '0')} 条 · deleted ${formatNumber(stage.excluded, '0')}`
                  : `查看本口径 ${formatNumber(stage.count, '0')} 条 · 总排除 ${formatNumber(stage.excluded, '0')}`}</small>
              </button>
            ))}
          </div>
          <div className="mih-opinion-funnel__dimensions" aria-label="并行质量维度">
            {funnelDimensions.map((dimension) => (
              <article key={dimension.key}>
                <span>{dimension.label}</span><strong>{formatNumber(dimension.count, '0')}</strong>
                <div>{dimension.issues.map(([reason, count]) => (
                  <button type="button" key={reason} onClick={() => setRecordExplorer({ label: OPINION_REASON_LABELS[reason], filters: { reason } })}>
                    {OPINION_REASON_LABELS[reason]} {formatNumber(count, '0')}
                  </button>
                ))}</div>
              </article>
            ))}
          </div>
          <div className="mih-opinion-funnel__reasons" aria-label="排除原因快捷查看">
            <span>并行诊断 · 排除原因可重叠</span>
            {funnelReasons.map(([field, reason]) => (
              <button type="button" key={reason} onClick={() => setRecordExplorer({ label: OPINION_REASON_LABELS[reason], filters: { reason } })}>
                {OPINION_REASON_LABELS[reason]} <strong>{formatNumber(funnelData.reasons?.[field], '0')}</strong>
              </button>
            ))}
          </div>
        </> : null}
      </section>

      <section className="mih-product-kpis" aria-label="全国舆情当前状态">
        <article><MapTrifold size={20} weight="duotone" /><span>省级地区</span><strong>{formatNumber(regionList.length, '34')}</strong><small>固定行政区目录</small></article>
        <article><NewspaperClipping size={20} weight="duotone" /><span>{selectedRegion.name}可用</span><strong>{formatNumber(available, '0')}</strong><small>当前时间窗 / 当前口径</small></article>
        <article className={shortfall > 0 ? 'is-warning' : ''}><Warning size={20} weight="duotone" /><span>覆盖缺口</span><strong>{formatNumber(shortfall, '0')}</strong><small>相对每省 10 条目标</small></article>
        <article><Pulse size={20} weight="duotone" /><span>实施管线</span><strong>{pipeline.data?.status || 'unknown'}</strong><small>{progress.data?.blocker || '无显式阻塞'}</small></article>
      </section>

      <section className="mih-opinion-toolbar qp-panel">
        <div>
          <GlobeHemisphereWest size={18} weight="duotone" />
          <span><strong>{selectedRegion.name}舆情榜</strong><small>{formatNumber(feedData?.pageInfo?.returnedCount, '0')} 条当前结果</small></span>
        </div>
        <div className="mih-command-segmented" aria-label="舆情排序">
          <button type="button" aria-pressed={sort === 'hot'} onClick={() => setQuery({ sort: 'hot' })}>热点</button>
          <button type="button" aria-pressed={sort === 'latest'} onClick={() => setQuery({ sort: 'latest' })}>最新</button>
        </div>
        <button className="qp-button qp-button--ghost" type="button" onClick={() => setProvincePickerOpen(true)}>
          <MagnifyingGlass size={16} />搜索地区
        </button>
      </section>

      <section className="mih-opinion-workbench">
        <aside className="qp-panel mih-opinion-list">
          <header><Fire size={18} weight="fill" /><strong>{selectedRegion.name}{sort === 'hot' ? '舆情榜' : '最新舆情'}</strong><span>{range === '24h' ? '24H' : range.toUpperCase()}</span></header>
          <div className="mih-opinion-list__body qp-scrollbar">
            {feed.loading && !feedData ? <LoadingState label="正在加载省级舆情" /> : null}
            {feed.error ? <ErrorState error={feed.error} onRetry={feed.refresh} /> : null}
            {!feed.loading && !feed.error && !(feedData?.items || []).length ? (
              <EmptyState icon={NewspaperClipping} title={`${selectedRegion.name}当前没有可展示舆情`}
                description="这是接口成功后的零数据状态；可切换时间范围、最新排序，或查看右侧覆盖与管线问题。" />
            ) : null}
            {(feedData?.items || []).map((item, index) => (
              <OpinionListItem key={item.id} item={item} index={feedPage * 30 + index}
                active={selectedId === item.id} onSelect={() => setSelectedId(item.id)} />
            ))}
          </div>
          <CursorControls page={feedPage + 1} noun="页" loading={feed.loading}
            hasMore={Boolean(feedData?.pageInfo?.hasMore)}
            onPrevious={() => setFeedPage((value) => Math.max(0, value - 1))}
            onNext={() => {
              const next = feedData?.pageInfo?.nextCursor
              if (!next) return
              setFeedCursors((current) => [...current.slice(0, feedPage + 1), next])
              setFeedPage((value) => value + 1)
            }} />
        </aside>

        <main className="qp-panel mih-opinion-detail">
          {detail.loading && selectedId ? <LoadingState label="正在加载舆情详情" /> : null}
          {detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : null}
          {!selectedId && !detail.loading ? <EmptyState icon={NewspaperClipping} title="选择一条舆情查看详情"
            description="左侧列表为空时，请先切换地区或检查下方数据诊断。" /> : null}
          {detailItem ? (
            <>
              <header>
                <div><span className="qp-tag qp-tag--success">实时线索</span><span className="qp-tag">{detailItem.province?.name || '地区未分类'}</span></div>
                <small>热点详情</small>
              </header>
              <article>
                <h2>{detailItem.title || '无标题舆情记录'}</h2>
                <p>{detailItem.summary || '当前记录没有已归档的正文摘要。'}</p>
                <div className="mih-opinion-meta"><MapPin size={16} /><span>{detailItem.province?.name || '未归属省份'}</span><span>{detailItem.origin?.name || detailItem.origin?.platform || '来源待确认'}</span><time>{formatDateTime(detailItem.publishedAt)}</time></div>
              </article>
              <dl className="mih-opinion-facts">
                <div><dt>数据来源</dt><dd>{detailItem.origin?.name || detailItem.origin?.platform || '待确认'}</dd></div>
                <div><dt>地区标签</dt><dd>{detailItem.province?.name || '未分类'}</dd></div>
                <div><dt>热度指数</dt><dd>{formatNumber(detailItem.heatScore)}</dd></div>
              </dl>
              {detailItem.url && !detailItem.demoMode ? <a className="qp-button qp-button--primary mih-opinion-source-link" href={detailItem.url}
                target="_blank" rel="noreferrer">打开业务来源<ArrowSquareOut size={16} /></a> : null}
              {detailItem.demoMode ? <span className="mih-opinion-demo-source">演示数据不提供外部跳转</span> : null}
            </>
          ) : null}
        </main>
      </section>

      <section className="mih-opinion-diagnostics qp-panel" aria-label="舆情数据问题诊断">
        <header><Warning size={18} weight="duotone" /><div><strong>接口与数据问题</strong><small>把服务故障、覆盖不足和质量问题分开汇报</small></div></header>
        <div className="mih-opinion-diagnostic-grid">
          <article className={coverage.error ? 'is-danger' : shortfall > 0 ? 'is-warning' : 'is-ok'}>
            <span>地区覆盖</span><strong>{coverage.error ? '接口失败' : shortfall > 0 ? `缺 ${shortfall}` : '达标'}</strong>
            <small>{coverage.error ? readableError(coverage.error)?.detail : `${selectedRegion.name}当前可用 ${formatNumber(available, '0')} 条`}</small>
          </article>
          <article className={pipeline.error || pipelineIssues.length ? 'is-danger' : 'is-ok'}>
            <span>采集与清洗</span><strong>{pipeline.error ? '不可读取' : pipeline.data?.status || 'unknown'}</strong>
            <small>{pipeline.error ? readableError(pipeline.error)?.detail : pipelineIssues[0] || '没有上报显式配置问题'}</small>
          </article>
          <article className={progress.error || progress.data?.blocker ? 'is-warning' : 'is-ok'}>
            <span>调度进度</span><strong>{progress.data?.task?.status || progress.data?.status || 'unknown'}</strong>
            <small>{progress.error ? readableError(progress.error)?.detail : progress.data?.blocker || '无显式阻塞'}</small>
          </article>
          <article className={quality.error ? 'is-danger' : 'is-ok'}>
            <span>归档质量</span><strong>{formatNumber(qualityFormal, quality.error ? '接口失败' : '0')}</strong>
            <small>{quality.error ? readableError(quality.error)?.detail : `候选 ${formatNumber(qualityCandidate, '0')} · 待处理 ${formatNumber(qualityPending, '0')}`}</small>
          </article>
        </div>
      </section>

      {provincePickerOpen ? <ProvincePicker regions={regionList} coverage={coverageData}
        selectedCode={provinceCode} search={provinceSearch} setSearch={setProvinceSearch}
        onClose={() => setProvincePickerOpen(false)} onSelect={(code) => {
          setQuery({ province: code })
          setProvincePickerOpen(false)
          setProvinceSearch('')
        }} /> : null}
      {recordExplorer ? <OpinionRecordExplorer key={`${recordExplorer.label}:${range}`} token={token}
        timeWindow={timeWindow} initialView={recordExplorer} onUnauthorized={onUnauthorized}
        onClose={() => setRecordExplorer(null)} /> : null}
    </div>
  )
}
