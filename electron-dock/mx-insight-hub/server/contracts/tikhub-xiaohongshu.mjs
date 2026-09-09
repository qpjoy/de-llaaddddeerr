import { createHash } from 'node:crypto'
import { redactCredentialEcho } from '../core/credential-redaction.mjs'

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

function scalarSafe(value) {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index] + value[index + 1]
        index += 1
      } else {
        result += '\uFFFD'
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += '\uFFFD'
    } else {
      result += value[index]
    }
  }
  return result
}

function boundedCodePoints(value, _maximum) {
  const normalized = string(value)
  if (normalized == null) return { value: null }
  // The complete HTTP response is already bounded by the adapter. A second
  // field-level ceiling would destroy valid acquired business content.
  // Repair only impossible Unicode scalar sequences before JSONB/ES ingest;
  // this does not trim or redact valid provider business content.
  return { value: scalarSafe(normalized) }
}

function boundedString(value, maximum) {
  return boundedCodePoints(value, maximum).value
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

  const noteFingerprintBody = {
    contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
    platform: XIAOHONGSHU_PLATFORM,
    ...identity,
  }

  return {
    platform: XIAOHONGSHU_PLATFORM,
    deliveryMode,
    identity,
    upstreamQuery,
    fingerprintBody: {
      ...noteFingerprintBody,
      deliveryMode,
    },
    noteFingerprintBody,
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

// TikHub documents that accepted bad/missing note and user identity lookups
// carry an upstream "service error" in data. Until a sanitized live fixture
// pins a richer shape, recognize only that direct bounded phrase. Generic
// schema examples use `data: null`, so null alone is not evidence of a
// request-local miss.
export function isTikHubXiaohongshuUnavailable(payload) {
  if (!isRecord(payload) || payload.code !== 200 || typeof payload.data !== 'string') return false
  const message = payload.data.trim()
  return message.length > 0 && message.length <= 512
    && /(?:服务异常|service\s+error)/iu.test(message)
}

function safeHttpsUrl(value, { official = false, providerCredential = null } = {}) {
  const normalized = string(value)
  if (!normalized) return null
  try {
    const credentialSafe = redactCredentialEcho(normalized, providerCredential)
    const url = new URL(credentialSafe)
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
    // Signed media query strings are acquired business data and often make the
    // URL usable. They are not the Hub-to-provider API credential.
    return url.toString()
  } catch {
    return null
  }
}

function imageUrl(image, options) {
  if (typeof image === 'string') return safeHttpsUrl(image, options)
  if (!image || typeof image !== 'object') return null
  const info = Array.isArray(image.info_list) ? image.info_list : image.infoList
  return safeHttpsUrl(image.url_default, options) || safeHttpsUrl(image.urlDefault, options)
    || safeHttpsUrl(image.url_pre, options) || safeHttpsUrl(image.urlPre, options)
    || safeHttpsUrl(image.url, options)
    || (Array.isArray(info) ? info.map((entry) => safeHttpsUrl(entry?.url, options)).find(Boolean) : null)
}

function tagsOf(note) {
  const values = [note.tag_list, note.tagList, note.tags, note.topics, note.topic_list]
    .find(Array.isArray) || []
  return [...new Set(values.map((tag) => (
    boundedString(tag?.name) || boundedString(tag?.title)
      || boundedString(tag?.tag_name) || boundedString(tag?.tagName)
      || boundedString(tag)
  )).filter(Boolean))]
}

function mediaOf(note, options) {
  const images = [note.image_list, note.imageList, note.images]
    .find(Array.isArray) || []
  return [...new Set(images.map((image) => imageUrl(image, options)).filter(Boolean))]
    .map((url) => ({ type: 'image', url }))
}

export function normalizeTikHubXiaohongshuNoteResult(payload, {
  capturedAt = new Date(),
  providerCredential = null,
} = {}) {
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
  const title = boundedString(note.title)
    || boundedString(note.display_title)
    || boundedString(note.displayTitle)
  const body = boundedCodePoints(
    string(note.desc) || string(note.description) || string(note.content),
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
      id: boundedString(user.user_id) || boundedString(user.userId) || boundedString(user.id),
      name: boundedString(user.nickname) || boundedString(user.nick_name) || boundedString(user.name),
      avatarUrl: safeHttpsUrl(user.avatar, { providerCredential })
        || safeHttpsUrl(user.avatar_url, { providerCredential })
        || safeHttpsUrl(user.image, { providerCredential }),
    },
    metrics: {
      liked: number(interactions.liked_count ?? interactions.likedCount ?? note.liked_count),
      collected: number(interactions.collected_count ?? interactions.collectedCount ?? note.collected_count),
      comments: number(interactions.comment_count ?? interactions.commentCount ?? note.comment_count),
      shared: number(interactions.share_count ?? interactions.shareCount ?? note.share_count),
    },
    media: mediaOf(note, { providerCredential }),
    publishedAt: timestamp(note.timestamp ?? note.time ?? note.create_time ?? note.createTime),
    collectedAt,
  }
  return { item }
}

export function normalizeTikHubXiaohongshuNote(payload, options) {
  return normalizeTikHubXiaohongshuNoteResult(payload, options)?.item ?? null
}

export function sha256Json(value) {
  const hash = createHash('sha256')
  const pending = [{ kind: 'value', value }]
  while (pending.length > 0) {
    const entry = pending.pop()
    if (entry.kind === 'token') {
      hash.update(entry.value)
      continue
    }
    const candidate = entry.value
    if (Array.isArray(candidate)) {
      pending.push({ kind: 'token', value: ']' })
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        if (index < candidate.length - 1) pending.push({ kind: 'token', value: ',' })
        pending.push({ kind: 'value', value: candidate[index] })
      }
      pending.push({ kind: 'token', value: '[' })
      continue
    }
    if (candidate && typeof candidate === 'object') {
      const keys = Object.keys(candidate).sort()
      pending.push({ kind: 'token', value: '}' })
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        if (index < keys.length - 1) pending.push({ kind: 'token', value: ',' })
        const key = keys[index]
        pending.push({ kind: 'value', value: candidate[key] })
        pending.push({ kind: 'token', value: ':' })
        pending.push({ kind: 'token', value: JSON.stringify(key) })
      }
      pending.push({ kind: 'token', value: '{' })
      continue
    }
    hash.update(JSON.stringify(candidate === undefined ? null : candidate))
  }
  return hash.digest('hex')
}

export function redactTikHubEnvelope(payload) {
  // Provider field names such as token, signature, params and cache_url are
  // legitimate acquired business data. Credential isolation is value-bound in
  // the adapter, where the exact active Hub-to-TikHub credential is known.
  if (!payload || typeof payload !== 'object') return payload
  const cloned = Array.isArray(payload) ? [] : {}
  const pending = [{ source: payload, target: cloned }]
  while (pending.length > 0) {
    const { source, target } = pending.pop()
    for (const [key, child] of Object.entries(source)) {
      let copied
      if (child && typeof child === 'object') {
        copied = Array.isArray(child) ? [] : {}
        pending.push({ source: child, target: copied })
      } else {
        copied = child
      }
      Object.defineProperty(target, key, {
        value: copied,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }
  return cloned
}
