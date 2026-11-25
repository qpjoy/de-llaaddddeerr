import { SHARE_LINK_LIMITS } from '../../shared/share-link-resolver.mjs'
import { AppError } from '../core/errors.mjs'
import { readBounded } from '../collect/http.mjs'

export { SHARE_LINK_LIMITS }
const hosts = new Map([
  ...['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'v.douyin.com'].map(host => [host, 'douyin']),
  ...['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'].map(host => [host, 'xiaohongshu']),
])
const shortHosts = new Set(['v.douyin.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'])
// Consume the whole authority (including internationalized domains), but
// stop a platform path before surrounding Chinese share copy and punctuation.
const linkPattern = /(?<![A-Za-z0-9_@%/.=-])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/<>"'`,()[\]「」“”]+|(?<![\p{L}\p{N}\p{M}])(?:[\p{L}\p{N}\p{M}_-]+[.。．｡])+[\p{L}\p{N}\p{M}-]+)(?:\/[^\s\u0080-\u{10ffff}<>"'`,]*)?/gu
const inlineLink = /\[(?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\])*\])*\]\(\s*(?:<([^<>\n]*)>|((?:\\.|[^()\s\\]|\([^()\s]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/gu
const redirects = new Set([301, 302, 303, 307, 308])

function trustedUrl(value, platform, base) {
  if (/[\\\s\u0000-\u001f]/u.test(value) || value.length > 4096) return null
  const authority = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/u.exec(value)
  if (authority && !/^[A-Za-z0-9.-]+(?::\d+)?$/u.test(authority[1])) return null
  const url = URL.parse(value, base)
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
  const owner = hosts.get(url.hostname)
  if (!owner || (platform && owner !== platform)) return null
  // Official HTTP share text is accepted, but all outgoing requests use TLS.
  url.protocol = 'https:'
  url.hash = ''
  return url
}

function* shareUrls(text) {
  let start = 0
  function* plain(value) {
    for (const [match] of value.matchAll(linkPattern)) yield match.replace(/[.,;:!?)\]}]+$/gu, '')
  }
  for (const link of text.matchAll(inlineLink)) {
    yield* plain(text.slice(start, link.index))
    // Markdown's visible label may itself be a different URL.
    yield link[1] ?? link[2]
    start = link.index + link[0].length
  }
  yield* plain(text.slice(start))
}

function failure(code, error, extra) { return { ok: false, code, error, ...extra } }

function query(url) {
  return new URLSearchParams(url.search.slice(1).replaceAll(';', '&').replaceAll('+', '%2B'))
}

function identify(url, platform) {
  if (shortHosts.has(url.hostname)) return null
  const params = query(url)
  if (platform === 'douyin') {
    const post = /^\/(?:share\/)?(video|note|slides)\/(\d{15,25})\/?$/iu.exec(url.pathname)
    if (post) {
      let authorUid
      try {
        authorUid = JSON.parse(params.get('activity_info'), (key, value, context) =>
          key === 'social_author_id' && typeof value === 'number' ? context.source : value)?.social_author_id
      } catch { /* Optional metadata. */ }
      return { ok: true, type: post[1].toLowerCase(), postId: post[2], aweme_id: post[2],
        ...(typeof authorUid === 'string' && /^\d+$/u.test(authorUid) ? { author_uid: authorUid } : {}) }
    }
    const other = /^\/(?:share\/)?(user|music|live|challenge)(?:\/|$)/iu.exec(url.pathname)
    if (other) return failure('not_a_post', '该抖音链接指向非作品页面', { type: other[1].toLowerCase() })
  } else {
    const note = /^\/(?:discovery\/item|explore)\/([0-9a-f]{24})\/?$/iu.exec(url.pathname)
    if (note) {
      const id = note[1].toLowerCase()
      const token = params.get('xsec_token')
      return { ok: true, type: 'note', postId: id, note_id: id, ...(token ? { xsec_token: token } : {}) }
    }
    if (/^\/user\/profile(?:\/|$)/iu.test(url.pathname)) return failure('not_a_post', '该链接指向小红书用户主页', { type: 'user' })
  }
  return null
}

function identifyTarget(url, platform) {
  if (platform === 'xiaohongshu' && !shortHosts.has(url.hostname) && /^\/login\/?$/u.test(url.pathname)) {
    const path = query(url).get('redirectPath')
    const nested = path && trustedUrl(path.replaceAll('&amp;', '&'), platform, url.origin)
    return nested && identify(nested, platform)
  }
  return identify(url, platform)
}

// Only page metadata explicitly declaring its own URL can identify a post.
// IDs in page scripts, recommended links and bare hexadecimal values cannot.
function pageIdentity(html, base, platform) {
  const header = html.split(/<\/head\s*>|<body\b/iu, 1)[0].replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '')
  let result
  for (const [tag, name] of header.matchAll(/<(link|meta)\b[^<>]*>/giu)) {
    const attrs = Object.fromEntries([...tag.matchAll(/\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)]
      .map(([, key, double, single]) => [key.toLowerCase(), double ?? single]))
    const target = name.toLowerCase() === 'link' && attrs.rel?.toLowerCase().split(/\s+/u).includes('canonical') ? attrs.href
      : attrs.property?.toLowerCase() === 'og:url' ? attrs.content : null
    const url = target && trustedUrl(target.replaceAll('&amp;', '&'), platform, base)
    const post = url && identify(url, platform)
    if (post?.ok) {
      if (result && result.postId !== post.postId) return null
      if (!result || post.xsec_token) result = post
    }
  }
  return result
}

async function resolveLink(start, platform, fetchImpl, signal) {
  let url = start
  const visited = new Set()
  let token
  for (;;) {
    if (platform === 'xiaohongshu') token = query(url).get('xsec_token') || token
    const hit = identifyTarget(url, platform)
    if (hit) return hit.ok ? { ...(token && { xsec_token: token }), ...hit, how: visited.size ? 'redirect' : 'direct' } : hit
    // Never fetch an unknown platform path as an arbitrary GET endpoint.
    const shortPath = platform === 'xiaohongshu' ? /^\/(?:o\/)?[A-Za-z0-9_-]+\/?$/u : /^\/[A-Za-z0-9_-]+\/?$/u
    if (!shortHosts.has(url.hostname) || !shortPath.test(url.pathname)) return failure('unrecognized_link', '链接未指向可识别的作品')
    if (visited.size >= 5 || visited.has(url.href)) return failure('redirect_limit', '短链循环跳转或超过跳转上限')
    visited.add(url.href)
    try {
      signal.throwIfAborted()
      const response = await fetchImpl(url.href, { redirect: 'manual', signal, headers: { accept: 'text/html' } })
      if (response.ok && /\btext\/html\b/iu.test(response.headers.get('content-type') || '')) {
        const hit = pageIdentity(await readBounded(response, 256 * 1024), url, platform)
        return hit ? { ...(token && { xsec_token: token }), ...hit, how: 'body-scan', uncertain: true } : failure('unrecognized_link', '页面未提供明确的作品链接')
      }
      await response.body?.cancel()
      if (!redirects.has(response.status)) return failure('unresolved_link', '未能从平台响应中识别作品')
      const target = response.headers.get('location')
      url = target && trustedUrl(target, platform, url)
      if (!url) return failure('invalid_redirect', '跳转目标缺失或不属于该平台')
    } catch (error) {
      if (signal.aborted) return failure('resolution_timeout', '短链解析已超时或取消')
      if (error?.code === 'response_too_large') return failure('response_too_large', '短链页面超过大小上限')
      return failure('network_error', '短链请求失败')
    }
  }
}

function prepare(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'invalid_request', '请求体必须为对象')
  if (Object.keys(input).some(key => key !== 'text' && key !== 'platform')) {
    throw new AppError(400, 'unsupported_fields', '只接受 text 和 platform 字段')
  }
  const { text, platform = 'auto' } = input
  if (typeof text !== 'string' || !text.trim() || text.length > SHARE_LINK_LIMITS.maxTextLength) {
    throw new AppError(400, 'invalid_share_text', `请提供 1 至 ${SHARE_LINK_LIMITS.maxTextLength} 个字符的分享文本`)
  }
  if (!['auto', 'douyin', 'xiaohongshu'].includes(platform)) throw new AppError(400, 'invalid_platform', '不支持的分享平台')
  const links = new Map()
  let sawUrl = false
  for (const raw of shareUrls(text)) {
    sawUrl = true
    const url = trustedUrl(raw.includes('://') ? raw : `https://${raw}`)
    if (!url) continue
    links.set(url.href, url)
    if (links.size > SHARE_LINK_LIMITS.maxLinks) throw new AppError(400, 'too_many_share_links', `每次最多解析 ${SHARE_LINK_LIMITS.maxLinks} 个不同链接`)
  }
  return { normalized: { text: text.trim(), platform }, links, sawUrl }
}

export function normalizeShareLinkInput(input) {
  return prepare(input).normalized
}

export async function resolveShareLinks(input, { fetchImpl = globalThis.fetch, signal } = {}) {
  const { normalized: { text, platform }, links, sawUrl } = prepare(input)
  const deadline = AbortSignal.timeout(15_000)
  const results = []
  for (const url of links.values()) {
    const owner = hosts.get(url.hostname)
    const linkSignal = AbortSignal.any([deadline, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])])
    const result = platform !== 'auto' && platform !== owner
      ? failure('platform_mismatch', '链接与请求的平台不匹配')
      : await resolveLink(url, owner, fetchImpl, linkSignal)
    results.push({ platform: owner, link: url.href, ...result })
  }
  if (!sawUrl && platform !== 'xiaohongshu' && /抖音|douyin/iu.test(text)) {
    results.push({ platform: 'douyin', link: null, ...failure('share_code_requires_lookup', '抖音纯口令需要单独查询，无法直接提取作品 ID', { type: 'share_code' }) })
  }
  const succeeded = results.filter(r => r.ok).length
  return { results, total: results.length, succeeded, failed: results.length - succeeded }
}
