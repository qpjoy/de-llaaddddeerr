// 传感器（自动检查项）：每一步都免费的隐式判据。
//
// A test fails only where someone wrote an assertion. Most real defects are
// where nobody did: an uncaught exception, an API answering 500, a page that
// renders nothing, a spinner that never stops, `undefined` printed where a
// name belongs. Sensors watch for those on every step the browser station
// takes — an Agent's action, a procedure's replay, a station's regression —
// with no model and no assertion written.
//
// A reading is a lead (线索), never a verdict: nothing here changes a step's
// or a run's result. A project may later promote a low-noise sensor to a gate
// (docs/20 §4.2); until then a person reads them beside the result.
//
// Page content is untrusted and may hold business data: messages are cut
// short and scrubbed of anything shaped like a credential before they leave
// the page, URLs keep their path only, and a parameter that looks like a
// token is reported by name, never by value.

import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'

export const SENSORS = Object.freeze({
  page_error: { label: '页面异常', severity: 'error' },
  console_error: { label: '控制台报错', severity: 'warn' },
  http_error: { label: '接口失败', severity: 'error' },
  request_failed: { label: '请求失败', severity: 'warn' },
  slow_request: { label: '慢接口', severity: 'notice' },
  blank_page: { label: '白屏', severity: 'error' },
  stuck_loading: { label: '加载卡死', severity: 'warn' },
  content_leak: { label: '内容泄漏', severity: 'warn' },
  text_truncated: { label: '文字截断', severity: 'notice' },
  dead_click: { label: '无效点击', severity: 'notice' },
  secret_in_url: { label: 'URL 中的令牌', severity: 'warn' },
  slow_page: { label: '首屏慢', severity: 'notice' },
  layout_shift: { label: '布局跳动', severity: 'notice' }
})

export const SEVERITIES = Object.freeze(['error', 'warn', 'notice'])

export const SENSOR_DEFAULTS = Object.freeze({
  // An XHR/fetch slower than this is a lead.
  slowRequestMs: 1500,
  // A loading indicator still showing after this long is stuck.
  stuckMs: 8000,
  // Web Vitals' published "poor" thresholds.
  lcpPoorMs: 4000,
  clsPoor: 0.25,
  maxSignals: 100
})

// A blank page is looked at twice: a framework may clear the page an instant
// before it renders the next one.
const BLANK_RECHECK_MS = 600
// A click whose effect is asynchronous gets this long to show one.
const DEAD_CLICK_MS = 400
// A page busy enough not to answer within this is skipped, not waited for.
const PROBE_TIMEOUT_MS = 2000
const PROBE_NODES = 4000
const DURATIONS_KEPT = 2000

// What a request was for. Images, fonts and media failing are the page's
// cosmetics; these are its function.
const WATCHED = new Set(['document', 'xhr', 'fetch', 'script', 'stylesheet'])
const API = new Set(['xhr', 'fetch'])

const SECRET_PARAM =
  /^(token|access[_-]?token|id[_-]?token|refresh[_-]?token|auth|authorization|password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|session|session[_-]?id|sid|jwt|ticket)$/i
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
const JWT_ONE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/
// No `/`: a long path is not a token.
const LONG_TOKEN = /[A-Za-z0-9_\-+]{32,}={0,2}/g
const ID_SEGMENT = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{32,36}|[A-Za-z0-9_-]{24,})$/i

const signalShape = {
  sensor: z.enum(Object.keys(SENSORS)),
  label: z.string().max(40),
  severity: z.enum(SEVERITIES),
  title: z.string().max(200),
  detail: z.string().max(400).optional(),
  url: z.string().max(600).nullable().optional(),
  step: z.number().int().min(0).max(10_000).nullable().optional(),
  count: z.number().int().min(1).max(1_000_000).optional(),
  at: z.iso.datetime().optional(),
  signature: z.string().max(240),
  evidence: z
    .record(z.string().max(40), z.union([z.string().max(600), z.number(), z.boolean(), z.null()]))
    .optional()
}
export const signalSchema = z.object(signalShape).strict()

