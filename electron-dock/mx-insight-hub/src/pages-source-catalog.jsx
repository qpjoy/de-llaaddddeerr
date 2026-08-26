import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import {
  Archive,
  ArrowRight,
  ArrowSquareOut,
  Books,
  ChartDonut,
  Check,
  CheckCircle,
  CirclesThree,
  ClipboardText,
  ClockCounterClockwise,
  Columns,
  Compass,
  Database,
  FileCsv,
  FloppyDisk,
  FlowArrow,
  FolderOpen,
  Funnel,
  Globe,
  Kanban,
  ListChecks,
  MagnifyingGlass,
  NotePencil,
  Path,
  Plus,
  Pulse,
  Rows,
  ShieldCheck,
  SortAscending,
  Stack,
  Tag,
  Trash,
  TreeStructure,
  UserCircle,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  PageHeading,
  Pagination,
  ReadinessGauge,
  StatusRing,
  formatDate,
  formatNumber,
  useRemoteData,
} from './components.jsx'

const COVERAGE_OPTIONS = [
  { value: 'unknown', label: '待核验' },
  { value: 'not_covered', label: '未覆盖' },
  { value: 'partial', label: '部分覆盖' },
  { value: 'covered', label: '已覆盖' },
]

const DELIVERY_OPTIONS = [
  { value: 'exploring', label: '探索中' },
  { value: 'planned', label: '已规划' },
  { value: 'doing', label: '进行中' },
  { value: 'blocked', label: '受阻' },
  { value: 'complete', label: '已完成' },
  { value: 'paused', label: '已暂停' },
  { value: 'retired', label: '已退役' },
]

const REVIEW_OPTIONS = [
  { value: 'needs_review', label: '待补充' },
  { value: 'verified', label: '已核验' },
  { value: 'rejected', label: '已驳回' },
]

const RUNTIME_OPTIONS = [
  { value: 'not_configured', label: '未配置' },
  { value: 'unknown', label: '未知' },
  { value: 'healthy', label: '健康' },
  { value: 'degraded', label: '降级' },
  { value: 'failed', label: '失败' },
]

const SOURCE_KIND_OPTIONS = [
  { value: 'platform', label: '平台' },
  { value: 'platform_module', label: '平台模块' },
  { value: 'source_class', label: '通用来源类型' },
  { value: 'registry', label: '登记/权威库' },
  { value: 'provider', label: '第三方数据服务' },
  { value: 'dataset', label: '数据集' },
  { value: 'other', label: '其他' },
]

const PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3'].map((value) => ({ value, label: value }))
const optionLabel = (options, value) => options.find((option) => option.value === value)?.label || value || '—'

const BUILTIN_VIEWS = [
  { id: 'all', label: '底表', icon: Rows, predicate: (item) => !item.archivedAt },
  { id: 'covered', label: '已覆盖', icon: CheckCircle, predicate: (item) => !item.archivedAt && item.coverageStatus === 'covered' },
  { id: 'uncovered', label: '未覆盖', icon: Compass, predicate: (item) => !item.archivedAt && item.coverageStatus === 'not_covered' },
  { id: 'in-progress', label: '进行中', icon: Pulse, predicate: (item) => !item.archivedAt && ['doing', 'exploring'].includes(item.deliveryStatus) },
  { id: 'p0', label: 'P0', icon: WarningCircle, predicate: (item) => !item.archivedAt && item.priority === 'P0' },
  { id: 'unassigned', label: '无负责人', icon: UserCircle, predicate: (item) => !item.archivedAt && !item.owner },
  { id: 'archived', label: '已归档', icon: Archive, predicate: (item) => Boolean(item.archivedAt) },
]

const SECTION_OPTIONS = [
  { id: 'overview', label: '数据源总览', icon: ChartDonut },
  { id: 'catalog', label: '多维数据表', icon: Rows },
  { id: 'taxonomy', label: '分类与字段', icon: TreeStructure },
  { id: 'plans', label: '计划与证据', icon: FlowArrow },
]

const EMPTY_FILTERS = Object.freeze({
  category: '',
  region: '',
  priority: '',
  coverage: '',
  delivery: '',
  owner: '',
})

