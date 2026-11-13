// Reviewed read routes of the RapidAPI listing rapidapi.com/Lundehund/api/threads-api4.
// Parameters come from the listing's playground (2026-11-11). The listing also
// documents "Get User Info" by username on the same route, but its parameter
// is not public, so usernames resolve through search-profiles instead.
export const THREADS_RAPIDAPI_HOST = 'threads-api4.p.rapidapi.com'
export const THREADS_RAPIDAPI_VERSION = 'threads-api4.2026-11-11'
export const THREADS_SCRAPER_RAPIDAPI_HOST = 'threads-scraper.p.rapidapi.com'

const text = (name, description, required = true) => Object.freeze({ name, required, type: 'string', description })
const cursor = text('end_cursor', '分页游标（上一页 page_info.end_cursor）', false)
const userId = text('user_id', 'Threads 用户数字 ID')
const postId = text('post_id', 'Threads 帖子数字 ID')
const query = text('query', '搜索关键词')

// A separate RapidAPI subscription. Search Posts takes its own opaque cursor.
const scraperKey = 'r.threads_scraper_search_posts'
export const THREADS_SCRAPER_SEARCH_ENDPOINT = Object.freeze({
  key: scraperKey, id: scraperKey, provider: 'rapidapi', host: THREADS_SCRAPER_RAPIDAPI_HOST,
  method: 'GET', path: '/api/v1/posts/search', summary: 'Threads Scraper 关键词帖子搜索',
  platform: 'threads', platformLabel: 'Threads', marketplace: 'threads-scraper', authorizationPlatform: 'social',
  operation: `native.${scraperKey}`, endpointKey: `native.${scraperKey}`, hubPath: `/api/v1/data/native/${scraperKey}`,
  schemaVersion: 'threads-scraper.2026-11-13', status: 'fixed_read_contract', reason: null,
  sourceUrl: 'https://rapidapi.com/premium-apis-oanor/api/threads-scraper/playground/apiendpoint_b999a4ee-9518-4668-9b6c-0057d2c433c3',
  parameters: Object.freeze([query, Object.freeze({ ...text('cursor', '上一页的 data.cursor，原样回传', false), pattern: '\\S' })]),
  fixedQuery: Object.freeze({}),
})

export const THREADS_RAPIDAPI_ENDPOINTS = Object.freeze([
  ['r.threads_user_info', '/api/user/info', '根据用户ID获取用户信息', [text('id', 'Threads 用户数字 ID')]],
  ['r.threads_user_posts', '/api/user/posts', '获取用户帖子', [userId, cursor]],
  ['r.threads_user_reposts', '/api/user/reposts', '获取用户转发', [userId, cursor]],
  ['r.threads_user_replies', '/api/user/replies', '获取用户回复', [userId, cursor]],
  ['r.threads_post_get_id', '/api/post/get-id', '根据链接获取帖子ID', [text('url', 'Threads 帖子链接')]],
  ['r.threads_post_detail', '/api/post/detail', '获取帖子详情', [postId]],
  ['r.threads_post_related', '/api/post/related', '获取相关帖子', [postId]],
  ['r.threads_post_comments', '/api/post/comments', '获取帖子评论', [postId, cursor]],
  ['r.threads_search_top', '/api/search/top', '搜索热门内容', [query, cursor]],
  ['r.threads_search_recent', '/api/search/recent', '搜索最新内容', [query, cursor]],
  ['r.threads_search_profiles', '/api/search/profiles', '搜索用户档案', [query]],
].map(([key, path, summary, parameters]) => Object.freeze({
  key, id: key, provider: 'rapidapi', host: THREADS_RAPIDAPI_HOST, method: 'GET', path, summary,
  platform: 'threads', platformLabel: 'Threads', authorizationPlatform: 'social',
  operation: `native.${key}`, endpointKey: `native.${key}`, hubPath: `/api/v1/data/native/${key}`,
  schemaVersion: THREADS_RAPIDAPI_VERSION, status: 'fixed_read_contract', reason: null,
  sourceUrl: 'https://rapidapi.com/Lundehund/api/threads-api4',
  parameters: Object.freeze(parameters), fixedQuery: Object.freeze({}),
})))
