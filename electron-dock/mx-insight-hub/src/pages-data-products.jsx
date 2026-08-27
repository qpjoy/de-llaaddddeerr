import { useCallback, useEffect, useMemo, useState } from 'react'
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

function windowFor(range) {
  const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30
  const to = new Date()
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

function TelegramMessage({ item, anchor = false }) {
  const author = item?.author?.name || item?.author?.username || item?.author?.id || '未知发送者'
  const text = telegramText(item)
  return (
    <article className={`mih-tg-message${anchor ? ' is-anchor' : ''}`}>
      <header>
        <span className="mih-tg-avatar" aria-hidden="true">{String(author).slice(0, 1).toUpperCase()}</span>
        <strong>{author}</strong>
        <time>{formatDateTime(item?.eventTime ?? item?.publishedAt)}</time>
        {anchor ? <span className="qp-tag">检索锚点</span> : null}
      </header>
      <div className="mih-tg-bubble">
        {text ? <p>{text}</p> : <p className="is-muted">[{item?.contentType || '媒体 / 服务消息'}，无公开文本]</p>}
        {item?.relations?.replyToMessageId ? <small>回复消息 {item.relations.replyToMessageId}</small> : null}
        {item?.metrics?.views != null ? <small>{formatNumber(item.metrics.views)} 次查看</small> : null}
      </div>
    </article>
  )
}

function TelegramDirectoryPage({ kind, token, onUnauthorized }) {
  const isChannel = kind === 'channel'
  const title = isChannel ? 'Telegram 公开频道' : 'Telegram 公开群组'
  const KindIcon = isChannel ? Broadcast : Users
  const [directoryDraft, setDirectoryDraft] = useState('')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [directoryCursors, setDirectoryCursors] = useState([null])
  const [directoryPage, setDirectoryPage] = useState(0)
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [messageCursors, setMessageCursors] = useState([null])
  const [messagePage, setMessagePage] = useState(0)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchData, setSearchData] = useState(null)
  const [searchError, setSearchError] = useState(null)
  const [searching, setSearching] = useState(false)
  const [contextAnchor, setContextAnchor] = useState(null)
  const [contextData, setContextData] = useState(null)
  const [contextError, setContextError] = useState(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [beforeCount, setBeforeCount] = useState(10)
  const [afterCount, setAfterCount] = useState(10)

  const loadDirectory = useCallback(() => adminApi.dataProductTelegramChats(token, {
    kind,
    query: directoryQuery || undefined,
    pageSize: 30,
    cursor: directoryCursors[directoryPage] || undefined,
  }), [directoryCursors, directoryPage, directoryQuery, kind, token])
  const directory = useRemoteData(loadDirectory, onUnauthorized)

  useEffect(() => {
    const items = directory.data?.items || []
    if (!items.length) {
      setSelectedChatId(null)
      return
    }
    if (!selectedChatId || !items.some((item) => item.externalId === selectedChatId)) {
      setSelectedChatId(items[0].externalId)
    }
  }, [directory.data, selectedChatId])

  const selectedChat = useMemo(
    () => (directory.data?.items || []).find((item) => item.externalId === selectedChatId) || null,
    [directory.data, selectedChatId],
  )

  const loadMessages = useCallback(() => selectedChatId
    ? adminApi.dataProductTelegramMessages(token, selectedChatId, {
        pageSize: 30,
        cursor: messageCursors[messagePage] || undefined,
      })
    : Promise.resolve({ items: [], pageInfo: { returnedCount: 0, hasMore: false, nextCursor: null } }),
  [messageCursors, messagePage, selectedChatId, token])
  const messages = useRemoteData(loadMessages, onUnauthorized)

  useEffect(() => {
    setMessageCursors([null])
    setMessagePage(0)
    setSearchData(null)
    setSearchError(null)
    setContextAnchor(null)
    setContextData(null)
    setContextError(null)
  }, [selectedChatId])

  const submitDirectory = (event) => {
    event.preventDefault()
    setDirectoryCursors([null])
    setDirectoryPage(0)
    setDirectoryQuery(directoryDraft.trim())
  }

  const submitSearch = async (event) => {
    event.preventDefault()
    const query = searchDraft.trim()
    if (!query || !selectedChatId) return
    setSearching(true)
    setSearchError(null)
    setContextData(null)
    try {
      setSearchData(await adminApi.searchDataProductTelegram(token, {
        query,
        chatId: selectedChatId,
        pageSize: 20,
      }))
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setSearchError(error)
      setSearchData(null)
    } finally {
      setSearching(false)
    }
  }

  const openContext = async (item) => {
    const canonicalId = item?.canonicalId || item?.id
    if (!canonicalId) return
    setContextAnchor(canonicalId)
    setContextLoading(true)
    setContextError(null)
    try {
      setContextData(await adminApi.dataProductTelegramContext(token, canonicalId, {
        before: beforeCount,
        after: afterCount,
      }))
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setContextError(error)
      setContextData(null)
    } finally {
      setContextLoading(false)
    }
  }

  const transcript = contextData?.items
    ? contextData.items
    : [...(messages.data?.items || [])].reverse()
  const demoMode = Boolean(directory.data?.demoMode || messages.data?.demoMode)
  const warningList = [
    ...(searchData?.warnings || []),
    ...(contextData?.warnings || []),
  ]

  return (
    <div className="mih-product-page mih-product-page--telegram">
      <PageHeading
        eyebrow="DATA PRODUCTS / TELEGRAM"
        title={title}
        description="从 Hub 已归档的公开会话中检索频道与群组，按消息窗口还原上下文；不把当前存储窗口冒充 Telegram 完整历史。"
        loading={directory.loading || messages.loading}
        onRefresh={() => { directory.refresh(); messages.refresh() }}
      >
        <StatusBadge status={directory.error ? 'down' : demoMode ? 'degraded' : 'ready'}
          label={directory.error ? '目录接口异常' : demoMode ? '本地演示' : '只读展示'} />
      </PageHeading>

      <PageModeNotice demoMode={demoMode}>仅展示服务端已验证为公开的 {isChannel ? '频道' : '群组'}，私有或无法判定的对象不会进入目录。</PageModeNotice>

      <section className="mih-product-kpis" aria-label="Telegram 当前窗口概览">
        <article><KindIcon size={20} weight="duotone" /><span>当前目录</span><strong>{formatNumber(directory.data?.pageInfo?.returnedCount, '0')}</strong><small>本页已验证公开对象</small></article>
        <article><Users size={20} weight="duotone" /><span>会话成员</span><strong>{formatNumber(selectedChat?.memberCount)}</strong><small>{selectedChat?.title || '尚未选择会话'}</small></article>
        <article><ChatCircleText size={20} weight="duotone" /><span>消息窗口</span><strong>{formatNumber(transcript.length, '0')}</strong><small>按事件时间展示</small></article>
        <article><Database size={20} weight="duotone" /><span>数据范围</span><strong>Monitor</strong><small>当前展示口径</small></article>
      </section>

      <section className="mih-tg-workbench">
        <aside className="qp-panel mih-tg-directory" aria-label={`${title}目录`}>
          <header>
            <div><TelegramLogo size={20} weight="fill" /><strong>公开会话</strong></div>
            <span>{directoryPage + 1}</span>
          </header>
          <form className="mih-product-search" onSubmit={submitDirectory}>
            <MagnifyingGlass size={17} aria-hidden="true" />
            <input value={directoryDraft} onChange={(event) => setDirectoryDraft(event.target.value)}
              placeholder={`搜索${isChannel ? '频道' : '群组'}名称或用户名`} aria-label={`搜索${title}`} />
            <button type="submit">查找</button>
          </form>
          <div className="mih-tg-directory__list qp-scrollbar">
            {directory.loading && !directory.data ? <LoadingState label="正在加载公开会话" /> : null}
            {directory.error ? <ErrorState error={directory.error} onRetry={directory.refresh} /> : null}
            {!directory.loading && !directory.error && !(directory.data?.items || []).length ? (
              <EmptyState icon={TelegramLogo} title="暂无已验证公开会话"
                description="这不等于 Telegram 上不存在对象；可能尚未接入、类型无法判定或没有公开入口证据。" />
            ) : null}
            {(directory.data?.items || []).map((chat) => (
              <button className={`mih-tg-chat${selectedChatId === chat.externalId ? ' is-active' : ''}`}
                type="button" key={chat.canonicalId || chat.externalId}
                onClick={() => setSelectedChatId(chat.externalId)}>
                <span className="mih-tg-avatar"><KindIcon size={16} weight="fill" aria-hidden="true" /></span>
                <span><strong>{chat.title || chat.username || chat.externalId}</strong><small>{chat.username ? `@${chat.username.replace(/^@/, '')}` : '无公开用户名'}</small></span>
                <em>{chat.memberCount == null ? '—' : formatNumber(chat.memberCount)}</em>
              </button>
            ))}
          </div>
          <CursorControls page={directoryPage + 1} noun="页" loading={directory.loading}
            hasMore={Boolean(directory.data?.pageInfo?.hasMore)}
            onPrevious={() => setDirectoryPage((value) => Math.max(0, value - 1))}
            onNext={() => {
              const next = directory.data?.pageInfo?.nextCursor
              if (!next) return
              setDirectoryCursors((current) => [...current.slice(0, directoryPage + 1), next])
              setDirectoryPage((value) => value + 1)
            }} />
        </aside>

        <main className="qp-panel mih-tg-conversation">
          <header className="mih-tg-conversation__header">
            <div className="mih-tg-avatar mih-tg-avatar--large"><KindIcon size={21} weight="fill" aria-hidden="true" /></div>
            <div>
              <strong>{selectedChat?.title || '选择一个公开会话'}</strong>
              <span>{selectedChat?.username ? `@${selectedChat.username.replace(/^@/, '')}` : selectedChat?.externalId || '从左侧目录开始'}</span>
            </div>
            {selectedChat?.url ? <a className="qp-button qp-button--ghost qp-icon-button" href={selectedChat.url}
              target="_blank" rel="noreferrer" aria-label="打开公开 Telegram 入口"><ArrowSquareOut size={17} /></a> : null}
          </header>
          <form className="mih-tg-search" onSubmit={submitSearch}>
            <MagnifyingGlass size={17} aria-hidden="true" />
            <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="在当前会话的已归档消息中搜索" disabled={!selectedChatId} aria-label="搜索当前会话消息" />
            <button className="qp-button qp-button--outline qp-button--sm" type="submit"
              disabled={!selectedChatId || !searchDraft.trim() || searching}>{searching ? '检索中' : '检索'}</button>
            {searchData || searchError ? <button className="qp-button qp-button--ghost qp-button--sm" type="button"
              onClick={() => { setSearchData(null); setSearchError(null); setContextData(null); setContextAnchor(null) }}>返回消息</button> : null}
          </form>
          {searchError ? <div className="mih-tg-inline-state"><ErrorState error={searchError} /></div> : null}
          {searchData ? (
            <section className="mih-tg-search-results">
              <header><strong>检索结果</strong><span>{searchData.pageInfo?.returnedCount || 0} 条 · {searchData.searchMode || 'unknown'}</span></header>
              {(searchData.items || []).length ? searchData.items.map((item) => (
                <button type="button" key={item.canonicalId || item.id} onClick={() => openContext(item)}>
                  <span><strong>{item.author?.name || '未知发送者'}</strong><time>{formatDateTime(item.eventTime)}</time></span>
                  <p>{telegramText(item) || `[${item.contentType || '非文本消息'}]`}</p>
                  <small>查看前 {beforeCount} / 后 {afterCount} 条已存上下文</small>
                </button>
              )) : <EmptyState icon={MagnifyingGlass} title="没有命中已归档消息" description="可调整关键词；空结果不是接口故障。" />}
            </section>
          ) : null}
          <div className="mih-tg-transcript qp-scrollbar" aria-label="会话消息窗口">
            {messages.loading && !messages.data && !contextData ? <LoadingState label="正在加载消息窗口" /> : null}
            {messages.error && !contextData ? <ErrorState error={messages.error} onRetry={messages.refresh} /> : null}
            {contextLoading ? <LoadingState label="正在还原锚点上下文" /> : null}
            {contextError ? <ErrorState error={contextError} /> : null}
            {!messages.loading && !messages.error && selectedChatId && !transcript.length ? (
              <EmptyState icon={ChatCircleText} title="该公开会话暂无已归档消息"
                description="会话存在不代表消息已经同步；请在右侧检查数据范围与管线状态。" />
            ) : null}
            {transcript.map((item, index) => (
              <TelegramMessage item={item} key={item.canonicalId || item.id || `${item.externalId}-${index}`}
                anchor={Boolean(contextData && index === contextData.anchorIndex)} />
            ))}
          </div>
          {!contextData ? (
            <CursorControls page={messagePage + 1} noun="窗口" loading={messages.loading}
              hasMore={Boolean(messages.data?.pageInfo?.hasMore)}
              onPrevious={() => setMessagePage((value) => Math.max(0, value - 1))}
              onNext={() => {
                const next = messages.data?.pageInfo?.nextCursor
                if (!next) return
                setMessageCursors((current) => [...current.slice(0, messagePage + 1), next])
                setMessagePage((value) => value + 1)
              }} />
          ) : (
            <div className="mih-tg-context-footer">
              <span>当前为检索锚点上下文</span>
              <button className="qp-button qp-button--ghost qp-button--sm" type="button"
                onClick={() => { setContextData(null); setContextAnchor(null) }}>关闭上下文</button>
            </div>
          )}
        </main>

        <aside className="qp-panel mih-product-diagnostics" aria-label="Telegram 数据诊断">
          <header><Pulse size={18} weight="duotone" /><strong>数据诊断</strong></header>
          <section>
            <span>公开性判定</span>
            <strong>服务端过滤</strong>
            <small>类型 + 公开用户名 / 非邀请链接</small>
          </section>
          <section>
            <span>上下文窗口</span>
            <div className="mih-context-counts">
              <label>前<input type="number" min="0" max="50" value={beforeCount}
                onChange={(event) => setBeforeCount(Math.max(0, Math.min(50, Number(event.target.value) || 0)))} /></label>
              <label>后<input type="number" min="0" max="50" value={afterCount}
                onChange={(event) => setAfterCount(Math.max(0, Math.min(50, Number(event.target.value) || 0)))} /></label>
            </div>
            <small>每侧最多 50 条，点击检索命中后生效</small>
          </section>
          <section>
            <span>存储完整性</span>
            <strong>{contextData?.upstreamCompleteness?.status || 'unknown'}</strong>
            <small>{contextData
              ? `前侧更多 ${contextData.storedWindow?.hasMoreStoredBefore ? '是' : '否'} · 后侧更多 ${contextData.storedWindow?.hasMoreStoredAfter ? '是' : '否'}`
              : '尚未打开锚点上下文'}</small>
          </section>
          <section>
            <span>检索后端</span>
            <strong>{searchData?.searchMode || '未执行'}</strong>
            <small>ES 不可用时允许退化到 PG</small>
          </section>
          {warningList.map((warning) => <div className="mih-product-warning" key={warning.code || warning.message}>
            <Warning size={16} weight="fill" /><span><strong>{warning.code || 'warning'}</strong><small>{warning.message}</small></span>
          </div>)}
          {[directory.error, messages.error, searchError, contextError].filter(Boolean).map((error, index) => {
            const readable = readableError(error)
            return <div className="mih-product-warning is-danger" key={`${readable.title}-${index}`}><Warning size={16} weight="fill" /><span><strong>{readable.title}</strong><small>{readable.detail}</small></span></div>
          })}
          <footer>
            <Database size={15} /><span>{directory.data?.sourceScope?.datasets?.join(' · ') || 'telegram.monitor.*'}</span>
          </footer>
        </aside>
      </section>
    </div>
  )
}

export function TelegramChannelsPage(props) {
  return <TelegramDirectoryPage {...props} kind="channel" />
}

export function TelegramGroupsPage(props) {
  return <TelegramDirectoryPage {...props} kind="group" />
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

export function PublicOpinionPage({ token, query, setQuery, onUnauthorized }) {
  const range = ['24h', '7d', '30d'].includes(query.get('range')) ? query.get('range') : '30d'
  const provinceCode = query.get('province') || 'CN-JS'
  const sort = query.get('sort') === 'latest' ? 'latest' : 'hot'
  const [provincePickerOpen, setProvincePickerOpen] = useState(false)
  const [provinceSearch, setProvinceSearch] = useState('')
  const [feedCursors, setFeedCursors] = useState([null])
  const [feedPage, setFeedPage] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const timeWindow = useMemo(() => windowFor(range), [range])

  const regions = useRemoteData(useCallback(
    () => adminApi.dataProductPublicOpinionRegions(token), [token],
  ), onUnauthorized)
  const coverage = useRemoteData(useCallback(
    () => adminApi.dataProductPublicOpinionCoverage(token, { ...timeWindow, targetPerProvince: 10 }),
    [timeWindow, token],
  ), onUnauthorized)
  const feed = useRemoteData(useCallback(
    () => adminApi.dataProductPublicOpinionProvince(token, provinceCode, {
      sort,
      ...timeWindow,
      pageSize: 30,
      cursor: feedCursors[feedPage] || undefined,
    }),
    [feedCursors, feedPage, provinceCode, sort, timeWindow, token],
  ), onUnauthorized)
  const pipeline = useRemoteData(useCallback(
    () => adminApi.provinceOpinionPipeline(token), [token],
  ), onUnauthorized)
  const progress = useRemoteData(useCallback(
    () => adminApi.provinceOpinionPipelineProgress(token), [token],
  ), onUnauthorized)
  const quality = useRemoteData(useCallback(
    () => adminApi.provinceOpinionQualitySummary(token), [token],
  ), onUnauthorized)

  useEffect(() => {
    setFeedCursors([null])
    setFeedPage(0)
    setSelectedId(null)
  }, [provinceCode, range, sort])

  useEffect(() => {
    const items = feed.data?.items || []
    if (!items.length) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) setSelectedId(items[0].id)
  }, [feed.data, selectedId])

  const detail = useRemoteData(useCallback(
    () => selectedId ? adminApi.dataProductPublicOpinionItem(token, selectedId) : Promise.resolve(null),
    [selectedId, token],
  ), onUnauthorized)
  const regionList = regions.data?.regions || []
  const selectedRegion = regionList.find((region) => region.code === provinceCode)
    || feed.data?.province
    || { code: provinceCode, name: provinceCode }
  const coverageItems = coverage.data?.provinces || coverage.data?.items || []
  const selectedCoverage = coverageItems.find((item) => (item.province?.code || item.code) === provinceCode)
  const demoMode = Boolean(regions.data?.demoMode || coverage.data?.demoMode || feed.data?.demoMode)
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
  const available = selectedCoverage?.availableCount ?? selectedCoverage?.available ?? selectedCoverage?.formalCount ?? feed.data?.pageInfo?.returnedCount ?? 0
  const shortfall = selectedCoverage?.shortfall ?? Math.max(0, 10 - Number(available || 0))
  const detailItem = detail.data

  const refreshAll = () => {
    regions.refresh(); coverage.refresh(); feed.refresh(); detail.refresh(); pipeline.refresh(); progress.refresh(); quality.refresh()
  }

  return (
    <div className="mih-product-page mih-product-page--opinion">
      <PageHeading eyebrow="DATA PRODUCTS / PUBLIC OPINION" title="全国舆情"
        description={`当前展示${selectedRegion.name}公开舆情，可切换省份、时间窗与排序，并把“无数据”和“接口异常”分开呈现。`}
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

      <PageModeNotice demoMode={demoMode}>地区目录、覆盖缺口、新闻列表与详情分别读取；列表为空不会被包装成系统健康。</PageModeNotice>

      <section className="mih-product-kpis" aria-label="全国舆情当前状态">
        <article><MapTrifold size={20} weight="duotone" /><span>省级地区</span><strong>{formatNumber(regionList.length, '34')}</strong><small>固定行政区目录</small></article>
        <article><NewspaperClipping size={20} weight="duotone" /><span>{selectedRegion.name}可用</span><strong>{formatNumber(available, '0')}</strong><small>当前时间窗 / 当前口径</small></article>
        <article className={shortfall > 0 ? 'is-warning' : ''}><Warning size={20} weight="duotone" /><span>覆盖缺口</span><strong>{formatNumber(shortfall, '0')}</strong><small>相对每省 10 条目标</small></article>
        <article><Pulse size={20} weight="duotone" /><span>实施管线</span><strong>{pipeline.data?.status || 'unknown'}</strong><small>{progress.data?.blocker || '无显式阻塞'}</small></article>
      </section>

      <section className="mih-opinion-toolbar qp-panel">
        <div>
          <GlobeHemisphereWest size={18} weight="duotone" />
          <span><strong>{selectedRegion.name}舆情榜</strong><small>{formatNumber(feed.data?.pageInfo?.returnedCount, '0')} 条当前结果</small></span>
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
            {feed.loading && !feed.data ? <LoadingState label="正在加载省级舆情" /> : null}
            {feed.error ? <ErrorState error={feed.error} onRetry={feed.refresh} /> : null}
            {!feed.loading && !feed.error && !(feed.data?.items || []).length ? (
              <EmptyState icon={NewspaperClipping} title={`${selectedRegion.name}当前没有可展示舆情`}
                description="这是接口成功后的零数据状态；可切换时间范围、最新排序，或查看右侧覆盖与管线问题。" />
            ) : null}
            {(feed.data?.items || []).map((item, index) => (
              <OpinionListItem key={item.id} item={item} index={feedPage * 30 + index}
                active={selectedId === item.id} onSelect={() => setSelectedId(item.id)} />
            ))}
          </div>
          <CursorControls page={feedPage + 1} noun="页" loading={feed.loading}
            hasMore={Boolean(feed.data?.pageInfo?.hasMore)}
            onPrevious={() => setFeedPage((value) => Math.max(0, value - 1))}
            onNext={() => {
              const next = feed.data?.pageInfo?.nextCursor
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
                <p>{detailItem.summary || '当前记录没有可公开展示的正文摘要。'}</p>
                <div className="mih-opinion-meta"><MapPin size={16} /><span>{detailItem.province?.name || '未归属省份'}</span><span>{detailItem.origin?.name || detailItem.origin?.platform || '来源待确认'}</span><time>{formatDateTime(detailItem.publishedAt)}</time></div>
              </article>
              <dl className="mih-opinion-facts">
                <div><dt>数据来源</dt><dd>{detailItem.origin?.name || detailItem.origin?.platform || '待确认'}</dd></div>
                <div><dt>地区标签</dt><dd>{detailItem.province?.name || '未分类'}</dd></div>
                <div><dt>热度指数</dt><dd>{formatNumber(detailItem.heatScore)}</dd></div>
              </dl>
              {detailItem.url && !detailItem.demoMode ? <a className="qp-button qp-button--primary mih-opinion-source-link" href={detailItem.url}
                target="_blank" rel="noreferrer">打开公开来源<ArrowSquareOut size={16} /></a> : null}
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

      {provincePickerOpen ? <ProvincePicker regions={regionList} coverage={coverage.data}
        selectedCode={provinceCode} search={provinceSearch} setSearch={setProvinceSearch}
        onClose={() => setProvincePickerOpen(false)} onSelect={(code) => {
          setQuery({ province: code })
          setProvincePickerOpen(false)
          setProvinceSearch('')
        }} /> : null}
    </div>
  )
}
