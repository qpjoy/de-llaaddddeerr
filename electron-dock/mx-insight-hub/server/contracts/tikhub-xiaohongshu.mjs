import { createHash } from 'node:crypto'

export const XIAOHONGSHU_PLATFORM = 'xiaohongshu'
export const TIKHUB_PROVIDER_KEY = 'tikhub'
export const XIAOHONGSHU_POST_OPERATION = 'social.posts.resolve'
export const XIAOHONGSHU_POST_CONTRACT_VERSION = 'mx-insight-hub.social-post.v1'
export const TIKHUB_XIAOHONGSHU_ENDPOINT_KEY = 'xiaohongshu.image-note-detail.v2'
export const TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION = 'app_v2'
export const TIKHUB_XIAOHONGSHU_ENDPOINT_PATH = '/api/v1/xiaohongshu/app_v2/get_image_note_detail'

const REQUEST_FIELDS = new Set(['platform', 'url', 'deliveryMode'])
const DELIVERY_MODES = new Set(['cache_only', 'cache_first', 'refresh'])
const NOTE_ID_PATTERN = /^[0-9a-f]{24}$/iu
const LONG_HOSTS = new Set(['xiaohongshu.com', 'www.xiaohongshu.com'])
const SHORT_HOSTS = new Set(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'])
const MAX_TITLE_LENGTH = 500
const MAX_TEXT_LENGTH = 50_000
const MAX_TAGS = 100
const MAX_TAG_LENGTH = 160
const MAX_MEDIA = 20
const PRIVATE_FIELD = /^(?:access[_-]?token|api[_-]?key|auth|auth[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|credentials|jwt|key|password|passwd|private[_-]?key|refresh[_-]?token|secret|session(?:[_-]?(?:id|key|token))?|sid|sig|sign|signature|set[_-]?cookie|ticket|token|xsec[_-]?token)$/iu
const PRIVATE_ASSIGNMENT = /\b(access[_-]?token|api[_-]?key|auth(?:[_-]?key)?|authorization|bearer|client[_-]?secret|cookie|credential(?:s)?|jwt|key|password|passwd|private[_-]?key|refresh[_-]?token|secret|session(?:[_-]?(?:id|key|token))?|sid|sig|sign|signature|set[_-]?cookie|ticket|token|xsec[_-]?token)\s*[:=]\s*([^&;,\r\n]+)/giu
const PRIVATE_JSON_ASSIGNMENT = /"(access[_-]?token|api[_-]?key|auth(?:[_-]?key)?|authorization|bearer|client[_-]?secret|cookie|credential(?:s)?|jwt|key|password|passwd|private[_-]?key|refresh[_-]?token|secret|session(?:[_-]?(?:id|key|token))?|sid|sig|sign|signature|set[_-]?cookie|ticket|token|xsec[_-]?token)"\s*:\s*"(?:\\.|[^"\\])*"/giu
const PRIVATE_ESCAPED_JSON_ASSIGNMENT = /\\"(access[_-]?token|api[_-]?key|auth(?:[_-]?key)?|authorization|bearer|client[_-]?secret|cookie|credential(?:s)?|jwt|key|password|passwd|private[_-]?key|refresh[_-]?token|secret|session(?:[_-]?(?:id|key|token))?|sid|sig|sign|signature|set[_-]?cookie|ticket|token|xsec[_-]?token)\\"\s*:\s*\\"(?:\\\\.|[^"\\])*\\"/giu

export class TikHubXiaohongshuContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TikHubXiaohongshuContractError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new TikHubXiaohongshuContractError(code, message)
}