const ms = z.number().min(0).max(86_400_000)
export const metricsSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            url: z.string().max(600),
            lcpMs: ms.nullable(),
            cls: z.number().min(0).max(1000).nullable(),
            longTasks: z.number().int().min(0).nullable(),
            domContentLoadedMs: ms.nullable(),
            loadMs: ms.nullable()
          })
          .strict()
      )
      .max(50),
    requests: z
      .object({
        count: z.number().int().min(0),
        failed: z.number().int().min(0),
        slow: z.number().int().min(0),
        p50Ms: ms.nullable(),
        p95Ms: ms.nullable(),
        maxMs: ms.nullable()
      })
      .strict()
  })
  .strict()

/** A URL as a place: origin and path, with ids folded so `/items/42` and `/items/43` are one. */
export function pathPattern(raw) {
  try {
    const url = new URL(raw)
    const path = url.pathname
      .split('/')
      .map((segment) => (segment && ID_SEGMENT.test(segment) ? ':id' : segment))
      .join('/')
    return `${url.origin}${path}`
  } catch {
    return ''
  }
}

/** A URL without its query and fragment: those are where credentials and personal data travel. */
export function plainUrl(raw) {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

/** Text from a page, short and with anything shaped like a token taken out. */
export function scrub(text, max = 300) {
  const clean = String(text ?? '')
    .replace(JWT, '••••••')
    .replace(LONG_TOKEN, '••••••')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The names of query or fragment parameters that carry a credential. Never their values. */
export function secretParams(raw) {
  try {
    const url = new URL(raw)
    const found = []
    for (const [key, value] of url.searchParams)
      if (SECRET_PARAM.test(key) || JWT_ONE.test(value)) found.push(key)
    if (url.hash.includes('='))
      for (const [key, value] of new URLSearchParams(url.hash.slice(1)))
        if (SECRET_PARAM.test(key) || JWT_ONE.test(value)) found.push(`#${key}`)
    return [...new Set(found)]
  } catch {
    return []
  }
}

const normalize = (text) =>
  String(text ?? '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 120)

/** Signals from many steps as one list: the same signature counted, not repeated. */
export function mergeSignals(current = [], incoming = [], limit = SENSOR_DEFAULTS.maxSignals) {
  const out = current.map((signal) => ({ ...signal }))
  const index = new Map(out.map((signal, position) => [signal.signature, position]))
  for (const signal of incoming) {
    const at = index.get(signal.signature)
    if (at !== undefined) out[at].count = (out[at].count ?? 1) + (signal.count ?? 1)
    else if (out.length < limit) {
      index.set(signal.signature, out.length)
      out.push({ ...signal })
    }
  }
  return out
}

/** Counts a person can read at a glance: by severity, and by sensor. */
export function summarizeSignals(signals = []) {
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]))
  const bySensor = {}
  for (const signal of signals) {
    bySeverity[signal.severity] = (bySeverity[signal.severity] ?? 0) + 1
    bySensor[signal.sensor] = (bySensor[signal.sensor] ?? 0) + 1
  }
  return { total: signals.length, bySeverity, bySensor }
}

/**
 * Web Vitals as the page measures them, from its first moment: installed as
 * an init script, read by the probe. Buffered observers also catch what
 * happened before the script ran.
 */
