// Chinese word segmentation for search projections.
//
// Segmentation runs here, in the writer, rather than as an Elasticsearch
// analyzer plugin. See src/elasticsearch/analysis.mjs for why. The contract is
// simple: `segment(text)` returns tokens, and the projector joins them with
// spaces into the `*Hanlp` fields that `mx_presegmented` indexes verbatim.
//
// Three backends, in descending quality and ascending cost:
//
//   hanlp     HanLP RESTful service (MX_COMMON_HANLP_URL). Best quality,
//             especially on entity and brand names. Costs a ~2GB PyTorch
//             container and a model download.
//   jieba     @node-rs/jieba, dictionary-based, in-process. Much better than
//             bigrams, no extra service, prebuilt native binaries. The right
//             default for most deployments.
//   fallback  CJK bigrams. No dependency at all, materially worse, always
//             available.
//
// None of these is an Elasticsearch plugin, deliberately. See
// src/elasticsearch/analysis.mjs.
//
// The fallbacks exist so that a HanLP outage degrades first to jieba and only
// then to bigrams instead of stopping ingestion. Because ES projections are
// rebuildable from PostgreSQL, documents indexed with fallback tokens can be
// corrected later by a reindex; documents *not* ingested at all would be a
// permanent hole in the ledger.

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/
// A leading # or @ is kept only when it actually prefixes a word. Matching the
// sigil on its own would emit a bare "#" for every Chinese hashtag (`#大模型`,
// where the tag text is CJK and is handled by the bigram branch instead), filling
// the `tokens` keyword facet with a term present in nearly every document that
// discriminates nothing.
const LATIN_TOKEN = /[#@]?[A-Za-z0-9_][A-Za-z0-9_'\-.]*/g

// Per-call provenance is returned with the tokens so concurrent requests never
// have to infer their backend from the shared `available`/`lastError` snapshot.
// `errorDetail` carries the one fact `errorCode` cannot: which HTTP status the
// tokenizer answered with. 503-still-loading, 429-busy, 413-too-large and
// 404-wrong-path all collapse into `hanlp_http_error`, and they need completely
// different responses from an operator. Only server-derived text goes in here,
// never the input being segmented.
function segmentResult(tokens, backendUsed, degraded = false, errorCode = null, errorDetail = null) {
  return { tokens, backendUsed, degraded, errorCode, errorDetail }
}

function segmenterError(code, message) {
  return Object.assign(new Error(message), { segmenterCode: code })
}

/**
 * Quote the tokenizer's own explanation of a non-2xx answer.
 *
 * The service says "model is still loading" or "tokenizer is busy" in the body;
 * without it a 503 during a cold model load is indistinguishable from a broken
 * deployment. Bounded and read only from the error response, so nothing large
 * or caller-supplied can reach a log line.
 */
async function hanlpErrorSuffix(response) {
  try {
    const text = (await response.text()).slice(0, 200).replace(/\s+/gu, ' ').trim()
    return text ? `: ${text}` : ''
  } catch {
    return ''
  }
}

export class HanlpSegmenter {
  constructor({
    url,
    token,
    timeoutMs = 5_000,
    // A batch is one forward pass over many texts, so it legitimately takes far
    // longer than a single call. Reusing the interactive timeout here would
    // abort batches that were about to succeed and degrade every caller in
    // them -- the opposite of what batching is for.
    batchTimeoutMs = 60_000,
    fetchImpl = globalThis.fetch,
    fallbackSegmenter = null,
    logger = console,
  }) {
    this.url = url.replace(/\/$/, '')
    this.token = token || null
    this.timeoutMs = timeoutMs
    this.batchTimeoutMs = batchTimeoutMs
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.fallbackSegmenter = fallbackSegmenter || new JiebaSegmenter({ logger })
    this.available = true
    this.lastError = null
    // The Hub and the tokenizer image are deployed independently, so a Hub that
    // knows about batching will meet services that do not. Discovered once, on
    // the first 404, rather than configured: an operator should never have to
    // keep a client flag in step with an image tag.
    this.batchSupported = true
  }

  async segment(text) {
    return (await this.segmentWithMeta(text)).tokens
  }

  /**
   * Segment many texts in one forward pass.
   *
   * HanLP's own API takes a list, so a batch of N costs one model handoff and
   * one round trip instead of N of each -- the difference between a rebuild
   * measured in hours and one measured in days. Provenance stays per item, so
   * a strict caller can still reject anything that did not come from HanLP.
   *
   * Alignment is checked rather than assumed: a short or reordered response
   * would attach one record's tokens to another, which is worse than failing.
   */
  async segmentBatchWithMeta(texts) {
    if (texts.length === 0) return []
    // An older tokenizer has no /tokenize/batch. Falling back to the per-text
    // endpoint keeps full HanLP provenance -- only the request shape changes --
    // whereas letting the 404 through would degrade every item to jieba and, in
    // a strict rebuild, fail the whole run on a version skew that costs nothing
    // but speed.
    if (!this.batchSupported) {
      return Promise.all(texts.map((text) => this.segmentWithMeta(text)))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.batchTimeoutMs)
    try {
      const response = await this.fetchImpl(`${this.url}/tokenize/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Basic ${this.token}` } : {}),
        },
        body: JSON.stringify({ texts, coarse: true }),
        signal: controller.signal,
      })
      if (response.status === 404) {
        this.batchSupported = false
        this.logger?.warn?.('[mx-common] HanLP has no /tokenize/batch; using per-text calls')
        clearTimeout(timer)
        return Promise.all(texts.map((text) => this.segmentWithMeta(text)))
      }
      if (!response.ok) {
        throw segmenterError('hanlp_http_error', `HanLP responded ${response.status}${await hanlpErrorSuffix(response)}`)
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw segmenterError('hanlp_invalid_json', 'HanLP returned invalid JSON')
      }
      const batch = payload?.batch
      if (!Array.isArray(batch) || batch.length !== texts.length) {
        throw segmenterError('hanlp_misaligned_batch', 'HanLP returned a misaligned batch')
      }
      const results = batch.map((sentence) => {
        const tokens = normalizeHanlpResponse([sentence])
        return tokens.length > 0 ? segmentResult(tokens, 'hanlp') : null
      })
      this.available = true
      this.lastError = null
      // An empty result is only legitimate for input with nothing to tokenize;
      // anywhere else it is a degradation, resolved per item so one bad text
      // does not condemn the batch.
      return Promise.all(results.map(async (result, index) => {
        if (result) return result
        if (!texts[index]) return segmentResult([], 'hanlp')
        const fallback = await this.fallbackSegmenter.segmentWithMeta(texts[index])
        return segmentResult(fallback.tokens, fallback.backendUsed, true, 'hanlp_empty_response')
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const errorCode = controller.signal.aborted
        ? 'hanlp_timeout'
        : error?.segmenterCode || 'hanlp_request_error'
      this.available = false
      this.lastError = message
      this.logger?.warn?.(`[mx-common] HanLP batch segmentation failed, using jieba fallback: ${message}`)
      return Promise.all(texts.map(async (text) => {
        const fallback = await this.fallbackSegmenter.segmentWithMeta(text)
        return segmentResult(fallback.tokens, fallback.backendUsed, true, errorCode, message)
      }))
    } finally {
      clearTimeout(timer)
    }
  }

  async segmentWithMeta(text) {
    if (!text) return segmentResult([], 'hanlp')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.url}/tokenize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Basic ${this.token}` } : {}),
        },
        // `coarse: true` yields dictionary-sized words ("人工智能" rather than
        // "人工"+"智能"), which is what search relevance wants. Fine-grained
        // segmentation over-splits brand and entity names.
        body: JSON.stringify({ text, coarse: true }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw segmenterError('hanlp_http_error', `HanLP responded ${response.status}${await hanlpErrorSuffix(response)}`)
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw segmenterError('hanlp_invalid_json', 'HanLP returned invalid JSON')
      }
      const tokens = normalizeHanlpResponse(payload)
      if (tokens.length === 0) {
        throw segmenterError('hanlp_empty_response', 'HanLP returned no tokens')
      }
      this.available = true
      this.lastError = null
      return segmentResult(tokens, 'hanlp')
    } catch (error) {
      // Do not throw: a segmentation failure must never fail an ingest.
      const message = error instanceof Error ? error.message : String(error)
      const errorCode = controller.signal.aborted
        ? 'hanlp_timeout'
        : error?.segmenterCode || 'hanlp_request_error'
      this.available = false
      this.lastError = message
      this.logger?.warn?.(`[mx-common] HanLP segmentation failed, using jieba fallback: ${message}`)
      const fallback = await this.fallbackSegmenter.segmentWithMeta(text)
      return segmentResult(fallback.tokens, fallback.backendUsed, true, errorCode, message)
    } finally {
      clearTimeout(timer)
    }
  }
}

// HanLP RESTful returns either `[["token", ...]]` (one array per sentence) or a
// flat `["token", ...]`, depending on version and input shape.
function normalizeHanlpResponse(payload) {
  const data = Array.isArray(payload) ? payload : payload?.tokens || payload?.data || []
  if (!Array.isArray(data)) return []
  const flat = Array.isArray(data[0]) ? data.flat() : data
  return flat.filter((token) => typeof token === 'string' && token.trim()).map((token) => token.trim())
}

/**
 * Dependency-free approximation: Latin runs are split on word boundaries, CJK
 * runs emit unigrams plus bigrams.
 *
 * Bigrams are what make this usable rather than useless — "人工智能" produces
 * 人工/工智/智能, so a search for 人工智能 (itself bigrammed at query time by the
 * companion `.bigram` field) still matches. It over-generates tokens and scores
 * worse than HanLP, which is exactly the expected degradation.
 */
export function fallbackSegment(text) {
  if (!text) return []
  const tokens = []
  for (const match of String(text).matchAll(LATIN_TOKEN)) tokens.push(match[0].toLowerCase())

  let run = ''
  const flushRun = () => {
    if (!run) return
    if (run.length === 1) tokens.push(run)
    else {
      for (let index = 0; index < run.length; index += 1) tokens.push(run[index])
      for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2))
    }
    run = ''
  }
  for (const character of String(text)) {
    if (CJK.test(character)) run += character
    else flushRun()
  }
  flushRun()

  return [...new Set(tokens)]
}

/**
 * Dictionary-based segmentation in the projector process.
 *
 * Loaded lazily and optional: a deployment that never installs @node-rs/jieba
 * degrades to bigrams with a warning rather than failing to start. The package
 * ships prebuilt native binaries, so this adds no build toolchain requirement.
 *
 * Two details that are easy to get wrong and silently halve the quality:
 *
 *  - `new Jieba()` starts with an EMPTY dictionary and segments Chinese into
 *    single characters, which looks like it works and retrieves like bigrams.
 *    The default dictionary has to be passed explicitly via `Jieba.withDict`.
 *  - `hmm: true` lets the model segment words absent from the dictionary, which
 *    social-media text is full of. With it, 吴恩达 stays one token; without it,
 *    it becomes three.
 */
async function loadDefaultJieba() {
  const { Jieba } = await import('@node-rs/jieba')
  // Explicit `.js`: the package publishes no exports map, so the bare
  // '@node-rs/jieba/dict' subpath does not resolve under ESM.
  const dictionary = await import('@node-rs/jieba/dict.js')
  const dict = dictionary.dict ?? dictionary.default?.dict
  if (!dict) throw new Error('@node-rs/jieba/dict.js exposes no dict')
  return Jieba.withDict(dict)
}

export class JiebaSegmenter {
  #instance = null
  #loading = null

  constructor({ logger = console, loadImpl = loadDefaultJieba } = {}) {
    this.logger = logger
    this.loadImpl = loadImpl
    this.available = true
    this.lastError = null
  }

  async #load() {
    if (this.#instance) return this.#instance
    if (!this.#loading) {
      this.#loading = (async () => {
        this.#instance = await this.loadImpl()
        if (typeof this.#instance?.cutAsync !== 'function') {
          throw new Error('jieba loader returned no cutAsync implementation')
        }
        this.available = true
        this.lastError = null
        return this.#instance
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.#instance = null
        this.available = false
        this.lastError = message
        this.logger?.warn?.(
          `[mx-common] jieba unavailable (${message}); using the bigram fallback`,
        )
        return null
      })
    }
    return this.#loading
  }

  async segment(text) {
    return (await this.segmentWithMeta(text)).tokens
  }

  async segmentWithMeta(text) {
    if (!text) return segmentResult([], 'jieba')
    const jieba = await this.#load()
    if (!jieba) {
      return segmentResult(fallbackSegment(text), 'bigram', true, 'jieba_unavailable')
    }
    try {
      // cutAsync keeps the native call off the event loop; the projector runs
      // this once per document in a tight bulk-indexing loop.
      const tokens = await jieba.cutAsync(String(text), true)
      const normalized = tokens
        .map((token) => token.trim().toLowerCase())
        // Punctuation and whitespace carry no retrieval signal and would
        // dominate the `tokens` keyword facet.
        .filter((token) => token && /[\p{L}\p{N}]/u.test(token))
      if (normalized.length === 0) {
        this.available = false
        this.lastError = 'jieba returned no tokens'
        return segmentResult(fallbackSegment(text), 'bigram', true, 'jieba_empty_response')
      }
      this.available = true
      this.lastError = null
      return segmentResult(normalized, 'jieba')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.available = false
      this.lastError = message
      return segmentResult(fallbackSegment(text), 'bigram', true, 'jieba_inference_error')
    }
  }
}

export class FallbackSegmenter {
  constructor() {
    this.available = true
    this.lastError = null
  }

  async segment(text) {
    return (await this.segmentWithMeta(text)).tokens
  }

  async segmentWithMeta(text) {
    return segmentResult(fallbackSegment(text), 'bigram')
  }
}

/**
 * Pick a backend.
 *
 * An explicit `MX_COMMON_SEGMENTER` wins so a deployment can pin one; otherwise
 * a configured HanLP URL beats jieba, and jieba beats bigrams. Every branch
 * degrades at runtime rather than refusing to start: the projection is
 * rebuildable, so a worse segmenter costs a reindex later, while a projector
 * that will not boot costs ingestion now.
 */
export function createSegmenter(config, { logger = console } = {}) {
  const explicit = config?.backend
  if (explicit === 'fallback') return new FallbackSegmenter()
  if (explicit === 'jieba') return new JiebaSegmenter({ logger })
  if (explicit === 'hanlp' || (!explicit && config?.hanlpUrl)) {
    if (!config?.hanlpUrl) {
      logger?.warn?.('[mx-common] MX_COMMON_SEGMENTER=hanlp but no MX_COMMON_HANLP_URL; using jieba')
      return new JiebaSegmenter({ logger })
    }
    return new HanlpSegmenter({
      url: config.hanlpUrl,
      token: config.hanlpToken,
      timeoutMs: config.timeoutMs,
      batchTimeoutMs: config.batchTimeoutMs,
      logger,
    })
  }
  return new JiebaSegmenter({ logger })
}

/**
 * Coalesce concurrent single-text calls into one batch request.
 *
 * Callers keep the `segmentWithMeta(text)` interface they already have -- the
 * document builder, the strict reindex wrapper and the memo cache are all
 * untouched -- while the calls they make in the same tick leave as one HTTP
 * request. Batching is therefore an execution detail, not a contract change,
 * which matters because the strict rebuild's guarantee is expressed per result:
 * every item still carries its own backend and degraded flag, so a batch can
 * never smuggle fallback tokens past a caller that rejects them.
 *
 * A batch is dispatched as soon as the current tick's callers have queued,
 * or immediately once `maxBatch` is reached. There is no timer: waiting on a
 * clock would add latency for the interactive path without adding throughput
 * for the bulk one, since a bulk writer always has more work queued already.
 */
export function batchingSegmenter(segmenter, { maxBatch = 64 } = {}) {
  if (typeof segmenter?.segmentBatchWithMeta !== 'function') return segmenter
  let pending = []
  let scheduled = false

  const flush = async () => {
    scheduled = false
    while (pending.length > 0) {
      const batch = pending.slice(0, maxBatch)
      pending = pending.slice(maxBatch)
      try {
        const results = await segmenter.segmentBatchWithMeta(batch.map((entry) => entry.text))
        // Defensive: a misaligned batch must fail its callers rather than hand
        // any of them another record's tokens.
        if (!Array.isArray(results) || results.length !== batch.length) {
          throw new Error('segmenter returned a misaligned batch')
        }
        batch.forEach((entry, index) => entry.resolve(results[index]))
      } catch (error) {
        batch.forEach((entry) => entry.reject(error))
      }
    }
  }

  return {
    async segmentWithMeta(text) {
      if (!text) return segmentResult([], 'hanlp')
      return new Promise((resolve, reject) => {
        pending.push({ text, resolve, reject })
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      })
    },
    async segment(text) {
      return (await this.segmentWithMeta(text)).tokens
    },
  }
}

/** Join tokens into the whitespace-delimited form `mx_presegmented` expects. */
export function toPresegmentedText(tokens) {
  return tokens.join(' ')
}
