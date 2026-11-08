import { commentRoutePlatforms, COMMENT_REPLY_CONTENT_REQUIRED } from '../server/contracts/comment-routes.mjs'
import { STRATEGY_SEARCH_PLATFORMS } from './strategy-search-experience-model.js'

export const STRATEGY_COMMENT_PATHS = { 'post-comments': '/api/v1/data/social/post-comments', 'comment-replies': '/api/v1/data/social/comment-replies' }
export const isCommentOperation = operation => Object.hasOwn(STRATEGY_COMMENT_PATHS, operation)
const EXTRA_PLATFORMS = [{ platform: 'linkedin', label: 'LinkedIn', mark: 'in' }]
const ID_HINTS = {
  twitter: '推文 ID 或 x.com/…/status/… 链接', reddit: '帖子 ID（如 1abcde）或帖子链接', xiaohongshu: '24 位笔记 ID 或笔记链接',
  weibo: '微博数字 ID（mid）或详情链接', instagram: '帖子 shortcode、数字媒体 ID 或帖子链接', douyin: '视频 aweme_id 或 douyin.com/video/… 链接',
  bilibili: 'BV 号、AV 号或视频链接', kuaishou: '作品 photo_id 或作品链接', zhihu: '回答 ID 或 …/answer/… 链接',
  tiktok: '视频 ID 或 tiktok.com/…/video/… 链接', linkedin: 'activity ID 或动态链接', facebook: '帖子 ID 或帖子链接', youtube: '视频 ID 或视频链接',
}
export const commentIdHint = platform => ID_HINTS[platform] || '帖子 ID 或规范帖子链接'
export const replyNeedsContent = platform => COMMENT_REPLY_CONTENT_REQUIRED.includes(platform)

// Platforms this Key can call for one comment interface: the platform grant and
// social.comments.list. Without an access snapshot every supported platform shows.
export function strategyCommentPlatforms(access, operation) {
  const supported = commentRoutePlatforms(operation)
  return [...STRATEGY_SEARCH_PLATFORMS, ...EXTRA_PLATFORMS].filter(row => supported.includes(row.platform)
    && (!access || access.platforms?.includes(row.platform) && access.capabilities?.includes('social.comments.list')))
}

const urlLike = value => /^https?:\/\//iu.test(value)
export function strategyCommentBody(operation, form, platforms, cursor = null) {
  if (!isCommentOperation(operation)) throw new Error('请选择帖子评论或评论回复。')
  if (!platforms.some(row => row.platform === form.platform)) throw new Error('请选择当前 Key 已授权的目标平台。')
  const count = Number(form.count ?? 20)
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('每页数量应为 1–100 的整数，并受当前 Key 上限约束。')
  const content = String(form.contentId ?? '').trim()
  if (content.length > 2048 || content.includes('\0')) throw new Error('contentId 或链接过长。')
  const contentField = content ? urlLike(content) ? { url: content } : { contentId: content } : {}
  if (operation === 'post-comments') {
    if (!content) throw new Error(`请输入${commentIdHint(form.platform)}。`)
    return { platform: form.platform, ...contentField, count, ...(cursor ? { cursor } : {}) }
  }
  const commentId = String(form.commentId ?? '').trim()
  if (!commentId || commentId.length > 128 || commentId.includes('\0')) throw new Error('请输入要查看回复的 commentId（帖子评论结果中的评论 ID）。')
  if (replyNeedsContent(form.platform) && !content) throw new Error('该平台查回复还需要评论所属帖子的 contentId；从评论结果点「查看回复」会自动带上。')
  return { platform: form.platform, commentId, ...contentField, count, ...(cursor ? { cursor } : {}) }
}

export const strategyCommentPage = payload => payload?.data?.page || payload?.data?.pageInfo || null
export function strategyCommentRows(payload) {
  const items = payload?.data?.items
  return Array.isArray(items) ? items : []
}
