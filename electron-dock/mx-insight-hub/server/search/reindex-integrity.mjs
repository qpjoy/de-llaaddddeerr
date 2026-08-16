const SUPPORTED_BACKENDS = new Set(['hanlp', 'jieba', 'bigram'])

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class ReindexSegmenterIntegrityError extends Error {
  constructor(expectedBackend, actualBackend, errorCode, cause = null) {
    const detail = cause?.message || errorCode || 'the tokenizer reported degraded output'
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
export function requireSegmenterBackend(segmenter, {
  expectedBackend,
  maxAttempts = 3,
  retryDelayMs = 250,
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
        await sleep(retryDelayMs * (2 ** (attempt - 1)))
      }
    }

    throw new ReindexSegmenterIntegrityError(
      expectedBackend,
      lastResult?.backendUsed,
      lastResult?.errorCode,
      lastError,
    )
  }

  return {
    segmentWithMeta,
    async segment(text) {
      return (await segmentWithMeta(text)).tokens
    },
  }
}
