#!/usr/bin/env node
// One-off paid calibration for comment and reply suppliers (2026-11-07).
// For each platform: find a post (keyword search, or Instagram account posts),
// read its comments, pick the comment with the most replies, read its replies.
// Every call is a single TikHub dispatch with no retry and a per-platform cap.
// Redacted raw envelopes and a call ledger are written to --out for offline
// parser calibration. The credential is read from MX_INSIGHT_TIKHUB_API_KEY
// or --key-file and is never printed or written.
//
//   MX_INSIGHT_TIKHUB_API_KEY=... node server/ops/calibrate-comment-replies.mjs --out /tmp/comment-calibration \
//     [--platforms reddit,xiaohongshu] [--max-calls 5] [--seed douyin:7290000000000000000[:7300000000000000001]]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TikHubAdapter } from '../adapters/tikhub.mjs'
import { normalizeTikHubContentSearchRequest, projectTikHubContentSearch, contentSearchDataItem } from '../contracts/tikhub-content-search.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch, projectHubSocialCompatResponse } from '../contracts/hub-social-compat.mjs'
import { normalizePostCommentsRequest, postCommentRecipe, providerQuery } from '../contracts/post-comments.mjs'
import { projectPostCommentPage } from '../contracts/post-comment-projection.mjs'
import { normalizeCommentRepliesRequest, commentReplyRecipe, replyProviderQuery } from '../contracts/comment-replies.mjs'
import { projectCommentReplyPage } from '../contracts/comment-reply-projection.mjs'
import { normalizeNativeForwardingRequest } from '../contracts/native-forwarding.mjs'

const PLATFORMS = ['twitter', 'reddit', 'xiaohongshu', 'weibo', 'instagram', 'douyin', 'bilibili', 'kuaishou', 'zhihu']
const KEYWORDS = { twitter: 'OpenAI', reddit: 'worldnews', xiaohongshu: '美食', weibo: '新闻', douyin: '美食', bilibili: '科技', kuaishou: '美食', zhihu: '人工智能' }
// Fresh keyword results often have no comments yet; these platforms start from
// a large public account's posts instead.
const ACCOUNT_SOURCES = { instagram: { username: 'natgeo' }, weibo: { uid: '2803301701' },
  zhihu: { userId: 'zhang-jia-wei', activityTypes: ['answers'] } }
const SEARCH_PARAMS = { xiaohongshu: { sort_type: 'general' } }

function args(argv) {
  const out = { platforms: PLATFORMS, maxCalls: 5, seeds: {}, out: null, keyFile: null, keyJson: null, keyPath: null, baseUrlPath: null }
  for (let i = 0; i < argv.length; i++) {
    const [name, value] = [argv[i], argv[i + 1]]
    if (name === '--out') { out.out = value; i++ }
    else if (name === '--platforms') { out.platforms = value.split(',').map(row => row.trim()).filter(Boolean); i++ }
    else if (name === '--max-calls') { out.maxCalls = Number(value); i++ }
    else if (name === '--key-file') { out.keyFile = value; i++ }
    else if (name === '--key-json') { out.keyJson = value; i++ }
    else if (name === '--key-path') { out.keyPath = value; i++ }
    else if (name === '--base-url-path') { out.baseUrlPath = value; i++ }
    else if (name === '--seed') { const [platform, contentId, commentId] = value.split(':'); out.seeds[platform] = { contentId, commentId }; i++ }
    else throw new Error(`Unknown argument ${name}`)
  }
  if (!out.out) throw new Error('--out is required')
  if (out.platforms.some(platform => !PLATFORMS.includes(platform))) throw new Error('Unsupported platform')
  if (!Number.isInteger(out.maxCalls) || out.maxCalls < 1 || out.maxCalls > 5) throw new Error('--max-calls must be 1-5')
  return out
}

