import {
  ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
  JUSTONE_CONTRACT_VERSION,
  JUSTONE_OPERATION,
  JUSTONE_PROVIDER_KEY,
  normalizeJustOneProductSearchResponse,
  redactJustOnePrivateFields,
} from '../contracts/justone.mjs'
import { canonicalJson, sha256 } from './normalizers.mjs'

export const JUSTONE_DATASET_ID = 'ecommerce.products.v1'
export const JUSTONE_CONNECTOR_ID = 'external-platform:justone'
export const JUSTONE_PARSER_VERSION = 'mxih-justone-product-search.v1'

const QUEUED_RECORD_TIME_FIELDS = Object.freeze([
  'eventTime',
  'collectedAt',
  'editedAt',
  'deletedAt',
  'observedAt',
])
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-](\d{2}):(\d{2}))$/u

function daysInMonth(year, month) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    return leapYear ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function queuedRecordTime(value, { field, index, required = false }) {
  if (value == null) {
    if (required) throw new TypeError(`external-platform record ${index} is missing ${field}`)
    return null
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError(`external-platform record ${index} has invalid ${field}`)
    }
    return new Date(value.getTime())
  }
  const match = typeof value === 'string' && value.length <= 64
    ? RFC3339_TIMESTAMP.exec(value)
    : null
  if (!match) {
    throw new TypeError(`external-platform record ${index} ${field} must be an RFC3339 timestamp`)
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const validComponents = month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 59
    && (offsetHourText == null || Number(offsetHourText) <= 23)
    && (offsetMinuteText == null || Number(offsetMinuteText) <= 59)
  const parsed = validComponents ? new Date(value) : null
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    throw new TypeError(`external-platform record ${index} has invalid ${field}`)
  }
  return parsed
}

/**
 * PostgreSQL queue payloads are JSONB, so Date values arrive at the worker as
 * strings. Restore canonical time fields at that boundary and reject a
 * malformed job before it can open an ingest transaction or compute an
 * observation hash.
 */
export function rehydrateJustOneQueuedRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('external-platform records must be an array')
  return records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`external-platform record ${index} must be an object`)
    }
    const hydrated = { ...record }
    for (const field of QUEUED_RECORD_TIME_FIELDS) {
      if (field !== 'collectedAt' && !Object.hasOwn(record, field)) continue
      hydrated[field] = queuedRecordTime(record[field], {
        field,
        index,
        required: field === 'collectedAt',
      })
    }
    return hydrated
  })
}

export const JUSTONE_MARKETPLACE_CATALOG = Object.freeze({
  taobao: Object.freeze({
    entryId: '5a4e3453-86f2-5980-9d07-35df7a1acd83',
    sourceKey: 'source-catalog-0058',
    revision: 1,
    canonicalName: '淘宝',
  }),
  tmall: Object.freeze({
    entryId: '3964d3e4-ca42-55a4-9ace-c2eebd66e488',
    sourceKey: 'source-catalog-0059',
    revision: 1,
    canonicalName: '天猫',
  }),
  jd: Object.freeze({
    entryId: '8057bdc8-cc03-5783-a6dd-08e44bfabe9a',
    sourceKey: 'source-catalog-0060',
    revision: 1,
    canonicalName: '京东',
  }),
  xiaohongshu_ec: Object.freeze({
    entryId: '995613cb-9881-5d76-921a-1af73734a81d',
    sourceKey: 'source-catalog-0064',
    revision: 1,
    canonicalName: '小红书店铺',
  }),
  xianyu: Object.freeze({
    entryId: '4f7ca4e1-9d06-528e-9632-de4b7dcd8174',
    sourceKey: 'source-catalog-0073',
    revision: 1,
    canonicalName: '闲鱼',
  }),
})

function collectedAtDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new TypeError('capturedAt must be a valid timestamp')
  return date
}

function exactNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Number.isSafeInteger(value) || !Number.isInteger(value) ? value : null
  }
  if (typeof value !== 'string') return null
  const text = value.replace(/[,\s]/gu, '').trim()
  if (!/^-?\d+(?:\.\d+)?$/u.test(text)) return null
  const number = Number(text)
  if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) return null
  return number
}

function contentDigest(record) {
  const {
    collectedAt: _collectedAt,
    metrics: _metrics,
    rank: _rank,
    rawItem: _rawItem,
    rawPayloadSha256: _rawPayloadSha256,
    sourcePointer: _sourcePointer,
    ...content
  } = record
  return sha256(canonicalJson(content))
}

function marketplaceFacet(marketplace, catalog) {
  return {
    status: 'mapped',
    sourceValue: marketplace,
    entryId: catalog.entryId,
    sourceKey: catalog.sourceKey,
    revision: catalog.revision,
    canonicalName: catalog.canonicalName,
    majorCategory: '国内电商与本地生活',
  }
}

