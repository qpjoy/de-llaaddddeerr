import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import {
  ArrowClockwise,
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

export function PageHeading({ eyebrow, title, description, loading, onRefresh, children }) {
  return (
    <header className="mih-page-heading">
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

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`qp-field ${className}`.trim()}>
      <span className="qp-field__label">{label}</span>
      {children}
      {hint ? <span className="qp-field__hint">{hint}</span> : null}
    </label>
  )
}

export function Modal({ title, description, children, footer, onClose, size = 'medium' }) {
  const titleId = useId()
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="mih-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`mih-modal mih-modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
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

export function OutcomeChart({ committed = 0, released = 0, unknown = 0 }) {
  const values = useMemo(() => [committed, released, unknown], [committed, released, unknown])
  const signature = values.join(':')
  const buildConfig = useCallback((theme, reducedMotion) => ({
    type: 'doughnut',
    data: {
      labels: ['成功', '已释放', '结果未知'],
      datasets: [{ data: values, backgroundColor: [theme.success, theme.danger, theme.warning], borderWidth: 0, spacing: 3 }],
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
  }), [values])
  const ref = useChart(buildConfig, signature)
  return (
    <div className="mih-chart-canvas">
      <canvas ref={ref} role="img" aria-label={`成功 ${committed}，已释放 ${released}，结果未知 ${unknown}`} />
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
      datasets: [{ label: '请求数', data: values, backgroundColor: theme.info, hoverBackgroundColor: theme.primary, borderRadius: 4 }],
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
  }
  return labels[platform] || platform
}

export function rangeBounds(range) {
  const duration = range === '30d' ? 30 * 86400000 : range === '7d' ? 7 * 86400000 : 86400000
  const to = new Date()
  return { from: new Date(to.getTime() - duration).toISOString(), to: to.toISOString() }
}
