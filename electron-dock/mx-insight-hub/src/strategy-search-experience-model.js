import { HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS, HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS } from '../shared/social-account-contract.mjs'

export const STRATEGY_DATA_SEARCH_PATH = '/api/v1/data/search'
export const STRATEGY_ACCOUNT_PATHS = { crawl: '/api/v1/data/social/crawl', 'user-info': '/api/v1/data/social/user-info' }
export const STRATEGY_SEARCH_PLATFORMS = [
  ['douyin', '抖音', '抖'], ['bilibili', '哔哩哔哩', 'B'], ['kuaishou', '快手', '快'], ['zhihu', '知乎', '知'],
  ['telegram', 'Telegram', 'TG'], ['twitter', 'Twitter / X', '𝕏'], ['reddit', 'Reddit', 'R'],
  ['xiaohongshu', '小红书', '红'], ['weibo', '微博', '微'], ['instagram', 'Instagram', 'IG'],
  ['facebook', 'Facebook', 'f'], ['tiktok', 'TikTok', '♪'], ['youtube', 'YouTube', 'YT'],
  ['wechat_search', '微信搜一搜', '搜'], ['wechat_mp', '微信公众号', '公'],
].map(([platform, label, mark]) => ({ platform, label, mark }))

export const strategyOperationPath = operation => STRATEGY_ACCOUNT_PATHS[operation] || STRATEGY_DATA_SEARCH_PATH

export function strategyAccountPlatforms(access, operation) {
  const supported = operation === 'crawl' ? HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS : HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS
  const capability = operation === 'crawl' ? 'social.content.crawl' : 'social.profile.get'
  const rows = [...STRATEGY_SEARCH_PLATFORMS, { platform: 'linkedin', label: 'LinkedIn', mark: 'in' }]
  return rows.filter(row => supported.includes(row.platform) && (!access
    || access.platforms?.includes(row.platform) && access.capabilities?.includes(capability)))
}

export function strategyAccountBody(operation, form, platforms, cursor) {
  if (!Object.hasOwn(STRATEGY_ACCOUNT_PATHS, operation)) throw new Error('请选择账号内容或账号资料。')
  if (!platforms.some(row => row.platform === form.platform)) throw new Error('请选择当前 Key 已授权的目标平台。')
  const field = form.accountField || 'username', account = String(form.account || '').trim()
  if (!['username', 'userId', 'user_id', 'uid'].includes(field) || !account || account.length > 500 || account.includes('\0')) throw new Error('请输入 1–500 字的有效账号标识。')
  const pageSize = Number(form.pageSize)
  if (operation === 'crawl' && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500)) throw new Error('每页数量应为 1–500 的整数，并受当前 Key 上限约束。')
  return { platform: form.platform, [field]: account, ...(operation === 'crawl' ? { pageSize } : {}), ...(cursor ? { cursor } : {}) }
}

export function strategyResultMatches(result, identity, input) {
  if (!input || result?.identity !== identity || result.input?.path !== input.path) return false
  const withoutCursor = body => Object.fromEntries(Object.entries(body || {}).filter(([name]) => name !== 'cursor'))
  return JSON.stringify(withoutCursor(result.input.body)) === JSON.stringify(withoutCursor(input.body))
}

export function strategyAccountForm(body) {
  const accountField = ['username', 'userId', 'user_id', 'uid'].find(field => typeof body?.[field] === 'string') || 'username'
  return { accountField, account: body?.[accountField] || '' }
}

// Account delivery keeps the legacy field names. Project only presentation
// aliases here; the complete response and strings remain unchanged.
export function strategyAccountItem(item, operation) {
  const list = value => {
    if (Array.isArray(value)) return value
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
  }
  if (operation === 'user-info') return { ...item,
    id: item.id ?? item.user_id, userId: item.userId ?? item.user_id,
    platform: item.platform ?? item.platform_name, username: item.username ?? item.user_name,
    name: item.name ?? item.nickname, avatarUrl: item.avatarUrl ?? item.avatar_url ?? item.profile_image_url,
    url: item.url ?? item.original_url, followers: item.followers ?? item.followers_count ?? item.follower_count,
    following: item.following ?? item.following_count ?? item.friends_count, posts: item.posts ?? item.statuses_count,
  }
  if (operation !== 'crawl') return item
  return { ...item, id: item.id ?? item.content_id ?? item.external_id, platform: item.platform ?? item.platform_name,
    text: item.text ?? item.content ?? item.full_text, url: item.url ?? item.original_url,
    publishedAt: item.publishedAt ?? item.published_at ?? item.created_at,
    author: item.author ?? { name: item.author_name ?? item.user_name }, contentType: item.contentType ?? item.content_type,
    metrics: { likes: item.metrics?.likes ?? item.like_count, comments: item.metrics?.comments ?? item.metrics?.replies ?? item.comment_count ?? item.reply_count,
      shares: item.metrics?.shares ?? item.share_count ?? item.forward_count, views: item.metrics?.views ?? item.view_count,
      bookmarks: item.metrics?.bookmarks ?? item.collect_count ?? item.bookmark_count },
    media: { coverUrl: item.media?.coverUrl, images: list(item.media?.images ?? item.imageUrls ?? item.image_urls).map(row => typeof row === 'string' ? row : row?.url) },
  }
}