function Panel({ title, subtitle, action, className = '', children }) {
  return (
    <section className={`qp-panel mih-panel ${className}`.trim()}>
      <header className="mih-panel__header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action ? <div className="mih-page-actions">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

function SelectField({ label, value, onChange, options, emptyLabel, disabled = false }) {
  return (
    <Field label={label}>
      <select className="qp-select" value={value ?? ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {emptyLabel ? <option value="">{emptyLabel}</option> : null}
        {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select>
    </Field>
  )
}

function CatalogBadge({ dimension, value }) {
  const labels = dimension === 'coverage'
    ? COVERAGE_OPTIONS
    : dimension === 'delivery'
      ? DELIVERY_OPTIONS
      : dimension === 'review'
        ? REVIEW_OPTIONS
        : RUNTIME_OPTIONS
  const Icon = ['covered', 'complete', 'verified', 'healthy'].includes(value)
    ? CheckCircle
    : ['blocked', 'failed', 'rejected'].includes(value)
      ? WarningCircle
      : dimension === 'delivery'
        ? Pulse
        : CirclesThree
  return (
    <span className={`mih-catalog-status mih-catalog-status--${value || 'unknown'}`}>
      <Icon size={13} weight="fill" aria-hidden="true" />
      {optionLabel(labels, value)}
    </span>
  )
}

function CatalogKpi({ icon: Icon, label, value, hint, tone = 'primary' }) {
  return (
    <article className={`mih-command-kpi mih-command-kpi--${tone}`}>
      <Icon size={18} weight="duotone" aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint || '当前目录'}</small>
    </article>
  )
}

function chartTheme() {
  const styles = getComputedStyle(document.documentElement)
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback
  return {
    primary: token('--qp-primary', '#2bf6d2'),
    success: token('--qp-success', '#48bc77'),
    warning: token('--qp-warning', '#f8d06c'),
    danger: token('--qp-danger', '#ee6067'),
    info: token('--qp-info', '#5e8eec'),
    archetype: token('--qp-archetype', '#b974ff'),
    text: token('--qp-text-2', 'rgba(226,226,226,.7)'),
    muted: token('--qp-text-3', 'rgba(226,226,226,.5)'),
    line: token('--qp-line', 'rgba(94,142,236,.18)'),
    panel: token('--qp-bg-4', '#292c37'),
  }
}

function useCatalogChart(buildConfig, signature) {
  const canvasRef = useRef(null)
  useEffect(() => {
    if (!canvasRef.current) return undefined
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const chart = new Chart(canvasRef.current, buildConfig(chartTheme(), reducedMotion))
    return () => chart.destroy()
  }, [buildConfig, signature])
  return canvasRef
}

function CategoryCoverageChart({ categories }) {
  const rows = useMemo(() => [...categories].sort((left, right) => right.total - left.total), [categories])
  const signature = rows.map((row) => `${row.category}:${row.covered}:${row.partial}:${row.total}`).join('|')
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'bar',
    data: {
      labels: rows.map((row) => row.category.replace('与', ' / ')),
      datasets: [
        { label: '已覆盖', data: rows.map((row) => row.covered), backgroundColor: theme.primary, borderRadius: 3, maxBarThickness: 16 },
        { label: '部分覆盖', data: rows.map((row) => row.partial), backgroundColor: theme.warning, borderRadius: 3, maxBarThickness: 16 },
        { label: '未覆盖', data: rows.map((row) => Math.max(0, row.total - row.covered - row.partial)), backgroundColor: theme.info, borderRadius: 3, maxBarThickness: 16 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion ? false : { duration: 220 },
      scales: {
        x: { stacked: true, beginAtZero: true, grid: { color: theme.line }, ticks: { color: theme.muted, precision: 0 } },
        y: { stacked: true, grid: { display: false }, ticks: { color: theme.text, font: { size: 10 } } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: theme.text, boxWidth: 9, boxHeight: 9, padding: 12 } },
        tooltip: { backgroundColor: theme.panel, titleColor: theme.text, bodyColor: theme.text },
      },
    },
  }), [rows])
  const ref = useCatalogChart(buildConfig, signature)
  return (
    <div className="mih-source-category-chart">
      <canvas ref={ref} role="img" aria-label={rows.map((row) => `${row.category} ${row.covered}/${row.total} 已覆盖`).join('，')} />
    </div>
  )
}

function DeliveryChart({ delivery }) {
  const rows = DELIVERY_OPTIONS
    .map((option) => ({ ...option, value: Number(delivery?.[option.value] || 0) }))
    .filter((row) => row.value > 0)
  const signature = rows.map((row) => `${row.value}:${row.label}`).join('|')
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'doughnut',
    data: {
      labels: rows.map((row) => row.label),
      datasets: [{
        data: rows.map((row) => row.value),
        backgroundColor: [theme.info, theme.archetype, theme.primary, theme.danger, theme.success, theme.warning, theme.muted],
        borderWidth: 0,
        spacing: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '67%',
      animation: reducedMotion ? false : { duration: 220 },
      plugins: {
        legend: { position: 'bottom', labels: { color: theme.text, boxWidth: 9, boxHeight: 9, padding: 12 } },
        tooltip: { backgroundColor: theme.panel, titleColor: theme.text, bodyColor: theme.text },
      },
    },
  }), [rows])
  const ref = useCatalogChart(buildConfig, signature)
  return (
    <div className="mih-source-delivery-chart">
      <canvas ref={ref} role="img" aria-label={rows.map((row) => `${row.label} ${row.value}`).join('，')} />
    </div>
  )
}

