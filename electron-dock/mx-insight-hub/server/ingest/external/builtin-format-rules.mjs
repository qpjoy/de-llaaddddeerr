// Small, deterministic recognition rules for external files whose layouts are
// already known. These rules are suggestions, not ingestion authority: the
// selected mapping still goes through the normal approval/versioning path.

export const TWITTER_CANYIE_RULE_KEY = 'rule-twitter-canyie'
export const TWITTER_CANYIE_DATASET_ID = 'external.twitter.canyie.v1'
export const TWITTER_CANYIE_RULE_DISPLAY_NAME = 'Twitter / Canyie archive'

export const TWITTER_CANYIE_COLUMNS = Object.freeze([
  'text',
  'content_id',
  'reply_count',
  'created_at',
  'author_id',
  'platform_name',
  'source',
  'original_url',
  'image_urls',
  'updated_time',
  'like_count',
  'forward_count',
  'lang',
  'is_forward',
  'created_time',
  'quote_count',
  'video_urls',
  'content',
  'crawled_at',
  'full_text',
  'url',
  'bookmark_count',
  'metadata',
  'view_count',
])

export const TWITTER_CANYIE_FIELD_MAP = deepFreeze({
  externalId: { from: 'content_id' },
  body: { from: ['full_text', 'content', 'text'] },
  url: { from: ['original_url', 'url'] },
  authorExternalId: { from: 'author_id' },
  language: { from: 'lang' },
  eventTime: { from: 'created_at', type: 'timestamp' },
  editedAt: { from: ['updated_time', 'created_at'], type: 'timestamp' },
  collectedAt: { from: 'crawled_at', type: 'timestamp' },
  'metrics.likes': { from: 'like_count', type: 'number' },
  'metrics.comments': { from: 'reply_count', type: 'number' },
  'metrics.shares': { from: 'forward_count', type: 'number' },
  'metrics.views': { from: 'view_count', type: 'number' },
  'metrics.bookmarks': { from: 'bookmark_count', type: 'number' },
})

const FORMAT_BY_EXTENSION = new Map([
  ['.csv', 'csv'],
  ['.json', 'json'],
  ['.jsonl', 'jsonl'],
  ['.ndjson', 'jsonl'],
])

export const BUILTIN_FILE_FORMAT_RULES = deepFreeze([{
  ruleKey: TWITTER_CANYIE_RULE_KEY,
  displayName: TWITTER_CANYIE_RULE_DISPLAY_NAME,
  datasetId: TWITTER_CANYIE_DATASET_ID,
  platform: 'twitter',
  objectType: 'post',
  inputFormats: ['csv', 'json', 'jsonl'],
  fieldMap: TWITTER_CANYIE_FIELD_MAP,
  builtIn: true,
}])