function canonicalRecord(archiveObject, request, capturedAt, secret) {
  if (archiveObject?.kind && archiveObject.kind !== 'item') return null
  const item = archiveObject?.normalizedItem
  const catalog = JUSTONE_MARKETPLACE_CATALOG[request.marketplace]
  if (!item?.id || !catalog) return null
  const rawItem = redactJustOnePrivateFields(archiveObject.rawItem, { secret })
  const comments = exactNumber(item.signals.reviewCount)
  const metrics = comments === null ? {} : { comments }
  const marketplace = marketplaceFacet(request.marketplace, catalog)
  const stableFields = {
    author: {
      externalId: item.shop.id,
      name: item.shop.name,
      handle: null,
    },
    media: { images: [...item.images] },
    entities: [],
    links: item.url ? [item.url] : [],
    metrics,
    attributes: {
      sourcePlatform: request.marketplace,
      sourceCatalogEntryId: catalog.entryId,
      sourceCatalogSourceKey: catalog.sourceKey,
      sourceCatalogMappingStatus: 'mapped',
    },
    commerce: {
      contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
      product: {
        goodsId: item.id,
        title: item.title,
        url: item.url,
        pricing: { ...item.pricing },
        brand: item.attributes.brand,
        category: item.attributes.category,
      },
      shop: { ...item.shop },
      signals: { ...item.signals },
      marketplace,
    },
    source: {
      connectorId: JUSTONE_CONNECTOR_ID,
      operation: JUSTONE_OPERATION,
      connectorContractVersion: JUSTONE_CONTRACT_VERSION,
      endpointKey: request.endpointKey,
      endpointVersion: request.endpointVersion,
    },
    language: null,
  }
  const record = {
    platform: 'ecommerce',
    objectType: 'product',
    externalId: `${request.marketplace}:${item.id}`,
    contentType: 'product',
    url: item.url,
    title: item.title,
    body: null,
    authorExternalId: item.shop.id,
    authorName: item.shop.name,
    eventTime: null,
    collectedAt: capturedAt,
    editedAt: null,
    deletedAt: null,
    latitude: null,
    longitude: null,
    countryCode: 'CN',
    admin1Code: null,
    admin2Code: null,
    stableFields,
    extensions: {
      brand: item.attributes.brand,
      category: item.attributes.category,
    },
    metrics,
    rank: archiveObject.rank,
    parserVersion: JUSTONE_PARSER_VERSION,
    // ingest.source_objects stores the individual raw item, so its local JSON
    // pointer is always '$'. external_platform.archive_objects separately
    // retains this item's pointer inside the complete provider envelope.
    sourcePointer: '$',
    rawItem,
    rawPayloadSha256: archiveObject.rawPayloadSha256 || sha256(canonicalJson(rawItem)),
  }
  record.payloadSha256 = contentDigest(record)
  return record
}

/**
 * Turn reviewed archive objects into canonical rows. Identity is always the
 * marketplace plus a source product ID; page number, rank and query never
 * participate in the ID and therefore cannot create replay duplicates.
 */
export function normalizeJustOneArchiveObjects(archiveObjects, request, {
  capturedAt,
  secret = null,
} = {}) {
  if (!Array.isArray(archiveObjects)) throw new TypeError('archiveObjects must be an array')
  const captureTime = collectedAtDate(capturedAt)
  const unique = new Map()
  let skipped = 0
  let duplicates = 0
  for (const archiveObject of archiveObjects) {
    // Response-level evidence represents the paid call itself, not a product
    // candidate, so it must not inflate invalid-item counts.
    if (archiveObject?.kind === 'response') continue
    const record = canonicalRecord(archiveObject, request, captureTime, secret)
    if (!record) {
      skipped += 1
      continue
    }
    if (unique.has(record.externalId)) {
      duplicates += 1
      continue
    }
    unique.set(record.externalId, record)
  }
  return {
    records: [...unique.values()],
    skipped,
    duplicates,
  }
}

export function prepareJustOneArchiveObjects(archiveObjects, request, {
  capturedAt,
} = {}) {
  if (!Array.isArray(archiveObjects)) throw new TypeError('archiveObjects must be an array')
  const catalog = JUSTONE_MARKETPLACE_CATALOG[request?.marketplace]
  if (!catalog) throw new TypeError('request marketplace is not mapped to the source catalog')
  const capturedDate = collectedAtDate(capturedAt).toISOString().slice(0, 10)
  return archiveObjects.map((object) => {
    const archiveKind = object.kind === 'response' ? 'responses' : 'items'
    return {
      ...object,
      marketplace: request.marketplace,
      endpointVersion: request.endpointVersion,
      // Keep the database partition key byte-for-byte aligned with the UTC
      // date embedded in archivePath; never let a process/PG timezone recast it.
      capturedDate,
      archivePath: [
        JUSTONE_PROVIDER_KEY,
        request.marketplace,
        'product-search',
        request.endpointVersion,
        capturedDate,
        archiveKind,
        `${object.rawPayloadSha256}.json`,
      ].join('/'),
      sourceKey: catalog.sourceKey,
      payloadSha256: object.rawPayloadSha256,
      rawPayload: object.rawItem,
    }
  })
}

export function normalizeJustOneProductSearchPayload(raw, request, options = {}) {
  const normalized = normalizeJustOneProductSearchResponse(raw, request, options)
  const ingest = normalizeJustOneArchiveObjects(normalized.archiveObjects, request, options)
  const archiveObjects = prepareJustOneArchiveObjects(normalized.archiveObjects, request, {
    capturedAt: normalized.publicBody.meta.capturedAt,
  })
  return {
    ...normalized,
    archiveObjects,
    records: ingest.records,
    skipped: ingest.skipped,
    duplicates: ingest.duplicates,
  }
}