function string(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function boundedCodePoints(value, maximum) {
  const normalized = string(value)
  if (normalized == null) return { value: null, limited: false }

  const points = []
  let limited = false
  for (const point of normalized) {
    if (points.length === maximum) {
      limited = true
      break
    }
    const codePoint = point.codePointAt(0)
    // JSON permits escaped unpaired surrogates, but they are not Unicode
    // scalar values. Replace any provider-supplied lone surrogate while also
    // ensuring the length boundary can never split a valid surrogate pair.
    points.push(codePoint >= 0xD800 && codePoint <= 0xDFFF ? '\uFFFD' : point)
  }
  return { value: points.join(''), limited }
}

function boundedString(value, maximum) {
  return boundedCodePoints(value, maximum).value
}

function privateField(value) {
  const text = String(value)
  if (PRIVATE_FIELD.test(text)) return true
  const compact = text.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return /(?:accesskey|accesstoken|apikey|authkey|authorization|bearer|cookie|credential|jwt|password|passwd|privatekey|refreshtoken|secret|sessionid|sessionkey|sessiontoken|setcookie|signature|ticket|token|xsectoken)$/u.test(compact)
}

function redactTikHubString(value) {
  let result = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
  result = result.replace(PRIVATE_ESCAPED_JSON_ASSIGNMENT, '\\"$1\\":\\"[REDACTED]\\"')
  result = result.replace(PRIVATE_JSON_ASSIGNMENT, '"$1":"[REDACTED]"')
  result = result.replace(PRIVATE_ASSIGNMENT, '$1=[REDACTED]')
  try {
    const url = new URL(result)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (privateField(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.toString()
  } catch {
    return result
  }
}

function number(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function timestamp(value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizedUrl(value) {
  let url
  try { url = new URL(value) } catch {
    invalid('invalid_post_url', 'url must be an official Xiaohongshu note link')
  }
  const host = url.hostname.toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.port) {
    invalid('invalid_post_url', 'url must be an HTTP(S) Xiaohongshu link without credentials or fragment')
  }
  if (!LONG_HOSTS.has(host) && !SHORT_HOSTS.has(host)) {
    invalid('invalid_post_url', 'url must use an official Xiaohongshu or xhslink host')
  }
  if (LONG_HOSTS.has(host)) {
    const segments = url.pathname.split('/').filter(Boolean)
    const exactNotePath = segments.length === 2 && segments[0] === 'explore'
    const discoveryPath = segments.length === 3 && segments[0] === 'discovery' && segments[1] === 'item'
    if ((!exactNotePath && !discoveryPath) || !NOTE_ID_PATTERN.test(segments.at(-1) || '')) {
      invalid('invalid_post_url', 'url must be an official Xiaohongshu note detail link')
    }
  }
  url.hostname = host
  return url
}

function noteIdFromPath(pathname) {
  const segments = pathname.split('/').filter(Boolean)
  const candidate = segments.findLast((segment) => NOTE_ID_PATTERN.test(segment))
  return candidate ? candidate.toLowerCase() : null
}

export function normalizeXiaohongshuPostRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('invalid_request', 'request body must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !REQUEST_FIELDS.has(field))
  if (unsupported.length > 0) {
    invalid('unsupported_fields', `request contains unsupported field ${unsupported[0]}`)
  }
  if (input.platform !== XIAOHONGSHU_PLATFORM) {
    invalid('invalid_platform', 'platform must be xiaohongshu')
  }
  if (typeof input.url !== 'string' || !input.url.trim() || input.url.length > 2_048) {
    invalid('invalid_post_url', 'url must be a non-empty string of at most 2048 characters')
  }
  const url = normalizedUrl(input.url.trim())
  const deliveryMode = input.deliveryMode == null ? 'cache_first' : input.deliveryMode
  if (!DELIVERY_MODES.has(deliveryMode)) {
    invalid('invalid_delivery_mode', 'deliveryMode must be cache_only, cache_first, or refresh')
  }

  let identity
  let upstreamQuery
  if (SHORT_HOSTS.has(url.hostname)) {
    const normalized = url.toString()
    identity = { shareUrl: normalized }
    upstreamQuery = { share_text: normalized }
  } else {
    const noteId = noteIdFromPath(url.pathname)
    if (!noteId) {
      invalid('invalid_post_url', 'the Xiaohongshu link does not contain a 24-character note id')
    }
    identity = { noteId }
    upstreamQuery = { note_id: noteId }
  }

  return {
    platform: XIAOHONGSHU_PLATFORM,
    deliveryMode,
    identity,
    upstreamQuery,
    fingerprintBody: {
      contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
      platform: XIAOHONGSHU_PLATFORM,
      ...identity,
    },
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function usableNote(candidate) {
  if (!isRecord(candidate)) return false
  const id = string(candidate.note_id) || string(candidate.noteId) || string(candidate.id)
  const images = candidate.image_list || candidate.imageList || candidate.images
  const hasContent = string(candidate.title) || string(candidate.desc)
    || string(candidate.description) || string(candidate.content)
    || (Array.isArray(images) && images.length > 0)
  return Boolean(id && NOTE_ID_PATTERN.test(id) && hasContent)
}

function noteCandidate(payload) {
  // TikHub has returned both a direct `data` note and the App V2 envelope
  // `data.data[].note_list[]`.  Accept only these explicit verified paths; do
  // not recursively scan arbitrary provider JSON for a note-looking object.
  const outer = isRecord(payload?.data) ? payload.data : null
  if (!outer) return null
  const candidates = []
  if (usableNote(outer)) candidates.push(outer)
  const nested = outer.data
  const containers = Array.isArray(nested) ? nested : isRecord(nested) ? [nested] : []
  for (const container of containers) {
    if (!isRecord(container)) continue
    if (usableNote(container)) candidates.push(container)
    const notes = Array.isArray(container.note_list)
      ? container.note_list
      : Array.isArray(container.noteList) ? container.noteList : []
    candidates.push(...notes.filter(usableNote))
  }
  if (candidates.length > 1) {
    invalid('invalid_upstream_contract', 'TikHub note detail response contained multiple usable notes')
  }
  return candidates[0] || null
}

// TikHub documents that an accepted bad/missing note carries an upstream
// "service error" in data. Until a sanitized live fixture pins a richer shape,
// recognize only that direct bounded phrase. Generic schema examples use
// `data: null`, so null alone is not evidence of a request-local miss.
export function isTikHubXiaohongshuUnavailable(payload) {
  if (!isRecord(payload) || payload.code !== 200 || typeof payload.data !== 'string') return false
  const message = payload.data.trim()
  return message.length > 0 && message.length <= 512
    && /(?:服务异常|service\s+error)/iu.test(message)
}

function safeHttpsUrl(value, { official = false } = {}) {
  const normalized = string(value)
  if (!normalized || normalized.length > 2_048) return null
  try {
    const url = new URL(normalized)
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (url.port && url.port !== '443')
      || !hostname
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.svc')
      || (official && !LONG_HOSTS.has(hostname) && !SHORT_HOSTS.has(hostname))
    ) return null
    url.hostname = hostname
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function imageUrl(image) {
  if (typeof image === 'string') return safeHttpsUrl(image)
  if (!image || typeof image !== 'object') return null
  const info = Array.isArray(image.info_list) ? image.info_list : image.infoList
  return safeHttpsUrl(image.url_default) || safeHttpsUrl(image.urlDefault) || safeHttpsUrl(image.url_pre)
    || safeHttpsUrl(image.urlPre) || safeHttpsUrl(image.url)
    || (Array.isArray(info) ? info.map((entry) => safeHttpsUrl(entry?.url)).find(Boolean) : null)
}

function tagsOf(note) {
  const values = [note.tag_list, note.tagList, note.tags, note.topics, note.topic_list]
    .find(Array.isArray) || []
  return [...new Set(values.map((tag) => (
    boundedString(tag?.name, MAX_TAG_LENGTH) || boundedString(tag?.title, MAX_TAG_LENGTH)
      || boundedString(tag?.tag_name, MAX_TAG_LENGTH) || boundedString(tag?.tagName, MAX_TAG_LENGTH)
      || boundedString(tag, MAX_TAG_LENGTH)
  )).filter(Boolean))].slice(0, MAX_TAGS)
}

function mediaOf(note) {
  const images = [note.image_list, note.imageList, note.images]
    .find(Array.isArray) || []
  return [...new Set(images.map(imageUrl).filter(Boolean))]
    .slice(0, MAX_MEDIA)
    .map((url) => ({ type: 'image', url }))
}

export function normalizeTikHubXiaohongshuNoteResult(payload, { capturedAt = new Date() } = {}) {
  const note = noteCandidate(payload)
  if (!note) return null
  const user = note.user && typeof note.user === 'object'
    ? note.user
    : note.author && typeof note.author === 'object' ? note.author : {}
  const interactions = note.interact_info && typeof note.interact_info === 'object'
    ? note.interact_info
    : note.interactInfo && typeof note.interactInfo === 'object' ? note.interactInfo : {}
  const externalId = (string(note.note_id) || string(note.noteId) || string(note.id))?.toLowerCase()
  if (!externalId || !NOTE_ID_PATTERN.test(externalId)) return null
  const title = boundedString(note.title, MAX_TITLE_LENGTH)
    || boundedString(note.display_title, MAX_TITLE_LENGTH)
    || boundedString(note.displayTitle, MAX_TITLE_LENGTH)
  const body = boundedCodePoints(
    string(note.desc) || string(note.description) || string(note.content),
    MAX_TEXT_LENGTH,
  )
  const text = body.value || title
  const url = `https://www.xiaohongshu.com/explore/${externalId}`
  const collectedAt = new Date(capturedAt).toISOString()
  const item = {
    id: `${XIAOHONGSHU_PLATFORM}:${externalId}`,
    externalId,
    platform: XIAOHONGSHU_PLATFORM,
    contentType: 'post',
    url,
    title,
    text,
    tags: tagsOf(note),
    author: {
      id: boundedString(user.user_id, 128) || boundedString(user.userId, 128) || boundedString(user.id, 128),
      name: boundedString(user.nickname, 256) || boundedString(user.nick_name, 256) || boundedString(user.name, 256),
      avatarUrl: safeHttpsUrl(user.avatar) || safeHttpsUrl(user.avatar_url) || safeHttpsUrl(user.image),
    },
    metrics: {
      liked: number(interactions.liked_count ?? interactions.likedCount ?? note.liked_count),
      collected: number(interactions.collected_count ?? interactions.collectedCount ?? note.collected_count),
      comments: number(interactions.comment_count ?? interactions.commentCount ?? note.comment_count),
      shared: number(interactions.share_count ?? interactions.shareCount ?? note.share_count),
    },
    media: mediaOf(note),
    publishedAt: timestamp(note.timestamp ?? note.time ?? note.create_time ?? note.createTime),
    collectedAt,
  }
  return { item, safetyLimited: body.limited }
}

export function normalizeTikHubXiaohongshuNote(payload, options) {
  return normalizeTikHubXiaohongshuNoteResult(payload, options)?.item ?? null
}

export function sha256Json(value) {
  const canonical = (candidate) => {
    if (Array.isArray(candidate)) return `[${candidate.map(canonical).join(',')}]`
    if (candidate && typeof candidate === 'object') {
      return `{${Object.keys(candidate).sort().map((key) => `${JSON.stringify(key)}:${canonical(candidate[key])}`).join(',')}}`
    }
    return JSON.stringify(candidate === undefined ? null : candidate)
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function redactTikHubEnvelope(payload) {
  if (Array.isArray(payload)) return payload.map(redactTikHubEnvelope)
  if (typeof payload === 'string') {
    if (/^\s*bearer\s+/iu.test(payload)) return '[REDACTED]'
    return redactTikHubString(payload)
  }
  if (!payload || typeof payload !== 'object') return payload
  const redacted = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'cache_url' || key === 'params' || privateField(key)) continue
    redacted[key] = redactTikHubEnvelope(value)
  }
  return redacted
}