export function vitalsScript() {
  if (window.__mxRigVitals) return
  const vitals = (window.__mxRigVitals = { lcp: null, cls: 0, longTasks: 0 })
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcp = Math.round(entry.startTime)
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {
    /* Not measured here. */
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) vitals.cls += entry.value
    }).observe({ type: 'layout-shift', buffered: true })
  } catch {
    /* Not measured here. */
  }
  try {
    new PerformanceObserver((list) => {
      vitals.longTasks += list.getEntries().length
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    /* Not measured here. */
  }
}

/**
 * Everything the probe reads in one pass over the page. Runs in the page, so
 * it refers to nothing outside itself. The pilot's own overlay is not the
 * page and is skipped.
 */
function probePage({ maxNodes }) {
  const out = { url: location.href, blank: false, loading: [], leaks: [], truncated: [], vitals: null }
  const visible = (element) => {
    if (!element || element.closest('mx-rig-pilot')) return false
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
  const body = document.body
  if (!body) {
    out.blank = true
    return out
  }
  const text = (body.innerText || '').trim()
  const media = [...document.querySelectorAll('img, svg, canvas, video, iframe, object, embed')].some(visible)
  out.blank = text.length === 0 && !media
  const LOADING = [
    '[role="progressbar"]',
    '[aria-busy="true"]',
    '.loading',
    '.spinner',
    '.q-spinner',
    '.q-loading',
    '.el-loading-mask',
    '.ant-spin-spinning',
    '.van-loading'
  ]
  for (const selector of LOADING)
    for (const element of document.querySelectorAll(selector))
      if (visible(element)) {
        out.loading.push(selector)
        break
      }
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'TEMPLATE', 'INPUT', 'SELECT', 'OPTION'])
  const LEAK = /(^|[^A-Za-z0-9_])(undefined|NaN|\[object Object\]|Invalid Date)(?![A-Za-z0-9_])|\{\{[^{}]{0,60}\}\}/
  const KEY = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+){2,}$/
  const NOT_A_KEY = /^(com|cn|net|org|io|dev|app|gov|edu|info|local|co|me|ai|html|htm|js|mjs|css|json|png|jpg|jpeg|gif|svg|pdf|zip|md|txt)$/i
  const seen = new Set()
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let nodes = 0
  while (walker.nextNode() && nodes < maxNodes && out.leaks.length < 10) {
    nodes += 1
    const value = walker.currentNode.nodeValue.trim()
    if (!value || value.length > 400) continue
    const parent = walker.currentNode.parentElement
    if (!parent || SKIP.has(parent.tagName) || parent.closest('code, pre, [contenteditable="true"]')) continue
    let kind = null
    if (LEAK.test(value) || value === 'null') kind = 'placeholder'
    else if (KEY.test(value) && !NOT_A_KEY.test(value.split('.').at(-1))) kind = 'i18n'
    if (!kind || seen.has(value) || !visible(parent)) continue
    seen.add(value)
    out.leaks.push({ kind, text: value.slice(0, 80), tag: parent.tagName.toLowerCase() })
  }
  let checked = 0
  for (const element of body.querySelectorAll('button, a, label, th, td, h1, h2, h3, h4, li, span, p, div')) {
    if (out.truncated.length >= 10 || ++checked > maxNodes) break
    if (![...element.childNodes].some((child) => child.nodeType === 3 && child.nodeValue.trim())) continue
    if (element.clientWidth === 0 || element.scrollWidth <= element.clientWidth + 1) continue
    const style = getComputedStyle(element)
    if (!['hidden', 'clip'].includes(style.overflowX) && style.textOverflow !== 'ellipsis') continue
    if (element.title || element.getAttribute('aria-label') || !visible(element)) continue
    out.truncated.push({ text: (element.textContent || '').trim().slice(0, 80), tag: element.tagName.toLowerCase() })
  }
  const vitals = window.__mxRigVitals
  const navigation = performance.getEntriesByType?.('navigation')?.[0]
  out.vitals = {
    lcpMs: vitals?.lcp ?? null,
    cls: vitals ? Math.round(vitals.cls * 1000) / 1000 : null,
    longTasks: vitals?.longTasks ?? null,
    domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
    loadMs: navigation && navigation.loadEventEnd > 0 ? Math.round(navigation.loadEventEnd) : null
  }
  return out
}

/**
 * Count what changes in the page from now on — not the station's own nodes:
 * the pilot's overlay, and the glass Playwright lays over a page while it
 * takes a masked screenshot.
 */
function armMutations() {
  window.__mxRigMutations = 0
  if (window.__mxRigObserver) return
  const pilot = (node) =>
    node?.nodeName === 'MX-RIG-PILOT' ||
    String(node?.nodeName ?? '').startsWith('X-PW-') ||
    Boolean(node?.closest?.('mx-rig-pilot'))
  window.__mxRigObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (pilot(record.target)) continue
      const nodes = [...record.addedNodes, ...record.removedNodes]
      if (record.type === 'childList' && nodes.length && nodes.every(pilot)) continue
      window.__mxRigMutations += 1
    }
  })
  window.__mxRigObserver.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
}

function countMutations() {
  return typeof window.__mxRigMutations === 'number' ? window.__mxRigMutations : -1
}

/** The page's answer, or nothing: a busy or departed page is not waited for. */
async function ask(page, fn, arg) {
  if (typeof page?.evaluate !== 'function') return null
  try {
    return await Promise.race([
      Promise.resolve(page.evaluate(fn, arg)).catch(() => null),
      sleep(PROBE_TIMEOUT_MS, null)
    ])
  } catch {
    return null
  }
}

