import { batchingSegmenter } from '@qpjoy/mx-common/segmenter'

const SUPPORTED_BACKENDS = new Set(['hanlp', 'jieba', 'bigram'])

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class ReindexSegmenterIntegrityError extends Error {
  constructor(expectedBackend, actualBackend, errorCode, cause = null, errorDetail = null) {
    // Prefer the tokenizer's own words. "hanlp_http_error" is a category; the
    // operator needs the status behind it, because 503-still-loading means wait,
    // 429 means lower concurrency and 404 means the deployment is wrong.
    const detail = cause?.message
      || errorDetail
      || errorCode
      || 'the tokenizer reported degraded output'
    super(
      `reindex requires ${expectedBackend} tokens but received ${actualBackend || 'no verified backend'}: ${detail}`,
      cause ? { cause } : undefined,
    )
    this.name = 'ReindexSegmenterIntegrityError'
    this.code = 'reindex_segmenter_degraded'
    this.expectedBackend = expectedBackend
    this.actualBackend = actualBackend || null
    this.segmenterErrorCode = errorCode || null
    this.segmenterErrorDetail = errorDetail || null
  }
}

const RETRYABLE_SEGMENTER_CODES = new Set([
  'hanlp_timeout',
  'hanlp_network_error',
  'hanlp_busy',
  'hanlp_unavailable',
])

function segmenterHttpStatus(error) {
  let cause = error?.cause
  for (let depth = 0; cause && depth < 4; depth += 1, cause = cause.cause) {
    const direct = Number(cause.status ?? cause.statusCode)
    if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct
  }
  const detail = error?.segmenterErrorDetail || error?.cause?.message || error?.message || ''
  const match = String(detail).match(/(?:responded|HTTP(?:\s+status)?)\s+(\d{3})\b/iu)
  return match ? Number(match[1]) : null
}

function hasRetryableNetworkCause(error) {
  const codes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND',
    'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ])
  let cause = error?.cause
  for (let depth = 0; cause && depth < 4; depth += 1, cause = cause.cause) {
    if (codes.has(cause.code) || cause.name === 'AbortError' || cause.name === 'TimeoutError') {
      return true
    }
  }
  return false
}

