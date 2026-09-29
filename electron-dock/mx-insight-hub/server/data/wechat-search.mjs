import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { WECHAT_SEARCH_KEY } from '../contracts/wechat-search-alias.mjs'

const scalar = value => typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null
const text = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '') : null
function link(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

// Only the documented raw=false items list is content. Categories, navigation
// boxes and unrelated arrays must never become search hits.
export function wechatAggregatePage(body, route) {
  const data = body?.data
  if (body?.endpoint !== WECHAT_SEARCH_KEY || !Array.isArray(data?.items)
    || data.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new AppError(502, 'invalid_wechat_search_response', 'WeChat search did not return the declared item list', { requestId: body?.requestId })
  }
  const items = data.items.map(item => {
    const jump = item.jumpInfo || {}
    const url = link(item.url) || link(item.link) || link(jump.url)
    const externalId = scalar(item.docID) || scalar(item.exportId) || scalar(jump.userName) || url
      || `content:${createHash('sha256').update(JSON.stringify(item)).digest('hex')}`
    return { externalId, title: text(item.title), text: text(item.desc) || text(jump.signature), url,
      contentType: text(item.accTypeName) || (route.platform === 'wechat_mp' ? 'article' : null),
      author: { id: scalar(jump.userName), name: text(jump.nickName) },
      collectedAt: body.meta?.capturedAt || null }
  })
  const next = typeof data.cursor === 'string' && data.cursor && data.cursor !== route.cursor ? data.cursor : null
  const continuing = [true, 1, '1'].includes(data.continue_flag) && !data.no_more && items.length > 0
  return { items, pageInfo: { hasMore: continuing, nextCursor: continuing ? next : null } }
}