const describeRequest = (request) => {
  let method = 'GET'
  try {
    method = request.method()
  } catch {
    /* A double without methods. */
  }
  const url = request.url()
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    /* Not a URL we can shorten. */
  }
  return { method, url, path: scrub(path, 160) }
}

/**
 * One browser session's sensors. The browser station makes one per context
 * and tells it which step is current; everything it reads is kept as a
 * signal, deduplicated by signature, until the station takes it.
 */
export class Sensors {
  constructor(options = {}) {
    this.options = { ...SENSOR_DEFAULTS, ...options }
    this.signals = []
    this.bySignature = new Map()
    this.fresh = []
    this.dropped = 0
    this.step = null
    this.refused = new WeakSet()
    this.started = new WeakMap()
    this.requestTotal = 0
    this.requests = { count: 0, failed: 0, slow: 0, durations: [] }
    this.loading = new Map()
    this.pages = new Map()
    this.clickMark = null
    this.stopped = false
  }

  /** Which step what follows belongs to. */
  at(step) {
    this.step = Number.isInteger(step) && step >= 0 ? step : null
  }

  /** A request the station itself stopped (outside this mission's sites): not the page failing. */
  refuse(request) {
    try {
      this.refused.add(request)
    } catch {
      /* Not an object to remember. */
    }
  }

  attachContext(context) {
    context?.on?.('request', (request) => this.#request(request))
    context?.on?.('response', (response) => this.#response(response))
    context?.on?.('requestfinished', (request) => this.#finished(request))
    context?.on?.('requestfailed', (request) => this.#failed(request))
  }

  attachPage(page) {
    page?.on?.('pageerror', (error) => this.#pageError(page, error))
    page?.on?.('console', (message) => this.#console(page, message))
    page?.on?.('framenavigated', (frame) => {
      try {
        if (frame === page.mainFrame()) this.#secrets(frame.url(), '页面地址')
      } catch {
        /* A double without frames. */
      }
    })
  }

  /** What the page looks like now: blank, loading, leaking text, cutting text off, how fast it was. */
  async probe(page, { step } = {}) {
    if (this.stopped) return
    if (step !== undefined) this.at(step)
    let seen = await ask(page, probePage, { maxNodes: PROBE_NODES })
    if (!seen || typeof seen !== 'object') return
    if (seen.blank) {
      await sleep(BLANK_RECHECK_MS)
      const again = await ask(page, probePage, { maxNodes: PROBE_NODES })
      if (again && typeof again === 'object') seen = again
      if (seen.blank) this.#add('blank_page', { title: '页面加载后几乎没有任何内容（白屏）', url: seen.url })
    }
    this.#loading(seen)
    for (const leak of seen.leaks ?? [])
      this.#add('content_leak', {
        title:
          leak.kind === 'i18n'
            ? `页面上出现了未翻译的文案键「${leak.text}」`
            : `页面上出现了「${leak.text}」`,
        url: seen.url,
        key: leak.text,
        evidence: { kind: leak.kind, tag: String(leak.tag ?? '') }
      })
    for (const cut of seen.truncated ?? [])
      this.#add('text_truncated', {
        title: `文字被截断，而且没有办法看到全文：「${cut.text}」`,
        url: seen.url,
        key: cut.text,
        evidence: { tag: String(cut.tag ?? '') }
      })
    this.#vitals(seen)
  }

  /** Before a click: start counting what changes. */
  async armClick(page) {
    if (this.stopped || typeof page?.evaluate !== 'function') return
    let url = null
    try {
      url = page.url()
    } catch {
      /* No address to compare. */
    }
    this.clickMark = { requests: this.requestTotal, url }
    await ask(page, armMutations)
  }

  /**
   * After a click: did anything happen — a request, a navigation, a change to
   * the page, a dialog, a download, a new tab? Nothing at all is a lead: a
   * button that does nothing is either broken or should not be a button.
   */
  async checkClick(page, { label = null, effects = false } = {}) {
    const mark = this.clickMark
    this.clickMark = null
    if (this.stopped || !mark || effects || typeof page?.evaluate !== 'function') return
    const changed = async () => {
      if (this.requestTotal > mark.requests) return true
      try {
        if (page.url() !== mark.url) return true
      } catch {
        return true
      }
      // Not knowing (-1, null) counts as a change: a lead must be sure of itself.
      return (await ask(page, countMutations)) !== 0
    }
    if (await changed()) return
    await sleep(DEAD_CLICK_MS)
    if (await changed()) return
    this.#add('dead_click', {
      title: `点击${label ? `「${label}」` : ''}之后页面没有任何反应`,
      url: page.url(),
      key: label ?? ''
    })
  }

