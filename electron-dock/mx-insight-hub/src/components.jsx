import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Copy,
  Info,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react'

export function useRemoteData(load, onUnauthorized) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    let active = true
    setState((current) => ({ ...current, error: null, loading: true }))
    load()
      .then((data) => {
        if (active) setState({ data, error: null, loading: false })
      })
      .catch((error) => {
        if (!active) return
        if (error?.status === 401) onUnauthorized?.(error)
        setState((current) => ({ ...current, error, loading: false }))
      })
    return () => {
      active = false
    }
  }, [load, onUnauthorized, revision])

  return { ...state, refresh, setData: (data) => setState({ data, error: null, loading: false }) }
}

export function PageHeading({ eyebrow, title, description, loading, onRefresh, children, className = '' }) {
  return (
    <header className={`mih-page-heading ${className}`.trim()}>
      <div className="mih-page-heading__copy">
        <p className="qp-kicker">{eyebrow}</p>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="mih-page-actions">
        {onRefresh ? (
          <button
            className="qp-button qp-button--ghost qp-icon-button"
            type="button"
            aria-label="刷新当前数据"
            onClick={onRefresh}
            disabled={loading}
          >
            <ArrowClockwise size={18} className={loading ? 'mih-spin' : undefined} aria-hidden="true" />
          </button>
        ) : null}
        {children}
      </div>
    </header>
  )
}

export function LoadingState({ label = '正在加载数据' }) {
  return (
    <div className="mih-state mih-state--loading" role="status">
      <CircleNotch size={28} className="mih-spin" aria-hidden="true" />
      <strong>{label}</strong>
    </div>
  )
}

export function ErrorState({ error, onRetry }) {
  return (
    <section className="mih-state mih-state--error" role="alert">
      <WarningCircle size={30} weight="duotone" aria-hidden="true" />
      <div>
        <strong>{error?.message || '数据请求失败'}</strong>
        <p>
          {error?.code ? `错误码：${error.code}` : '请检查服务状态后重试'}
          {error?.requestId ? ` · Request ID：${error.requestId}` : ''}
        </p>
      </div>
      {onRetry ? (
        <button className="qp-button qp-button--outline" type="button" onClick={onRetry}>
          <ArrowClockwise size={16} aria-hidden="true" />
          重试
        </button>
      ) : null}
    </section>
  )
}

export function EmptyState({ icon: Icon = Info, title, description, action }) {
  return (
    <section className="mih-state mih-state--empty">
      <Icon size={32} weight="duotone" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </section>
  )
}

const STATUS_TONES = {
  active: 'success',
  ready: 'success',
  up: 'success',
  live: 'success',
  committed: 'success',
  enabled: 'success',
  degraded: 'warning',
  not_ready: 'warning',
  warning: 'warning',
  unknown: 'warning',
  revoked: 'danger',
  expired: 'danger',
  down: 'danger',
  released: 'danger',
  disabled: 'neutral',
}

export function StatusBadge({ status, label }) {
  const normalized = String(status || 'unknown').toLowerCase()
  const tone = STATUS_TONES[normalized] || 'neutral'
  const Icon = tone === 'success' ? CheckCircle : tone === 'danger' ? XCircle : tone === 'warning' ? WarningCircle : Info
  return (
    <span className={`qp-tag mih-status mih-status--${tone}`}>
      <Icon size={14} weight="fill" aria-hidden="true" />
      {label || normalized.replaceAll('_', ' ')}
    </span>
  )
}

export function MetricCard({ icon: Icon, label, value, hint, tone = 'primary' }) {
  return (
    <article className={`qp-metric mih-metric mih-metric--${tone}`}>
      <span className="mih-metric__icon"><Icon size={22} weight="duotone" aria-hidden="true" /></span>
      <span className="qp-metric__label">{label}</span>
      <strong className="qp-metric__value">{value}</strong>
      <small className="qp-metric__hint">{hint}</small>
    </article>
  )
}

function paginationPages(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  const candidates = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((left, right) => left - right)
  const items = []
  for (const value of candidates) {
    const previous = items.at(-1)
    if (typeof previous === 'number' && value - previous > 1) items.push(`ellipsis-${value}`)
    items.push(value)
  }
  return items
}

