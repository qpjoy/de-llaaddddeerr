// Minimal Elasticsearch client over `fetch`.
//
// Deliberately not @elastic/elasticsearch: that package pins a client major to a
// cluster major and pulls a large dependency tree into every product image. The
// surface we need (index/template/ILM administration, bulk, search) is a dozen
// REST calls, and staying on fetch means a cluster upgrade never forces a
// coordinated client upgrade across products.

/**
 * Recognise a cluster health document.
 *
 * `_cluster/health` answers a `wait_for_status` timeout with HTTP 408 and the
 * health document itself rather than an error envelope, so a body carrying a
 * cluster name and a colour is a successful read of a cluster that has not
 * settled -- not a malformed error.
 */
export function isClusterHealthBody(body) {
  return Boolean(body)
    && typeof body === 'object'
    && typeof body.cluster_name === 'string'
    && ['red', 'yellow', 'green'].includes(body.status)
}

/** One-line, log-safe summary of a cluster health document. */
export function describeClusterHealth(health) {
  if (!isClusterHealthBody(health)) return 'unknown cluster health'
  const parts = [`status=${health.status}`]
  if (health.timed_out === true) parts.push('timed_out')
  for (const [label, key] of [
    ['nodes', 'number_of_nodes'],
    ['unassigned_shards', 'unassigned_shards'],
    ['initializing_shards', 'initializing_shards'],
    ['relocating_shards', 'relocating_shards'],
  ]) {
    if (Number.isFinite(health[key])) parts.push(`${label}=${health[key]}`)
  }
  return parts.join(', ')
}

export class ElasticsearchError extends Error {
  constructor(status, body, { method, path } = {}) {
    // A health document has no `error` envelope. Falling through to
    // "unknown error" there discards the only diagnostic the response carried.
    const reason = body?.error?.reason
      || body?.error?.type
      || (isClusterHealthBody(body) ? describeClusterHealth(body) : null)
      || body?.message
      || 'unknown error'
    super(`Elasticsearch ${method || ''} ${path || ''} failed (${status}): ${reason}`)
    this.name = 'ElasticsearchError'
    this.status = status
    this.body = body
    // ES reports "already exists" style conflicts with a stable type string;
    // callers use it to keep reconciliation idempotent.
    this.type = body?.error?.type || null
  }
}

export class ElasticsearchUnavailableError extends Error {
  constructor(cause) {
    super(`Elasticsearch is unreachable: ${cause?.message || cause}`)
    this.name = 'ElasticsearchUnavailableError'
    this.cause = cause
  }
}

export class ElasticsearchClient {
  constructor({ url, username, password, requestTimeoutMs = 10_000, fetchImpl = globalThis.fetch }) {
    if (!url) throw new Error('Elasticsearch url is required')
    this.baseUrl = url.replace(/\/$/, '')
    this.requestTimeoutMs = requestTimeoutMs
    this.fetchImpl = fetchImpl
    this.authorization = username
      ? `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}`
      : null
  }