const options = args(process.argv.slice(2))
// A JSON config (e.g. Night-All config.json) is read by field path; the value
// stays inside this process.
const jsonConfig = options.keyJson ? JSON.parse(readFileSync(options.keyJson, 'utf8')) : null
const at = (value, path) => path?.split('.').reduce((node, part) => node?.[part], value)
const apiKey = String(jsonConfig ? at(jsonConfig, options.keyPath) ?? '' : options.keyFile ? readFileSync(options.keyFile, 'utf8') : process.env.MX_INSIGHT_TIKHUB_API_KEY || '').trim()
if (!apiKey) throw new Error('Provide MX_INSIGHT_TIKHUB_API_KEY, --key-file or --key-json with --key-path')
const baseUrl = jsonConfig && options.baseUrlPath ? at(jsonConfig, options.baseUrlPath) : undefined
mkdirSync(options.out, { recursive: true })
const adapter = new TikHubAdapter({ apiKey, timeoutMs: 40000, ...(baseUrl ? { baseUrl } : {}) })
const ledger = []
let sequence = 0

async function call(platform, step, key, params, extra = {}) {
  const used = ledger.filter(row => row.platform === platform).length
  if (used >= options.maxCalls) throw Object.assign(new Error('budget'), { budget: true })
  const entry = { seq: ++sequence, platform, step, key, params, startedAt: new Date().toISOString() }
  ledger.push(entry)
  try {
    const result = await adapter.forwardNative(key, { params }, extra)
    const payload = result.responseArchive?.rawPayload ?? null
    Object.assign(entry, { outcome: 'succeeded', httpStatus: result.responseArchive?.httpStatus ?? null,
      businessCode: result.responseArchive?.businessCode ?? null, upstreamRequestId: result.upstreamEvidence?.requestId ?? null,
      bodySize: result.responseArchive?.bodySize ?? null, file: `${String(entry.seq).padStart(2, '0')}-${platform}-${step}.json` })
    writeFileSync(join(options.out, entry.file), JSON.stringify(payload, null, 2))
    return { result, payload }
  } catch (error) {
    Object.assign(entry, { outcome: error.evidence?.outcome || 'failed', httpStatus: error.evidence?.httpStatus ?? null,
      billed: error.evidence?.billed ?? null, errorCode: error.evidence?.errorCode || error.code || error.message })
    const archived = error.persistence?.responseArchive?.rawPayload ?? error.responseArchive?.rawPayload
    if (archived) { entry.file = `${String(entry.seq).padStart(2, '0')}-${platform}-${step}-error.json`; writeFileSync(join(options.out, entry.file), JSON.stringify(archived, null, 2)) }
    throw error
  } finally { writeFileSync(join(options.out, 'calls.json'), JSON.stringify(ledger, null, 2)) }
}

async function findPost(platform) {
  if (ACCOUNT_SOURCES[platform]) {
    const request = normalizeHubSocialCompatRequest('crawl', { platform, ...ACCOUNT_SOURCES[platform], count: 20 })
    const job = request.jobs[0]
    const step = buildHubSocialCompatDispatch(job, { resolvedIdentity: { ...job.identity, profileReady: true }, pageSize: 20 })
    const { payload } = await call(platform, 'posts', step.key, step.upstreamQuery)
    const rows = projectHubSocialCompatResponse(payload, step).acquiredItems
    return rows.map(row => ({ contentId: row.content_id || row.external_id, comments: Number(row.comment_count) || 0 }))
  }
  const request = normalizeTikHubContentSearchRequest({ platform, query: KEYWORDS[platform], pageSize: 20, params: SEARCH_PARAMS[platform] || {} })
  const { result } = await call(platform, 'search', request.recipeKey, request.upstreamQuery,
    ['kuaishou', 'twitter'].includes(platform) ? { contentSearchProjection: true } : {})
  return projectTikHubContentSearch(result, request).acquiredItems.map(contentSearchDataItem)
    .filter(item => platform !== 'zhihu' || String(item.contentType || '').includes('answer'))
    .map(item => ({ contentId: item.externalId, comments: Number(item.metrics?.comments ?? item.metrics?.replies) || 0 }))
}

