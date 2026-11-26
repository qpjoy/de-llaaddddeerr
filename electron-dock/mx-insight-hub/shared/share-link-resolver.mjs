export const SHARE_LINK_RESOLVER = Object.freeze({
  key: 'share-link-resolver',
  label: '分享链接解析',
  path: '/data-products/share-link-resolver',
  docs: 'share-link-resolver',
  apiPath: '/api/v1/data/share-links/resolve',
  platform: 'social',
  capability: 'social.share_links.resolve',
})

export const SHARE_LINK_LIMITS = Object.freeze({ maxTextLength: 16_384, maxLinks: 10 })

const hosts = new Map([
  ...['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'v.douyin.com'].map(host => [host, 'douyin']),
  ...['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'].map(host => [host, 'xiaohongshu']),
])
// Consume the whole authority (including internationalized domains), but
// stop a platform path before surrounding Chinese share copy and punctuation.
const linkPattern = /(?<![A-Za-z0-9_@%/.=-])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/<>"'`,()[\]「」“”]+|(?<![\p{L}\p{N}\p{M}])(?:[\p{L}\p{N}\p{M}_-]+[.。．｡])+[\p{L}\p{N}\p{M}-]+)(?:\/[^\s\u0080-\u{10ffff}<>"'`,]*)?/gu
const inlineLink = /\[(?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\])*\])*\]\(\s*(?:<([^<>\n]*)>|((?:\\.|[^()\s\\]|\([^()\s]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/gu

export function trustedShareUrl(value, platform, base) {
  if (typeof value !== 'string' || /[\\\s\u0000-\u001f]/u.test(value) || value.length > 4096) return null
  if (!base && !/^https?:\/\//iu.test(value)) return null
  const authority = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/u.exec(value)
  if (authority && !/^[A-Za-z0-9.-]+(?::\d+)?$/u.test(authority[1])) return null
  let url
  try { url = new URL(value, base) } catch { return null }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
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

export function shareLinkPlatform(url) {
  return hosts.get(url.hostname)
}

export function scanShareText(text) {
  const urls = new Map()
  let sawUrl = false
  for (const raw of shareUrls(text)) {
    // Douyin starts copied captions with numbers such as "1.71". They have
    // no host or work ID, even though the text scanner sees a dotted token.
    if (/^\d+(?:\.\d+)+$/u.test(raw)) continue
    sawUrl = true
    const url = trustedShareUrl(raw.includes('://') ? raw : `https://${raw}`)
    if (url) urls.set(url.href, url)
  }
  return { urls, sawUrl }
}