  async request(method, path, body, { ndjson = false, timeoutMs } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.requestTimeoutMs)
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined
            ? {}
            : { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' }),
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      // A transport failure is categorically different from a rejected request:
      // the former means "search is down, degrade", the latter means "this call
      // is wrong, fix it". Callers branch on the class, never on a string.
      throw new ElasticsearchUnavailableError(error)
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { message: text }
      }
    }
    if (!response.ok) throw new ElasticsearchError(response.status, payload, { method, path })
    return payload
  }

  async ping() {
    await this.request('GET', '/')
    return true
  }

  // `waitForStatus` defaults to yellow: a single-node cluster with replicas
  // configured can never reach green, and gating deploy on green would hang.
  //
  // Not reaching that status is reported as HTTP 408 with the health document
  // as the body. That is an answer, not a failure: the cluster was reached and
  // told us its colour. Returning it -- flagged with `timedOut` -- keeps the
  // distinction callers actually need, between a cluster that is unreachable
  // and one that is reachable and unhealthy. Only the first is an outage.
  async clusterHealth({ waitForStatus = 'yellow', timeout = '30s' } = {}) {
    try {
      return await this.request(
        'GET',
        `/_cluster/health?wait_for_status=${waitForStatus}&timeout=${timeout}`,
        undefined,
        { timeoutMs: 45_000 },
      )
    } catch (error) {
      if (
        error instanceof ElasticsearchError
        && error.status === 408
        && isClusterHealthBody(error.body)
      ) {
        return { ...error.body, timedOut: true }
      }
      throw error
    }
  }

  async exists(path) {
    try {
      await this.request('HEAD', path)
      return true
    } catch (error) {
      if (error instanceof ElasticsearchError && error.status === 404) return false
      throw error
    }
  }

  putIlmPolicy(name, policy) {
    return this.request('PUT', `/_ilm/policy/${encodeURIComponent(name)}`, policy)
  }

  getIlmPolicy(name) {
    return this.request('GET', `/_ilm/policy/${encodeURIComponent(name)}`)
  }

  putComponentTemplate(name, template) {
    return this.request('PUT', `/_component_template/${encodeURIComponent(name)}`, template)
  }

  putIndexTemplate(name, template) {
    return this.request('PUT', `/_index_template/${encodeURIComponent(name)}`, template)
  }

  createIndex(index, body) {
    return this.request('PUT', `/${encodeURIComponent(index)}`, body)
  }

  indexExists(index) {
    return this.exists(`/${encodeURIComponent(index)}`)
  }

  aliasExists(alias) {
    return this.exists(`/_alias/${encodeURIComponent(alias)}`)
  }

  getAlias(alias) {
    return this.request('GET', `/_alias/${encodeURIComponent(alias)}`)
  }

  rollover(alias, conditions) {
    return this.request('POST', `/${encodeURIComponent(alias)}/_rollover`, conditions)
  }

  putMapping(index, mapping) {
    return this.request('PUT', `/${encodeURIComponent(index)}/_mapping`, mapping)
  }

  getMapping(index) {
    return this.request('GET', `/${encodeURIComponent(index)}/_mapping`)
  }

  /**
   * Ask the cluster why one shard is where it is.
   *
   * Returns null when there is nothing to explain -- every shard assigned, or
   * the index not created yet -- because both are ordinary states rather than
   * failures. When a shard *is* stuck, the deciders in the response name the
   * exact cluster setting blocking it, which is the only form of this answer an
   * operator can act on.
   */
  async allocationExplain({ index, shard = 0, primary = true } = {}) {
    const body = index === undefined ? undefined : { index, shard, primary }
    try {
      return await this.request('POST', '/_cluster/allocation/explain', body)
    } catch (error) {
      if (error instanceof ElasticsearchError && (error.status === 400 || error.status === 404)) {
        return null
      }
      throw error
    }
  }

  /** Per-node shard and disk allocation, with byte counts rather than strings. */
  catAllocation() {
    return this.request('GET', '/_cat/allocation?format=json&bytes=b')
  }

  putSnapshotRepository(name, body) {
    return this.request('PUT', `/_snapshot/${encodeURIComponent(name)}`, body)
  }

  reindex(body, { waitForCompletion = false } = {}) {
    return this.request(
      'POST',
      `/_reindex?wait_for_completion=${waitForCompletion}&refresh=true`,
      body,
      { timeoutMs: 60_000 },
    )
  }

  search(index, body) {
    return this.request('POST', `/${encodeURIComponent(index)}/_search`, body)
  }

  count(index, body) {
    return this.request('POST', `/${encodeURIComponent(index)}/_count`, body)
  }

  /**
   * Bulk index a batch of operations.
   *
   * Returns per-item outcomes rather than throwing on partial failure: a bulk
   * response can be HTTP 200 with individual rejected documents, and a projector
   * must be able to retry only the failures instead of replaying the batch.
   */
  async bulk(operations, { refresh = false } = {}) {
    if (operations.length === 0) return { took: 0, errors: false, items: [] }
    const body = `${operations.map((operation) => JSON.stringify(operation)).join('\n')}\n`
    return this.request('POST', `/_bulk?refresh=${refresh}`, body, {
      ndjson: true,
      timeoutMs: 60_000,
    })
  }
}

export function createElasticsearchClient(config) {
  if (!config?.enabled) return null
  return new ElasticsearchClient(config)
}
