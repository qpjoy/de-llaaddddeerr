import { canonicalJson, sha256 } from './normalizers.mjs'
import {
  XIAOHONGSHU_POST_CONTRACT_VERSION,
  XIAOHONGSHU_POST_OPERATION,
} from '../contracts/tikhub-xiaohongshu.mjs'
import {
  XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
  XIAOHONGSHU_SEARCH_OPERATION,
} from '../contracts/tikhub-xiaohongshu-search.mjs'

export const TIKHUB_XIAOHONGSHU_DATASET_ID = 'social.posts.v1'
export const TIKHUB_XIAOHONGSHU_CONNECTOR_ID = 'external-platform:tikhub'
export const TIKHUB_XIAOHONGSHU_PARSER_VERSION = 'mxih-tikhub-xiaohongshu.v2'
export const TIKHUB_XIAOHONGSHU_SEARCH_PARSER_VERSION = 'mxih-tikhub-xiaohongshu-search.v1'
export const XIAOHONGSHU_SOURCE_CATALOG = Object.freeze({
  entryId: '491c69be-b20e-5677-a824-85bcebc9562a',
  sourceKey: 'source-catalog-0004',
  revision: 1,
  canonicalName: '小红书',
})

function date(value, field) {
  if (value == null) {
    if (field === 'collectedAt') throw new TypeError('collectedAt must be a valid timestamp')
    return null
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} must be a valid timestamp`)
  return parsed
}

function contentDigest(record) {
  const {
    collectedAt: _collectedAt,
    metrics: _metrics,
    rawItem: _rawItem,
    rawPayloadSha256: _rawPayloadSha256,
    sourcePointer: _sourcePointer,
    ...content
  } = record
  return sha256(canonicalJson(content))
}

function urlWithoutQuery(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function canonicalItem(item) {
  const sanitized = structuredClone(item)
  sanitized.url = urlWithoutQuery(item.url)
  if (sanitized.author && typeof sanitized.author === 'object' && !Array.isArray(sanitized.author)) {
    sanitized.author.avatarUrl = urlWithoutQuery(item.author?.avatarUrl)
  }
  sanitized.media = (Array.isArray(item.media) ? item.media : [])
    .filter((media) => media?.type === 'image')
    .map((media) => ({ type: 'image', url: urlWithoutQuery(media.url) }))
    .filter((media) => media.url)
  return sanitized
}

export function createTikHubXiaohongshuRecord(item, {
  operation = XIAOHONGSHU_POST_OPERATION,
  connectorContractVersion = XIAOHONGSHU_POST_CONTRACT_VERSION,
  parserVersion = TIKHUB_XIAOHONGSHU_PARSER_VERSION,
  rank = 1,
  sourcePointer = '$',
  bodyCompleteness = null,
  safetyLimited = false,
} = {}) {
  if (!item?.externalId || item.platform !== 'xiaohongshu') {
    throw new TypeError('TikHub Xiaohongshu item is invalid')
  }
  const storedItem = canonicalItem(item)
  const rawItem = structuredClone(storedItem)
  const metrics = {
    ...(storedItem.metrics?.liked == null ? {} : { likes: storedItem.metrics.liked }),
    ...(storedItem.metrics?.comments == null ? {} : { comments: storedItem.metrics.comments }),
    ...(storedItem.metrics?.shared == null ? {} : { shares: storedItem.metrics.shared }),
    ...(storedItem.metrics?.collected == null ? {} : { bookmarks: storedItem.metrics.collected }),
  }
  const images = (Array.isArray(storedItem.media) ? storedItem.media : [])
    .filter((media) => media?.type === 'image' && typeof media.url === 'string')
    .map((media) => media.url)
  const resolvedBodyCompleteness = safetyLimited === true ? 'safety_limited' : bodyCompleteness
  const record = {
    platform: 'xiaohongshu',
    objectType: 'post',
    externalId: storedItem.externalId,
    contentType: 'note',
    url: storedItem.url || null,
    title: storedItem.title || null,
    body: storedItem.text || null,
    authorExternalId: storedItem.author?.id || null,
    authorName: storedItem.author?.name || null,
    eventTime: date(storedItem.publishedAt, 'publishedAt'),
    collectedAt: date(storedItem.collectedAt, 'collectedAt'),
    editedAt: null,
    deletedAt: null,
    latitude: null,
    longitude: null,
    countryCode: 'CN',
    admin1Code: null,
    admin2Code: null,
    stableFields: {
      author: {
        externalId: storedItem.author?.id || null,
        name: storedItem.author?.name || null,
        avatarUrl: storedItem.author?.avatarUrl || null,
      },
      media: { images },
      entities: [],
      links: storedItem.url ? [storedItem.url] : [],
      tags: Array.isArray(storedItem.tags) ? [...storedItem.tags] : [],
      metrics,
      attributes: {
        sourceCatalogEntryId: XIAOHONGSHU_SOURCE_CATALOG.entryId,
        sourceCatalogSourceKey: XIAOHONGSHU_SOURCE_CATALOG.sourceKey,
        sourceCatalogMappingStatus: 'mapped',
      },
      source: {
        connectorId: TIKHUB_XIAOHONGSHU_CONNECTOR_ID,
        operation,
        connectorContractVersion,
      },
      language: 'zh-CN',
    },
    extensions: {
      sourceCatalog: XIAOHONGSHU_SOURCE_CATALOG,
      ...(resolvedBodyCompleteness ? { bodyCompleteness: resolvedBodyCompleteness } : {}),
    },
    metrics,
    rank,
    parserVersion,
    sourcePointer,
    rawItem,
    rawPayloadSha256: sha256(canonicalJson(rawItem)),
  }
  record.payloadSha256 = contentDigest(record)
  return record
}

export function createTikHubXiaohongshuSearchRecord(item, {
  rank = 1,
  sourcePointer = '$.data.data.items[0].note',
  bodyCompleteness = 'unverified_complete',
} = {}) {
  if (!item || item.platform !== 'xiaohongshu') {
    throw new TypeError('TikHub Xiaohongshu search item is invalid')
  }
  const normalized = {
    externalId: item.externalId,
    platform: item.platform,
    url: item.url,
    title: item.title,
    text: item.text,
    tags: [],
    author: item.author,
    metrics: {
      liked: item.metrics?.likes ?? null,
      comments: item.metrics?.comments ?? null,
      shared: item.metrics?.shares ?? null,
      collected: item.metrics?.bookmarks ?? null,
    },
    media: (Array.isArray(item.media?.images) ? item.media.images : [])
      .map((url) => ({ type: 'image', url })),
    publishedAt: item.publishedAt,
    collectedAt: item.collectedAt,
  }
  return createTikHubXiaohongshuRecord(normalized, {
    operation: XIAOHONGSHU_SEARCH_OPERATION,
    connectorContractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
    parserVersion: TIKHUB_XIAOHONGSHU_SEARCH_PARSER_VERSION,
    rank,
    sourcePointer,
    bodyCompleteness,
  })
}

export function rehydrateTikHubXiaohongshuQueuedRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('external-platform records must be an array')
  return records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`external-platform record ${index} must be an object`)
    }
    return {
      ...record,
      eventTime: date(record.eventTime, 'eventTime'),
      collectedAt: date(record.collectedAt, 'collectedAt'),
      editedAt: date(record.editedAt, 'editedAt'),
      deletedAt: date(record.deletedAt, 'deletedAt'),
    }
  })
}