export function Pagination({
  page,
  pageSize,
  total = null,
  totalPages = null,
  maxDirectPage = null,
  hasMore = false,
  loading = false,
  onPageChange,
  className = '',
  label = '分页',
}) {
  const currentPage = Math.max(1, Number(page) || 1)
  const knownPages = Number.isSafeInteger(totalPages) && totalPages >= 1
  const navigablePages = knownPages
    ? Math.min(totalPages, Number.isSafeInteger(maxDirectPage) && maxDirectPage >= 1 ? maxDirectPage : totalPages)
    : null
  const directPageLimited = knownPages && navigablePages < totalPages
  const [jumpDraft, setJumpDraft] = useState(String(currentPage))

  useEffect(() => setJumpDraft(String(currentPage)), [currentPage])

  const changePage = (nextPage) => {
    if (loading || !onPageChange || !Number.isSafeInteger(nextPage) || nextPage < 1) return
    if (knownPages && nextPage > navigablePages) return
    if (nextPage !== currentPage) onPageChange(nextPage)
  }

  const submitJump = (event) => {
    event.preventDefault()
    const nextPage = Number(jumpDraft)
    if (!Number.isSafeInteger(nextPage) || nextPage < 1 || (knownPages && nextPage > navigablePages)) {
      setJumpDraft(String(currentPage))
      return
    }
    changePage(nextPage)
  }

  return (
    <footer className={`qp-pagination ${className}`.trim()} aria-label={label}>
      <span className="qp-pagination__summary">
        {total != null ? `共 ${formatNumber(total)} 条 · ` : ''}
        每页 {formatNumber(pageSize)} 条 · 第 {formatNumber(currentPage)}
        {knownPages ? ` / ${formatNumber(totalPages)} 页` : ' 页 · 总数未知'}
        {directPageLimited ? ` · 可直达前 ${formatNumber(navigablePages)} 页` : ''}
      </span>
      <div className="qp-pagination__controls">
        <button className="qp-button qp-button--ghost qp-button--sm" type="button"
          disabled={loading || currentPage <= 1} onClick={() => changePage(currentPage - 1)}>
          上一页
        </button>
        {knownPages ? (
          <nav className="qp-pagination__pages" aria-label="页码">
            {paginationPages(Math.min(currentPage, navigablePages), navigablePages).map((item) => typeof item === 'number' ? (
              <button key={item} className={`qp-pagination__page${item === currentPage ? ' is-active' : ''}`}
                type="button" aria-current={item === currentPage ? 'page' : undefined}
                aria-label={`第 ${item} 页`} disabled={loading} onClick={() => changePage(item)}>
                {item}
              </button>
            ) : <span key={item} className="qp-pagination__ellipsis" aria-hidden="true">…</span>)}
          </nav>
        ) : null}
        <button className="qp-button qp-button--ghost qp-button--sm" type="button"
          disabled={loading || !hasMore || (knownPages && currentPage >= navigablePages)}
          onClick={() => changePage(currentPage + 1)}>
          下一页
        </button>
        {knownPages ? (
          <form className="qp-pagination__jump" onSubmit={submitJump}>
            <span>跳至</span>
            <input className="qp-input qp-input--sm" type="number" min="1" max={navigablePages}
              value={jumpDraft} disabled={loading} aria-label="跳转页码"
              onChange={(event) => setJumpDraft(event.target.value)} />
            <span>页</span>
            <button className="qp-button qp-button--outline qp-button--sm" type="submit" disabled={loading}>跳转</button>
          </form>
        ) : null}
      </div>
    </footer>
  )
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`qp-field ${className}`.trim()}>
      <span className="qp-field__label">{label}</span>
      {children}
      {hint ? <span className="qp-field__hint">{hint}</span> : null}
    </label>
  )
}