function hasRetryableNetworkDetail(error) {
  const detail = `${error?.segmenterErrorDetail || ''} ${error?.cause?.message || ''}`
  return /\b(?:fetch failed|network(?: is)? (?:down|unreachable)|socket|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/iu.test(detail)
}

/**
 * Only a shared dependency outage may bypass a durable projection retry budget.
 * Bad input, invalid response shapes, backend mismatches and ordinary 4xx
 * responses are aggregate-specific failures and must eventually quarantine.
 */
export function isRetryableSegmenterIntegrityError(error) {
  if (error?.code !== 'reindex_segmenter_degraded') return false
  if (RETRYABLE_SEGMENTER_CODES.has(error.segmenterErrorCode)) return true
  if (hasRetryableNetworkCause(error)) return true
  if ((error.segmenterErrorCode === 'hanlp_request_error' || !error.segmenterErrorCode)
    && hasRetryableNetworkDetail(error)) return true
  const status = segmenterHttpStatus(error)
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true
  return false
}

/** Resolve the backend the deployed process is configured to use. */
export function requiredReindexBackend(config = {}) {
  const explicit = config.backend || null
  if (explicit === 'fallback') return 'bigram'
  if (explicit === 'jieba') return 'jieba'
  if (explicit === 'hanlp') {
    if (!config.hanlpUrl) {
      throw new TypeError('MX_COMMON_SEGMENTER=hanlp requires MX_COMMON_HANLP_URL for a strict reindex')
    }
    return 'hanlp'
  }
  if (explicit) throw new TypeError(`unsupported MX_COMMON_SEGMENTER value: ${explicit}`)
  return config.hanlpUrl ? 'hanlp' : 'jieba'
}

/**
 * Wrap a fail-soft runtime segmenter with a fail-closed projection contract.
 *
 * Index writers use this wrapper so accepting fallback tokens can never make a
 * successful projection lie about its tokenizer provenance. Query analysis may
 * still use the original fail-soft segmenter for availability.
 */
// A busy tokenizer is a queueing signal, not a verdict on the text. Under
// concurrency it is also the expected way to discover the service's ceiling, so
// it earns a longer, growing wait rather than counting against the same short
// budget as a malformed response.
const BUSY_ERROR_CODES = new Set(['hanlp_busy', 'hanlp_timeout'])
const BUSY_RETRY_DELAY_MS = 1_000

export function requireSegmenterBackend(segmenter, {
  expectedBackend,
  maxAttempts = 6,
  retryDelayMs = 250,
  busyRetryDelayMs = BUSY_RETRY_DELAY_MS,
  maxBatch = 64,
  sleep = delay,
  logger = console,
} = {}) {
  if (!SUPPORTED_BACKENDS.has(expectedBackend)) {
    throw new TypeError(`expectedBackend must be one of ${[...SUPPORTED_BACKENDS].join(', ')}`)
  }
  if (!segmenter || typeof segmenter.segmentWithMeta !== 'function') {
    throw new TypeError('strict reindex requires a segmenter with per-call provenance')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError('maxAttempts must be an integer between 1 and 10')
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError('retryDelayMs must be a non-negative number')
  }
  if (!Number.isInteger(maxBatch) || maxBatch < 1) {
    throw new TypeError('maxBatch must be a positive integer')
  }

  // Coalesce the raw backend first, then verify each resolved item below. A
  // strict batch method cannot safely throw for one item without rejecting all
  // callers; this order keeps per-item provenance and retry budgets isolated.
  const sourceSegmenter = batchingSegmenter(segmenter, { maxBatch })

  const segmentWithMeta = async (text) => {
    // Punctuation/whitespace-only fields have no searchable tokens. Treating
    // that expected empty result as a backend degradation would make a strict
    // full-corpus rebuild fail on perfectly valid records such as emoji-only
    // messages.
    if (!/[\p{L}\p{N}]/u.test(String(text ?? ''))) {
      return { tokens: [], backendUsed: expectedBackend, degraded: false, errorCode: null }
    }
    let lastResult = null
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // No fallback: this wrapper rejects anything but the expected backend, so
        // asking the runtime segmenter to compute a fallback produces tokens that
        // are discarded on arrival. Under batching that was a burst of native
        // jieba calls per failed batch, which segfaulted the process outright.
        lastResult = await sourceSegmenter.segmentWithMeta(text, { allowFallback: false })
        lastError = null
        const hasVerifiedTokens = Array.isArray(lastResult?.tokens)
          && (!String(text ?? '').trim() || lastResult.tokens.length > 0)
        if (
          lastResult?.backendUsed === expectedBackend
          && lastResult.degraded === false
          && hasVerifiedTokens
        ) {
          return lastResult
        }
      } catch (error) {
        lastResult = null
        lastError = error instanceof Error ? error : new Error(String(error))
      }

      const integrityError = new ReindexSegmenterIntegrityError(
        expectedBackend,
        lastResult?.backendUsed,
        lastResult?.errorCode,
        lastError,
        lastResult?.errorDetail,
      )
      // A record-specific or permanent contract failure cannot improve by
      // holding the oldest queue item for another 31 seconds. Only shared
      // dependency failures receive the bounded exponential retry window.
      if (!isRetryableSegmenterIntegrityError(integrityError) || attempt >= maxAttempts) {
        throw integrityError
      }

      const actual = lastResult?.backendUsed || 'error'
      const reason = lastError?.message || lastResult?.errorCode || 'degraded output'
      logger?.warn?.(
        `[reindex] tokenizer attempt ${attempt}/${maxAttempts} rejected ` +
          `(expected=${expectedBackend}, actual=${actual}, reason=${reason}); retrying`,
      )
      // Backing off further on a busy signal lets the inference queue drain.
      // Retrying at the same cadence would keep the queue full and convert a
      // momentary overload into a rebuild-ending failure.
      const status = segmenterHttpStatus(integrityError)
      const busy = BUSY_ERROR_CODES.has(lastResult?.errorCode) || status === 429 || status === 503
      const base = busy ? busyRetryDelayMs : retryDelayMs
      await sleep(base * (2 ** (attempt - 1)))
    }

    throw new Error('unreachable tokenizer retry state')
  }

  /**
   * One pass over many texts as a few batch requests, with no retries.
   *
   * Returns only verified results, keyed by text. A bulk writer warms a memo
   * with it and then builds documents through `segmentWithMeta`, so anything
   * missing here still gets the full strict retry budget, and a tokenizer
   * outage is retried once by that path instead of once per prefetched text.
   */
  const prefetch = async (texts, { concurrency = 2 } = {}) => {
    const verified = new Map()
    if (typeof segmenter.segmentBatchWithMeta !== 'function') return verified
    const unique = [...new Set(texts.map((text) => String(text ?? '')))]
      .filter((text) => /[\p{L}\p{N}]/u.test(text))
    const chunks = []
    for (let index = 0; index < unique.length; index += maxBatch) {
      chunks.push(unique.slice(index, index + maxBatch))
    }
    let failed = false
    let next = 0
    const worker = async () => {
      while (!failed && next < chunks.length) {
        const chunk = chunks[next]
        next += 1
        try {
          const results = await segmenter.segmentBatchWithMeta(chunk, { allowFallback: false })
          if (!Array.isArray(results) || results.length !== chunk.length) {
            failed = true
            return
          }
          let accepted = 0
          results.forEach((result, index) => {
            if (result?.backendUsed === expectedBackend
              && result.degraded === false
              && Array.isArray(result.tokens)
              && result.tokens.length > 0) {
              verified.set(chunk[index], result)
              accepted += 1
            }
          })
          // Batch failures come back as degraded items rather than a throw.
          // Every text here has letters or digits, so nothing verified means
          // the tokenizer is failing: stop sending more of the same.
          if (accepted === 0) failed = true
        } catch {
          // A failed pass says nothing per text; leave it to the strict path.
          failed = true
        }
      }
    }
    const width = Math.max(1, Math.min(Number(concurrency) || 1, chunks.length))
    await Promise.all(Array.from({ length: width }, worker))
    return verified
  }

  return {
    expectedBackend,
    segmentWithMeta,
    prefetch,
    async segment(text) {
      return (await segmentWithMeta(text)).tokens
    },
  }
}
