import { scanShareText, SHARE_LINK_LIMITS, trustedShareUrl } from '../shared/share-link-resolver.mjs'

function linkedLabel(label, href = '') {
  return '[' + label.replace(/[\\[\]]/gu, '\\$&') + '](<' + href + '>)'
}

export function sharePasteText(plain, anchors, uriList = '') {
  let cursor = 0
  const parts = []
  const unlabelled = new Set()
  for (const { href, label } of anchors) {
    const url = trustedShareUrl(href)
    const index = label ? plain.indexOf(label, cursor) : -1
    if (index < 0) {
      if (url) unlabelled.add(url.href)
      continue
    }
    parts.push({ text: plain.slice(cursor, index) })
    const displayed = scanShareText(label).urls
    const misleading = [...displayed.keys()].some(link => link !== url?.href)
    // Bind an official-looking label to its actual destination before
    // deduplication. An empty target masks just that label for external links.
    parts.push({ text: misleading ? linkedLabel(label, url?.href) : label, target: url?.href })
    cursor = index + label.length
  }
  parts.push({ text: plain.slice(cursor) })
  const visible = parts.map(part => part.text).join('')
  const seen = new Set(scanShareText(visible).urls.keys())
  for (const part of parts) {
    if (part.target && !seen.has(part.target)) {
      part.text = linkedLabel(part.text, part.target)
      seen.add(part.target)
    }
  }
  for (const line of uriList.split(/\r\n?|\n/u)) {
    const href = line.trim()
    if (!href || href.startsWith('#')) continue
    const url = trustedShareUrl(href)
    if (url) unlabelled.add(url.href)
  }
  const extra = [...unlabelled].filter(href => !seen.has(href))
  const replacement = [parts.map(part => part.text).join(''), ...extra].filter(Boolean).join('\n')
  return replacement === plain ? null : replacement
}

export function shareClipboardText(clipboard, document) {
  const html = clipboard.getData('text/html')
  const uriList = clipboard.getData('text/uri-list')
  if (!html && !uriList) return null
  const plain = clipboard.getData('text/plain')
  const tooLarge = () => new RangeError('剪贴板内容过大，请分次粘贴或只复制作品链接。')
  // A small selection may carry considerable styling. Bound parsing work
  // before creating any DOM, while allowing ordinary formatted selections.
  if (plain.length > SHARE_LINK_LIMITS.maxTextLength || html.length + uriList.length > 1024 * 1024) throw tooLarge()
  const anchors = []
  if (html) {
    // Template contents stay inert. Read explicit destinations without
    // inserting markup into the page, loading resources or resolving a base.
    const template = document.createElement('template')
    template.innerHTML = html
    const links = template.content.querySelectorAll('a[href]')
    if (links.length > 256) throw tooLarge()
    for (const anchor of links) {
      anchors.push({ href: anchor.getAttribute('href').trim(), label: anchor.textContent.trim() })
    }
  }
  return sharePasteText(plain, anchors, uriList)
}
