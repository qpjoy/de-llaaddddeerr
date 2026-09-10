import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowSquareOut,
  CalendarBlank,
  ChartBar,
  CheckCircle,
  Clock,
  FileText,
  GlobeHemisphereWest,
  Graph,
  LinkSimple,
  ListMagnifyingGlass,
  MapPin,
  Sparkle,
  Tag,
  UserCircle,
  WarningCircle,
} from '@phosphor-icons/react'
import { adminApi, publicDocsHref } from './api.js'
import {
  DropdownField,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from './components.jsx'

const RANGE_OPTIONS = [
  { value: '24h', label: '近 24 小时', description: '捕捉正在形成的短周期主题' },
  { value: '7d', label: '近 7 天', description: '适合热点回顾与专题简报' },
  { value: '30d', label: '近 30 天', description: '观察月度趋势与来源差异' },
  { value: '90d', label: '近 90 天', description: '适合政策与行业变化复盘' },
]

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'en', label: 'English' },
]

const CORE_PLATFORMS = [
  'data_center_saved_records_news',
  'data_center_saved_records_media',
  'data_center_saved_records_local_news',
  'data_center_saved_records_hotspot',
  'data_center_saved_records_finance',
  'data_center_saved_records_technology',
  'data_center_saved_records_research',
]

const SOURCE_OPTIONS = [
  {
    value: 'all_granted',
    label: '全部已同步资讯（13 类）',
    description: '覆盖新闻、财经、科技、研究、社交与网页等 canonical 数据',
  },
  {
    value: 'editorial',
    label: '新闻与主流行业资讯',
    description: '聚焦新闻、媒体、地方、热点、财经、科技与研究',
  },
]

const STATUS_LABELS = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
}

const PHASE_LABELS = {
  queued: '等待 worker 领取任务',
  selecting_evidence: '筛选 canonical 证据',
  building_associations: '生成趋势与关联',
  complete: '报告已完成',
  failed: '生成失败',
}

