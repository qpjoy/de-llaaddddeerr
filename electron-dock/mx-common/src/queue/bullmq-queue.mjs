// BullMQ driver, exposing the same surface as PostgresQueue.
//
// Use it when a product genuinely needs broker features PostgreSQL does not
// give cheaply: very high job rates, rate-limited groups, repeatable schedules,
// or fan-out across many services. It cannot enlist in a PostgreSQL
// transaction, so a product that relies on transactional enqueue must stay on
// the `postgres` driver — `enqueue` rejects a `client` argument rather than
// silently dropping the transactional guarantee.
//
// Cursors stay in PostgreSQL regardless of driver: they are durable state, and
// Redis is configured for eviction in most deployments.

const OUTSTANDING_JOB_STATES = ['waiting', 'active', 'delayed', 'prioritized']

function assertPayloadMatch(payloadMatch) {
  if (payloadMatch === null || typeof payloadMatch !== 'object' || Array.isArray(payloadMatch)) {
    throw new TypeError('payloadMatch must be a plain object')
  }
}

// Mirror PostgreSQL JSONB containment for the JSON payload shapes used by jobs.
function jsonContains(value, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(value) &&
      expected.every((expectedItem) => value.some((item) => jsonContains(item, expectedItem)))
    )
  }
  if (expected !== null && typeof expected === 'object') {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(expected).every(
        ([key, expectedValue]) =>
          Object.prototype.hasOwnProperty.call(value, key) && jsonContains(value[key], expectedValue),
      )
    )
  }
  return value === expected
}

export class BullmqQueue {
  #queues = new Map()

  constructor({ pool, namespace, redisUrl, maxAttempts = 5, logger = console }) {
    this.pool = pool
    this.namespace = namespace
    this.redisUrl = redisUrl
    this.maxAttempts = maxAttempts
    this.logger = logger
    this.bullmq = null
  }

  async #load() {
    if (!this.bullmq) {
      try {
        this.bullmq = await import('bullmq')
      } catch (error) {
        throw new Error(
          'MX_COMMON_QUEUE_DRIVER=bullmq requires the optional `bullmq` dependency to be installed',
          { cause: error },
        )
      }
    }
    return this.bullmq
  }

  async #queue(name) {
    const key = `${this.namespace}:${name}`
    if (!this.#queues.has(key)) {
      const { Queue } = await this.#load()
      this.#queues.set(
        key,
        new Queue(key, {
          connection: { url: this.redisUrl },
          defaultJobOptions: {
            attempts: this.maxAttempts,
            backoff: { type: 'exponential', delay: 5_000 },
            // Keep terminal jobs around: `removeOnFail: false` is what makes the
            // failed set usable as a dead-letter queue.
            removeOnComplete: { age: 86_400, count: 1_000 },
            removeOnFail: false,
          },
        }),
      )
    }
    return this.#queues.get(key)
  }

  async enqueue(name, payload, { client = null, dedupeKey = null, runAt = null, priority = 100 } = {}) {
    if (client) {
      throw new Error(
        'Transactional enqueue is not available on the bullmq driver; use MX_COMMON_QUEUE_DRIVER=postgres',
      )
    }
    const queue = await this.#queue(name)
    const job = await queue.add(name, payload, {
      // BullMQ deduplicates by jobId, and refuses to re-add an id that is still
      // present — the same semantics as the partial unique index in the PG driver.
      ...(dedupeKey ? { jobId: dedupeKey } : {}),
      ...(runAt ? { delay: Math.max(0, new Date(runAt).getTime() - Date.now()) } : {}),
      priority,
    })
    return job.id
  }

  async stats(name = null) {
    if (!name) return []
    const queue = await this.#queue(name)
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
    return Object.entries(counts).map(([status, count]) => ({
      queue: `${this.namespace}:${name}`,
      status,
      count,
    }))
  }

  /** Return whether this namespaced queue has a non-terminal matching job. */
  async hasOutstandingJob(name, payloadMatch) {
    assertPayloadMatch(payloadMatch)
    const queue = await this.#queue(name)
    const jobs = await queue.getJobs(OUTSTANDING_JOB_STATES, 0, -1, true)
    return jobs.some((job) => jsonContains(job?.data, payloadMatch))
  }

  // BullMQ reclaims stalled jobs itself through its stalled-check interval, so
  // there is nothing for the caller to sweep.
  async reclaimExpired() {
    return 0
  }

  async close() {
    await Promise.all([...this.#queues.values()].map((queue) => queue.close()))
    this.#queues.clear()
  }

  async runWorker({ name, handler, concurrency = 4 }) {
    const { Worker } = await this.#load()
    const worker = new Worker(`${this.namespace}:${name}`, async (job) => handler(job.data, job), {
      connection: { url: this.redisUrl },
      concurrency,
    })
    worker.on('failed', (job, error) => {
      this.logger?.error?.(`[mx-common] job ${job?.id} failed: ${error.message}`)
    })
    return { stop: () => worker.close(), done: Promise.resolve() }
  }
}