  /**
   * The end of a session: a loading indicator still on screen gets the rest
   * of its allowance, then the page is read a last time.
   */
  async finish(page) {
    if (this.stopped || !page) return
    // Looked at twice a second: one that stops early ends the wait early.
    while (!this.stopped) {
      const waiting = [...this.loading.values()].filter((entry) => !entry.reported)
      if (!waiting.length) break
      const remaining = this.options.stuckMs - (Date.now() - Math.min(...waiting.map((entry) => entry.since)))
      if (remaining <= 0) break
      await sleep(Math.min(500, remaining))
      await this.probe(page)
    }
    await this.probe(page)
  }

  /** Signals read since the last call. */
  take() {
    return this.fresh.splice(0).map((signal) => ({ ...signal }))
  }

  /** Every signal of the session, deduplicated. */
  all() {
    return this.signals.map((signal) => ({ ...signal }))
  }

  /** What a monitor would chart: per page timings, and the API calls' latency. */
  metrics() {
    const sorted = [...this.requests.durations].sort((a, b) => a - b)
    const rank = (q) => (sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null)
    return {
      pages: [...this.pages.values()].slice(0, 50),
      requests: {
        count: this.requests.count,
        failed: this.requests.failed,
        slow: this.requests.slow,
        p50Ms: rank(0.5),
        p95Ms: rank(0.95),
        maxMs: sorted.at(-1) ?? null
      }
    }
  }

  stop() {
    this.stopped = true
  }

