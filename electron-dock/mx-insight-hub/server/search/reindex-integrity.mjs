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
  }
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
 * Wrap a fail-soft runtime segmenter with a fail-closed reindex contract.
 *
 * Normal projector traffic keeps using the original segmenter directly. This
 * wrapper is created only by the one-shot reindex process, where accepting
 * fallback tokens would make a successful command lie about projection quality.
 */
// A busy tokenizer is a queueing signal, not a verdict on the text. Under
// concurrency it is also the expected way to discover the service's ceiling, so
// it earns a longer, growing wait rather than counting against the same short
// budget as a malformed response.
const BUSY_ERROR_CODES = new Set(['hanlp_http_error', 'hanlp_timeout'])
const BUSY_RETRY_DELAY_MS = 1_000

export function requireSegmenterBackend(segmenter, {
  expectedBackend,
  maxAttempts = 6,
  retryDelayMs = 250,
  busyRetryDelayMs = BUSY_RETRY_DELAY_MS,
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
        lastResult = await segmenter.segmentWithMeta(text)
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

      if (attempt < maxAttempts) {
        const actual = lastResult?.backendUsed || 'error'
        const reason = lastError?.message || lastResult?.errorCode || 'degraded output'
        logger?.warn?.(
          `[reindex] tokenizer attempt ${attempt}/${maxAttempts} rejected ` +
            `(expected=${expectedBackend}, actual=${actual}, reason=${reason}); retrying`,
        )
        // Backing off further on a busy signal lets the inference queue drain.
        // Retrying at the same cadence would keep the queue full and convert a
        // momentary overload into a rebuild-ending failure.
        const base = BUSY_ERROR_CODES.has(lastResult?.errorCode) ? busyRetryDelayMs : retryDelayMs
        await sleep(base * (2 ** (attempt - 1)))
      }
    }

    throw new ReindexSegmenterIntegrityError(
      expectedBackend,
      lastResult?.backendUsed,
      lastResult?.errorCode,
      lastError,
      lastResult?.errorDetail,
    )
  }

  return {
    segmentWithMeta,
    async segment(text) {
      return (await segmentWithMeta(text)).tokens
    },
  }
}
