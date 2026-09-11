// Canonical rows for collected social accounts.
//
// Identity is `(platform, userId)` -- the de-duplication key the collecting
// scripts arrived at after 557 accounts across four platforms. Keyword, page
// and rank never participate in it, so re-running a keyword, paging deeper, or
// finding the same account through a different keyword all converge on one row
// rather than multiplying it.
//
// This layer is provider-agnostic on purpose: which vendor served a platform is
// call evidence, not a property of the account, and a platform that later moves
// to a different vendor must not fork its canonical identity.

import { createHash } from 'node:crypto'
import {
  SOCIAL_ACCOUNT_DATASET_ID,
  SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
  SOCIAL_ACCOUNT_SEARCH_OPERATION,
  socialAccountPlatform,
} from '../contracts/social-accounts.mjs'

export const SOCIAL_ACCOUNT_CONNECTOR_ID = 'external-platform:social-accounts'
export const SOCIAL_ACCOUNT_PARSER_VERSION = 'mxih-social-account-search.v1'
export { SOCIAL_ACCOUNT_DATASET_ID }

// Where a platform's account page lives, for callers that want to open it.
// Only formats attested by the collected data are produced; an unknown one
// stays null rather than guessing a URL that may 404.
const PROFILE_URL = Object.freeze({
  xiaohongshu: (account) => `https://www.xiaohongshu.com/user/profile/${account.userId}`,
  douyin: (account) => (account.secUid
    ? `https://www.douyin.com/user/${account.secUid}`
    : null),
  weibo: (account) => `https://weibo.com/u/${account.userId}`,
  kuaishou: () => null,
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function collectedAtDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new TypeError('capturedAt must be a valid timestamp')
  return date
}

export function socialAccountProfileUrl(account) {
  const build = PROFILE_URL[account?.platform]
  return build ? build(account) : null
}

// The content digest answers "did this account change", so anything that varies
// per call is excluded: capture time, volatile metrics, rank within a page, and
// the raw item. Discovery provenance is excluded for the same reason -- finding
// the same account through a second keyword is a fact about the search, not a
// change to the account, and letting it move the digest would rewrite every row
// each time the keyword set rotates.
function contentDigest(record) {
  const {
    collectedAt: _collectedAt,
    metrics: _metrics,
    rank: _rank,
    rawItem: _rawItem,
    rawPayloadSha256: _rawPayloadSha256,
    sourcePointer: _sourcePointer,
    stableFields: { discovery: _discovery, ...stableFields },
    ...content
  } = record
  return sha256(canonicalJson({ ...content, stableFields }))
}

function canonicalRecord(archiveObject, request, capturedAt) {
  if (archiveObject?.kind && archiveObject.kind !== 'item') return null
  const account = archiveObject?.normalizedItem
  const descriptor = socialAccountPlatform(request.platform)
  if (!account?.userId || !descriptor) return null

  const profileUrl = socialAccountProfileUrl(account)
  // A follower count that upstream did not state exactly is absent from
  // metrics, not zero. Downstream aggregation must be able to tell the two
  // apart, which a defaulted 0 would make impossible.
  const metrics = account.fans === null ? {} : { followers: account.fans }

  const stableFields = {
    author: {
      externalId: account.userId,
      name: account.name,
      handle: account.handle,
    },
    media: { images: account.avatar ? [account.avatar] : [] },
    entities: [],
    links: profileUrl ? [profileUrl] : [],
    metrics,
    attributes: {
      sourcePlatform: descriptor.platform,
      // The vendor that served this page is call evidence, kept here for cost
      // attribution without becoming part of the account's identity.
      servedByProvider: descriptor.providerKey,
    },
    profile: {
      contractVersion: SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
      userId: account.userId,
      secUid: account.secUid,
      handle: account.handle,
      displayName: account.name,
      bio: account.bio,
      followers: account.fans,
      verified: account.official,
      avatarUrl: account.avatar,
      profileUrl,
    },
    discovery: {
      // Which keyword surfaced this account is discovery provenance, not
      // identity: the same account found through another keyword updates this
      // row rather than creating a second one.
      keyword: request.keyword,
      page: request.page,
    },
    source: {
      connectorId: SOCIAL_ACCOUNT_CONNECTOR_ID,
      operation: SOCIAL_ACCOUNT_SEARCH_OPERATION,
      connectorContractVersion: request.endpointContractVersion,
      endpointKey: request.endpointKey,
      endpointVersion: request.endpointVersion,
    },
    language: null,
  }

  const record = {
    platform: descriptor.platform,
    objectType: 'profile',
    externalId: `${descriptor.platform}:${account.userId}`,
    contentType: 'profile',
    url: profileUrl,
    title: account.name,
    body: account.bio,
    authorExternalId: account.userId,
    authorName: account.name,
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
      verified: account.official,
      followers: account.fans,
      // These upstream shapes carry more than this contract consumes and drift
      // without notice, so the provider's own item is retained verbatim.
      sourceItem: archiveObject.rawItem ?? null,
    },
    metrics,
    rank: archiveObject.rank ?? null,
    parserVersion: SOCIAL_ACCOUNT_PARSER_VERSION,
    sourcePointer: '$',
    rawItem: archiveObject.rawItem ?? null,
    rawPayloadSha256: archiveObject.rawPayloadSha256
      || sha256(canonicalJson(archiveObject.rawItem ?? null)),
  }
  record.payloadSha256 = contentDigest(record)
  return record
}

export function normalizeSocialAccountArchiveObjects(archiveObjects, request, { capturedAt } = {}) {
  if (!Array.isArray(archiveObjects)) throw new TypeError('archiveObjects must be an array')
  const captureTime = collectedAtDate(capturedAt)
  const unique = new Map()
  let skipped = 0
  let duplicates = 0

  for (const archiveObject of archiveObjects) {
    const record = canonicalRecord(archiveObject, request, captureTime)
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
    datasetId: SOCIAL_ACCOUNT_DATASET_ID,
    records: [...unique.values()],
    skipped,
    duplicates,
  }
}
