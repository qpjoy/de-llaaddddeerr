import { scanShareText, shareLinkPlatform, SHARE_LINK_LIMITS, trustedShareUrl } from '../../shared/share-link-resolver.mjs'
import { AppError } from '../core/errors.mjs'
import { readBounded } from '../collect/http.mjs'

export { SHARE_LINK_LIMITS }
const shortHosts = new Set(['v.douyin.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'])
const redirects = new Set([301, 302, 303, 307, 308])

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
    const nested = path && trustedShareUrl(path.replaceAll('&amp;', '&'), platform, url.origin)
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
    const url = target && trustedShareUrl(target.replaceAll('&amp;', '&'), platform, base)
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
      url = target && trustedShareUrl(target, platform, url)
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
  const { urls: links, sawUrl } = scanShareText(text)
  if (links.size > SHARE_LINK_LIMITS.maxLinks) throw new AppError(400, 'too_many_share_links', `每次最多解析 ${SHARE_LINK_LIMITS.maxLinks} 个不同链接`)
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
    const owner = shareLinkPlatform(url)
    const linkSignal = AbortSignal.any([deadline, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])])
    const result = platform !== 'auto' && platform !== owner
      ? failure('platform_mismatch', '链接与请求的平台不匹配')
      : await resolveLink(url, owner, fetchImpl, linkSignal)
    results.push({ platform: owner, link: url.href, ...result })
  }
  if (!sawUrl && platform !== 'xiaohongshu' && /抖音|douyin/iu.test(text)) {
    results.push({ platform: 'douyin', link: null, ...failure('share_code_requires_lookup', '文案里没有抖音作品网址。请在作品的分享菜单选择“复制链接”后粘贴；如果有完整口令，也可使用抖音口令查询。', { type: 'share_code' }) })
  }
  if (!sawUrl && platform !== 'douyin' && /小红书/u.test(text)) {
    results.push({ platform: 'xiaohongshu', link: null, ...failure('share_link_required', '文案里没有小红书笔记网址。请打开原笔记，在分享菜单选择“复制链接”后粘贴。') })
  }
  const succeeded = results.filter(r => r.ok).length
  return { results, total: results.length, succeeded, failed: results.length - succeeded }
}