function formatDateTime(value) {
  if (!value) return '尚未开始'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function reportStatusTone(status) {
  if (status === 'succeeded') return 'active'
  if (status === 'failed') return 'down'
  if (status === 'running') return 'live'
  return 'unknown'
}

function DimensionList({ title, icon: Icon, items = [], empty = '暂无明确线索' }) {
  return (
    <section className="mih-topic-dimension">
      <header><Icon size={18} weight="duotone" aria-hidden="true" /><strong>{title}</strong></header>
      {items.length ? (
        <ol>
          {items.slice(0, 8).map((item) => (
            <li key={item.id}>
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </li>
          ))}
        </ol>
      ) : <p>{empty}</p>}
    </section>
  )
}

function TopicTimeline({ items = [] }) {
  const max = Math.max(1, ...items.map((item) => Number(item.count) || 0))
  return (
    <section className="qp-panel mih-topic-timeline">
      <header>
        <div><ChartBar size={20} weight="duotone" aria-hidden="true" /><span><strong>时间趋势</strong><small>按 canonical 事件时间聚合</small></span></div>
      </header>
      {items.length ? (
        <div className="mih-topic-timeline__bars" role="img" aria-label="专题记录时间趋势">
          {items.map((item) => (
            <div className="mih-topic-timeline__bar" key={item.date} title={`${item.date}：${item.count} 条`}>
              <span style={{ height: `${Math.max(8, (item.count / max) * 100)}%` }} />
              <small>{item.date.slice(5)}</small>
            </div>
          ))}
        </div>
      ) : <p className="mih-topic-muted">当前时间窗没有匹配记录。</p>}
    </section>
  )
}

function AssociationCloud({ associations }) {
  const nodes = (associations?.nodes || []).filter((node) => node.type !== 'topic')
  return (
    <section className="qp-panel mih-topic-associations">
      <header>
        <div><Graph size={20} weight="duotone" aria-hidden="true" /><span><strong>关联线索</strong><small>共现关系，不代表因果判断</small></span></div>
      </header>
      {nodes.length ? (
        <div className="mih-topic-associations__cloud">
          {nodes.slice(0, 24).map((node) => (
            <span className={`mih-topic-node is-${node.type}`} key={node.id} title={`关联强度 ${node.weight}`}>
              <small>{node.type === 'category' ? '类别' : node.type === 'tag' ? '标签' : node.type === 'location' ? '地域' : '作者'}</small>
              <strong>{node.label}</strong>
              <i>{node.weight}</i>
            </span>
          ))}
        </div>
      ) : <p className="mih-topic-muted">当前证据不足以建立关联线索。</p>}
    </section>
  )
}

function TopicReportResult({ task }) {
  const report = task?.result
  if (!report) return null
  const coverage = report.coverage || {}
  return (
    <div className="mih-topic-result">
      <section className="qp-panel mih-topic-summary">
        <div className="mih-topic-summary__eyebrow"><Sparkle size={17} weight="fill" aria-hidden="true" />专题结论</div>
        <h2>{report.executiveSummary?.headline}</h2>
        <p>{report.executiveSummary?.overview}</p>
        <ul>
          {(report.executiveSummary?.keyFindings || []).map((finding) => <li key={finding}>{finding}</li>)}
        </ul>
        <div className="mih-topic-summary__meta">
          <span><CalendarBlank size={15} aria-hidden="true" />{formatDateTime(report.window?.from)} — {formatDateTime(report.window?.to)}</span>
          <span><CheckCircle size={15} aria-hidden="true" />PostgreSQL canonical truth</span>
          <span><ListMagnifyingGlass size={15} aria-hidden="true" />{coverage.analyzedRecords || 0} 条参与分析</span>
        </div>
      </section>

      <section className="mih-topic-kpis" aria-label="报告覆盖摘要">
        <article><strong>{coverage.matchedRecords || 0}</strong><span>匹配记录</span></article>
        <article><strong>{coverage.categoryCount || 0}</strong><span>数据类别</span></article>
        <article><strong>{report.dimensions?.authors?.length || 0}</strong><span>主要作者</span></article>
        <article><strong>{report.dimensions?.locations?.length || 0}</strong><span>地域线索</span></article>
      </section>

      <div className="mih-topic-insight-grid">
        <TopicTimeline items={report.timeline} />
        <AssociationCloud associations={report.associations} />
      </div>

      <section className="qp-panel mih-topic-dimensions">
        <DimensionList title="类别分布" icon={GlobeHemisphereWest} items={report.dimensions?.categories} />
        <DimensionList title="主题标签" icon={Tag} items={report.dimensions?.tags} />
        <DimensionList title="地域线索" icon={MapPin} items={report.dimensions?.locations} />
        <DimensionList title="作者与主体" icon={UserCircle} items={report.dimensions?.authors} />
      </section>

      <section className="qp-panel mih-topic-evidence">
        <header>
          <div><FileText size={20} weight="duotone" aria-hidden="true" /><span><strong>关键证据</strong><small>可回到原文核对的公开安全记录</small></span></div>
          <span>{coverage.evidenceRecords || 0} 条</span>
        </header>
        <div className="mih-topic-evidence__list">
          {(report.evidence || []).map((item) => (
            <article key={item.canonicalId}>
              <div>
                <span className="qp-tag">{item.category?.label || '资讯'}</span>
                {item.location ? <span className="qp-tag">{item.location}</span> : null}
                <time>{formatDateTime(item.eventTime)}</time>
              </div>
              <h3>{item.title}</h3>
              {item.summary ? <p>{item.summary}</p> : null}
              <footer>
                <span>{item.author || '来源作者未标注'}</span>
                {item.url ? <a href={item.url} target="_blank" rel="noreferrer">查看原文<LinkSimple size={14} aria-hidden="true" /></a> : null}
              </footer>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

export function TopicInsightsPage({ token, onUnauthorized, notify }) {
  const [tab, setTab] = useState('create')
  const [topic, setTopic] = useState('')
  const [range, setRange] = useState('7d')
  const [sourceScope, setSourceScope] = useState('all_granted')
  const [language, setLanguage] = useState('zh-CN')
  const [tasks, setTasks] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const data = await adminApi.topicReports(token, { limit: 40 })
      const next = data?.items || []
      setTasks(next)
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id || null)
      setError(null)
    } catch (caught) {
      if (caught?.status === 401) onUnauthorized?.(caught)
      setError(caught)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [onUnauthorized, token])

  useEffect(() => { load() }, [load])
  const hasActiveTask = tasks.some((task) => ['queued', 'running'].includes(task.status))
  useEffect(() => {
    if (!hasActiveTask) return undefined
    const timer = window.setInterval(() => load({ quiet: true }), 2_500)
    return () => window.clearInterval(timer)
  }, [hasActiveTask, load])

  const selected = useMemo(() => tasks.find((task) => task.id === selectedId) || null, [selectedId, tasks])

  const submit = async (event) => {
    event.preventDefault()
    if (topic.trim().length < 2) return
    setSubmitting(true)
    try {
      const body = {
        topic: topic.trim(),
        range,
        language,
        sourceScope: sourceScope === 'editorial' ? 'selected' : 'all_granted',
        ...(sourceScope === 'editorial' ? { platforms: CORE_PLATFORMS } : {}),
      }
      const created = await adminApi.createTopicReport(token, body)
      setTasks((current) => [created, ...current.filter((item) => item.id !== created.id)])
      setSelectedId(created.id)
      setTab('progress')
      setTopic('')
      notify?.('专题报告已进入队列，将直接读取已清洗的 canonical 数据', 'success')
    } catch (caught) {
      if (caught?.status === 401) onUnauthorized?.(caught)
      notify?.(caught?.message || '创建专题报告失败，请稍后重试', 'danger')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mih-product-page mih-topic-page">
      <PageHeading
        eyebrow="DATA PRODUCT / TOPIC INSIGHT"
        title="专题洞察"
        description="从已同步的数据中心生成可追溯的趋势、主体、地域与证据关联。"
        loading={loading}
        onRefresh={() => load()}
      >
        <a className="qp-button qp-button--outline qp-button--sm" href={publicDocsHref('/docs/topic-reports')} target="_blank" rel="noreferrer">
          开放 API<ArrowSquareOut size={15} aria-hidden="true" />
        </a>
      </PageHeading>

      <div className="mih-topic-workbench">
        <section className="qp-panel mih-topic-composer">
          <div className="mih-topic-tabs" role="tablist" aria-label="专题报告操作">
            <button type="button" role="tab" aria-selected={tab === 'create'} className={tab === 'create' ? 'is-active' : ''} onClick={() => setTab('create')}>创建专题报告</button>
            <button type="button" role="tab" aria-selected={tab === 'progress'} className={tab === 'progress' ? 'is-active' : ''} onClick={() => setTab('progress')}>
              任务进度{hasActiveTask ? <i /> : null}
            </button>
          </div>

          {tab === 'create' ? (
            <form className="mih-topic-form" onSubmit={submit}>
              <label className="qp-field">
                <span className="qp-field__label">新闻主题</span>
                <textarea value={topic} maxLength={300} rows={5} placeholder="例如：东南亚近期选举与外交政策变化" onChange={(event) => setTopic(event.target.value)} />
                <span className="mih-topic-character-count">{topic.length}/300</span>
              </label>
              <DropdownField label="时间范围" value={range} options={RANGE_OPTIONS} onChange={setRange} leadingIcon={Clock} />
              <DropdownField label="来源范围" value={sourceScope} options={SOURCE_OPTIONS} onChange={setSourceScope} leadingIcon={GlobeHemisphereWest} />
              <DropdownField label="报告语言" value={language} options={LANGUAGE_OPTIONS} onChange={setLanguage} leadingIcon={FileText} />
              <button className="qp-button qp-button--primary mih-topic-submit" type="submit" disabled={submitting || topic.trim().length < 2}>
                <Sparkle size={18} weight="fill" aria-hidden="true" />{submitting ? '正在提交…' : '提交生成'}
              </button>
              <p className="mih-topic-form__note">报告直接读取 PostgreSQL canonical truth，不触发 Elasticsearch 重建，也不调用 HanLP。</p>
            </form>
          ) : (
            <div className="mih-topic-task-list">
              {loading && !tasks.length ? <LoadingState label="正在读取专题任务" /> : null}
              {error ? <ErrorState error={error} onRetry={() => load()} /> : null}
              {!loading && !error && !tasks.length ? <EmptyState icon={FileText} title="还没有专题任务" description="创建第一个专题报告后，进度会显示在这里。" /> : null}
              {tasks.map((task) => (
                <button type="button" key={task.id} className={task.id === selectedId ? 'is-active' : ''} onClick={() => setSelectedId(task.id)}>
                  <span><strong>{task.topic}</strong><small>{formatDateTime(task.createdAt)} · {PHASE_LABELS[task.phase] || task.phase}</small></span>
                  <StatusBadge status={reportStatusTone(task.status)} label={STATUS_LABELS[task.status] || task.status} />
                  <i><span style={{ width: `${task.progress || 0}%` }} /></i>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="mih-topic-stage">
          {selected?.status === 'succeeded' ? <TopicReportResult task={selected} /> : null}
          {selected && ['queued', 'running'].includes(selected.status) ? (
            <section className="qp-panel mih-topic-running">
              <Sparkle size={30} weight="duotone" aria-hidden="true" />
              <div><span>{PHASE_LABELS[selected.phase] || '正在生成报告'}</span><strong>{selected.topic}</strong><small>{selected.progress}% · 任务可离开页面后继续执行</small></div>
              <i><span style={{ width: `${selected.progress || 0}%` }} /></i>
            </section>
          ) : null}
          {selected?.status === 'failed' ? (
            <section className="qp-panel mih-topic-failed"><WarningCircle size={30} weight="duotone" aria-hidden="true" /><div><strong>专题报告生成失败</strong><p>{selected.error?.message || '请重新创建任务。'}</p></div></section>
          ) : null}
          {!selected && !loading ? (
            <EmptyState icon={Graph} title="从一个问题开始" description="输入主题，系统会从已同步记录中建立可核对的证据关联。" />
          ) : null}
        </section>
      </div>
    </div>
  )
}
