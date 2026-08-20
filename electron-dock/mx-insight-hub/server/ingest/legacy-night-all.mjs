import { parseNightAllLegacyArray } from '../contracts/night-all-legacy.mjs'
import { applyMapping, CHUNKER_VERSION } from './external/mapping.mjs'

export const NIGHT_ALL_COMPAT_DATASET_ID = 'night-all.compat.v1'
export const NIGHT_ALL_COMPAT_CONNECTOR_ID = 'night-all-legacy'
export const NIGHT_ALL_COMPAT_PARSER_VERSION = `${CHUNKER_VERSION}:night-all-legacy.v1`

const CONTENT_FIELD_MAP = {
  externalId: { from: [
    'content_id', 'post_id', 'postId', 'note_id', 'noteId', 'aweme_id',
    'awemeId', 'status_id', 'statusId', 'tweet_id', 'tweetId', 'video_id',
    'videoId', 'id', 'url',
  ] },
  contentType: { from: ['content_type', 'contentType', 'media_type', 'type'] },
  url: { from: ['url', 'original_url', 'share_url', 'web_url'] },
  title: { from: ['title', 'note_title', 'name'] },
  body: { from: ['full_text', 'text', 'content', 'caption', 'description'] },
  authorExternalId: { from: ['author_id', 'authorId', 'user_id', 'userId', 'uid', 'channel_id'] },
  authorName: { from: [
    'author_name', 'authorName', 'user_name', 'username', 'screen_name',
    'nickname', 'author_info.screen_name', 'author_info.user_name',
  ] },
  eventTime: { from: ['published_at', 'publishedAt', 'created_at', 'created_time'] },
  collectedAt: { from: ['collected_at', 'collectedAt', 'crawled_at'] },
  language: { from: ['lang', 'language'] },
  'metrics.likes': { from: ['like_count', 'likes', 'digg_count'] },
  'metrics.comments': { from: ['comment_count', 'comments', 'reply_count'] },
  'metrics.shares': { from: ['share_count', 'shares', 'forward_count', 'repost_count'] },
  'metrics.views': { from: ['view_count', 'views', 'play_count'] },
  'metrics.bookmarks': { from: ['bookmark_count', 'bookmarks', 'collect_count'] },
  'attributes.username': { from: [
    'author_username', 'username', 'user_name', 'author_info.user_name',
  ] },
  'attributes.chatUsername': { from: ['rawGroupName', 'group_username', 'chat_username'] },
  'relations.chatId': { from: ['chat_id', 'group_id', 'rawGroupName'] },
  'relations.messageId': { from: ['message_id', 'content_id'] },
  'relations.replyToMessageId': { from: ['reply_to_message_id', 'replyToMessageId'] },
  'relations.threadId': { from: ['thread_id', 'threadId', 'topic_id'] },
  'relations.groupedId': { from: ['grouped_id', 'groupedId'] },
}

const PROFILE_FIELD_MAP = {
  externalId: { from: ['user_id', 'userId', 'uid', 'author_id', 'channel_id', 'id', 'username', 'url'] },
  contentType: { from: ['account_type', 'type'] },
  url: { from: ['profile_url', 'homepage_url', 'url'] },
  title: { from: ['display_name', 'screen_name', 'nickname', 'user_name', 'username', 'name'] },
  body: { from: ['bio', 'description', 'about', 'signature'] },
  authorExternalId: { from: ['user_id', 'userId', 'uid', 'author_id', 'channel_id', 'id'] },
  authorName: { from: ['display_name', 'screen_name', 'nickname', 'user_name', 'username', 'name'] },
  collectedAt: { from: ['collected_at', 'collectedAt', 'crawled_at', 'updated_at'] },
  language: { from: ['lang', 'language'] },
  'attributes.username': { from: ['username', 'user_name', 'screen_name', 'handle'] },
}

function parsedStringArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function decorate(record, raw, kind) {
  record.parserVersion = NIGHT_ALL_COMPAT_PARSER_VERSION
  record.stableFields.connectorId = NIGHT_ALL_COMPAT_CONNECTOR_ID

  if (kind === 'content') {
    const images = parsedStringArray(raw.image_urls ?? raw.images)
    const videos = parsedStringArray(raw.video_urls ?? raw.videos)
    record.stableFields.media = {
      ...(record.stableFields.media || {}),
      images,
      videos,
      coverUrl: raw.cover_url ?? raw.coverUrl ?? null,
    }
    record.stableFields.author.avatarUrl = raw.author_avatar_url
      ?? raw.profile_image_url
      ?? raw.author_info?.profile_image_url
      ?? null
  } else {
    record.stableFields.author.avatarUrl = raw.profile_image_url
      ?? raw.avatar_url
      ?? raw.avatarUrl
      ?? null
  }
  return record
}

function mapItems(items, fieldMap, options) {
  const records = []
  let skipped = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped += 1
      continue
    }
    const { record } = applyMapping(raw, fieldMap, {
      platform: options.platform,
      objectType: options.objectType,
    })
    if (!record) {
      skipped += 1
      continue
    }
    records.push(decorate(record, raw, options.kind))
  }
  return { records, skipped }
}

/**
 * Convert the compatibility envelope into the same canonical record shape used
 * by managed sources. Embedded prev/current/next Telegram context remains raw
 * evidence; it is intentionally not indexed as duplicate message content.
 */
export function normalizeNightAllLegacyPayload(payload, platform, _operation) {
  const rawInfo = parseNightAllLegacyArray(payload?.data?.raw_info) || []
  const rawData = parseNightAllLegacyArray(payload?.data?.raw_data) || []
  const profiles = mapItems(rawInfo, PROFILE_FIELD_MAP, {
    platform,
    objectType: 'profile',
    kind: 'profile',
  })
  const content = mapItems(rawData, CONTENT_FIELD_MAP, {
    platform,
    objectType: 'post',
    kind: 'content',
  })

  const unique = new Map()
  for (const record of [...profiles.records, ...content.records]) {
    unique.set(`${record.objectType}\u0000${record.externalId}`, record)
  }
  return {
    records: [...unique.values()],
    skipped: profiles.skipped + content.skipped,
  }
}