export function builtinFileFormatRule(ruleKey) {
  const rule = BUILTIN_FILE_FORMAT_RULES.find((candidate) => candidate.ruleKey === ruleKey)
  return rule ? clone(rule) : null
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function extensionOf(filename) {
  return /\.[^.]+$/u.exec(String(filename).toLowerCase())?.[0] ?? ''
}

function nonEmpty(value) {
  return value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
}

function valueTypeFamily(value) {
  if (!nonEmpty(value)) return null
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' || typeof value === 'bigint') return 'number'
  return 'string'
}

function deterministicSamplePositions(rowCount) {
  if (rowCount <= 0) return []
  if (rowCount <= 9) {
    return Array.from({ length: rowCount }, (_, index) => ({
      position: index < Math.ceil(rowCount / 3)
        ? 'head'
        : index >= Math.ceil((rowCount * 2) / 3)
          ? 'tail'
          : 'middle',
      index,
    }))
  }
  const middle = Math.floor((rowCount - 1) / 2)
  return [
    ...[0, 1, 2].map((index) => ({ position: 'head', index })),
    ...[middle - 1, middle, middle + 1].map((index) => ({ position: 'middle', index })),
    ...[rowCount - 3, rowCount - 2, rowCount - 1].map((index) => ({ position: 'tail', index })),
  ]
}

function normalizedColumnMap(columns) {
  return new Map(columns.map((column) => [String(column).normalize('NFKC').trim().toLowerCase(), column]))
}

function isTwitterPlatformValue(value) {
  return nonEmpty(value) && String(value).normalize('NFKC').trim().toLowerCase() === 'twitter'
}

function isTwitterUrl(value) {
  if (!nonEmpty(value)) return false
  try {
    const hostname = new URL(String(value).trim()).hostname.toLowerCase()
    return hostname === 'x.com'
      || hostname.endsWith('.x.com')
      || hostname === 'twitter.com'
      || hostname.endsWith('.twitter.com')
  } catch {
    return false
  }
}

function isDecimalString(value) {
  return typeof value === 'string' && /^\d+$/u.test(value.trim())
}

function timestampShape(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : ''
  if (/^\d{10}$/u.test(text)) return 'unix-seconds'
  if (/^\d{13}$/u.test(text)) return 'unix-milliseconds'
  return null
}

/**
 * Return a deterministic, value-free description of the first, middle and
 * last parsed rows. Column names, type families and aggregate signal counts are
 * safe to pass to a mapping agent; record values are deliberately never kept.
 */
export function buildDeterministicSamplingSummary({ columns, records }) {
  const samplePositions = deterministicSamplePositions(records.length)
  const sampledRecords = samplePositions.map(({ index }) => records[index])
  const byNormalizedName = normalizedColumnMap(columns)
  const platformColumns = ['platform', 'platform_name']
    .map((name) => byNormalizedName.get(name))
    .filter(Boolean)
  const urlColumns = ['url', 'original_url']
    .map((name) => byNormalizedName.get(name))
    .filter(Boolean)
  const contentIdColumn = byNormalizedName.get('content_id')
  const createdAtColumn = byNormalizedName.get('created_at')

  const summaryColumns = columns.map((column) => {
    const families = new Set()
    let presentCount = 0
    let nonEmptyCount = 0
    for (const record of sampledRecords) {
      if (Object.prototype.hasOwnProperty.call(record, column)) presentCount += 1
      const family = valueTypeFamily(record[column])
      if (!family) continue
      nonEmptyCount += 1
      families.add(family)
    }
    return {
      name: String(column),
      presentCount,
      nonEmptyCount,
      valueTypeFamilies: families.size > 0 ? [...families].sort() : ['unknown'],
    }
  })

  const signals = {
    platformValueRowCount: 0,
    twitterPlatformCount: 0,
    conflictingPlatformRowCount: 0,
    urlValueRowCount: 0,
    twitterUrlRowCount: 0,
    contentIdValueRowCount: 0,
    decimalStringContentIdCount: 0,
    unsafeNumericContentIdCount: 0,
    unixSecondsCreatedAtCount: 0,
    unixMillisecondsCreatedAtCount: 0,
    completeEligibleRowCount: 0,
  }
  for (const record of sampledRecords) {
    const platformValues = platformColumns.map((column) => record[column]).filter(nonEmpty)
    const hasTwitterPlatform = platformValues.length > 0
      && platformValues.every(isTwitterPlatformValue)
    if (platformValues.length > 0) {
      signals.platformValueRowCount += 1
      if (hasTwitterPlatform) signals.twitterPlatformCount += 1
      else signals.conflictingPlatformRowCount += 1
    }

    const urlValues = urlColumns.map((column) => record[column]).filter(nonEmpty)
    const hasTwitterUrl = urlValues.some(isTwitterUrl)
    if (urlValues.length > 0) {
      signals.urlValueRowCount += 1
      if (hasTwitterUrl) signals.twitterUrlRowCount += 1
    }

    let hasSafeContentId = false
    if (contentIdColumn) {
      const contentId = record[contentIdColumn]
      if (nonEmpty(contentId)) signals.contentIdValueRowCount += 1
      if (isDecimalString(contentId)) {
        signals.decimalStringContentIdCount += 1
        hasSafeContentId = true
      }
      else if (typeof contentId === 'number' || typeof contentId === 'bigint') {
        signals.unsafeNumericContentIdCount += 1
      }
    }

    let createdAtShape = null
    if (createdAtColumn) {
      createdAtShape = timestampShape(record[createdAtColumn])
      if (createdAtShape === 'unix-seconds') signals.unixSecondsCreatedAtCount += 1
      if (createdAtShape === 'unix-milliseconds') signals.unixMillisecondsCreatedAtCount += 1
    }

    // Keep the eligibility decision correlated within one row. Independent ID,
    // timestamp and platform totals could otherwise combine evidence from three
    // unrelated sparse rows into one false-positive "complete" sample.
    const hasTwitterEvidence = platformValues.length > 0 ? hasTwitterPlatform : hasTwitterUrl
    if (hasSafeContentId && createdAtShape && hasTwitterEvidence) {
      signals.completeEligibleRowCount += 1
    }
  }

  return {
    strategy: 'head-middle-tail',
    sourceRowCount: records.length,
    sampledRowCount: sampledRecords.length,
    sampledPositions: samplePositions,
    sampledRowIndexes: samplePositions.map(({ index }) => index),
    columns: summaryColumns,
    signals,
  }
}

function detectTwitterPlatform(sampling) {
  const { signals, sampledRowCount } = sampling
  const platformColumnIsUnanimous = signals.platformValueRowCount > 0
    && signals.twitterPlatformCount === signals.platformValueRowCount
    && signals.conflictingPlatformRowCount === 0
  // An explicit, conflicting platform column wins over URL inference. URLs
  // can reference Twitter posts from data owned by another platform.
  if (signals.platformValueRowCount > 0) return platformColumnIsUnanimous ? 'twitter' : null
  const urlHostIsUnanimous = signals.urlValueRowCount > 0
    && signals.twitterUrlRowCount === signals.urlValueRowCount
    && signals.twitterUrlRowCount === sampledRowCount
  return urlHostIsUnanimous ? 'twitter' : null
}

function exactCanyieHeader(columns) {
  return columns.length === TWITTER_CANYIE_COLUMNS.length
    && TWITTER_CANYIE_COLUMNS.every((column) => columns.includes(column))
}

function canyieShapeMatches(sampling) {
  if (sampling.sampledRowCount === 0) return false
  const { signals, sampledRowCount } = sampling
  return signals.completeEligibleRowCount > sampledRowCount / 2
    // Every sampled row that could be ingested must be a complete safe Twitter
    // row. The permitted sparse minority has no external ID and is therefore
    // rejected by applyMapping instead of being archived under this rule.
    && signals.completeEligibleRowCount === signals.contentIdValueRowCount
    && signals.unsafeNumericContentIdCount === 0
    && signals.conflictingPlatformRowCount === 0
}

/**
 * Detect a built-in format rule. `ruleKey` is the stable catalog choice; CSV,
 * JSON and line-delimited JSON are persisted as versions/input formats of that
 * same catalog rule.
 */
export function recognizeBuiltinFormatRule({ columns, records, filename, sampling = null }) {
  const inputFormat = FORMAT_BY_EXTENSION.get(extensionOf(filename))
  if (!inputFormat) return null
  const sampleSummary = sampling ?? buildDeterministicSamplingSummary({ columns, records })
  if (detectTwitterPlatform(sampleSummary) !== 'twitter') return null
  if (!exactCanyieHeader(columns) || !canyieShapeMatches(sampleSummary)) return null

  return {
    ruleKey: TWITTER_CANYIE_RULE_KEY,
    displayName: TWITTER_CANYIE_RULE_DISPLAY_NAME,
    datasetId: TWITTER_CANYIE_DATASET_ID,
    inputFormat,
    scope: { platform: 'twitter', objectType: 'post' },
    fieldMap: clone(TWITTER_CANYIE_FIELD_MAP),
    sampleSummary,
  }
}

/**
 * Local preview detection built exclusively from the value-free summary. This
 * is the object consumers may use to pre-fill a source scope; it contains no
 * source record values.
 */
export function detectExternalFile({ columns, records, filename, sampling = null }) {
  const summary = sampling ?? buildDeterministicSamplingSummary({ columns, records })
  const platform = detectTwitterPlatform(summary)
  const builtinRule = recognizeBuiltinFormatRule({ columns, records, filename, sampling: summary })
  const platformBasis = platform === 'twitter' && summary.signals.platformValueRowCount > 0
    ? 'platform-column'
    : platform === 'twitter' && summary.signals.twitterUrlRowCount > 0
      ? 'twitter-url-host'
      : null
  return {
    platform,
    objectType: builtinRule?.scope.objectType ?? (platform === 'twitter' ? 'post' : null),
    ruleKey: builtinRule?.ruleKey ?? null,
    inputFormat: FORMAT_BY_EXTENSION.get(extensionOf(filename)) ?? null,
    basis: [
      ...(platformBasis ? [platformBasis] : []),
      ...(builtinRule ? ['builtin-header-and-shape'] : []),
    ],
  }
}