function bestComment(platform, payload, request) {
  try {
    const rows = projectPostCommentPage(payload, { provider: 'tikhub', postComments: { request, continuation: null } }, { capturedAt: new Date().toISOString() }).projected.acquiredItems
    return rows.sort((a, b) => (b.replyCount || 0) - (a.replyCount || 0))[0] || null
  } catch {
    // Pending parsers (Bilibili TikHub): read the platform's native reply list.
    const replies = payload?.data?.data?.replies || payload?.data?.replies || []
    const top = [...replies].sort((a, b) => (b.rcount || 0) - (a.rcount || 0))[0]
    return top ? { commentId: String(top.rpid_str || top.rpid), replyCount: top.rcount } : null
  }
}

async function calibrate(platform) {
  const seed = options.seeds[platform] || {}
  let contentId = seed.contentId
  if (!contentId) {
    const posts = (await findPost(platform)).filter(row => row.contentId).sort((a, b) => b.comments - a.comments)
    contentId = posts[0]?.contentId
    if (!contentId) return { platform, stopped: 'no_post_found' }
  }
  const comments = normalizePostCommentsRequest({ platform, contentId, count: 20 }, { provider: 'tikhub' })
  const recipe = postCommentRecipe(platform, 'tikhub')
  const commentQuery = normalizeNativeForwardingRequest(recipe.key, { params: providerQuery(comments, recipe, null) }).upstreamQuery
  const { payload: commentPage } = await call(platform, 'comments', recipe.key, commentQuery)
  let commentId = seed.commentId, replyParams = null
  if (!commentId) {
    if (platform === 'reddit') {
      // Hidden replies are named by the comment tree's `more` placeholder.
      const trees = commentPage?.data?.postInfoById?.commentForest?.trees || []
      const placeholder = trees.find(tree => tree?.node === null && tree?.more?.cursor && String(tree.parentId || '').startsWith('t1_'))
        || trees.find(tree => tree?.more?.cursor)
      if (!placeholder) return { platform, contentId, stopped: 'no_reply_cursor_in_tree' }
      commentId = String(placeholder.parentId || '').startsWith('t1_') ? placeholder.parentId : trees.find(tree => tree?.node?.id)?.node?.id
      replyParams = { cursor: placeholder.more.cursor }
    } else {
      const best = bestComment(platform, commentPage, comments)
      if (!best?.commentId) return { platform, contentId, stopped: 'no_comment_found' }
      commentId = best.commentId
    }
  }
  const replies = normalizeCommentRepliesRequest({ platform, commentId, contentId: comments.postId, count: 20, ...(replyParams ? { params: replyParams } : {}) }, { provider: 'tikhub' })
  const replyRecipe = commentReplyRecipe(platform, 'tikhub')
  const replyQuery = normalizeNativeForwardingRequest(replyRecipe.key, { params: replyProviderQuery(replies, replyRecipe, null) }).upstreamQuery
  const { payload: replyPage } = await call(platform, 'replies', replyRecipe.key, replyQuery)
  let parsed = null
  try {
    parsed = projectCommentReplyPage(replyPage, { provider: 'tikhub', commentReplies: { request: replies, continuation: null } }, { capturedAt: new Date().toISOString() }).projected
  } catch (error) { parsed = { error: error.code || error.message } }
  return { platform, contentId: comments.postId, commentId, replyRows: parsed?.acquiredItems?.length ?? null, replyParseError: parsed?.error ?? null,
    replyNext: parsed?.providerPage?.nextParams ?? null }
}

const summary = []
for (const platform of options.platforms) {
  try { summary.push(await calibrate(platform)) }
  catch (error) { summary.push({ platform, stopped: error.budget ? 'budget_reached' : 'call_failed', error: error.evidence?.errorCode || error.code || error.message }) }
  writeFileSync(join(options.out, 'summary.json'), JSON.stringify(summary, null, 2))
}
console.log(JSON.stringify({ calls: ledger.length, byPlatform: Object.fromEntries(options.platforms.map(platform => [platform, ledger.filter(row => row.platform === platform).length])), summary }, null, 2))
