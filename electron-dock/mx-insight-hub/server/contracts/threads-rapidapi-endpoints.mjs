import { threadsScraperPostUrlParts } from '../../shared/threads-post-identity.mjs'

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

// Threads Scraper is separately subscribed and has its own marketplace circuit.
// Public listing endpoint descriptions and query table reviewed 2026-11-13.
const scraperCursor = Object.freeze({ ...text('cursor', '上一页的 data.cursor，原样回传', false), pattern: '\\S' })
const handle = '[A-Za-z0-9._]{1,64}'
const shortcode = '[A-Za-z0-9_-]{5,32}'
const shortcodePattern = new RegExp(`^${shortcode}$`, 'u')
const username = Object.freeze({ ...text('username', 'Threads 用户名，不含 @'), pattern: `^${handle}$` })
const usernameList = Object.freeze({ ...text('usernames', '1–3 个用户名，不含 @，以逗号分隔'), pattern: `^${handle}(?:,${handle}){0,2}$` })
const code = Object.freeze({ ...text('code', '帖子短码，5–32 个字符', false), pattern: `^${shortcode}$` })
const postUrl = text('url', 'Threads HTTPS 帖子链接，优先于 code', false)
const reference = text('reference', 'Threads HTTPS 帖子链接或短码')
const count = Object.freeze({ name: 'count', type: 'integer', required: false, minimum: 1, default: 10, description: '返回账号数量，默认 10，受当前 Key 的页大小限制' })

export const THREADS_SCRAPER_RAPIDAPI_ENDPOINTS = Object.freeze([
  ['search_posts', '/api/v1/posts/search', '关键词帖子搜索', [query, scraperCursor], 'b999a4ee-9518-4668-9b6c-0057d2c433c3'],
  ['user_detail', '/api/v1/users/detail', '查询账号详情', [username], '94acb47f-ab01-44f7-9614-3111b7900800'],
  ['user_detail_with_biolink', '/api/v1/users/detail-with-biolink', '查询账号详情与简介链接', [username], 'cc135321-5e54-45d0-9a42-c0e48e0d56f4'],
  ['search_users', '/api/v1/users/search', '搜索公开账号', [query, count], '4af33fdf-83ed-43fb-9b6d-b9fd074b13f8'],
  ['user_posts', '/api/v1/users/posts', '获取账号帖子', [username, scraperCursor], 'b2641945-2547-4778-8737-fc5a4bfff828'],
  ['post_detail', '/api/v1/posts/detail', '获取帖子详情', [postUrl, code], '6da30740-4df1-44ab-8341-27877aa001cc'],
  ['resolve_post', '/api/v1/explore/resolve', '规范化帖子链接或短码（不验证存在性）', [reference], '309a1956-8e1f-4bd3-9541-13e1a795d695'],
  ['post_media', '/api/v1/explore/post-media', '获取帖子媒体版本', [postUrl, code], '197f71bc-dbce-4c46-95a8-0e4d8f007e20'],
  ['profiles_batch', '/api/v1/explore/profiles', '批量查询账号（1–3 个）', [usernameList], '012936e7-065c-465c-9d07-9fa6aa3f4dd8'],
].map(([operation, path, summary, parameters, playgroundId]) => {
  const key = `r.threads_scraper_${operation}`
  return Object.freeze({ key, id: key, provider: 'rapidapi', host: THREADS_SCRAPER_RAPIDAPI_HOST,
    method: 'GET', path, summary: `Threads Scraper · ${summary}`, platform: 'threads', platformLabel: 'Threads',
    marketplace: 'threads-scraper', authorizationPlatform: 'social',
    operation: `native.${key}`, endpointKey: `native.${key}`, hubPath: `/api/v1/data/native/${key}`,
    schemaVersion: 'threads-scraper.2026-11-13', status: 'fixed_read_contract', reason: null,
    sourceUrl: `https://rapidapi.com/premium-apis-oanor/api/threads-scraper/playground/apiendpoint_${playgroundId}`,
    parameters: Object.freeze(parameters), fixedQuery: Object.freeze({}),
  })
}))
export const THREADS_SCRAPER_SEARCH_ENDPOINT = THREADS_SCRAPER_RAPIDAPI_ENDPOINTS[0]

export function validThreadsScraperPostInput(key, params) {
  if (key === 'r.threads_scraper_resolve_post') return shortcodePattern.test(params.reference) || !!threadsScraperPostUrlParts(params.reference)
  if (key === 'r.threads_scraper_post_detail' || key === 'r.threads_scraper_post_media') {
    return params.url !== undefined ? !!threadsScraperPostUrlParts(params.url) : !!params.code
  }
  return true
}

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
