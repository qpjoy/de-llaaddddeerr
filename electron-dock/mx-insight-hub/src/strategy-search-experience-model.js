export const STRATEGY_DATA_SEARCH_PATH = '/api/v1/data/search'
export const STRATEGY_SEARCH_PLATFORMS = [
  ['douyin', '抖音', '抖'], ['bilibili', '哔哩哔哩', 'B'], ['kuaishou', '快手', '快'], ['zhihu', '知乎', '知'],
  ['telegram', 'Telegram', 'TG'], ['twitter', 'Twitter / X', '𝕏'], ['reddit', 'Reddit', 'R'],
  ['xiaohongshu', '小红书', '红'], ['weibo', '微博', '微'], ['instagram', 'Instagram', 'IG'],
  ['facebook', 'Facebook', 'f'], ['tiktok', 'TikTok', '♪'], ['youtube', 'YouTube', 'YT'],
  ['wechat_search', '微信搜一搜', '搜'], ['wechat_mp', '微信公众号', '公'],
].map(([platform, label, mark]) => ({ platform, label, mark }))

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
  return data?.pageInfo || null
}

export function uncertainStrategySearch(error) {
  return !error?.responseBody || ['request_in_progress', 'request_outcome_unknown', 'upstream_outcome_unknown',
    'external_platform_outcome_unknown', 'external_platform_call_persistence_unknown', 'internal_error'].includes(error.code)
}

export function safeStrategyUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null }
  catch { return null }
}

export function createStrategySearchCell(platform) {
  let state = { form: { platform, query: '', pageSize: 20 }, attempts: new Map(), consoleAttempts: new Map(), result: null, busy: false, error: null, checking: false }
  const listeners = new Set()
  return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state,
    update: patch => { state = { ...state, ...patch }; for (const listener of listeners) listener() } }
}

export const strategyRequestFingerprint = input => JSON.stringify([input.method, input.path, input.body])

export function recordStrategyAttempt(cell, event) {
  if (!event.idempotencyKey) return
  const state = cell.getSnapshot(), scope = strategyRequestFingerprint(event.input)
  const operation = state.attempts.get(scope)?.idempotencyKey === event.idempotencyKey
    ? state.attempts.get(scope) : { idempotencyKey: event.idempotencyKey, body: event.input.body, input: event.input }
  operation.state = event.state === 'failed' ? uncertainStrategySearch(event.error) ? 'uncertain' : 'received' : event.state
  operation.requestId = event.requestId || operation.requestId
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
