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
// Read by deploy/hanlp/server.py's admission lanes.
const SEGMENT_PRIORITY_HEADER = 'x-mx-segment-priority'

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
   *
   * `priority: 'interactive'` asks the service to admit the batch ahead of
   * bulk work, onto a worker bulk writers may not take. Only a caller with a
   * person waiting should pass it; leaving it out is what keeps a writer a
   * writer, because the service treats an unlabelled request as bulk.
   */
  async segmentBatchWithMeta(texts, {
    allowFallback = true,
    timeoutMs = this.batchTimeoutMs,
    priority = null,
  } = {}) {
    if (texts.length === 0) return []
    // An older tokenizer has no /tokenize/batch. Falling back to the per-text
    // endpoint keeps full HanLP provenance -- only the request shape changes --
    // whereas letting the 404 through would degrade every item to jieba and, in
    // a strict rebuild, fail the whole run on a version skew that costs nothing
    // but speed.
    if (!this.batchSupported) {
      return Promise.all(texts.map((text) => this.segmentWithMeta(text, { allowFallback })))
    }
    const controller = new AbortController()
    // Bulk writers keep the long batch timeout. A request-path caller passes
    // its own, shorter one: it has a person waiting and a fallback to use.
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.url}/tokenize/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Basic ${this.token}` } : {}),
          // An older image ignores the header, so sending it is never a skew risk.
          ...(priority === 'interactive' ? { [SEGMENT_PRIORITY_HEADER]: 'interactive' } : {}),
        },
        body: JSON.stringify({ texts, coarse: true }),
        signal: controller.signal,
      })
      if (response.status === 404) {
        this.batchSupported = false
        this.logger?.warn?.('[mx-common] HanLP has no /tokenize/batch; using per-text calls')
        clearTimeout(timer)
        return Promise.all(texts.map((text) => this.segmentWithMeta(text, { allowFallback })))
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
        if (!allowFallback) return segmentResult([], null, true, 'hanlp_empty_response')
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
      // A strict caller discards fallback tokens by definition, so computing
      // them is pure waste -- and under batching it is a burst of up to one
      // native jieba call per text, concurrently, for results nobody will use.
      // That burst is what segfaulted the projector once an hour.
      if (!allowFallback) {
        this.logger?.warn?.(`[mx-common] HanLP batch segmentation failed, no fallback requested: ${message}`)
        return texts.map(() => segmentResult([], null, true, errorCode, message))
      }
      this.logger?.warn?.(`[mx-common] HanLP batch segmentation failed, using jieba fallback: ${message}`)
      return Promise.all(texts.map(async (text) => {
        const fallback = await this.fallbackSegmenter.segmentWithMeta(text)
        return segmentResult(fallback.tokens, fallback.backendUsed, true, errorCode, message)
      }))
    } finally {
      clearTimeout(timer)
    }
  }

  async segmentWithMeta(text, { allowFallback = true } = {}) {
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
      if (!allowFallback) {
        this.logger?.warn?.(`[mx-common] HanLP segmentation failed, no fallback requested: ${message}`)
        return segmentResult([], null, true, errorCode, message)
      }
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
  #queue = Promise.resolve()

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
    // Native calls are serialized. @node-rs/jieba is a Rust binding, and driving
    // `cutAsync` from many concurrent callers segfaulted the projector process
    // (exit 139) roughly once an hour. Serializing costs throughput only on the
    // fallback path, which is by definition already degraded.
    const previous = this.#queue
    let release
    this.#queue = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await this.#segmentSerialized(text)
    } finally {
      release()
    }
  }

  async #segmentSerialized(text) {
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
        // Every entry in a coalesced batch shares one request, so the strictest
        // choice in it wins: never compute a fallback someone in this batch
        // would reject.
        const allowFallback = batch.every((entry) => entry.options?.allowFallback !== false)
        const results = await segmenter.segmentBatchWithMeta(
          batch.map((entry) => entry.text),
          { allowFallback },
        )
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
    async segmentWithMeta(text, options = {}) {
      if (!text) return segmentResult([], 'hanlp')
      return new Promise((resolve, reject) => {
        pending.push({ text, resolve, reject, options })
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      })
    },
    async segment(text, options = {}) {
      return (await this.segmentWithMeta(text, options)).tokens
    },
  }
}

/**
 * Request-path segmentation: coalesce under load, remember verified answers,
 * and never keep a caller waiting on the tokenizer past its budget.
 *
 * The HanLP service has a few workers, each running one forward pass at a time.
 * One query per HTTP request pays the per-pass overhead (HTTP, Python dispatch,
 * model handoff) per query, so the service saturates long before Elasticsearch
 * does, and every queued search keeps its request slot while it waits. Here a
 * query that arrives while earlier ones are in flight joins the next batch
 * instead. Idle traffic still leaves at once as a batch of one; batch size
 * grows with load, so one pass absorbs a burst instead of the burst forming a
 * queue at the service. Every batch is labelled interactive, so the service
 * admits it ahead of bulk work and onto a worker writers cannot occupy.
 *
 *  - Only verified HanLP answers are cached. Tokens are a pure function of the
 *    text for a deployed model; the TTL bounds staleness across a redeploy.
 *  - Identical concurrent texts share one slot in one batch.
 *  - A caller waits at most its budget, then gets what HanlpSegmenter gives on
 *    failure: fail-soft callers a labelled jieba fallback, strict callers
 *    (`allowFallback: false`) a degraded empty result. Work nobody waits for is
 *    dropped before it is sent; work already sent completes and warms the cache.
 *  - The unsent queue is bounded. Past it a caller degrades immediately rather
 *    than holding its request for a pass that cannot arrive in time.
 *
 * Bulk writers do not use this: they already batch, and they must not be
 * dropped for being slow. A segmenter without a batch API (jieba, bigram, test
 * doubles) is returned unchanged; it has no per-request overhead to coalesce.
 */
export function interactiveSegmenter(segmenter, {
  maxBatch = 32,
  maxBatchChars = 16_384,
  maxInFlight = 2,
  maxPending = 1_024,
  waitMs = 2_000,
  strictWaitMs = segmenter?.timeoutMs ?? 5_000,
  // The HTTP request outlives any single caller's budget on purpose: an answer
  // that arrives after its callers gave up still lands in the cache.
  requestTimeoutMs = Math.max(waitMs, strictWaitMs),
  cacheEntries = 5_000,
  cacheTtlMs = 10 * 60_000,
  maxCachedTextLength = 256,
  now = Date.now,
} = {}) {
  if (typeof segmenter?.segmentBatchWithMeta !== 'function') return segmenter
  const cache = new Map()
  const entries = new Map()
  const queue = []
  let inFlight = 0
  let scheduled = false
  const counters = {
    requests: 0, cacheHits: 0, joined: 0, batches: 0, batchedTexts: 0,
    verified: 0, failed: 0, shed: 0, waitExpired: 0, dropped: 0,
  }

  const copy = (result) => ({ ...result, tokens: [...result.tokens] })
  const verified = (result) => result?.backendUsed === 'hanlp'
    && result.degraded === false
    && Array.isArray(result.tokens)

  const readCache = (text) => {
    const hit = cache.get(text)
    if (!hit) return null
    cache.delete(text)
    if (hit.expiresAt <= now()) return null
    // Re-inserted so eviction (oldest key first) approximates least recently used.
    cache.set(text, hit)
    return copy(hit.result)
  }
  const remember = (text, result) => {
    if (cacheEntries <= 0 || text.length > maxCachedTextLength) return
    cache.delete(text)
    if (cache.size >= cacheEntries) cache.delete(cache.keys().next().value)
    cache.set(text, { result: copy(result), expiresAt: now() + cacheTtlMs })
  }

  const degrade = async (text, strict, errorCode, errorDetail) => {
    if (strict) return segmentResult([], null, true, errorCode, errorDetail)
    const fallback = segmenter.fallbackSegmenter
      ? await segmenter.fallbackSegmenter.segmentWithMeta(text)
      : segmentResult(fallbackSegment(text), 'bigram')
    return segmentResult(fallback.tokens, fallback.backendUsed, true, errorCode, errorDetail)
  }

  const send = async (batch) => {
    inFlight += 1
    counters.batches += 1
    counters.batchedTexts += batch.length
    let results
    try {
      results = await segmenter.segmentBatchWithMeta(
        batch.map((entry) => entry.text),
        { allowFallback: false, timeoutMs: requestTimeoutMs, priority: 'interactive' },
      )
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error('segmenter returned a misaligned batch')
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      results = batch.map(() => segmentResult([], null, true, 'hanlp_request_error', detail))
    } finally {
      inFlight -= 1
    }
    batch.forEach((entry, index) => {
      if (entries.get(entry.text) === entry) entries.delete(entry.text)
      if (verified(results[index])) {
        counters.verified += 1
        remember(entry.text, results[index])
      } else {
        counters.failed += 1
      }
      entry.settle(results[index])
    })
    schedule()
  }

  const pump = () => {
    scheduled = false
    while (inFlight < maxInFlight && queue.length > 0) {
      const batch = []
      let chars = 0
      while (queue.length > 0 && batch.length < maxBatch) {
        // A batch is one forward pass; bounding its text keeps the pass, and so
        // the wait of whoever is queued behind it, short.
        if (batch.length > 0 && chars + queue[0].text.length > maxBatchChars) break
        const entry = queue.shift()
        entry.sent = true
        chars += entry.text.length
        batch.push(entry)
      }
      send(batch)
    }
  }
  // Callers from the same tick leave together even when nothing is in flight.
  const schedule = () => {
    if (scheduled || queue.length === 0) return
    scheduled = true
    queueMicrotask(pump)
  }

  const enqueue = (text) => {
    let settle
    const promise = new Promise((resolve) => { settle = resolve })
    const entry = { text, promise, settle, waiters: 0, sent: false }
    entries.set(text, entry)
    queue.push(entry)
    schedule()
    return entry
  }
  const drop = (entry) => {
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    if (entries.get(entry.text) === entry) entries.delete(entry.text)
    counters.dropped += 1
  }

  return {
    fallbackSegmenter: segmenter.fallbackSegmenter,
    stats: () => ({
      pending: queue.length,
      inFlight,
      cacheSize: cache.size,
      ...counters,
    }),
    async segmentWithMeta(text, options = {}) {
      if (!text) return segmentResult([], 'hanlp')
      const strict = options?.allowFallback === false
      counters.requests += 1
      const cached = readCache(text)
      if (cached) {
        counters.cacheHits += 1
        return cached
      }
      let entry = entries.get(text)
      if (entry) {
        counters.joined += 1
      } else if (queue.length >= maxPending) {
        counters.shed += 1
        return degrade(text, strict, 'hanlp_busy', 'tokenizer queue is full')
      } else {
        entry = enqueue(text)
      }
      entry.waiters += 1
      const budget = strict ? strictWaitMs : waitMs
      let timer
      const expired = Symbol('expired')
      const outcome = await Promise.race([
        entry.promise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(expired), budget) }),
      ])
      clearTimeout(timer)
      entry.waiters -= 1
      if (outcome === expired) {
        counters.waitExpired += 1
        if (entry.waiters === 0 && !entry.sent) drop(entry)
        return degrade(text, strict, 'hanlp_busy', `tokenizer did not answer within ${budget} ms`)
      }
      if (verified(outcome)) return copy(outcome)
      return degrade(
        text,
        strict,
        outcome?.errorCode || 'hanlp_request_error',
        outcome?.errorDetail ?? null,
      )
    },
    async segment(text, options = {}) {
      return (await this.segmentWithMeta(text, options)).tokens
    },
  }
}

/** Join tokens into the whitespace-delimited form `mx_presegmented` expects. */
export function toPresegmentedText(tokens) {
  return tokens.join(' ')
}
