import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import {
  Archive,
  ArrowRight,
  ArrowSquareOut,
  Books,
  CaretDown,
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
const TAXONOMY_KINDS = [
  { value: 'major_category', label: '大类', singular: '大类', description: '每个平台的主业务归属，用于稳定汇报。' },
  { value: 'scenario', label: '细分场景', singular: '场景', description: '一个平台可关联多个 use case。' },
  { value: 'region', label: '区域', singular: '区域', description: '多选覆盖范围，不与数据驻留或合规区域混用。' },
]
const OWNER_KIND = { value: 'owner', label: '负责人', singular: '负责人', description: '独立维护的人员或团队；后续可选择关联登录账号，目前不依赖账号系统。' }
const GOVERNANCE_KINDS = [...TAXONOMY_KINDS, OWNER_KIND]

const BUILTIN_VIEWS = [
  { id: 'all', label: '底表', icon: Rows, predicate: (item) => !item.archivedAt },
  { id: 'covered', label: '已覆盖', icon: CheckCircle, predicate: (item) => !item.archivedAt && item.coverageStatus === 'covered' },
  { id: 'uncovered', label: '未覆盖', icon: Compass, predicate: (item) => !item.archivedAt && item.coverageStatus === 'not_covered' },
  { id: 'in-progress', label: '进行中', icon: Pulse, predicate: (item) => !item.archivedAt && ['doing', 'exploring'].includes(item.deliveryStatus) },
  { id: 'p0', label: 'P0', icon: WarningCircle, predicate: (item) => !item.archivedAt && item.priority === 'P0' },
  { id: 'unassigned', label: '无负责人', icon: UserCircle, predicate: (item) => !item.archivedAt && !item.owner },
  { id: 'archived', label: '已归档', icon: Archive, predicate: (item) => Boolean(item.archivedAt) },
]
const REFERENCE_VIEW = { id: 'references', label: '治理引用', icon: TreeStructure, predicate: () => true }

const SECTION_OPTIONS = [
  { id: 'overview', label: '数据源总览', icon: ChartDonut },
  { id: 'catalog', label: '多维数据表', icon: Rows },
  { id: 'taxonomy', label: '分类与字段', icon: TreeStructure },
  { id: 'plans', label: '计划与证据', icon: FlowArrow },
]

const EMPTY_FILTERS = Object.freeze({
  category: '',
  scenario: '',
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
  const normalizedOptions = emptyLabel ? [{ value: '', label: emptyLabel }, ...options] : options
  return <SearchableSelect label={label} value={value ?? ''} disabled={disabled} options={normalizedOptions} onChange={onChange} />
}

function SearchableSelect({ label, value, onChange, options = [], placeholder = '请选择', disabled = false, className = '', leadingIcon: LeadingIcon = null }) {
  const labelId = useId()
  const triggerId = useId()
  const searchId = useId()
  const listboxId = useId()
  const rootRef = useRef(null)
  const anchorRef = useRef(null)
  const searchRef = useRef(null)
  const optionRefs = useRef([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const normalizedQuery = normalizeDraft(query).toLocaleLowerCase('zh-CN')
  const selected = options.find((option) => option.value === value)
  const visibleOptions = useMemo(() => options.filter((option) => {
    if (!normalizedQuery) return true
    return normalizeDraft([option.label, option.value, option.description]
      .filter(Boolean)
      .join('\n'))
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery)
  }), [normalizedQuery, options])
  const firstEnabledIndex = Math.max(0, visibleOptions.findIndex((option) => !option.disabled))
  const openUpward = useUpwardMenu(open, anchorRef, visibleOptions.length, 48)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex)
    window.requestAnimationFrame(() => searchRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (open) setHighlightedIndex(firstEnabledIndex)
  }, [firstEnabledIndex, normalizedQuery])

  useEffect(() => {
    if (open) optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, open])

  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const choose = (option) => {
    if (!option || option.disabled) return
    onChange(option.value)
    close()
    window.requestAnimationFrame(() => document.getElementById(triggerId)?.focus())
  }
  const move = (delta) => {
    if (!visibleOptions.length) return
    setHighlightedIndex((current) => {
      let next = current
      for (let offset = 0; offset < visibleOptions.length; offset += 1) {
        next = (next + delta + visibleOptions.length) % visibleOptions.length
        if (!visibleOptions[next]?.disabled) return next
      }
      return current
    })
  }
  const onMenuKeyDown = (event) => {
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' && visibleOptions.length) {
      event.preventDefault()
      choose(visibleOptions[highlightedIndex] || visibleOptions[firstEnabledIndex])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
      document.getElementById(triggerId)?.focus()
    }
  }

  return (
    <div
      ref={rootRef}
      className={`qp-field mih-search-select ${className}`.trim()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close()
      }}
    >
      <span className={`qp-field__label mih-search-select__label${LeadingIcon ? ' mih-sr-only' : ''}`} id={labelId}>{label}</span>
      <div className="mih-search-select__anchor" ref={anchorRef}>
        <button
          className={`mih-search-select__trigger${open ? ' is-open' : ''}`}
          id={triggerId}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-labelledby={`${labelId} ${triggerId}`}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (!open) setOpen(true)
              else move(event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'Escape' && open) {
              event.preventDefault()
              close()
            }
          }}
        >
          {LeadingIcon ? <LeadingIcon size={16} aria-hidden="true" /> : null}
          {LeadingIcon ? <span className="mih-search-select__inline-label">{label}</span> : null}
          <span className={`mih-search-select__value${selected ? '' : ' is-placeholder'}`}>{selected?.label ?? (value || placeholder)}</span>
          <CaretDown className="mih-search-select__chevron" size={14} aria-hidden="true" />
        </button>
        {open ? (
          <div className={`mih-search-select__menu${openUpward ? ' is-upward' : ''}`}>
            <label className="mih-search-select__search" htmlFor={searchId}>
              <MagnifyingGlass size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                id={searchId}
                role="combobox"
                value={query}
                placeholder={`搜索${label}`}
                aria-label={`搜索${label}选项`}
                aria-autocomplete="list"
                aria-expanded="true"
                aria-haspopup="listbox"
                aria-controls={listboxId}
                aria-activedescendant={visibleOptions.length ? `${listboxId}-option-${highlightedIndex}` : undefined}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onMenuKeyDown}
              />
              {query ? <button type="button" aria-label={`清空${label}搜索`} onClick={() => setQuery('')}><X size={12} aria-hidden="true" /></button> : null}
            </label>
            <div className="mih-search-select__options" id={listboxId} role="listbox" aria-labelledby={labelId}>
              {visibleOptions.map((option, index) => (
                <button
                  ref={(node) => { optionRefs.current[index] = node }}
                  className={`mih-combobox-option${index === highlightedIndex ? ' is-highlighted' : ''}${option.value === value ? ' is-selected' : ''}`}
                  id={`${listboxId}-option-${index}`}
                  key={`${option.value}-${option.label}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => { if (!option.disabled) setHighlightedIndex(index) }}
                  onClick={() => choose(option)}
                >
                  <Check className="mih-combobox-option__check" size={13} weight="bold" aria-hidden="true" />
                  <span>{option.label}</span>
                </button>
              ))}
              {!visibleOptions.length ? <p className="mih-search-select__empty">没有匹配项</p> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function CatalogBadge({ dimension, value, onClick = null, ariaLabel = null }) {
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
  const content = (
    <>
      <Icon size={13} weight="fill" aria-hidden="true" />
      {optionLabel(labels, value)}
    </>
  )
  const className = `mih-catalog-status mih-catalog-status--${value || 'unknown'}${onClick ? ' mih-catalog-status--interactive' : ''}`
  return onClick ? (
    <button className={className} type="button" aria-label={ariaLabel || `编辑${dimension === 'coverage' ? '覆盖状态' : '实施阶段'}`} onClick={onClick}>
      {content}
    </button>
  ) : <span className={className}>{content}</span>
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

function normalizeDraft(value) {
  return String(value || '').normalize('NFKC').trim()
}

function uniqueSuggestions(values) {
  return [...new Set((values || []).map(normalizeDraft).filter(Boolean))]
}

function useUpwardMenu(open, rootRef, optionCount, extraHeight = 0) {
  const [openUpward, setOpenUpward] = useState(false)
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return
    const rootRect = rootRef.current.getBoundingClientRect()
    const boundaryRect = rootRef.current.closest('.mih-modal__body')?.getBoundingClientRect()
      ?? rootRef.current.closest('.mih-modal')?.getBoundingClientRect()
    const boundaryTop = Math.max(0, boundaryRect?.top ?? 0)
    const boundaryBottom = Math.min(window.innerHeight, boundaryRect?.bottom ?? window.innerHeight)
    const menuHeight = Math.min(328, optionCount * 35 + 12 + extraHeight)
    const spaceBelow = boundaryBottom - rootRect.bottom - 8
    const spaceAbove = rootRect.top - boundaryTop - 8
    setOpenUpward(spaceBelow < menuHeight && spaceAbove > spaceBelow)
  }, [extraHeight, open, optionCount, rootRef])
  return openUpward
}

function CreateableCombobox({ label, value, onChange, suggestions = [], placeholder = '输入或选择' }) {
  const labelId = useId()
  const inputId = useId()
  const listboxId = useId()
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const normalized = normalizeDraft(value)
  const options = useMemo(() => {
    const query = filtering ? normalized.toLocaleLowerCase() : ''
    const available = uniqueSuggestions(suggestions)
      .filter((item) => !query || item.toLocaleLowerCase().includes(query))
      .slice(0, 12)
      .map((item) => ({ value: item, label: item, create: false }))
    if (normalized && !available.some((item) => item.value === normalized)
      && !uniqueSuggestions(suggestions).includes(normalized)) {
      available.unshift({ value: normalized, label: `使用新分类 “${normalized}”`, create: true })
    }
    return available
  }, [filtering, normalized, suggestions])
  const openUpward = useUpwardMenu(open, rootRef, options.length)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  useEffect(() => setHighlightedIndex(0), [normalized, open])

  const choose = (option) => {
    if (!option) return
    onChange(option.value)
    setFiltering(false)
    setOpen(false)
    inputRef.current?.focus()
  }

  const move = (delta) => {
    if (!options.length) return
    setHighlightedIndex((current) => (current + delta + options.length) % options.length)
  }

  return (
    <div className="qp-field mih-createable-combobox" ref={rootRef} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <label className="qp-field__label" id={labelId} htmlFor={inputId}>{label}</label>
      <div className="mih-combobox-anchor">
        <div className={`mih-createable-combobox__control${open ? ' is-open' : ''}`}>
          <input
            ref={inputRef}
            id={inputId}
            value={value}
            required
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={open && options.length ? `${listboxId}-option-${highlightedIndex}` : undefined}
            placeholder={placeholder}
            onFocus={() => { setFiltering(false); setOpen(true) }}
            onChange={(event) => { onChange(event.target.value); setFiltering(true); setOpen(true) }}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (!open) setOpen(true)
                else move(event.key === 'ArrowDown' ? 1 : -1)
              } else if (event.key === 'Enter' && open && options.length) {
                event.preventDefault()
                choose(options[highlightedIndex])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
              }
            }}
          />
          <button
            type="button"
            aria-label={`${open ? '收起' : '展开'}${label}选项`}
            aria-expanded={open}
            aria-controls={listboxId}
            onClick={() => {
              if (open) {
                setOpen(false)
                return
              }
              setFiltering(false)
              setOpen(true)
              inputRef.current?.focus()
            }}
          >
            <CaretDown size={14} aria-hidden="true" />
          </button>
        </div>
        {open && options.length ? (
          <div className={`mih-combobox-menu${openUpward ? ' is-upward' : ''}`} id={listboxId} role="listbox" aria-labelledby={labelId}>
            {options.map((option, index) => (
              <button
                className={`mih-combobox-option${index === highlightedIndex ? ' is-highlighted' : ''}${option.value === normalized && !option.create ? ' is-selected' : ''}`}
                id={`${listboxId}-option-${index}`}
                key={`${option.create ? 'create' : 'option'}-${option.value}`}
                type="button"
                role="option"
                aria-selected={option.value === normalized && !option.create}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => choose(option)}
              >
                {option.create ? <Plus size={13} aria-hidden="true" /> : <Check className="mih-combobox-option__check" size={13} weight="bold" aria-hidden="true" />}
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TagInput({ label, values, onChange, suggestions = [], hint, placeholder = '输入后按回车新增', draft = '', onDraftChange }) {
  const labelId = useId()
  const inputId = useId()
  const listboxId = useId()
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const normalizedDraft = normalizeDraft(draft)
  const options = useMemo(() => {
    const available = uniqueSuggestions(suggestions)
      .filter((item) => !normalizedDraft || item.toLocaleLowerCase().includes(normalizedDraft.toLocaleLowerCase()))
      .slice(0, 12)
      .map((item) => ({ value: item, label: item, create: false }))
    if (normalizedDraft && !available.some((item) => item.value === normalizedDraft)
      && !values.includes(normalizedDraft)) {
      available.unshift({ value: normalizedDraft, label: `新增 “${normalizedDraft}”`, create: true })
    }
    return available
  }, [normalizedDraft, suggestions, values])
  const openUpward = useUpwardMenu(open, rootRef, options.length)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  useEffect(() => setHighlightedIndex(0), [normalizedDraft, open])

  const commit = (candidate = draft) => {
    const next = normalizeDraft(candidate)
    if (next && !values.includes(next)) onChange([...values, next])
    if (next) onDraftChange?.('')
  }

  const choose = (option) => {
    if (!option) return
    if (values.includes(option.value)) onChange(values.filter((item) => item !== option.value))
    else onChange([...values, option.value])
    onDraftChange?.('')
    setOpen(true)
    inputRef.current?.focus()
  }

  const move = (delta) => {
    if (!options.length) return
    setHighlightedIndex((current) => (current + delta + options.length) % options.length)
  }

  return (
    <div className="qp-field mih-tag-combobox" ref={rootRef} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        commit()
        setOpen(false)
      }
    }}>
      <label className="qp-field__label" id={labelId} htmlFor={inputId}>{label}</label>
      <div className="mih-combobox-anchor">
        <div className={`mih-tag-editor${open ? ' is-open' : ''}`}>
          {values.map((value) => (
            <span className="mih-tag-editor__tag" key={value}>
              {value}
              <button type="button" aria-label={`移除 ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            id={inputId}
            value={draft}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={open && options.length ? `${listboxId}-option-${highlightedIndex}` : undefined}
            placeholder={values.length ? '继续添加' : placeholder}
            onFocus={() => setOpen(true)}
            onChange={(event) => { onDraftChange?.(event.target.value); setOpen(true) }}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (!open) setOpen(true)
                else move(event.key === 'ArrowDown' ? 1 : -1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (open && options.length) choose(options[highlightedIndex])
                else commit()
              } else if (event.key === ',') {
                event.preventDefault()
                commit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
              } else if (event.key === 'Backspace' && !draft && values.length) {
                onChange(values.slice(0, -1))
              }
            }}
          />
          <button
            className="mih-tag-editor__toggle"
            type="button"
            aria-label={`${open ? '收起' : '展开'}${label}选项`}
            aria-expanded={open}
            aria-controls={listboxId}
            onClick={() => {
              if (open) {
                setOpen(false)
                return
              }
              setOpen(true)
              inputRef.current?.focus()
            }}
          >
            <CaretDown size={14} aria-hidden="true" />
          </button>
        </div>
        {open && options.length ? (
          <div className={`mih-combobox-menu${openUpward ? ' is-upward' : ''}`} id={listboxId} role="listbox" aria-labelledby={labelId} aria-multiselectable="true">
            {options.map((option, index) => {
              const selected = values.includes(option.value)
              return (
                <button
                  className={`mih-combobox-option${index === highlightedIndex ? ' is-highlighted' : ''}${selected ? ' is-selected' : ''}`}
                  id={`${listboxId}-option-${index}`}
                  key={`${option.create ? 'create' : 'option'}-${option.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => choose(option)}
                >
                  {option.create ? <Plus size={13} aria-hidden="true" /> : <Check className="mih-combobox-option__check" size={13} weight="bold" aria-hidden="true" />}
                  <span>{option.label}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
      {hint ? <span className="qp-field__hint">{hint}</span> : null}
    </div>
  )
}

function ToolbarDropdown({ icon: Icon, label, value, onChange, options }) {
  return <SearchableSelect className="mih-source-toolbar-dropdown" leadingIcon={Icon} label={label} value={value} options={options} onChange={onChange} />
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
    && (!filters.scenario || item.scenarios?.includes(filters.scenario))
    && (!filters.region || item.regions?.includes(filters.region))
    && (!filters.priority || item.priority === filters.priority)
    && (!filters.coverage || item.coverageStatus === filters.coverage)
    && (!filters.delivery || item.deliveryStatus === filters.delivery)
    && (!filters.owner || (filters.owner === '__unassigned'
      ? !item.ownerId && !item.owner
      : filters.owner.startsWith('legacy:')
        ? item.owner === filters.owner.slice('legacy:'.length)
        : item.ownerId === filters.owner || item.owner === filters.owner))
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

function SourceCatalogTable({ snapshot, token, onUnauthorized, notify, onRefresh, requestedView, onRequestedViewHandled, requestedTermKind = '', requestedTermValue = '' }) {
  const ownerLoad = useCallback(() => adminApi.sourceCatalogOwners(token, { includeArchived: true }), [token])
  const ownerState = useRemoteData(ownerLoad, onUnauthorized)
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
  const managedOwners = Array.isArray(ownerState.data?.items) ? ownerState.data.items : []
  const managedOwnerNames = new Set(managedOwners.map((owner) => owner.displayName))
  const ownerFilterOptions = [
    ...managedOwners
      .filter((owner) => !owner.archivedAt || filters.owner === owner.id)
      .map((owner) => ({ value: owner.id, label: owner.archivedAt ? `${owner.displayName}（已归档）` : owner.displayName })),
    ...(snapshot.facets.owners || [])
      .filter((ownerName) => !managedOwnerNames.has(ownerName) || filters.owner === ownerName || filters.owner === `legacy:${ownerName}`)
      .map((ownerName) => ({ value: filters.owner === ownerName ? ownerName : `legacy:${ownerName}`, label: `${ownerName}（旧记录）` })),
  ]
  const pageSize = density === 'compact' ? 40 : density === 'spacious' ? 20 : 30

  useEffect(() => {
    if (!requestedView) return
    setViewId(requestedView)
    onRequestedViewHandled?.()
  }, [onRequestedViewHandled, requestedView])

  useEffect(() => {
    if (!requestedTermValue) return
    const field = requestedTermKind === 'major_category'
      ? 'category'
      : requestedTermKind === 'scenario'
        ? 'scenario'
        : requestedTermKind === 'region'
          ? 'region'
          : requestedTermKind === 'owner'
            ? 'owner'
          : null
    if (!field) return
    setViewId(requestedView || REFERENCE_VIEW.id)
    setFilters({ ...EMPTY_FILTERS, [field]: requestedTermValue })
    setPage(1)
    setSelectedIds(new Set())
  }, [requestedTermKind, requestedTermValue, requestedView])

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

  const baseView = viewId === REFERENCE_VIEW.id
    ? REFERENCE_VIEW
    : BUILTIN_VIEWS.find((view) => view.id === viewId) || BUILTIN_VIEWS[0]
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

  const openEditor = (entry, initialTab = 'profile') => setEditing({ entry, initialTab })

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
          {viewId === REFERENCE_VIEW.id ? (
            <button type="button" aria-pressed="true" onClick={() => selectView('all')}>
              <TreeStructure size={15} aria-hidden="true" /><span>{REFERENCE_VIEW.label}</span><small>{visible.length}</small><X size={12} aria-label="退出治理引用视图" />
            </button>
          ) : null}
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
          <ToolbarDropdown icon={Columns} label="分组" value={groupBy} onChange={setGroupBy} options={[{ value: 'none', label: '不分组' }, { value: 'majorCategory', label: '按大类' }, { value: 'deliveryStatus', label: '按阶段' }, { value: 'region', label: '按区域' }]} />
          <ToolbarDropdown icon={SortAscending} label="排序" value={sortBy} onChange={setSortBy} options={[{ value: 'sequence', label: '序号' }, { value: 'name', label: '名称' }, { value: 'priority', label: '优先级' }, { value: 'coverage', label: '覆盖状态' }, { value: 'updated', label: '最近更新' }]} />
          <ToolbarDropdown icon={Rows} label="行高" value={density} onChange={setDensity} options={[{ value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '适中' }, { value: 'spacious', label: '宽松' }]} />
          <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => setSaveViewOpen(true)}><FloppyDisk size={16} aria-hidden="true" />保存视图</button>
          <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => downloadCatalogCsv(visible)}><FileCsv size={16} aria-hidden="true" />导出 {visible.length}</button>
          <button className="qp-button qp-button--primary qp-button--sm" type="button" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />新增数据源</button>
        </div>

        {filterOpen ? (
          <div className="mih-source-filter-panel">
            <SelectField label="一级分类" value={filters.category} emptyLabel="全部分类" options={snapshot.facets.majorCategories.map((value) => ({ value, label: value }))} onChange={(value) => setFilters({ ...filters, category: value })} />
            <SelectField label="细分场景" value={filters.scenario} emptyLabel="全部场景" options={snapshot.facets.scenarios.map((value) => ({ value, label: value }))} onChange={(value) => setFilters({ ...filters, scenario: value })} />
            <SelectField label="区域" value={filters.region} emptyLabel="全部区域" options={snapshot.facets.regions.map((value) => ({ value, label: value }))} onChange={(value) => setFilters({ ...filters, region: value })} />
            <SelectField label="优先级" value={filters.priority} emptyLabel="全部优先级" options={PRIORITY_OPTIONS} onChange={(value) => setFilters({ ...filters, priority: value })} />
            <SelectField label="覆盖状态" value={filters.coverage} emptyLabel="全部状态" options={COVERAGE_OPTIONS} onChange={(value) => setFilters({ ...filters, coverage: value })} />
            <SelectField label="实施阶段" value={filters.delivery} emptyLabel="全部阶段" options={DELIVERY_OPTIONS} onChange={(value) => setFilters({ ...filters, delivery: value })} />
            <SelectField label="负责人" value={filters.owner} emptyLabel="全部负责人" options={[{ value: '__unassigned', label: '未分配' }, ...ownerFilterOptions]} onChange={(value) => setFilters({ ...filters, owner: value })} />
            <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={!activeFilterCount} onClick={() => setFilters({ ...EMPTY_FILTERS })}><X size={14} aria-hidden="true" />清空筛选</button>
          </div>
        ) : null}

        {selected.length ? (
          <div className="mih-source-bulk-bar" role="region" aria-label="批量操作">
            <strong>已选 {selected.length} 条</strong>
            <span />
            <SearchableSelect className="mih-source-bulk-dropdown" label="覆盖状态" value="" disabled={bulkSaving} placeholder="批量设置" options={COVERAGE_OPTIONS} onChange={(value) => bulkUpdate('coverageStatus', value)} />
            <SearchableSelect className="mih-source-bulk-dropdown" label="实施阶段" value="" disabled={bulkSaving} placeholder="批量设置" options={DELIVERY_OPTIONS} onChange={(value) => bulkUpdate('deliveryStatus', value)} />
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
                    <td><button className="mih-source-name" type="button" onClick={() => openEditor(item, 'related')}><strong>{item.canonicalName}</strong><small>{optionLabel(SOURCE_KIND_OPTIONS, item.sourceKind)} · rev {item.revision}</small></button></td>
                    <td><span className="mih-source-cell-tag">{item.majorCategory}</span></td>
                    <td><div className="mih-source-cell-tags">{item.scenarios?.slice(0, 2).map((value) => <span key={value}>{value}</span>)}{item.scenarios?.length > 2 ? <small>+{item.scenarios.length - 2}</small> : null}</div></td>
                    <td><div className="mih-source-cell-tags">{item.regions?.map((value) => <span key={value}>{value}</span>)}</div></td>
                    <td><CatalogBadge dimension="coverage" value={item.coverageStatus} ariaLabel={`编辑 ${item.canonicalName} 的覆盖状态`} onClick={() => openEditor(item, 'governance')} /></td>
                    <td><CatalogBadge dimension="delivery" value={item.deliveryStatus} ariaLabel={`编辑 ${item.canonicalName} 的实施阶段`} onClick={() => openEditor(item, 'governance')} /></td>
                    <td><span className={`mih-source-priority mih-source-priority--${item.priority.toLowerCase()}`}>{item.priority}</span></td>
                    <td>{item.owner ? <span className="mih-source-owner"><UserCircle size={15} aria-hidden="true" />{item.owner}</span> : <button className="mih-source-unassigned" type="button" onClick={() => openEditor(item, 'governance')}>待分配</button>}</td>
                    <td><div className="mih-source-cell-tags">{item.connectorHints?.slice(0, 2).map((value) => <span key={value}>{value}</span>)}{!item.connectorHints?.length ? <small>—</small> : null}</div></td>
                    <td><button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`编辑 ${item.canonicalName}`} onClick={() => openEditor(item)}><NotePencil size={16} aria-hidden="true" /></button></td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
          {visible.length === 0 ? <EmptyState icon={MagnifyingGlass} title="没有符合当前视图的数据源" description="清空筛选或切换保存视图后重试。" /> : null}
        </div>

        <Pagination page={currentPage} pageSize={pageSize} total={visible.length} totalPages={totalPages} hasMore={currentPage < totalPages} onPageChange={setPage} label="数据源目录分页" />
      </section>

      {creating ? <CatalogEntryModal token={token} facets={snapshot.facets} owners={managedOwners} onOwnersChanged={ownerState.refresh} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setCreating(false)} onChanged={() => { setCreating(false); onRefresh() }} /> : null}
      {editing ? <CatalogEntryModal token={token} entry={editing.entry} initialTab={editing.initialTab} facets={snapshot.facets} owners={managedOwners} onOwnersChanged={ownerState.refresh} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); onRefresh() }} /> : null}
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
    ownerId: entry?.ownerId || '',
    owner: entry?.owner || '',
    connectorHints: entry?.connectorHints || [],
    notes: entry?.notes || '',
    tags: entry?.tags || [],
    evidenceRefs: entry?.evidenceRefs || [],
    customFields: entry?.customFields || {},
  }
}

function relatedNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function RelatedDataTab({ entry, state, onRetry }) {
  if (state.loading && !state.data) return <LoadingState label="正在汇总平台关联数据" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={onRetry} />

  const data = state.data || {}
  const datasets = Array.isArray(data.datasets) ? data.datasets : []
  const externalSources = Array.isArray(data.externalSources) ? data.externalSources : []
  const recentRecords = Array.isArray(data.recentRecords) ? data.recentRecords : []
  const projection = data.searchProjection || {}
  const stats = data.stats || {}
  const matchKeys = (Array.isArray(data.matchKeys) && data.matchKeys.length
    ? data.matchKeys
    : [entry.canonicalName, ...(entry.aliases || [])])
    .map((value) => typeof value === 'string' ? value : value?.key || value?.value || value?.label)
    .filter(Boolean)
  const datasetCount = relatedNumber(stats.datasetCount, datasets.length)
  const objectCount = relatedNumber(stats.objectTypeCount, new Set(datasets.flatMap((item) => item.objectTypes || (item.objectType ? [item.objectType] : []))).size)
  const recordCount = relatedNumber(stats.activeRecordCount ?? stats.canonicalRecordCount, datasets.reduce((sum, item) => sum + relatedNumber(item.activeRecordCount ?? item.recordCount), 0))
  const indexedCount = relatedNumber(projection.projectedChunkCount ?? stats.projectedChunkCount)

  return (
    <section className="mih-source-editor-section mih-source-related">
      <p className="mih-source-editor-callout mih-source-related__archive-note">
        <Archive size={17} aria-hidden="true" />
        <span><strong>归档不会删除数据。</strong> 平台改名或归档只改变目录展示；canonical 记录、数据集、外部接入与可重建的索引投影都会保留。</span>
      </p>

      {state.error ? <ErrorState error={state.error} onRetry={onRetry} /> : null}

      <div className="mih-source-related__match">
        <div>
          <strong>平台匹配口径</strong>
          <small>使用 canonicalName 与 aliases 归一匹配数据中的 platform；不会用可变显示名作为数据主键。</small>
        </div>
        <div className="mih-source-cell-tags" aria-label="平台匹配名称">
          {matchKeys.map((value) => <span key={value}>{value}</span>)}
        </div>
      </div>

      <div className="mih-source-related__metrics">
        <article><Database size={18} weight="duotone" aria-hidden="true" /><span>数据集</span><strong>{formatNumber(datasetCount)}</strong><small>匹配的平台数据集</small></article>
        <article><Stack size={18} weight="duotone" aria-hidden="true" /><span>对象类型</span><strong>{formatNumber(objectCount)}</strong><small>canonical object type</small></article>
        <article><Rows size={18} weight="duotone" aria-hidden="true" /><span>有效记录</span><strong>{formatNumber(recordCount)}</strong><small>{stats.deletedRecordCount ? `${formatNumber(stats.deletedRecordCount)} 条删除版本保留` : 'PostgreSQL current truth'}</small></article>
        <article><MagnifyingGlass size={18} weight="duotone" aria-hidden="true" /><span>索引分块</span><strong>{formatNumber(indexedCount)}</strong><small>{projection.state || '未建立投影'}</small></article>
      </div>

      <div className="mih-source-related__grid">
        <div className="mih-source-related__panel">
          <header><div><strong>数据集与对象</strong><small>点击平台时汇总全部匹配数据，不把 ES 当成业务真相。</small></div><span>{datasets.length}</span></header>
          {datasets.length ? (
            <div className="qp-data-table mih-table-wrap">
              <table className="mih-table" aria-label={`${entry.canonicalName} 关联数据集`}>
                <thead><tr><th>Dataset</th><th>平台 / 对象</th><th>有效记录</th><th>分块 / 已投影</th><th>最近更新</th></tr></thead>
                <tbody>{datasets.map((dataset, index) => (
                  <tr key={dataset.datasetId || dataset.id || index}>
                    <td><code>{dataset.datasetId || dataset.id || '—'}</code></td>
                    <td><strong>{dataset.platforms?.join(' / ') || dataset.platform || entry.canonicalName}</strong><small>{dataset.objectTypes?.join(' / ') || dataset.objectType || 'record'}</small></td>
                    <td>{formatNumber(relatedNumber(dataset.activeRecordCount ?? dataset.recordCount ?? dataset.records))}<small>{dataset.deletedRecordCount ? `${formatNumber(dataset.deletedRecordCount)} 条已删除版本` : ''}</small></td>
                    <td>{formatNumber(relatedNumber(dataset.chunkCount))}<small>{formatNumber(relatedNumber(dataset.projectedChunkCount))} 已投影</small></td>
                    <td>{formatDate(dataset.lastCollectedAt || dataset.lastEventAt || dataset.updatedAt || dataset.latestRecordAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <EmptyState icon={Database} title="尚无关联数据集" description="目录已经登记，但还没有匹配到 canonical dataset 或对象记录。" />}
        </div>

        <div className="mih-source-related__panel">
          <header><div><strong>外部接入</strong><small>物理 source 按规范名称或别名匹配，不随目录归档级联删除。</small></div><span>{externalSources.length}</span></header>
          {externalSources.length ? <div className="mih-source-related__sources">{externalSources.map((source, index) => (
            <article key={source.sourceKey || source.id || index}>
              <span><FlowArrow size={17} weight="duotone" aria-hidden="true" /></span>
              <div><strong>{source.displayName || source.sourceKey || '未命名接入'}</strong><small>{source.datasetId || '未绑定 dataset'} · {source.sourceKind || 'source'}</small></div>
              <em>{source.status || 'unknown'}</em>
            </article>
          ))}</div> : <EmptyState icon={FlowArrow} title="尚无外部接入" description="可在“数据清洗计划”中注册 source，并将其 platform 统一为本平台的规范名称或别名。" />}
        </div>
      </div>

      <div className="mih-source-related__panel mih-source-related__records">
        <header><div><strong>最近数据</strong><small>仅展示有权限读取的 canonical 摘要。</small></div><span>{recentRecords.length}</span></header>
        {recentRecords.length ? <div>{recentRecords.map((record, index) => (
          <article key={record.id || (record.datasetId && record.externalId ? `${record.datasetId}-${record.externalId}` : `record-${index}`)}>
            <div><strong>{record.title || record.externalId || '未命名记录'}</strong><p>{record.body || record.summary || '暂无正文摘要'}</p></div>
            <small>{record.datasetId || 'dataset'} · {record.objectType || 'record'} · {formatDate(record.eventTime || record.updatedAt || record.collectedAt)}</small>
          </article>
        ))}</div> : <EmptyState icon={Rows} title="尚无可展示记录" description="接入完成后，这里会显示与平台匹配的最近数据。" />}
      </div>
    </section>
  )
}

function CatalogEntryModal({ token, entry = null, initialTab = 'profile', facets, owners = [], onOwnersChanged, onUnauthorized, notify, onClose, onChanged }) {
  const [tab, setTab] = useState(initialTab)
  const [form, setForm] = useState(() => emptyForm(entry))
  const [tagDrafts, setTagDrafts] = useState({})
  const [events, setEvents] = useState(null)
  const [relatedState, setRelatedState] = useState({ data: null, error: null, loading: false, loaded: false })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [localOwners, setLocalOwners] = useState([])
  const [ownerCreating, setOwnerCreating] = useState(false)
  const [ownerName, setOwnerName] = useState('')
  const [ownerSaving, setOwnerSaving] = useState(false)
  const [ownerError, setOwnerError] = useState(null)
  const availableOwners = useMemo(() => {
    const byId = new Map([...owners, ...localOwners].map((owner) => [owner.id, owner]))
    return [...byId.values()]
  }, [localOwners, owners])

  useEffect(() => {
    if (form.ownerId || !form.owner) return
    const matchedOwner = availableOwners.find((owner) => owner.displayName === form.owner)
    if (matchedOwner) setForm((current) => ({ ...current, ownerId: matchedOwner.id }))
  }, [availableOwners, form.owner, form.ownerId])

  useEffect(() => {
    if (!entry || tab !== 'history' || events) return
    adminApi.sourceCatalogEvents(token, entry.id)
      .then(setEvents)
      .catch((requestError) => {
        if (requestError?.status === 401) onUnauthorized?.(requestError)
        setError(requestError)
      })
  }, [entry, events, onUnauthorized, tab, token])

  const loadRelatedData = useCallback(() => {
    if (!entry) return
    setRelatedState((current) => ({ ...current, error: null, loading: true, loaded: true }))
    adminApi.sourceCatalogRelatedData(token, entry.id)
      .then((data) => setRelatedState({ data, error: null, loading: false, loaded: true }))
      .catch((requestError) => {
        if (requestError?.status === 401) onUnauthorized?.(requestError)
        setRelatedState((current) => ({ ...current, error: requestError, loading: false, loaded: true }))
      })
  }, [entry, onUnauthorized, token])

  useEffect(() => {
    if (entry && tab === 'related' && !relatedState.loaded && !relatedState.loading) loadRelatedData()
  }, [entry, loadRelatedData, relatedState.loaded, relatedState.loading, tab])

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const tagDraftProps = (field) => ({
    draft: tagDrafts[field] || '',
    onDraftChange: (value) => setTagDrafts((current) => ({ ...current, [field]: value })),
  })
  const createOwner = async () => {
    const displayName = normalizeDraft(ownerName)
    if (!displayName || ownerSaving) return
    setOwnerSaving(true)
    setOwnerError(null)
    try {
      const response = await adminApi.createSourceCatalogOwner(token, { displayName, description: null })
      const created = response?.item || response
      if (!created?.id) throw new Error('负责人创建成功，但响应缺少负责人标识')
      setLocalOwners((current) => [...current, created])
      setForm((current) => ({ ...current, ownerId: created.id, owner: created.displayName }))
      setOwnerCreating(false)
      setOwnerName('')
      onOwnersChanged?.()
      notify?.(`负责人“${created.displayName}”已创建并选中`, 'success')
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setOwnerError(requestError)
    } finally {
      setOwnerSaving(false)
    }
  }
  const save = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const committedForm = Object.entries(tagDrafts).reduce((current, [field, draft]) => {
        const next = normalizeDraft(draft)
        if (!next || !Array.isArray(current[field]) || current[field].includes(next)) return current
        return { ...current, [field]: [...current[field], next] }
      }, { ...form })
      const { owner: ownerText, ownerId, ...catalogFields } = committedForm
      const payload = {
        ...catalogFields,
        ...(ownerId ? { ownerId } : ownerText.trim() ? { owner: ownerText.trim() } : { ownerId: null }),
        complianceBoundary: committedForm.complianceBoundary.trim() || null,
        notes: committedForm.notes.trim() || null,
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
    ...(entry ? [{ id: 'related', label: '关联数据', icon: Database }] : []),
    ...(entry ? [{ id: 'history', label: '变更记录', icon: ClockCounterClockwise }] : []),
  ]

  return (
    <Modal
      size="xlarge"
      title={entry ? `平台详情 · ${entry.canonicalName}` : '新增数据源'}
      description={entry ? `稳定标识 ${entry.sourceKey} · revision ${entry.revision}` : '先登记业务目录，再建立获取与清洗计划；目录中不保存连接密码。'}
      onClose={onClose}
      closeOnBackdrop={false}
      footer={(
        <>
          <span>
            {entry ? <button className={`qp-button ${confirmArchive ? 'qp-button--danger' : 'qp-button--ghost'}`} type="button" disabled={saving} onClick={archive}>{entry.archivedAt ? <Check size={16} /> : <Archive size={16} />}{entry.archivedAt ? (confirmArchive ? '确认恢复' : '恢复') : (confirmArchive ? '确认归档' : '归档')}</button> : null}
            {entry && confirmArchive && !entry.archivedAt ? <small className="mih-source-archive-impact">仅从活动目录隐藏；关联数据、接入和索引都保留。</small> : null}
          </span>
          <span className="mih-page-actions"><button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button><button className="qp-button qp-button--primary" type="submit" form="source-catalog-entry-form" disabled={saving || ['history', 'related'].includes(tab)}><FloppyDisk size={16} aria-hidden="true" />{saving ? '正在保存' : '保存修改'}</button></span>
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
              <CreateableCombobox label="一级分类" value={form.majorCategory} suggestions={facets.majorCategories} onChange={(value) => update('majorCategory', value)} />
              <SelectField label="优先级" value={form.priority} options={PRIORITY_OPTIONS} onChange={(value) => update('priority', value)} />
            </div>
            <TagInput label="别名" values={form.aliases} onChange={(value) => update('aliases', value)} {...tagDraftProps('aliases')} />
            <TagInput label="细分场景" values={form.scenarios} onChange={(value) => update('scenarios', value)} suggestions={facets.scenarios} hint="可输入后回车新增；支持一个平台属于多个 use case。" {...tagDraftProps('scenarios')} />
            <TagInput label="区域" values={form.regions} onChange={(value) => update('regions', value)} suggestions={facets.regions} hint="区域为多选，避免把全球/中国大陆长期塞成一个枚举。" {...tagDraftProps('regions')} />
            <TagInput label="自由标签" values={form.tags} onChange={(value) => update('tags', value)} suggestions={facets.tags} {...tagDraftProps('tags')} />
          </section>
        ) : null}

        {tab === 'capabilities' ? (
          <section className="mih-source-editor-section">
            <p className="mih-source-editor-callout"><WarningCircle size={17} aria-hidden="true" /><span>“可监测内容”等初始值来自分类模板，不等于该平台已经实测覆盖；完成验证后再把核验状态改为“已核验”。</span></p>
            <TagInput label="代表入口 / 模块" values={form.entryModules} onChange={(value) => update('entryModules', value)} {...tagDraftProps('entryModules')} />
            <TagInput label="可监测内容" values={form.monitorableContent} onChange={(value) => update('monitorableContent', value)} {...tagDraftProps('monitorableContent')} />
            <TagInput label="可提取线索" values={form.extractableClues} onChange={(value) => update('extractableClues', value)} {...tagDraftProps('extractableClues')} />
            <TagInput label="主体追踪字段" values={form.trackingFields} onChange={(value) => update('trackingFields', value)} {...tagDraftProps('trackingFields')} />
            <TagInput label="建议接入方式" values={form.suggestedAccess} onChange={(value) => update('suggestedAccess', value)} {...tagDraftProps('suggestedAccess')} />
          </section>
        ) : null}

        {tab === 'governance' ? (
          <section className="mih-source-editor-section">
            <p className="mih-source-editor-callout">
              <ShieldCheck size={17} aria-hidden="true" />
              <span><strong>覆盖状态与实施阶段是人工维护的对外汇报口径。</strong> 自动检测只提供运行健康和证据建议，不会静默覆盖人工结论；每次保存都会进入变更记录。</span>
            </p>
            <div className="mih-source-editor-grid">
              <SelectField label="覆盖状态（人工 / 对外）" value={form.coverageStatus} options={COVERAGE_OPTIONS} onChange={(value) => update('coverageStatus', value)} />
              <SelectField label="实施阶段（人工 / 对外）" value={form.deliveryStatus} options={DELIVERY_OPTIONS} onChange={(value) => update('deliveryStatus', value)} />
              <SelectField label="字段核验" value={form.reviewStatus} options={REVIEW_OPTIONS} onChange={(value) => update('reviewStatus', value)} />
              <Field label="运行健康（自动观测）" hint="由已关联 source、pipeline 与索引投影汇总；此处只读。"><div className="mih-source-runtime-readonly"><CatalogBadge dimension="runtime" value={form.runtimeStatus} /><small>system observed</small></div></Field>
              <div className="mih-owner-assignment">
                <SelectField
                  label="负责人"
                  value={form.ownerId}
                  emptyLabel="尚未分配"
                  options={availableOwners
                    .filter((owner) => !owner.archivedAt || owner.id === form.ownerId)
                    .map((owner) => ({ value: owner.id, label: owner.archivedAt ? `${owner.displayName}（已归档）` : owner.displayName, description: owner.description }))}
                  onChange={(ownerId) => {
                    const owner = availableOwners.find((candidate) => candidate.id === ownerId)
                    setForm((current) => ({ ...current, ownerId, owner: owner?.displayName || '' }))
                  }}
                />
                <button className="mih-owner-assignment__create" type="button" onClick={() => { setOwnerCreating((current) => !current); setOwnerError(null) }}><Plus size={13} aria-hidden="true" />新增负责人</button>
                <span className="qp-field__hint">负责人是人员或团队，不是 tikhub / justone 等接入供应商。</span>
                {ownerCreating ? (
                  <div className="mih-owner-quick-create">
                    <input
                      className="qp-input"
                      autoFocus
                      value={ownerName}
                      placeholder="负责人或团队名称"
                      onChange={(event) => setOwnerName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return
                        if (event.key === 'Enter') { event.preventDefault(); createOwner() }
                        if (event.key === 'Escape') { event.preventDefault(); setOwnerCreating(false); setOwnerName('') }
                      }}
                    />
                    <button className="qp-button qp-button--primary qp-button--sm" type="button" disabled={ownerSaving || !ownerName.trim()} onClick={createOwner}>{ownerSaving ? '创建中' : '创建并选中'}</button>
                    <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => { setOwnerCreating(false); setOwnerName(''); setOwnerError(null) }}>取消</button>
                  </div>
                ) : null}
                {ownerError ? <small className="mih-owner-assignment__error">{ownerError.message || '负责人创建失败'}</small> : null}
              </div>
            </div>
            <Field label="合规边界"><textarea className="qp-textarea" rows="5" value={form.complianceBoundary} onChange={(event) => update('complianceBoundary', event.target.value)} /></Field>
            <Field label="备注 / 待补充"><textarea className="qp-textarea" rows="4" value={form.notes} onChange={(event) => update('notes', event.target.value)} /></Field>
          </section>
        ) : null}

        {tab === 'evidence' ? (
          <section className="mih-source-editor-section">
            <TagInput label="接入线索 / Connector" values={form.connectorHints} onChange={(value) => update('connectorHints', value)} suggestions={facets.connectorHints} hint="仅保存 provider 或方式线索，不保存 URL 凭证、密码或 token。" {...tagDraftProps('connectorHints')} />
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

        {tab === 'related' && entry ? (
          <RelatedDataTab
            entry={entry}
            state={relatedState}
            onRetry={() => {
              setRelatedState({ data: null, error: null, loading: false, loaded: false })
            }}
          />
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

function taxonomyReferenceCount(term) {
  return relatedNumber(term?.referenceCount ?? term?.usageCount ?? term?.entryCount ?? term?.references?.length)
}

function TaxonomyTermModal({ token, term = null, kind, onUnauthorized, notify, onClose, onChanged }) {
  const kindConfig = TAXONOMY_KINDS.find((item) => item.value === (term?.kind || kind)) || TAXONOMY_KINDS[0]
  const [form, setForm] = useState({
    displayName: term?.displayName || '',
    description: term?.description || '',
  })
  const [saving, setSaving] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [error, setError] = useState(null)

  const visibleError = error?.code === 'source_catalog_term_in_use'
    ? { ...error, message: `无法修改“${term?.displayName || kindConfig.singular}”：仍有数据源引用该词条。请先查看引用并迁移到其他词条后，再重命名或归档。` }
    : error

  const save = async (event) => {
    event.preventDefault()
    const displayName = form.displayName.normalize('NFKC').trim()
    if (!displayName) return
    setSaving(true)
    setError(null)
    try {
      const payload = {
        displayName,
        description: form.description.trim() || null,
      }
      if (term) await adminApi.updateSourceCatalogTaxonomyTerm(token, term.id, { ...payload, revision: term.revision })
      else await adminApi.createSourceCatalogTaxonomyTerm(token, { ...payload, kind: kindConfig.value })
      notify?.(`${kindConfig.singular}词条已${term ? '更新' : '创建'}`, 'success')
      onChanged()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally {
      setSaving(false)
    }
  }

  const archive = async () => {
    if (!term) return
    if (!confirmArchive) {
      setConfirmArchive(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (term.archivedAt) await adminApi.restoreSourceCatalogTaxonomyTerm(token, term.id, term.revision)
      else await adminApi.archiveSourceCatalogTaxonomyTerm(token, term.id, term.revision)
      notify?.(term.archivedAt ? '词条已恢复，可继续在数据源中选择' : '词条已归档', 'success')
      onChanged()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      setConfirmArchive(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={term ? `管理${kindConfig.singular} · ${term.displayName}` : `新增${kindConfig.singular}`}
      description="统一词条会立即进入数据源编辑下拉；未引用词条可安全重命名或归档，且不会删除任何平台或数据。"
      onClose={onClose}
      closeOnBackdrop={false}
      footer={(
        <>
          <span>{term ? <button className={`qp-button ${confirmArchive ? 'qp-button--danger' : 'qp-button--ghost'}`} type="button" disabled={saving} onClick={archive}>{term.archivedAt ? <Check size={16} /> : <Archive size={16} />}{term.archivedAt ? (confirmArchive ? '确认恢复' : '恢复词条') : (confirmArchive ? '确认归档' : '归档词条')}</button> : null}</span>
          <span className="mih-page-actions"><button className="qp-button qp-button--ghost" type="button" onClick={onClose}>取消</button><button className="qp-button qp-button--primary" type="submit" form="source-taxonomy-term-form" disabled={saving || !form.displayName.trim()}><FloppyDisk size={16} aria-hidden="true" />{saving ? '正在保存' : '保存'}</button></span>
        </>
      )}
    >
      {visibleError ? <ErrorState error={visibleError} /> : null}
      <form id="source-taxonomy-term-form" className="mih-form mih-source-taxonomy-form" onSubmit={save}>
        <Field label="词条类型"><div className="mih-source-taxonomy-kind-readonly"><TreeStructure size={16} weight="duotone" aria-hidden="true" /><strong>{kindConfig.label}</strong><small>{kindConfig.description}</small></div></Field>
        <Field label="显示名称"><input className="qp-input" required autoFocus value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder={`输入${kindConfig.singular}名称`} /></Field>
        <Field label="说明" hint="说明用于治理和选择提示，不会写入平台数据。"><textarea className="qp-textarea" rows="5" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="适用范围、命名口径或使用注意事项" /></Field>
        {term ? <p className="mih-source-editor-callout"><ShieldCheck size={17} aria-hidden="true" /><span>当前有 {formatNumber(taxonomyReferenceCount(term))} 条数据源引用。引用中词条不能重命名或归档；系统会要求先完成迁移，不会级联修改或删除数据。</span></p> : null}
      </form>
    </Modal>
  )
}

function OwnerModal({ token, owner = null, onUnauthorized, notify, onClose, onChanged }) {
  const [form, setForm] = useState({
    displayName: owner?.displayName || '',
    description: owner?.description || '',
  })
  const [saving, setSaving] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [error, setError] = useState(null)
  const visibleError = error?.code === 'source_catalog_owner_in_use'
    ? { ...error, message: `无法归档“${owner?.displayName || '负责人'}”：仍有数据源由其负责。请先点击引用数量迁移这些平台。` }
    : error

  const save = async (event) => {
    event.preventDefault()
    const displayName = normalizeDraft(form.displayName)
    if (!displayName) return
    setSaving(true)
    setError(null)
    try {
      const payload = { displayName, description: normalizeDraft(form.description) || null }
      if (owner) await adminApi.updateSourceCatalogOwner(token, owner.id, { ...payload, revision: owner.revision })
      else await adminApi.createSourceCatalogOwner(token, payload)
      notify?.(`负责人已${owner ? '更新' : '创建'}`, 'success')
      onChanged()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally {
      setSaving(false)
    }
  }

  const archive = async () => {
    if (!owner) return
    if (!confirmArchive) {
      setConfirmArchive(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (owner.archivedAt) await adminApi.restoreSourceCatalogOwner(token, owner.id, owner.revision)
      else await adminApi.archiveSourceCatalogOwner(token, owner.id, owner.revision)
      notify?.(owner.archivedAt ? '负责人已恢复' : '负责人已归档', 'success')
      onChanged()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      setConfirmArchive(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={owner ? `管理负责人 · ${owner.displayName}` : '新增负责人'}
      description="负责人先作为独立治理对象维护；未来可显式关联登录账号，但不会把账号系统当作负责人表。"
      onClose={onClose}
      closeOnBackdrop={false}
      footer={(
        <>
          <span>{owner ? <button className={`qp-button ${confirmArchive ? 'qp-button--danger' : 'qp-button--ghost'}`} type="button" disabled={saving} onClick={archive}>{owner.archivedAt ? <Check size={16} /> : <Archive size={16} />}{owner.archivedAt ? (confirmArchive ? '确认恢复' : '恢复负责人') : (confirmArchive ? '确认归档' : '归档负责人')}</button> : null}</span>
          <span className="mih-page-actions"><button className="qp-button qp-button--ghost" type="button" onClick={onClose}>取消</button><button className="qp-button qp-button--primary" type="submit" form="source-owner-form" disabled={saving || !form.displayName.trim()}><FloppyDisk size={16} aria-hidden="true" />{saving ? '正在保存' : '保存'}</button></span>
        </>
      )}
    >
      {visibleError ? <ErrorState error={visibleError} /> : null}
      <form id="source-owner-form" className="mih-form mih-source-taxonomy-form" onSubmit={save}>
        <Field label="显示名称"><input className="qp-input" required autoFocus value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="输入人员或团队名称" /></Field>
        <Field label="说明" hint="可填写职责范围、团队或交接说明。"><textarea className="qp-textarea" rows="5" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="例如：内容平台接入与监测能力负责人" /></Field>
        <p className="mih-source-editor-callout"><UserCircle size={17} aria-hidden="true" /><span>当前负责人记录与登录账号相互独立。{owner ? `已有 ${formatNumber(owner.usageCount || 0)} 条数据源引用。` : '创建后即可在平台治理页搜索选择。'}</span></p>
      </form>
    </Modal>
  )
}

function TaxonomyPage({ token, onUnauthorized, notify, onRefresh, onOpenCatalog }) {
  const load = useCallback(() => adminApi.sourceCatalogTaxonomy(token, { includeArchived: true }), [token])
  const state = useRemoteData(load, onUnauthorized)
  const ownerLoad = useCallback(() => adminApi.sourceCatalogOwners(token, { includeArchived: true }), [token])
  const ownerState = useRemoteData(ownerLoad, onUnauthorized)
  const [kind, setKind] = useState('major_category')
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null)
  const kindConfig = GOVERNANCE_KINDS.find((item) => item.value === kind) || TAXONOMY_KINDS[0]
  const terms = Array.isArray(state.data?.items) ? state.data.items : []
  const owners = Array.isArray(ownerState.data?.items) ? ownerState.data.items : []
  const activeState = kind === 'owner' ? ownerState : state
  const visible = (kind === 'owner' ? owners : terms.filter((term) => term.kind === kind))
    .filter((item) => showArchived || !item.archivedAt)
    .filter((item) => !query.trim() || normalizeDraft([item.displayName, item.description].filter(Boolean).join('\n')).toLocaleLowerCase('zh-CN').includes(normalizeDraft(query).toLocaleLowerCase('zh-CN')))
    .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0) || left.displayName.localeCompare(right.displayName, 'zh-CN'))
  const changed = () => {
    setCreating(false)
    setEditing(null)
    if (kind === 'owner') ownerState.refresh()
    else state.refresh()
    onRefresh?.()
  }

  return (
    <section className="mih-source-taxonomy">
      <div className="qp-panel mih-source-taxonomy-manager">
        <nav className="mih-source-taxonomy-kind-tabs" aria-label="分类与负责人类型">
          {GOVERNANCE_KINDS.map((item) => {
            const count = item.value === 'owner'
              ? owners.filter((owner) => !owner.archivedAt).length
              : terms.filter((term) => term.kind === item.value && !term.archivedAt).length
            return <button type="button" aria-pressed={kind === item.value} key={item.value} onClick={() => { setKind(item.value); setQuery(''); setCreating(false); setEditing(null) }}><span>{item.label}</span><small>{count}</small></button>
          })}
        </nav>

        <div className="mih-source-taxonomy-toolbar">
          <div><strong>{kind === 'owner' ? '负责人管理' : `${kindConfig.label}词条`}</strong><p>{kindConfig.description}</p></div>
          <label className="mih-source-search"><MagnifyingGlass size={16} aria-hidden="true" /><input value={query} placeholder={`搜索${kindConfig.singular}名称或说明`} onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={13} /></button> : null}</label>
          <button className={`qp-button qp-button--ghost qp-button--sm${showArchived ? ' is-active' : ''}`} type="button" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}><Archive size={15} aria-hidden="true" />{showArchived ? '隐藏已归档' : '显示已归档'}</button>
          <button className="qp-button qp-button--primary qp-button--sm" type="button" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />新增{kindConfig.singular}</button>
        </div>

        {activeState.loading && !activeState.data ? <LoadingState label={`正在加载${kindConfig.label}`} /> : null}
        {activeState.error ? <ErrorState error={activeState.error} onRetry={activeState.refresh} /> : null}
        {activeState.data ? (
          <div className="qp-data-table mih-table-wrap mih-source-taxonomy-table">
            <table className="mih-table" aria-label={`${kindConfig.label}管理`}>
              <thead><tr><th>名称</th><th>说明</th><th>引用</th><th>状态</th><th>最近更新</th><th aria-label="操作" /></tr></thead>
              <tbody>{visible.map((item) => (
                <tr className={item.archivedAt ? 'is-archived' : ''} key={item.id}>
                  <td><button className="mih-source-taxonomy-name" type="button" onClick={() => setEditing(item)}><strong>{item.displayName}</strong><small>{item.ownerKey || item.termKey || item.id}</small></button></td>
                  <td><p>{item.description || '尚未补充说明'}</p></td>
                  <td><button className="mih-source-taxonomy-reference" type="button" onClick={() => onOpenCatalog(kind, kind === 'owner' ? item.id : item.displayName)}>{formatNumber(kind === 'owner' ? item.usageCount || 0 : taxonomyReferenceCount(item))} 条数据源<ArrowRight size={12} aria-hidden="true" /></button></td>
                  <td><span className={`mih-source-taxonomy-state${item.archivedAt ? ' is-archived' : ''}`}>{item.archivedAt ? '已归档' : '使用中'}</span></td>
                  <td>{formatDate(item.updatedAt || item.createdAt)}</td>
                  <td><button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`管理 ${item.displayName}`} onClick={() => setEditing(item)}><NotePencil size={16} aria-hidden="true" /></button></td>
                </tr>
              ))}</tbody>
            </table>
            {!visible.length ? <EmptyState icon={kind === 'owner' ? UserCircle : TreeStructure} title={`暂无${showArchived ? '符合条件的' : '可用'}${kindConfig.singular}`} description={`可以新增${kindConfig.singular}；创建后会立即出现在数据源编辑选择中。`} /> : null}
          </div>
        ) : null}
      </div>

      <div className="mih-source-taxonomy-panels">
        <Panel title="字段字典" subtitle="人工汇报口径与自动运行观测保持独立">
          <dl className="mih-source-dictionary">
            <div><dt>coverage_status</dt><dd>{COVERAGE_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>人工维护的对外能力覆盖口径</small></div>
            <div><dt>delivery_status</dt><dd>{DELIVERY_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>人工维护的对外实施阶段</small></div>
            <div><dt>review_status</dt><dd>{REVIEW_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>模板字段是否已被人工核验</small></div>
            <div><dt>runtime_status</dt><dd>{RUNTIME_OPTIONS.map((item) => item.label).join(' / ')}</dd><small>source / pipeline / index 自动观测</small></div>
          </dl>
        </Panel>
        <Panel title="安全变更规则" subtitle={kind === 'owner' ? '负责人以稳定 ownerId 关联平台' : '词条是稳定治理对象，不是随手改写的字符串'}>
          {kind === 'owner' ? (
            <div className="mih-source-governance-notes">
              <article><UserCircle size={18} aria-hidden="true" /><div><strong>独立负责人表</strong><p>当前不依赖登录账号；未来只通过显式字段关联账号。</p></div></article>
              <article><NotePencil size={18} aria-hidden="true" /><div><strong>引用中可以改名</strong><p>平台保存 ownerId，改名会安全同步显示文本，不会让保存视图失效。</p></div></article>
              <article><Archive size={18} aria-hidden="true" /><div><strong>引用中禁止归档</strong><p>点击引用数量查看活动与已归档平台，完成改派或清空后再归档负责人。</p></div></article>
            </div>
          ) : (
            <div className="mih-source-governance-notes">
              <article><Tag size={18} aria-hidden="true" /><div><strong>新建后立即可选</strong><p>大类、场景与区域统一进入编辑选择，避免自由文本继续分叉。</p></div></article>
              <article><Archive size={18} aria-hidden="true" /><div><strong>引用中禁止归档</strong><p>先查看引用并完成迁移；归档不级联删除平台或历史数据。</p></div></article>
              <article><ShieldCheck size={18} aria-hidden="true" /><div><strong>稳定标识与审计</strong><p>未引用词条可重命名；引用中先迁移，API 以 revision 防止并发覆盖。</p></div></article>
            </div>
          )}
        </Panel>
      </div>

      {creating && kind === 'owner' ? <OwnerModal token={token} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setCreating(false)} onChanged={changed} /> : null}
      {creating && kind !== 'owner' ? <TaxonomyTermModal token={token} kind={kind} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setCreating(false)} onChanged={changed} /> : null}
      {editing && kind === 'owner' ? <OwnerModal token={token} owner={editing} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setEditing(null)} onChanged={changed} /> : null}
      {editing && kind !== 'owner' ? <TaxonomyTermModal token={token} term={editing} kind={editing.kind} onUnauthorized={onUnauthorized} notify={notify} onClose={() => setEditing(null)} onChanged={changed} /> : null}
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
  const requestedTermKind = query.get('termKind') || ''
  const requestedTermValue = query.get('termValue') || ''
  const [catalogViewRequest, setCatalogViewRequest] = useState(requestedView)

  useEffect(() => setCatalogViewRequest(requestedView), [requestedView])

  if (state.loading && !state.data) return <LoadingState label="正在汇总数据源目录" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const snapshot = state.data || { items: [], summary: {}, facets: { majorCategories: [], scenarios: [], regions: [], owners: [], connectorHints: [], tags: [] } }
  const heading = section === 'catalog'
    ? { eyebrow: 'CATALOG / MULTI-DIMENSIONAL / GOVERNANCE', title: '多维数据源目录', description: '同一底表上的保存视图、筛选、分组、批量状态、编辑、归档与导出。' }
    : section === 'taxonomy'
      ? { eyebrow: 'TAXONOMY / OWNERS / FIELDS', title: '分类与字段治理', description: '集中管理大类、场景、区域和负责人，并与平台实测证据拆开治理。' }
      : section === 'plans'
        ? { eyebrow: 'ACQUIRE / CLEAN / ARCHIVE / PUBLISH', title: '计划与实施证据', description: '目录说明“做什么”，计划说明“怎么做”，Agent 只是可审核的受控步骤。' }
        : { eyebrow: 'SOURCE CATALOG / COVERAGE / EVIDENCE', title: '数据源覆盖总览', description: '基于 215 条权威目录观察覆盖、优先级、实施阶段、负责人和字段核验。' }

  const openCatalog = (view = 'all', termKind = null, termValue = null) => {
    setCatalogViewRequest(view)
    setQuery({ section: 'catalog', catalogView: view, termKind, termValue })
  }

  return (
    <>
      <PageHeading className="mih-command-heading" {...heading} loading={state.loading} onRefresh={state.refresh}>
        {section !== 'catalog' ? <button className="qp-button qp-button--primary qp-button--sm" type="button" onClick={() => openCatalog('all')}><Rows size={16} aria-hidden="true" />进入数据表</button> : null}
      </PageHeading>

      <nav className="mih-source-section-tabs" aria-label="数据源系统菜单">
        {SECTION_OPTIONS.map((item) => { const Icon = item.icon; return <button type="button" aria-pressed={section === item.id} key={item.id} onClick={() => setQuery({ section: item.id, catalogView: item.id === 'catalog' ? (requestedView || 'all') : null, termKind: null, termValue: null })}><Icon size={16} weight={section === item.id ? 'duotone' : 'regular'} aria-hidden="true" /><span>{item.label}</span></button> })}
      </nav>

      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {section === 'overview' ? <SourceCatalogOverview snapshot={snapshot} onOpenCatalog={openCatalog} /> : null}
      {section === 'catalog' ? <SourceCatalogTable snapshot={snapshot} token={token} onUnauthorized={onUnauthorized} notify={notify} onRefresh={state.refresh} requestedView={catalogViewRequest} onRequestedViewHandled={() => setCatalogViewRequest('')} requestedTermKind={requestedTermKind} requestedTermValue={requestedTermValue} /> : null}
      {section === 'taxonomy' ? <TaxonomyPage token={token} onUnauthorized={onUnauthorized} notify={notify} onRefresh={state.refresh} onOpenCatalog={(termKind, termValue) => openCatalog(REFERENCE_VIEW.id, termKind, termValue)} /> : null}
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