function SourceCatalogOverview({ snapshot, onOpenCatalog }) {
  const { items, summary } = snapshot
  const p0 = items.filter((item) => !item.archivedAt && item.priority === 'P0')
  const p0Covered = p0.filter((item) => item.coverageStatus === 'covered').length
  const p0CoverageRate = p0.length ? (p0Covered / p0.length) * 100 : 0
  const assignmentRate = summary.total ? ((summary.total - summary.unassigned) / summary.total) * 100 : 0
  const verified = Number(summary.review?.verified || 0)
  const verificationRate = summary.total ? (verified / summary.total) * 100 : 0
  const attention = [
    {
      tone: 'danger',
      icon: WarningCircle,
      title: `${formatNumber(p0.length - p0Covered)} 个 P0 尚未覆盖`,
      detail: '优先确认真实接入路径、授权边界与采集范围。',
      view: 'p0',
    },
    {
      tone: 'warning',
      icon: UserCircle,
      title: `${formatNumber(summary.unassigned)} 条目录没有负责人`,
      detail: '负责人字段与供应商/连接器严格分离，当前不会把 tikhub 等误识别为人员。',
      view: 'unassigned',
    },
    {
      tone: 'info',
      icon: ClipboardText,
      title: `${formatNumber(summary.review?.needs_review || 0)} 条等待字段核验`,
      detail: '模板能力不等于平台实测能力；需要逐能力补充证据。',
      view: 'all',
    },
  ]

  return (
    <>
      <section className="mih-command-overview mih-source-command-overview" aria-label="数据源覆盖指挥舱">
        <Panel title="目录覆盖率" subtitle="业务目录口径；不等同于运行健康" className="mih-command-readiness">
          <ReadinessGauge
            score={summary.coverageRate}
            label={`${formatNumber(summary.covered)} / ${formatNumber(summary.total)} 已覆盖`}
            delta={`${formatNumber(summary.uncovered)} 个尚未覆盖`}
          />
        </Panel>

        <Panel title="分类覆盖态势" subtitle="按一级分类展示已覆盖、部分覆盖与未覆盖" className="mih-command-traffic mih-source-category-panel">
          <CategoryCoverageChart categories={summary.categories || []} />
        </Panel>

        <Panel title="治理健康" subtitle="覆盖、负责人和核验是三条独立证据轴" className="mih-command-rings">
          <StatusRing label="P0 覆盖" value={p0CoverageRate} display={`${p0Covered}/${p0.length}`} hint="高优先级目录" tone="success" />
          <StatusRing label="负责人分配" value={assignmentRate} display={`${Math.round(assignmentRate)}%`} hint={`${summary.unassigned} 条待分配`} tone="info" />
          <StatusRing label="字段核验" value={verificationRate} display={`${verified}/${summary.total}`} hint="模板需人工确认" tone="archetype" />
        </Panel>
      </section>

      <section className="mih-command-kpi-rail mih-source-kpi-rail" aria-label="数据源目录核心指标">
        <CatalogKpi icon={Books} label="目录总数" value={formatNumber(summary.total)} hint="单一权威底表" tone="info" />
        <CatalogKpi icon={CheckCircle} label="已覆盖" value={formatNumber(summary.covered)} hint={`${summary.coverageRate}%`} tone="success" />
        <CatalogKpi icon={Compass} label="未覆盖" value={formatNumber(summary.uncovered)} hint="保存视图" tone="warning" />
        <CatalogKpi icon={Pulse} label="进行中" value={formatNumber(summary.inProgress)} hint="doing" tone="primary" />
        <CatalogKpi icon={MagnifyingGlass} label="探索中" value={formatNumber(summary.exploring)} hint="exploring" tone="info" />
        <CatalogKpi icon={ShieldCheck} label="已完成" value={formatNumber(summary.complete)} hint="有证据的 complete" tone="success" />
        <CatalogKpi icon={WarningCircle} label="受阻" value={formatNumber(summary.blocked)} hint="需处置" tone="danger" />
        <CatalogKpi icon={UserCircle} label="未分配" value={formatNumber(summary.unassigned)} hint="负责人为空" tone="archetype" />
      </section>

      <section className="mih-command-grid mih-source-command-grid">
        <Panel title="实施阶段分布" subtitle="覆盖度与交付阶段分开计算" className="mih-source-delivery-panel">
          <DeliveryChart delivery={summary.delivery} />
          <div className="mih-source-stage-note">
            <ShieldCheck size={18} weight="duotone" aria-hidden="true" />
            <span><strong>Telegram 已按真实任务与文档证据标记 complete</strong><small>运行失败只改变健康状态，不回滚项目完成阶段。</small></span>
          </div>
        </Panel>

        <Panel
          title="待办与风险"
          subtitle="由目录字段直接推导，不制造演示告警"
          className="mih-command-panel--risks mih-source-attention-panel"
          action={<button className="mih-command-link" type="button" onClick={() => onOpenCatalog('all')}>进入数据表<ArrowRight size={13} aria-hidden="true" /></button>}
        >
          <div className="mih-risk-list">
            {attention.map((risk) => {
              const Icon = risk.icon
              return (
                <button className={`mih-risk-item mih-risk-item--${risk.tone} mih-source-risk-button`} type="button" key={risk.title} onClick={() => onOpenCatalog(risk.view)}>
                  <span className="mih-risk-item__icon"><Icon size={17} weight="duotone" aria-hidden="true" /></span>
                  <span><strong>{risk.title}</strong><small>{risk.detail}</small></span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </Panel>

        <Panel
          title="一级分类矩阵"
          subtitle="目录规模、覆盖与实施状态"
          className="mih-command-panel--platforms mih-source-category-matrix"
          action={<button className="mih-command-link" type="button" onClick={() => onOpenCatalog('all')}>查看全部<ArrowRight size={13} aria-hidden="true" /></button>}
        >
          <div className="qp-data-table mih-table-wrap">
            <table className="mih-table" aria-label="数据源一级分类矩阵">
              <thead><tr><th>一级分类</th><th>目录</th><th>已覆盖</th><th>覆盖率</th><th>complete</th><th>doing</th></tr></thead>
              <tbody>
                {(summary.categories || []).map((row) => (
                  <tr key={row.category}>
                    <td><strong>{row.category}</strong></td>
                    <td>{formatNumber(row.total)}</td>
                    <td>{formatNumber(row.covered)}</td>
                    <td>{row.total ? `${((row.covered / row.total) * 100).toFixed(1)}%` : '0%'}</td>
                    <td>{formatNumber(row.complete)}</td>
                    <td>{formatNumber(row.doing)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>
    </>
  )
}

function TagInput({ label, values, onChange, suggestions = [], hint, placeholder = '输入后按回车新增' }) {
  const [draft, setDraft] = useState('')
  const listId = useMemo(() => `mih-tag-suggestions-${Math.random().toString(16).slice(2)}`, [])
  const add = () => {
    const next = draft.normalize('NFKC').trim()
    if (!next || values.includes(next)) {
      setDraft('')
      return
    }
    onChange([...values, next])
    setDraft('')
  }
  return (
    <Field label={label} hint={hint}>
      <div className="mih-tag-editor">
        {values.map((value) => (
          <span className="mih-tag-editor__tag" key={value}>
            {value}
            <button type="button" aria-label={`移除 ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          list={listId}
          placeholder={values.length ? '继续添加' : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              add()
            }
            if (event.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1))
          }}
        />
        <datalist id={listId}>{suggestions.filter((value) => !values.includes(value)).map((value) => <option value={value} key={value} />)}</datalist>
      </div>
    </Field>
  )
}

function textSearch(item, query) {
  if (!query) return true
  const haystack = [
    item.canonicalName,
    item.majorCategory,
    item.owner,
    item.notes,
    ...(item.aliases || []),
    ...(item.scenarios || []),
    ...(item.regions || []),
    ...(item.entryModules || []),
    ...(item.tags || []),
    ...(item.connectorHints || []),
  ].filter(Boolean).join('\n').toLocaleLowerCase('zh-CN')
  return haystack.includes(query.toLocaleLowerCase('zh-CN'))
}

function matchesFilters(item, filters) {
  return (!filters.category || item.majorCategory === filters.category)
    && (!filters.region || item.regions?.includes(filters.region))
    && (!filters.priority || item.priority === filters.priority)
    && (!filters.coverage || item.coverageStatus === filters.coverage)
    && (!filters.delivery || item.deliveryStatus === filters.delivery)
    && (!filters.owner || (filters.owner === '__unassigned' ? !item.owner : item.owner === filters.owner))
}

function compareCatalog(left, right, sortBy) {
  if (sortBy === 'name') return left.canonicalName.localeCompare(right.canonicalName, 'zh-CN')
  if (sortBy === 'priority') return left.priority.localeCompare(right.priority) || Number(left.legacySequence || 0) - Number(right.legacySequence || 0)
  if (sortBy === 'coverage') return left.coverageStatus.localeCompare(right.coverageStatus) || Number(left.legacySequence || 0) - Number(right.legacySequence || 0)
  if (sortBy === 'updated') return String(right.updatedAt).localeCompare(String(left.updatedAt))
  return Number(left.legacySequence || Number.MAX_SAFE_INTEGER) - Number(right.legacySequence || Number.MAX_SAFE_INTEGER)
}

function downloadCatalogCsv(items) {
  const headers = ['序号', '数据源/平台', '大类', '细分场景', '区域', '覆盖状态', '实施阶段', '优先级', '负责人', '接入线索', '备注']
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = items.map((item) => [
    item.legacySequence,
    item.canonicalName,
    item.majorCategory,
    item.scenarios?.join('、'),
    item.regions?.join('、'),
    optionLabel(COVERAGE_OPTIONS, item.coverageStatus),
    optionLabel(DELIVERY_OPTIONS, item.deliveryStatus),
    item.priority,
    item.owner,
    item.connectorHints?.join('、'),
    item.notes,
  ].map(escape).join(','))
  const blob = new Blob([`\ufeff${headers.map(escape).join(',')}\n${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `mx-insight-source-catalog-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function SourceCatalogTable({ snapshot, token, onUnauthorized, notify, onRefresh, requestedView, onRequestedViewHandled }) {
  const [viewId, setViewId] = useState(requestedView || 'all')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS })
  const [filterOpen, setFilterOpen] = useState(false)
  const [groupBy, setGroupBy] = useState('none')
  const [sortBy, setSortBy] = useState('sequence')
  const [density, setDensity] = useState('comfortable')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [bulkSaving, setBulkSaving] = useState(false)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [savedViews, setSavedViews] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('mx-insight-hub.source-catalog.views') || '[]')
    } catch {
      return []
    }
  })
  const pageSize = density === 'compact' ? 40 : density === 'spacious' ? 20 : 30

  useEffect(() => {
    if (!requestedView) return
    setViewId(requestedView)
    onRequestedViewHandled?.()
  }, [onRequestedViewHandled, requestedView])

  const selectView = (id) => {
    const custom = savedViews.find((view) => view.id === id)
    if (custom) {
      setFilters({ ...EMPTY_FILTERS, ...(custom.filters || {}) })
      setGroupBy(custom.groupBy || 'none')
      setSortBy(custom.sortBy || 'sequence')
      setDensity(custom.density || 'comfortable')
      setQuery(custom.query || '')
      setViewId('all')
    } else {
      setViewId(id)
      setFilters({ ...EMPTY_FILTERS })
    }
    setPage(1)
    setSelectedIds(new Set())
  }

  const baseView = BUILTIN_VIEWS.find((view) => view.id === viewId) || BUILTIN_VIEWS[0]
  const visible = useMemo(() => snapshot.items
    .filter(baseView.predicate)
    .filter((item) => textSearch(item, query.trim()))
    .filter((item) => matchesFilters(item, filters))
    .sort((left, right) => compareCatalog(left, right, sortBy)), [baseView, filters, query, snapshot.items, sortBy])
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageItems = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: null, items: pageItems }]
    const grouped = new Map()
    for (const item of pageItems) {
      const keys = groupBy === 'region' ? item.regions || ['未设置'] : [item[groupBy] || '未设置']
      for (const key of keys) grouped.set(key, [...(grouped.get(key) || []), item])
    }
    return [...grouped.entries()].map(([key, items]) => ({ key, items }))
  }, [groupBy, pageItems])
  const allPageSelected = pageItems.length > 0 && pageItems.every((item) => selectedIds.has(item.id))
  const selected = snapshot.items.filter((item) => selectedIds.has(item.id))
  const activeFilterCount = Object.values(filters).filter(Boolean).length

  useEffect(() => setPage(1), [density, filters, query, sortBy, viewId])

  const togglePage = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allPageSelected) pageItems.forEach((item) => next.delete(item.id))
      else pageItems.forEach((item) => next.add(item.id))
      return next
    })
  }

  const bulkUpdate = async (field, value) => {
    if (!selected.length) return
    setBulkSaving(true)
    try {
      await Promise.all(selected.map((item) => adminApi.updateSourceCatalogEntry(token, item.id, {
        revision: item.revision,
        [field]: value,
      })))
      notify?.(`已更新 ${selected.length} 条数据源`, 'success')
      setSelectedIds(new Set())
      onRefresh()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      notify?.(error?.message || '批量更新失败', 'warning')
    } finally {
      setBulkSaving(false)
    }
  }

  const saveCurrentView = (event) => {
    event.preventDefault()
    const name = viewName.trim()
    if (!name) return
    const next = [...savedViews, {
      id: `local-${Date.now()}`,
      name,
      filters,
      groupBy,
      sortBy,
      density,
      query,
    }]
    setSavedViews(next)
    localStorage.setItem('mx-insight-hub.source-catalog.views', JSON.stringify(next))
    setSaveViewOpen(false)
    setViewName('')
    notify?.('当前视图已保存到本浏览器', 'success')
  }

  return (
    <>
      <section className="qp-panel mih-source-table-shell">
        <nav className="mih-source-view-tabs" aria-label="数据源保存视图">
          {BUILTIN_VIEWS.map((view) => {
            const Icon = view.icon
            const count = snapshot.items.filter(view.predicate).length
            return (
              <button type="button" aria-pressed={viewId === view.id} key={view.id} onClick={() => selectView(view.id)}>
                <Icon size={15} aria-hidden="true" /><span>{view.label}</span><small>{count}</small>
              </button>
            )
          })}
          {savedViews.map((view) => (
            <button type="button" key={view.id} onClick={() => selectView(view.id)}>
              <FloppyDisk size={15} aria-hidden="true" /><span>{view.name}</span>
              <X size={12} aria-label={`删除视图 ${view.name}`} onClick={(event) => {
                event.stopPropagation()
                const next = savedViews.filter((item) => item.id !== view.id)
                setSavedViews(next)
                localStorage.setItem('mx-insight-hub.source-catalog.views', JSON.stringify(next))
              }} />
            </button>
          ))}
        </nav>

        <div className="mih-source-table-toolbar">
          <label className="mih-source-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input value={query} placeholder="搜索平台、分类、场景、备注…" onChange={(event) => setQuery(event.target.value)} />
            {query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={13} /></button> : null}
          </label>
          <button className={`qp-button qp-button--ghost qp-button--sm${filterOpen ? ' is-active' : ''}`} type="button" onClick={() => setFilterOpen((value) => !value)}>
            <Funnel size={16} aria-hidden="true" />筛选{activeFilterCount ? ` · ${activeFilterCount}` : ''}
          </button>
          <label className="mih-source-toolbar-select"><Columns size={16} aria-hidden="true" /><span>分组</span><select value={groupBy} onChange={(event) => setGroupBy(event.target.value)}><option value="none">不分组</option><option value="majorCategory">按大类</option><option value="deliveryStatus">按阶段</option><option value="region">按区域</option></select></label>
          <label className="mih-source-toolbar-select"><SortAscending size={16} aria-hidden="true" /><span>排序</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="sequence">序号</option><option value="name">名称</option><option value="priority">优先级</option><option value="coverage">覆盖状态</option><option value="updated">最近更新</option></select></label>
          <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => setDensity((value) => value === 'comfortable' ? 'compact' : value === 'compact' ? 'spacious' : 'comfortable')}>
            <Rows size={16} aria-hidden="true" />行高 · {density === 'compact' ? '紧凑' : density === 'spacious' ? '宽松' : '适中'}
          </button>
          <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => setSaveViewOpen(true)}><FloppyDisk size={16} aria-hidden="true" />保存视图</button>
          <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => downloadCatalogCsv(visible)}><FileCsv size={16} aria-hidden="true" />导出 {visible.length}</button>
          <button className="qp-button qp-button--primary qp-button--sm" type="button" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />新增数据源</button>
        </div>

        {filterOpen ? (
          <div className="mih-source-filter-panel">
            <SelectField label="一级分类" value={filters.category} emptyLabel="全部分类" options={snapshot.facets.majorCategories.map((value) => ({ value, label: value }))} onChange={(value) => setFilters({ ...filters, category: value })} />
            <SelectField label="区域" value={filters.region} emptyLabel="全部区域" options={snapshot.facets.regions.map((value) => ({ value, label: value }))} onChange={(value) => setFilters({ ...filters, region: value })} />
            <SelectField label="优先级" value={filters.priority} emptyLabel="全部优先级" options={PRIORITY_OPTIONS} onChange={(value) => setFilters({ ...filters, priority: value })} />
            <SelectField label="覆盖状态" value={filters.coverage} emptyLabel="全部状态" options={COVERAGE_OPTIONS} onChange={(value) => setFilters({ ...filters, coverage: value })} />
            <SelectField label="实施阶段" value={filters.delivery} emptyLabel="全部阶段" options={DELIVERY_OPTIONS} onChange={(value) => setFilters({ ...filters, delivery: value })} />
            <SelectField label="负责人" value={filters.owner} emptyLabel="全部负责人" options={[{ value: '__unassigned', label: '未分配' }, ...snapshot.facets.owners.map((value) => ({ value, label: value }))]} onChange={(value) => setFilters({ ...filters, owner: value })} />
            <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={!activeFilterCount} onClick={() => setFilters({ ...EMPTY_FILTERS })}><X size={14} aria-hidden="true" />清空筛选</button>
          </div>
        ) : null}

        {selected.length ? (
          <div className="mih-source-bulk-bar" role="region" aria-label="批量操作">
            <strong>已选 {selected.length} 条</strong>
            <span />
            <label>覆盖状态<select disabled={bulkSaving} defaultValue="" onChange={(event) => { if (event.target.value) bulkUpdate('coverageStatus', event.target.value); event.target.value = '' }}><option value="">批量设置</option>{COVERAGE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            <label>实施阶段<select disabled={bulkSaving} defaultValue="" onChange={(event) => { if (event.target.value) bulkUpdate('deliveryStatus', event.target.value); event.target.value = '' }}><option value="">批量设置</option>{DELIVERY_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            <button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => setSelectedIds(new Set())}>取消选择</button>
          </div>
        ) : null}

        <div className={`qp-data-table mih-table-wrap mih-source-grid mih-source-grid--${density}`}>
          <table className="mih-table" aria-label={`${baseView.label}数据源目录`}>
            <thead>
              <tr>
                <th className="mih-source-check"><input type="checkbox" aria-label="选择当前页" checked={allPageSelected} onChange={togglePage} /></th>
                <th>#</th><th>数据源 / 平台</th><th>大类</th><th>细分场景</th><th>区域</th><th>覆盖</th><th>实施阶段</th><th>优先级</th><th>负责人</th><th>接入线索</th><th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((group) => [
                group.key ? <tr className="mih-source-group-row" key={`group-${group.key}`}><td colSpan="12"><TreeStructure size={14} aria-hidden="true" /><strong>{group.key}</strong><span>{group.items.length} 条</span></td></tr> : null,
                ...group.items.map((item) => (
                  <tr className={item.archivedAt ? 'is-archived' : ''} key={item.id}>
                    <td className="mih-source-check"><input type="checkbox" aria-label={`选择 ${item.canonicalName}`} checked={selectedIds.has(item.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} /></td>
                    <td>{item.legacySequence || '—'}</td>
                    <td><button className="mih-source-name" type="button" onClick={() => setEditing(item)}><strong>{item.canonicalName}</strong><small>{optionLabel(SOURCE_KIND_OPTIONS, item.sourceKind)} · rev {item.revision}</small></button></td>
                    <td><span className="mih-source-cell-tag">{item.majorCategory}</span></td>
                    <td><div className="mih-source-cell-tags">{item.scenarios?.slice(0, 2).map((value) => <span key={value}>{value}</span>)}{item.scenarios?.length > 2 ? <small>+{item.scenarios.length - 2}</small> : null}</div></td>
                    <td><div className="mih-source-cell-tags">{item.regions?.map((value) => <span key={value}>{value}</span>)}</div></td>
                    <td><CatalogBadge dimension="coverage" value={item.coverageStatus} /></td>
                    <td><CatalogBadge dimension="delivery" value={item.deliveryStatus} /></td>
                    <td><span className={`mih-source-priority mih-source-priority--${item.priority.toLowerCase()}`}>{item.priority}</span></td>
                    <td>{item.owner ? <span className="mih-source-owner"><UserCircle size={15} aria-hidden="true" />{item.owner}</span> : <button className="mih-source-unassigned" type="button" onClick={() => setEditing(item)}>待分配</button>}</td>
                    <td><div className="mih-source-cell-tags">{item.connectorHints?.slice(0, 2).map((value) => <span key={value}>{value}</span>)}{!item.connectorHints?.length ? <small>—</small> : null}</div></td>
                    <td><button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`编辑 ${item.canonicalName}`} onClick={() => setEditing(item)}><NotePencil size={16} aria-hidden="true" /></button></td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
          {visible.length === 0 ? <EmptyState icon={MagnifyingGlass} title="没有符合当前视图的数据源" description="清空筛选或切换保存视图后重试。" /> : null}
        </div>

        <Pagination page={currentPage} pageSize={pageSize} total={visible.length} totalPages={totalPages} hasMore={currentPage < totalPages} onPageChange={setPage} label="数据源目录分页" />
      </section>

      {creating ? <CatalogEntryModal token={token} facets={snapshot.facets} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setCreating(false)} onChanged={() => { setCreating(false); onRefresh() }} /> : null}
      {editing ? <CatalogEntryModal token={token} entry={editing} facets={snapshot.facets} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); onRefresh() }} /> : null}
      {saveViewOpen ? (
        <Modal title="保存当前视图" description="保存筛选、分组、排序和行高；当前版本仅保存在此浏览器。" onClose={() => setSaveViewOpen(false)} footer={<><button className="qp-button qp-button--ghost" type="button" onClick={() => setSaveViewOpen(false)}>取消</button><button className="qp-button qp-button--primary" type="submit" form="save-source-view" disabled={!viewName.trim()}><FloppyDisk size={16} aria-hidden="true" />保存</button></>}>
          <form id="save-source-view" className="mih-form" onSubmit={saveCurrentView}><Field label="视图名称"><input className="qp-input" value={viewName} autoFocus onChange={(event) => setViewName(event.target.value)} placeholder="例如：P0 海外数据源" /></Field></form>
        </Modal>
      ) : null}
    </>
  )
}

function emptyForm(entry) {
  return {
    canonicalName: entry?.canonicalName || '',
    aliases: entry?.aliases || [],
    sourceKind: entry?.sourceKind || 'platform',
    majorCategory: entry?.majorCategory || '',
    scenarios: entry?.scenarios || [],
    regions: entry?.regions || [],
    entryModules: entry?.entryModules || [],
    monitorableContent: entry?.monitorableContent || [],
    extractableClues: entry?.extractableClues || [],
    trackingFields: entry?.trackingFields || [],
    suggestedAccess: entry?.suggestedAccess || [],
    complianceBoundary: entry?.complianceBoundary || '',
    priority: entry?.priority || 'P2',
    coverageStatus: entry?.coverageStatus || 'unknown',
    deliveryStatus: entry?.deliveryStatus || 'exploring',
    reviewStatus: entry?.reviewStatus || 'needs_review',
    runtimeStatus: entry?.runtimeStatus || 'not_configured',
    owner: entry?.owner || '',
    connectorHints: entry?.connectorHints || [],
    notes: entry?.notes || '',
    tags: entry?.tags || [],
    evidenceRefs: entry?.evidenceRefs || [],
    customFields: entry?.customFields || {},
  }
}

function CatalogEntryModal({ token, entry = null, facets, onUnauthorized, notify, onClose, onChanged }) {
  const [tab, setTab] = useState('profile')
  const [form, setForm] = useState(() => emptyForm(entry))
  const [events, setEvents] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [confirmArchive, setConfirmArchive] = useState(false)

  useEffect(() => {
    if (!entry || tab !== 'history' || events) return
    adminApi.sourceCatalogEvents(token, entry.id)
      .then(setEvents)
      .catch((requestError) => {
        if (requestError?.status === 401) onUnauthorized?.(requestError)
        setError(requestError)
      })
  }, [entry, events, onUnauthorized, tab, token])

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const save = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = {
        ...form,
        owner: form.owner.trim() || null,
        complianceBoundary: form.complianceBoundary.trim() || null,
        notes: form.notes.trim() || null,
      }
      if (entry) await adminApi.updateSourceCatalogEntry(token, entry.id, { ...payload, revision: entry.revision })
      else await adminApi.createSourceCatalogEntry(token, payload)
      notify?.(entry ? '数据源目录已更新' : '数据源目录已创建', 'success')
      onChanged()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally {
      setSaving(false)
    }
  }

  const archive = async () => {
    if (!entry) return
    if (!confirmArchive) {
      setConfirmArchive(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (entry.archivedAt) await adminApi.restoreSourceCatalogEntry(token, entry.id, entry.revision)
      else await adminApi.archiveSourceCatalogEntry(token, entry.id, entry.revision)
      notify?.(entry.archivedAt ? '数据源已恢复' : '数据源已归档，可从归档视图恢复', 'success')
      onChanged()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally {
      setSaving(false)
    }
  }

  const tabs = [
    { id: 'profile', label: '目录信息', icon: Books },
    { id: 'capabilities', label: '能力与字段', icon: ListChecks },
    { id: 'governance', label: '状态与合规', icon: ShieldCheck },
    { id: 'evidence', label: '接入与证据', icon: Path },
    ...(entry ? [{ id: 'history', label: '变更记录', icon: ClockCounterClockwise }] : []),
  ]

  return (
    <Modal
      size="xlarge"
      title={entry ? `编辑 · ${entry.canonicalName}` : '新增数据源'}
      description={entry ? `稳定标识 ${entry.sourceKey} · revision ${entry.revision}` : '先登记业务目录，再建立获取与清洗计划；目录中不保存连接密码。'}
      onClose={onClose}
      footer={(
        <>
          <span>
            {entry ? <button className={`qp-button ${confirmArchive ? 'qp-button--danger' : 'qp-button--ghost'}`} type="button" disabled={saving} onClick={archive}>{entry.archivedAt ? <Check size={16} /> : <Archive size={16} />}{entry.archivedAt ? (confirmArchive ? '确认恢复' : '恢复') : (confirmArchive ? '确认归档' : '归档')}</button> : null}
          </span>
          <span className="mih-page-actions"><button className="qp-button qp-button--ghost" type="button" onClick={onClose}>取消</button><button className="qp-button qp-button--primary" type="submit" form="source-catalog-entry-form" disabled={saving || tab === 'history'}><FloppyDisk size={16} aria-hidden="true" />{saving ? '正在保存' : '保存'}</button></span>
        </>
      )}
    >
      <nav className="mih-source-editor-tabs" aria-label="数据源编辑分区">
        {tabs.map((item) => { const Icon = item.icon; return <button type="button" aria-pressed={tab === item.id} key={item.id} onClick={() => { setTab(item.id); setConfirmArchive(false) }}><Icon size={15} aria-hidden="true" />{item.label}</button> })}
      </nav>
      {error ? <ErrorState error={error} /> : null}
      <form id="source-catalog-entry-form" className="mih-source-editor" onSubmit={save}>
        {tab === 'profile' ? (
          <section className="mih-source-editor-section">
            <div className="mih-source-editor-grid">
              <Field label="数据源 / 平台名称"><input className="qp-input" required autoFocus value={form.canonicalName} onChange={(event) => update('canonicalName', event.target.value)} /></Field>
              <SelectField label="来源类型" value={form.sourceKind} options={SOURCE_KIND_OPTIONS} onChange={(value) => update('sourceKind', value)} />
              <Field label="一级分类"><input className="qp-input" required list="mih-source-categories" value={form.majorCategory} onChange={(event) => update('majorCategory', event.target.value)} /><datalist id="mih-source-categories">{facets.majorCategories.map((value) => <option value={value} key={value} />)}</datalist></Field>
              <SelectField label="优先级" value={form.priority} options={PRIORITY_OPTIONS} onChange={(value) => update('priority', value)} />
            </div>
            <TagInput label="别名" values={form.aliases} onChange={(value) => update('aliases', value)} />
            <TagInput label="细分场景" values={form.scenarios} onChange={(value) => update('scenarios', value)} suggestions={facets.scenarios} hint="可输入后回车新增；支持一个平台属于多个 use case。" />
            <TagInput label="区域" values={form.regions} onChange={(value) => update('regions', value)} suggestions={facets.regions} hint="区域为多选，避免把全球/中国大陆长期塞成一个枚举。" />
            <TagInput label="自由标签" values={form.tags} onChange={(value) => update('tags', value)} suggestions={facets.tags} />
          </section>
        ) : null}

        {tab === 'capabilities' ? (
          <section className="mih-source-editor-section">
            <p className="mih-source-editor-callout"><WarningCircle size={17} aria-hidden="true" /><span>“可监测内容”等初始值来自分类模板，不等于该平台已经实测覆盖；完成验证后再把核验状态改为“已核验”。</span></p>
            <TagInput label="代表入口 / 模块" values={form.entryModules} onChange={(value) => update('entryModules', value)} />
            <TagInput label="可监测内容" values={form.monitorableContent} onChange={(value) => update('monitorableContent', value)} />
            <TagInput label="可提取线索" values={form.extractableClues} onChange={(value) => update('extractableClues', value)} />
            <TagInput label="主体追踪字段" values={form.trackingFields} onChange={(value) => update('trackingFields', value)} />
            <TagInput label="建议接入方式" values={form.suggestedAccess} onChange={(value) => update('suggestedAccess', value)} />
          </section>
        ) : null}

        {tab === 'governance' ? (
          <section className="mih-source-editor-section">
            <div className="mih-source-editor-grid">
              <SelectField label="覆盖状态" value={form.coverageStatus} options={COVERAGE_OPTIONS} onChange={(value) => update('coverageStatus', value)} />
              <SelectField label="实施阶段" value={form.deliveryStatus} options={DELIVERY_OPTIONS} onChange={(value) => update('deliveryStatus', value)} />
              <SelectField label="字段核验" value={form.reviewStatus} options={REVIEW_OPTIONS} onChange={(value) => update('reviewStatus', value)} />
              <SelectField label="运行健康" value={form.runtimeStatus} options={RUNTIME_OPTIONS} onChange={(value) => update('runtimeStatus', value)} />
              <Field label="负责人" hint="负责人是人员或团队，不是 tikhub / justone 等接入供应商。"><input className="qp-input" value={form.owner} onChange={(event) => update('owner', event.target.value)} placeholder="尚未分配" /></Field>
            </div>
            <Field label="合规边界"><textarea className="qp-textarea" rows="5" value={form.complianceBoundary} onChange={(event) => update('complianceBoundary', event.target.value)} /></Field>
            <Field label="备注 / 待补充"><textarea className="qp-textarea" rows="4" value={form.notes} onChange={(event) => update('notes', event.target.value)} /></Field>
          </section>
        ) : null}

        {tab === 'evidence' ? (
          <section className="mih-source-editor-section">
            <TagInput label="接入线索 / Connector" values={form.connectorHints} onChange={(value) => update('connectorHints', value)} suggestions={facets.connectorHints} hint="仅保存 provider 或方式线索，不保存 URL 凭证、密码或 token。" />
            <div className="mih-source-evidence-list">
              <h3>关联证据</h3>
              {form.evidenceRefs.length ? form.evidenceRefs.map((reference) => (
                <article key={`${reference.type}-${reference.key}`}>
                  <span><ClipboardText size={17} weight="duotone" aria-hidden="true" /></span>
                  <div><strong>{reference.label || reference.key}</strong><small>{reference.type} · {reference.key}</small></div>
                </article>
              )) : <EmptyState icon={ClipboardText} title="尚未绑定实施证据" description="后续可绑定计划、数据集、pipeline 与文档；连接凭证永远不进入目录。" />}
            </div>
            <p className="mih-source-editor-callout"><ShieldCheck size={17} aria-hidden="true" /><span>连接地址、凭据引用、存储桶和 mapping 版本属于“获取/清洗计划”；目录只记录业务归属与安全资源引用。</span></p>
          </section>
        ) : null}

        {tab === 'history' ? (
          <section className="mih-source-editor-section">
            {events ? (
              <div className="mih-source-history">
                {events.length ? events.map((event) => (
                  <article key={event.id}>
                    <span className={`mih-source-history__icon mih-source-history__icon--${event.eventType}`}><ClockCounterClockwise size={16} aria-hidden="true" /></span>
                    <div><strong>{event.eventType === 'create' ? '创建目录' : event.eventType === 'seed_import' ? '基线导入' : event.eventType === 'archive' ? '归档' : event.eventType === 'restore' ? '恢复' : '修改目录'}</strong><p>{event.actor} · revision {event.fromRevision ?? '—'} → {event.toRevision}</p></div>
                    <time>{formatDate(event.createdAt)}</time>
                  </article>
                )) : <EmptyState icon={ClockCounterClockwise} title="还没有变更记录" />}
              </div>
            ) : <LoadingState label="正在加载变更记录" />}
          </section>
        ) : null}
      </form>
    </Modal>
  )
}

function TaxonomyPage({ snapshot, onEdit }) {
  const categoryItems = snapshot.summary.categories || []
  return (
    <section className="mih-source-taxonomy">
      <div className="mih-source-taxonomy-grid">
        {categoryItems.map((category) => (
          <button className="qp-panel mih-source-taxonomy-card" type="button" key={category.category} onClick={() => onEdit(category.category)}>
            <span><TreeStructure size={18} weight="duotone" aria-hidden="true" /></span>
            <div><strong>{category.category}</strong><small>{category.total} 条目录 · {category.covered} 条已覆盖</small></div>
            <em>{category.total ? `${((category.covered / category.total) * 100).toFixed(1)}%` : '0%'}</em>
          </button>
        ))}
      </div>
      <div className="mih-source-taxonomy-panels">
        <Panel title="字段字典" subtitle="关键治理字段保持强类型，自由标签用于补充而非替代">
          <dl className="mih-source-dictionary">
            <div><dt>coverage_status</dt><dd>{COVERAGE_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>回答“能力是否覆盖”</small></div>
            <div><dt>delivery_status</dt><dd>{DELIVERY_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>回答“项目推进到哪里”</small></div>
            <div><dt>review_status</dt><dd>{REVIEW_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>回答“模板字段是否被核验”</small></div>
            <div><dt>runtime_status</dt><dd>{RUNTIME_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>回答“当前链路是否健康”</small></div>
          </dl>
        </Panel>
        <Panel title="分类治理提醒" subtitle="当前细分场景混合了业务能力、渠道形态和获取条件">
          <div className="mih-source-governance-notes">
            <article><Tag size={18} aria-hidden="true" /><div><strong>{snapshot.facets.scenarios.length} 个场景标签</strong><p>允许多选与回车新增；后续拆为 use case、channel type 与 access scope。</p></div></article>
            <article><Globe size={18} aria-hidden="true" /><div><strong>{snapshot.facets.regions.length} 个区域值</strong><p>区域使用多选关系，跨境属性单独治理，不依赖斜杠拼接字符串。</p></div></article>
            <article><ShieldCheck size={18} aria-hidden="true" /><div><strong>分类模板与平台验证分层</strong><p>模板提供默认能力；source override 与 evidence 才能证明平台实际覆盖。</p></div></article>
          </div>
        </Panel>
      </div>
    </section>
  )
}

function PlansPage({ snapshot }) {
  const evidenceEntries = snapshot.items.filter((item) => item.evidenceRefs?.length && !item.archivedAt)
  const planTypes = [
    { icon: Compass, title: '获取计划', description: '来源、连接/凭据引用、采集范围、周期、合规与预算。' },
    { icon: ListChecks, title: '清洗计划', description: '输入数据集、不可变 mapping、去重、脱敏、质量与目标 schema。' },
    { icon: Archive, title: '归档计划', description: 'raw 快照、对象存储引用、保留策略、backfill 与发布版本。' },
    { icon: Kanban, title: 'Plan Run', description: '绑定输入快照、规则/Agent 版本、计数、checkpoint 与投影证据。' },
  ]
  return (
    <section className="mih-source-plans">
      <div className="mih-source-plan-types">
        {planTypes.map((plan) => { const Icon = plan.icon; return <article className="qp-panel" key={plan.title}><span><Icon size={20} weight="duotone" aria-hidden="true" /></span><div><strong>{plan.title}</strong><p>{plan.description}</p></div></article> })}
      </div>
      <div className="mih-source-taxonomy-panels">
        <Panel
          title="已绑定实施证据"
          subtitle="complete 必须能回到任务、数据集或文档"
          action={<a className="mih-command-link" href="#/sources">打开数据清洗计划<ArrowSquareOut size={13} aria-hidden="true" /></a>}
        >
          {evidenceEntries.length ? (
            <div className="mih-source-plan-evidence">
              {evidenceEntries.map((item) => (
                <article key={item.id}>
                  <span><Database size={18} weight="duotone" aria-hidden="true" /></span>
                  <div><strong>{item.canonicalName}</strong><small>{item.evidenceRefs.map((reference) => reference.label || reference.key).join(' · ')}</small></div>
                  <CatalogBadge dimension="delivery" value={item.deliveryStatus} />
                </article>
              ))}
            </div>
          ) : <EmptyState icon={ClipboardText} title="尚未绑定实施证据" description="从数据源目录选择记录，再关联接入、清洗、数据集与文档。" />}
        </Panel>
        <Panel title="权威存储边界" subtitle="避免 PG 与 ES 双写产生两份业务真相">
          <div className="mih-source-authority-flow" aria-label="PostgreSQL 权威数据通过 outbox 投影到 Elasticsearch">
            <article><Database size={22} weight="duotone" aria-hidden="true" /><strong>PostgreSQL</strong><small>目录、分类、状态、计划、审计</small></article>
            <ArrowRight size={19} aria-hidden="true" />
            <article><FlowArrow size={22} weight="duotone" aria-hidden="true" /><strong>Outbox / Projector</strong><small>幂等、可观察、可重放</small></article>
            <ArrowRight size={19} aria-hidden="true" />
            <article><MagnifyingGlass size={22} weight="duotone" aria-hidden="true" /><strong>Elasticsearch</strong><small>可选全文与 facet 投影</small></article>
          </div>
          <p className="mih-source-editor-callout"><ShieldCheck size={17} aria-hidden="true" /><span>当前 215 条目录直接由 PG 聚合即可；ES 失效时只降级搜索，不改变目录事实。</span></p>
        </Panel>
      </div>
    </section>
  )
}

export function SourceCatalogPage({ token, query, setQuery, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.sourceCatalog(token, { includeArchived: true }), [token])
  const state = useRemoteData(load, onUnauthorized)
  const section = query.get('section') || 'overview'
  const requestedView = query.get('catalogView') || ''
  const [catalogViewRequest, setCatalogViewRequest] = useState(requestedView)

  useEffect(() => setCatalogViewRequest(requestedView), [requestedView])

  if (state.loading && !state.data) return <LoadingState label="正在汇总数据源目录" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const snapshot = state.data || { items: [], summary: {}, facets: { majorCategories: [], scenarios: [], regions: [], owners: [], connectorHints: [], tags: [] } }
  const heading = section === 'catalog'
    ? { eyebrow: 'CATALOG / MULTI-DIMENSIONAL / GOVERNANCE', title: '多维数据源目录', description: '同一底表上的保存视图、筛选、分组、批量状态、编辑、归档与导出。' }
    : section === 'taxonomy'
      ? { eyebrow: 'TAXONOMY / FIELDS / OVERRIDES', title: '分类与字段治理', description: '把大类、场景、区域、能力模板与平台实测证据拆开治理。' }
      : section === 'plans'
        ? { eyebrow: 'ACQUIRE / CLEAN / ARCHIVE / PUBLISH', title: '计划与实施证据', description: '目录说明“做什么”，计划说明“怎么做”，Agent 只是可审核的受控步骤。' }
        : { eyebrow: 'SOURCE CATALOG / COVERAGE / EVIDENCE', title: '数据源覆盖总览', description: '基于 215 条权威目录观察覆盖、优先级、实施阶段、负责人和字段核验。' }

  const openCatalog = (view = 'all') => {
    setCatalogViewRequest(view)
    setQuery({ section: 'catalog', catalogView: view })
  }

  return (
    <>
      <PageHeading className="mih-command-heading" {...heading} loading={state.loading} onRefresh={state.refresh}>
        {section !== 'catalog' ? <button className="qp-button qp-button--primary qp-button--sm" type="button" onClick={() => openCatalog('all')}><Rows size={16} aria-hidden="true" />进入数据表</button> : null}
      </PageHeading>

      <nav className="mih-source-section-tabs" aria-label="数据源系统菜单">
        {SECTION_OPTIONS.map((item) => { const Icon = item.icon; return <button type="button" aria-pressed={section === item.id} key={item.id} onClick={() => setQuery({ section: item.id, catalogView: item.id === 'catalog' ? (requestedView || 'all') : null })}><Icon size={16} weight={section === item.id ? 'duotone' : 'regular'} aria-hidden="true" /><span>{item.label}</span></button> })}
      </nav>

      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {section === 'overview' ? <SourceCatalogOverview snapshot={snapshot} onOpenCatalog={openCatalog} /> : null}
      {section === 'catalog' ? <SourceCatalogTable snapshot={snapshot} token={token} onUnauthorized={onUnauthorized} notify={notify} onRefresh={state.refresh} requestedView={catalogViewRequest} onRequestedViewHandled={() => setCatalogViewRequest('')} /> : null}
      {section === 'taxonomy' ? <TaxonomyPage snapshot={snapshot} onEdit={() => openCatalog('all')} /> : null}
      {section === 'plans' ? <PlansPage snapshot={snapshot} /> : null}

      <footer className="mih-command-footer" aria-label="数据源目录状态">
        <span>权威来源：PostgreSQL</span>
        <span><i className="is-live" aria-hidden="true" />种子批次：Feishu catalog v1</span>
        <span>最后更新：{snapshot.items.reduce((latest, item) => String(item.updatedAt) > latest ? String(item.updatedAt) : latest, '') ? formatDate(snapshot.items.reduce((latest, item) => String(item.updatedAt) > latest ? String(item.updatedAt) : latest, '')) : '—'}</span>
        <span>ES：可选、可重建投影</span>
      </footer>
    </>
  )
}