export function strategySearchPlatforms(access) {
  if (!access) return STRATEGY_SEARCH_PLATFORMS
  return STRATEGY_SEARCH_PLATFORMS.filter(row => {
    if (row.platform.startsWith('wechat_')) return access.platforms?.includes('social')
      && access.capabilities?.includes('native.wechat.search.search')
    return access.platforms?.includes(row.platform)
      && (row.platform !== 'xiaohongshu' || access.capabilities?.includes('social.posts.search'))
  })
}

export function strategySearchBody(form, platforms, cursor) {
  const query = String(form.query || '').trim()
  if (!platforms.some(row => row.platform === form.platform)) throw new Error('请选择当前 Key 已授权的目标平台。')
  if (!query || query.length > 500 || query.includes('\0')) throw new Error('请输入 1–500 字的关键词。')
  const wechat = form.platform.startsWith('wechat_')
  if (wechat && query.length > 100) throw new Error('微信搜索关键词最多 100 字。')
  const pageSize = Number(form.pageSize)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('每页数量应为 1–100 的整数。')
  if (wechat && pageSize !== 20) throw new Error('微信返回原生一页，每页数量请保留默认值 20。')
  return { platform: form.platform, query, pageSize, type: 'stable',
    ...(wechat ? { params: { raw: false } } : {}), ...(cursor ? { cursor } : {}) }
}

export function strategyPageInfo(payload) {
  const data = payload?.data
  if (payload?.endpoint === 'wechat.search.search') {
    const cursor = typeof data?.cursor === 'string' && data.cursor ? data.cursor : null
    return { hasMore: [true, 1, '1'].includes(data?.continue_flag) && !data?.no_more && Boolean(cursor), nextCursor: cursor }
  }
  return data?.pageInfo || data?.page || null
}

export function uncertainStrategySearch(error) {
  return !error?.responseBody || ['request_in_progress', 'request_outcome_unknown', 'upstream_outcome_unknown',
    'external_platform_outcome_unknown', 'external_platform_call_persistence_unknown', 'internal_error'].includes(error.code)
}

export function safeStrategyUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null }
  catch { return null }
}

export function isFacebookPhotoPage(value) {
  try {
    const url = new URL(safeStrategyUrl(value))
    return (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com')) && url.pathname === '/photo.php'
  } catch { return false }
}

export function createStrategySearchCell(platform) {
  let state = { form: { platform, query: '', pageSize: 20, accountField: 'username', account: '' }, attempts: new Map(), consoleAttempts: new Map(), result: null, busy: false, error: null, checking: false }
  const listeners = new Set()
  return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state,
    update: patch => { state = { ...state, ...patch }; for (const listener of listeners) listener() } }
}

export const strategyRequestFingerprint = input => JSON.stringify([input.method, input.path, input.body])

export function strategyUnresolvedAttempt(attempts, platform) {
  return [...attempts.values()].find(attempt => ['sending', 'uncertain'].includes(attempt.state)
    && strategyAttemptPlatform(attempt.body?.platform) === strategyAttemptPlatform(platform))
}

const strategyAttemptPlatform = value => {
  const platform = String(value || '').trim().toLowerCase()
  return { ig: 'instagram', ins: 'instagram', insta: 'instagram', x: 'twitter', xhs: 'xiaohongshu',
    red: 'xiaohongshu', rednote: 'xiaohongshu', wechat: 'wechat_search', weixin: 'wechat_search' }[platform] || platform
}

// Error envelopes can contain an HTTP correlation ID at the top level. Only
// explicit ledger details establish the request ID used for status matching.
export const strategyFailureRequestId = error => [error?.details?.requestId, error?.responseBody?.error?.details?.requestId]
  .find(value => typeof value === 'string' && value.trim()) || null

export function recordStrategyAttempt(cell, event) {
  if (!event.idempotencyKey) return
  const state = cell.getSnapshot(), scope = strategyRequestFingerprint(event.input)
  const operation = state.attempts.get(scope)?.idempotencyKey === event.idempotencyKey
    ? state.attempts.get(scope) : { idempotencyKey: event.idempotencyKey, body: event.input.body, input: event.input }
  operation.state = event.state === 'failed' ? uncertainStrategySearch(event.error) ? 'uncertain' : 'received' : event.state
  operation.requestId = (event.state === 'failed' ? strategyFailureRequestId(event.error) : event.requestId) || operation.requestId
  if (event.state === 'failed') operation.error = event.error
  state.attempts.set(scope, operation)
  cell.update({ busy: event.state === 'sending', ...(event.state === 'sending' ? { outcomeNote: null } : {}) })
}

export function strategyOutcomeMatches(attempt, recorded) {
  if (!recorded || !['committed', 'released'].includes(recorded.status) || typeof recorded.id !== 'string'
    || (attempt.requestId && recorded.id !== attempt.requestId)) return false
  const requested = String(attempt.body?.platform || '').trim().toLowerCase()
  if (['wechat', 'weixin', 'wechat_search', 'wechat_mp'].includes(requested)) {
    return recorded.platform === 'social' && recorded.capability === 'native.wechat.search.search'
  }
  const platform = { ig: 'instagram', ins: 'instagram', insta: 'instagram', x: 'twitter', xhs: 'xiaohongshu', red: 'xiaohongshu', rednote: 'xiaohongshu' }[requested] || requested
  return Boolean(platform) && recorded.platform === platform
}
