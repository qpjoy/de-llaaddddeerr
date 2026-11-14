import { AppError } from '../core/errors.mjs'
import { THREADS_SCRAPER_ROUTE } from '../../shared/threads-search-routing.mjs'
import { threadsScraperPostUrlParts, threadsDetailCode, threadsPostIdFromShortcode } from '../../shared/threads-post-identity.mjs'
import { parseThreadsScraperPostDetail, threadsPostRow } from './threads.mjs'
import { contentSearchDataItem } from './tikhub-content-search.mjs'

export const THREADS_POST_DETAIL_PATH = '/api/v1/data/social/post-detail'
export const THREADS_POST_DETAIL_CAPABILITY = 'social.posts.resolve'
export const THREADS_POST_DETAIL_VERSION = 'mx-insight-hub.threads-post-detail.v1'
const recipes = {
  rapidapi: { available: true, key: 'r.threads_post_detail' },
  [THREADS_SCRAPER_ROUTE]: { available: true, key: 'r.threads_scraper_post_detail' },
}
export const threadsPostDetailRecipe = (platform, provider) => platform === 'threads' && Object.hasOwn(recipes, provider) ? recipes[provider] : null

const invalid = () => { throw new AppError(400, 'invalid_threads_post', 'Supply platform threads and exactly one contentId or canonical Threads post URL') }
export function normalizeThreadsPostDetail(body) {
  if (!body || body.platform !== 'threads' || Object.keys(body).some(name => !['platform', 'url', 'contentId'].includes(name))
    || Object.hasOwn(body, 'contentId') === Object.hasOwn(body, 'url')) invalid()
  const code = Object.hasOwn(body, 'url') ? threadsScraperPostUrlParts(body.url)?.code : threadsDetailCode(body.contentId)
  if (!code) invalid()
  const postId = threadsPostIdFromShortcode(code)
  return { code, postId, fingerprintBody: { contractVersion: THREADS_POST_DETAIL_VERSION, platform: 'threads', code } }
}

// The original listing returns source post objects, also used by its search and
// account pages. Only accept the requested post inside a containing thread.
function originalListingPost(payload, { postId, capturedAt }) {
  const matches = post => [post?.pk, post?.id].some(id => typeof id === 'string'
    ? id.split('_')[0] === postId : Number.isSafeInteger(id) && String(id) === postId)
  const levels = []
  for (let node = payload; node && typeof node === 'object' && levels.length < 5; node = node.data) {
    if ((node.status != null && node.status !== 'ok') || node.errors?.length) throw new Error('invalid_threads_detail_status')
    levels.push(node)
  }
  for (const node of levels.reverse()) {
    const thread = node.containing_thread ?? node.thread ?? node
    const posts = [node.post, ...(Array.isArray(thread.thread_items) ? thread.thread_items.map(item => item?.post) : []), node]
    const post = posts.find(candidate => matches(candidate) && ['code', 'user', 'caption', 'text', 'taken_at'].some(key => Object.hasOwn(candidate, key)))
    if (post) {
      const row = threadsPostRow(post, capturedAt)
      if (row.content_id !== postId || (post.code != null && threadsPostIdFromShortcode(post.code) !== postId)) break
      return row
    }
  }
  throw new Error('invalid_threads_detail_identity')
}

export function projectThreadsPostDetail(payload, identity, provider, capturedAt) {
  const options = { ...identity, capturedAt }
  const row = provider === THREADS_SCRAPER_ROUTE ? parseThreadsScraperPostDetail(payload, options) : originalListingPost(payload, options)
  return contentSearchDataItem(row)
}