  #request(request) {
    if (this.stopped) return
    this.requestTotal += 1
    let type
    try {
      type = request.resourceType()
    } catch {
      return
    }
    if (!WATCHED.has(type)) return
    this.started.set(request, Date.now())
    if (API.has(type)) {
      this.requests.count += 1
      this.#secrets(request.url(), '接口请求的地址')
    }
  }

  #response(response) {
    if (this.stopped) return
    try {
      const request = response.request()
      const type = request.resourceType()
      if (!WATCHED.has(type)) return
      const status = response.status()
      const { method, url, path } = describeRequest(request)
      if (status >= 500)
        this.#add('http_error', {
          title: `${method} ${path} 返回 ${status}`,
          url,
          key: `${method} ${status}`,
          evidence: { method, status, type }
        })
      else if (status === 404 && (type === 'script' || type === 'stylesheet'))
        this.#add('request_failed', {
          title: `页面引用的资源不存在（404）：${path}`,
          url,
          key: `404 ${type}`,
          evidence: { status, type }
        })
    } catch {
      /* A response we cannot read. */
    }
  }

  #finished(request) {
    if (this.stopped) return
    try {
      if (!API.has(request.resourceType())) return
      let took = null
      try {
        const timing = request.timing()
        if (timing && timing.responseEnd >= 0) took = Math.round(timing.responseEnd)
      } catch {
        /* No timing from this engine. */
      }
      const begun = this.started.get(request)
      if (took === null && begun) took = Date.now() - begun
      if (took === null) return
      if (this.requests.durations.length < DURATIONS_KEPT) this.requests.durations.push(took)
      if (took <= this.options.slowRequestMs) return
      this.requests.slow += 1
      const { method, url, path } = describeRequest(request)
      this.#add('slow_request', {
        title: `${method} ${path} 用了 ${took} ms（预算 ${this.options.slowRequestMs} ms）`,
        url,
        key: method,
        evidence: { method, durationMs: took, budgetMs: this.options.slowRequestMs }
      })
    } catch {
      /* A request we cannot read. */
    }
  }

  #failed(request) {
    if (this.stopped || this.refused.has(request)) return
    try {
      const type = request.resourceType()
      if (!WATCHED.has(type)) return
      const reason = String(request.failure()?.errorText ?? '')
      // Cancelled by a navigation or by the page itself: not a failure.
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancel/i.test(reason)) return
      if (API.has(type)) this.requests.failed += 1
      const { method, url, path } = describeRequest(request)
      this.#add('request_failed', {
        title: `${method} ${path} 请求失败`,
        detail: reason,
        url,
        key: `${method} ${reason}`,
        evidence: { method, type, reason: scrub(reason, 120) }
      })
    } catch {
      /* A request we cannot read. */
    }
  }

  #pageError(page, error) {
    const message = String(error?.message ?? error ?? '').split('\n')[0]
    this.#add('page_error', { title: `未捕获的异常：${scrub(message, 160)}`, url: urlOf(page), key: message })
  }

  #console(page, message) {
    try {
      if (message.type() !== 'error') return
      const text = String(message.text() ?? '')
      // A failed load is the network sensors' to report, with its status.
      if (/^Failed to load resource\b/.test(text)) return
      this.#add('console_error', { title: `控制台报错：${scrub(text, 160)}`, url: urlOf(page), key: text })
    } catch {
      /* A message we cannot read. */
    }
  }

  #secrets(url, where) {
    const names = secretParams(url)
    if (!names.length) return
    this.#add('secret_in_url', {
      title: `${where}里带着令牌类参数：${names.join('、')}`,
      url,
      key: names.join(','),
      evidence: { params: names.join(',').slice(0, 200) }
    })
  }

  #loading(seen) {
    const now = Date.now()
    const place = pathPattern(seen.url)
    const present = new Map((seen.loading ?? []).map((selector) => [`${place}|${selector}`, selector]))
    for (const key of [...this.loading.keys()]) if (!present.has(key)) this.loading.delete(key)
    for (const [key, selector] of present) {
      const entry = this.loading.get(key)
      if (!entry) {
        this.loading.set(key, { since: now, reported: false })
        continue
      }
      const waited = now - entry.since
      if (entry.reported || waited < this.options.stuckMs) continue
      entry.reported = true
      this.#add('stuck_loading', {
        title: `加载提示持续了 ${Math.round(waited / 1000)} 秒还没有结束`,
        url: seen.url,
        key: selector,
        evidence: { selector, waitedMs: waited }
      })
    }
  }

  #vitals(seen) {
    const vitals = seen.vitals
    const url = plainUrl(seen.url)
    if (!vitals || !url) return
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
    const entry = {
      url,
      lcpMs: number(vitals.lcpMs),
      cls: number(vitals.cls),
      longTasks: Number.isInteger(vitals.longTasks) && vitals.longTasks >= 0 ? vitals.longTasks : null,
      domContentLoadedMs: number(vitals.domContentLoadedMs),
      loadMs: number(vitals.loadMs)
    }
    this.pages.set(url, entry)
    if (entry.lcpMs !== null && entry.lcpMs > this.options.lcpPoorMs)
      this.#add('slow_page', {
        title: `首屏最大内容绘制（LCP）用了 ${entry.lcpMs} ms，超过 ${this.options.lcpPoorMs} ms`,
        url,
        key: 'lcp',
        evidence: { lcpMs: entry.lcpMs }
      })
    if (entry.cls !== null && entry.cls > this.options.clsPoor)
      this.#add('layout_shift', {
        title: `布局累计偏移（CLS）${entry.cls}，超过 ${this.options.clsPoor}`,
        url,
        key: 'cls',
        evidence: { cls: entry.cls }
      })
  }

  #add(sensor, { title, detail = null, url = null, key = null, evidence = null }) {
    if (this.stopped) return null
    const spec = SENSORS[sensor]
    const signature = `${sensor}|${url ? pathPattern(url) : ''}|${normalize(key ?? title)}`.slice(0, 240)
    const existing = this.bySignature.get(signature)
    if (existing) {
      existing.count += 1
      return existing
    }
    if (this.signals.length >= this.options.maxSignals) {
      this.dropped += 1
      return null
    }
    const signal = {
      sensor,
      label: spec.label,
      severity: spec.severity,
      title: scrub(title, 200),
      ...(detail ? { detail: scrub(detail, 400) } : {}),
      url: url ? plainUrl(url) : null,
      step: this.step,
      count: 1,
      at: new Date().toISOString(),
      signature,
      ...(evidence ? { evidence } : {})
    }
    this.signals.push(signal)
    this.bySignature.set(signature, signal)
    this.fresh.push(signal)
    return signal
  }
}

function urlOf(page) {
  try {
    return page.url()
  } catch {
    return null
  }
}