export function DropdownField({ label, value, onChange, options, disabled = false, className = '' }) {
  const labelId = useId()
  const triggerId = useId()
  const listboxId = useId()
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const optionRefs = useRef([])
  const typeaheadRef = useRef({ value: '', timer: null })
  const [open, setOpen] = useState(false)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const firstEnabledIndex = useMemo(
    () => options.findIndex((option) => !option.disabled),
    [options],
  )
  const initialIndex = selectedIndex >= 0 ? selectedIndex : firstEnabledIndex
  const [highlightedIndex, setHighlightedIndex] = useState(initialIndex)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null

  const openMenu = () => {
    if (disabled) return
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex)
    setOpen(true)
  }

  const closeMenu = ({ restoreFocus = false } = {}) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const selectOption = (index) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setHighlightedIndex(index)
    closeMenu({ restoreFocus: true })
  }

  const moveHighlight = (delta) => {
    const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]))
    if (!enabled.length) return
    const position = enabled.indexOf(highlightedIndex)
    const nextPosition = position < 0
      ? (delta > 0 ? 0 : enabled.length - 1)
      : (position + delta + enabled.length) % enabled.length
    setHighlightedIndex(enabled[nextPosition])
  }

  const moveToEdge = (edge) => {
    const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]))
    if (enabled.length) setHighlightedIndex(edge === 'start' ? enabled[0] : enabled.at(-1))
  }

  const moveByCharacter = (character) => {
    if (!character || character.length !== 1 || /\s/u.test(character)) return false
    clearTimeout(typeaheadRef.current.timer)
    const query = `${typeaheadRef.current.value}${character}`.toLocaleLowerCase()
    const start = highlightedIndex >= 0 ? highlightedIndex + 1 : 0
    const ordered = [...options.keys()].map((_, offset) => (start + offset) % options.length)
    const match = ordered.find((index) => (
      !options[index].disabled && String(options[index].label).toLocaleLowerCase().startsWith(query)
    ))
    typeaheadRef.current.value = query
    typeaheadRef.current.timer = window.setTimeout(() => {
      typeaheadRef.current.value = ''
      typeaheadRef.current.timer = null
    }, 500)
    if (match !== undefined) {
      setHighlightedIndex(match)
      if (!open) setOpen(true)
    }
    return true
  }

  const onTriggerKeyDown = (event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      closeMenu()
      return
    }
    if (event.key === 'Tab') {
      closeMenu()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) openMenu()
      else moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      moveToEdge(event.key === 'Home' ? 'start' : 'end')
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) selectOption(highlightedIndex)
      else openMenu()
      return
    }
    if (moveByCharacter(event.key)) event.preventDefault()
  }

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) closeMenu()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  useEffect(() => {
    if (open) optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, open])

  useEffect(() => () => clearTimeout(typeaheadRef.current.timer), [])

  useEffect(() => {
    if (!open) setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex)
  }, [firstEnabledIndex, open, selectedIndex])

  return (
    <div
      ref={rootRef}
      className={`qp-field ${className}`.trim()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeMenu()
      }}
    >
      <span className="qp-field__label" id={labelId}>{label}</span>
      <div className={`qp-dropdown mih-dropdown${open ? ' is-open' : ''}`}>
        <button
          ref={triggerRef}
          id={triggerId}
          className="qp-dropdown__trigger"
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-labelledby={`${labelId} ${triggerId}`}
          aria-activedescendant={open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
          disabled={disabled}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={onTriggerKeyDown}
        >
          <span className="qp-dropdown__value">{selected?.label ?? (value ? `未知筛选：${value}` : '请选择')}</span>
          <CaretDown className="qp-dropdown__chevron" size={14} aria-hidden="true" />
        </button>
        <div className="qp-dropdown__menu mih-dropdown__menu" id={listboxId} role="listbox" aria-labelledby={labelId}>
          {options.map((option, index) => option.group ? (
            <div className="mih-dropdown__group" key={option.value} role="presentation">{option.label}</div>
          ) : (
            <button
              ref={(node) => { optionRefs.current[index] = node }}
              className={`qp-dropdown__option${index === selectedIndex ? ' is-selected' : ''}${index === highlightedIndex ? ' is-highlighted' : ''}`}
              id={`${listboxId}-option-${index}`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              tabIndex={-1}
              onMouseEnter={() => { if (!option.disabled) setHighlightedIndex(index) }}
              onClick={() => selectOption(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Modal({ title, description, children, footer, onClose, size = 'medium' }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const returnFocusRef = useRef(null)
  onCloseRef.current = onClose

  useEffect(() => {
    returnFocusRef.current = document.activeElement
    const dialog = dialogRef.current
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const focusableElements = () => [...(dialog?.querySelectorAll(focusableSelector) || [])]
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const elements = focusableElements()
      if (elements.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const [first] = elements
      const last = elements[elements.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const frame = window.requestAnimationFrame(() => {
      const initial = dialog?.querySelector('[autofocus]') || focusableElements()[0] || dialog
      initial?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      const returnTarget = returnFocusRef.current
      if (returnTarget instanceof HTMLElement && returnTarget.isConnected) returnTarget.focus()
    }
  }, [])

  return (
    <div className="mih-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={`mih-modal mih-modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="mih-modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="mih-modal__body">{children}</div>
        {footer ? <footer className="mih-modal__footer">{footer}</footer> : null}
      </section>
    </div>
  )
}

export function SecretPanel({ secret, onCopied }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      onCopied?.()
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="mih-secret-panel">
      <div className="mih-secret-panel__warning">
        <WarningCircle size={22} weight="duotone" aria-hidden="true" />
        <div>
          <strong>请立即保存此密钥</strong>
          <p>关闭窗口后，MX Insight Hub 不会再次显示完整密钥。</p>
        </div>
      </div>
      <div className="qp-input-group">
        <input className="qp-input mih-mono" value={secret} readOnly aria-label="新 API Key" />
        <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="复制 API Key" onClick={copy}>
          {copied ? <CheckCircle size={18} weight="fill" aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

export function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null
  return (
    <div className="mih-toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const Icon = toast.tone === 'danger' ? XCircle : toast.tone === 'warning' ? WarningCircle : CheckCircle
        return (
          <div className={`mih-toast mih-toast--${toast.tone}`} role={toast.tone === 'danger' ? 'alert' : 'status'} key={toast.id}>
            <Icon size={18} weight="fill" aria-hidden="true" />
            <span>{toast.message}</span>
            <button type="button" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function chartTheme() {
  const styles = getComputedStyle(document.documentElement)
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback
  return {
    primary: token('--qp-primary', '#2bf6d2'),
    success: token('--qp-success', '#48bc77'),
    danger: token('--qp-danger', '#ee6067'),
    warning: token('--qp-warning', '#f8d06c'),
    info: token('--qp-info', '#5e8eec'),
    archetype: token('--qp-archetype', '#b974ff'),
    text: token('--qp-text-2', 'rgba(226,226,226,.7)'),
    muted: token('--qp-text-3', 'rgba(226,226,226,.5)'),
    line: token('--qp-line', 'rgba(94,142,236,.18)'),
    panel: token('--qp-bg-4', '#292c37'),
  }
}

function useChart(buildConfig, signature) {
  const canvasRef = useRef(null)
  useEffect(() => {
    if (!canvasRef.current) return undefined
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const chart = new Chart(canvasRef.current, buildConfig(chartTheme(), reducedMotion))
    return () => chart.destroy()
  }, [buildConfig, signature])
  return canvasRef
}

export function OutcomeChart({ committed = 0, released = 0, unknown = 0, processing = 0 }) {
  const includeProcessing = Number(processing) > 0
  const values = useMemo(
    () => includeProcessing
      ? [committed, released, unknown, processing]
      : [committed, released, unknown],
    [committed, includeProcessing, processing, released, unknown],
  )
  const signature = values.join(':')
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'doughnut',
    data: {
      labels: includeProcessing ? ['成功', '已释放', '结果未知', '处理中'] : ['成功', '已释放', '结果未知'],
      datasets: [{
        data: values,
        backgroundColor: includeProcessing
          ? [theme.success, theme.danger, theme.warning, theme.info]
          : [theme.success, theme.danger, theme.warning],
        borderWidth: 0,
        spacing: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      animation: reducedMotion ? false : { duration: 220 },
      plugins: {
        legend: { position: 'bottom', labels: { color: theme.text, boxWidth: 10, boxHeight: 10, padding: 16 } },
        tooltip: { backgroundColor: theme.panel, titleColor: theme.text, bodyColor: theme.text },
      },
    },
  }), [includeProcessing, values])
  const ref = useChart(buildConfig, signature)
  return (
    <div className="mih-chart-canvas">
      <canvas
        ref={ref}
        role="img"
        aria-label={`成功 ${committed}，已释放 ${released}，结果未知 ${unknown}${includeProcessing ? `，处理中 ${processing}` : ''}`}
      />
    </div>
  )
}

export function PlatformChart({ entries }) {
  const labels = useMemo(() => entries.map(([platform]) => platformLabel(platform)), [entries])
  const values = useMemo(() => entries.map(([, value]) => Number(value.requests || 0)), [entries])
  const signature = `${labels.join('|')}:${values.join('|')}`
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '请求数',
        data: values,
        backgroundColor: theme.info,
        hoverBackgroundColor: theme.primary,
        borderRadius: 4,
        maxBarThickness: 52,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion ? false : { duration: 220 },
      scales: {
        x: { grid: { display: false }, ticks: { color: theme.text } },
        y: { beginAtZero: true, grid: { color: theme.line }, ticks: { color: theme.muted, precision: 0 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: theme.panel, titleColor: theme.text, bodyColor: theme.text },
      },
    },
  }), [labels, values])
  const ref = useChart(buildConfig, signature)
  return (
    <div className="mih-chart-canvas">
      <canvas ref={ref} role="img" aria-label={entries.map(([platform, value]) => `${platformLabel(platform)} ${value.requests || 0}`).join('，')} />
    </div>
  )
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0))
}

export function ReadinessGauge({ score, label, delta }) {
  const hasScore = score !== null && score !== undefined
  const normalized = hasScore ? clampPercent(score) : 0
  const values = useMemo(() => [normalized, 100 - normalized], [normalized])
  const signature = `${hasScore}:${values.join(':')}`
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'doughnut',
    data: {
      datasets: [{
        data: values,
        backgroundColor: [hasScore ? theme.primary : theme.muted, theme.line],
        borderWidth: 0,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      rotation: -120,
      circumference: 240,
      cutout: '78%',
      animation: reducedMotion ? false : { duration: 260 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  }), [hasScore, values])
  const ref = useChart(buildConfig, signature)
  return (
    <div className="mih-readiness-gauge">
      <canvas ref={ref} role="img" aria-label={hasScore ? `网关战备参考分 ${normalized} 分` : '当前窗口尚无请求，无法计算网关战备参考分'} />
      <div className="mih-readiness-gauge__value" aria-hidden="true">
        <strong>{hasScore ? normalized : '—'}{hasScore ? <small>/100</small> : null}</strong>
        <span>{label}</span>
      </div>
      <small className="mih-readiness-gauge__delta">{delta}</small>
    </div>
  )
}

export function StatusRing({ label, value, display, hint, tone = 'primary' }) {
  const normalized = clampPercent(value)
  const values = useMemo(() => [normalized, 100 - normalized], [normalized])
  const signature = `${tone}:${values.join(':')}`
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'doughnut',
    data: {
      datasets: [{
        data: values,
        backgroundColor: [theme[tone] || theme.primary, theme.line],
        borderWidth: 0,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '76%',
      animation: reducedMotion ? false : { duration: 220 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  }), [tone, values])
  const ref = useChart(buildConfig, signature)
  return (
    <article className="mih-status-ring">
      <div className="mih-status-ring__chart">
        <canvas ref={ref} role="img" aria-label={`${label} ${display}`} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{display}</strong>
        <small>{hint}</small>
      </div>
    </article>
  )
}

export function TrafficComparisonChart({ current = {}, previous = {} }) {
  const periods = useMemo(() => [previous, current], [current, previous])
  const values = useMemo(() => ({
    committed: periods.map((item) => Number(item.committed || 0)),
    released: periods.map((item) => Number(item.released || 0)),
    unknown: periods.map((item) => Number(item.unknown || 0)),
    processing: periods.map((item) => Math.max(0, Number(item.requests || 0)
      - Number(item.committed || 0) - Number(item.released || 0) - Number(item.unknown || 0))),
    successRate: periods.map((item) => item.requests ? Number(((Number(item.committed || 0) / Number(item.requests)) * 100).toFixed(2)) : 0),
  }), [periods])
  const signature = JSON.stringify(values)
  const comparisonLabel = `上一周期：成功 ${values.committed[0]}，已释放 ${values.released[0]}，结果未知 ${values.unknown[0]}，处理中 ${values.processing[0]}，成功率 ${values.successRate[0]}%；当前周期：成功 ${values.committed[1]}，已释放 ${values.released[1]}，结果未知 ${values.unknown[1]}，处理中 ${values.processing[1]}，成功率 ${values.successRate[1]}%`
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'bar',
    data: {
      labels: ['上一周期', '当前周期'],
      datasets: [
        { type: 'bar', label: '成功', data: values.committed, backgroundColor: theme.success, borderRadius: 3, maxBarThickness: 84, stack: 'outcome' },
        { type: 'bar', label: '已释放', data: values.released, backgroundColor: theme.danger, borderRadius: 3, maxBarThickness: 84, stack: 'outcome' },
        { type: 'bar', label: '结果未知', data: values.unknown, backgroundColor: theme.warning, borderRadius: 3, maxBarThickness: 84, stack: 'outcome' },
        { type: 'bar', label: '处理中', data: values.processing, backgroundColor: theme.info, borderRadius: 3, maxBarThickness: 84, stack: 'outcome' },
        {
          type: 'line',
          label: '成功率',
          data: values.successRate,
          yAxisID: 'rate',
          borderColor: theme.archetype,
          backgroundColor: theme.archetype,
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 5,
          tension: 0.28,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion ? false : { duration: 240 },
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: theme.text } },
        y: { stacked: true, beginAtZero: true, grid: { color: theme.line }, ticks: { color: theme.muted, precision: 0 } },
        rate: {
          position: 'right',
          min: 0,
          max: 100,
          grid: { display: false },
          ticks: { color: theme.archetype, callback: (value) => `${value}%` },
        },
      },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { color: theme.text, boxWidth: 9, boxHeight: 9, padding: 14 } },
        tooltip: { backgroundColor: theme.panel, titleColor: theme.text, bodyColor: theme.text },
      },
    },
  }), [values])
  const ref = useChart(buildConfig, signature)
  return (
    <div className="mih-chart-canvas mih-chart-canvas--comparison">
      <canvas ref={ref} role="img" aria-label={comparisonLabel} />
    </div>
  )
}

export function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', { notation: Number(value) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value || 0))
}

export function formatDate(value) {
  if (!value) return '从未'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function formatLatency(value) {
  if (value === null || value === undefined) return '暂无'
  return Number(value) >= 1000 ? `${(Number(value) / 1000).toFixed(2)} s` : `${Math.round(Number(value))} ms`
}

export function percent(part, total) {
  if (!total) return '0%'
  return `${Math.round((Number(part || 0) / Number(total)) * 100)}%`
}

export function platformLabel(platform) {
  const labels = {
    xiaohongshu: '小红书',
    weibo: '微博',
    douyin: '抖音',
    zhihu: '知乎',
    reddit: 'Reddit',
    tiktok: 'TikTok',
    instagram: 'Instagram',
    linkedin: 'LinkedIn',
    youtube: 'YouTube',
    wechat_search: '微信搜索',
    bilibili: '哔哩哔哩',
    kuaishou: '快手',
    twitter: 'X / Twitter',
    facebook: 'Facebook',
    wechat_mp: '微信公众号',
    telegram: 'Telegram',
    public_opinion: '全国省份舆情',
  }
  return labels[platform] || platform
}

export function rangeBounds(range) {
  const duration = range === '30d' ? 30 * 86400000 : range === '7d' ? 7 * 86400000 : 86400000
  const to = new Date()
  return { from: new Date(to.getTime() - duration).toISOString(), to: to.toISOString() }
}
