import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

const FIELDS = ['maxConcurrency', 'maxConsumerConcurrency', 'maxRequestsPerMinute', 'maxWaitMs', 'maxPending']
const BOUNDS = { maxConcurrency: 256, maxConsumerConcurrency: 256, maxRequestsPerMinute: 60000, maxWaitMs: 60000, maxPending: 256 }
const SCOPE = Object.freeze({ rate: 'provider_shared', concurrency: 'gateway_instance' })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unavailable = () => new AppError(503, 'external_admission_policy_unavailable', 'Provider admission policy is unavailable')
const invalid = message => { throw new AppError(400, 'invalid_external_admission_policy', message) }

function normalizeLimits(input) {
  if (!object(input) || Object.keys(input).some(key => !FIELDS.includes(key))) invalid('limits must contain only supported admission fields')
  const limits = {}
  for (const field of FIELDS) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 1 || input[field] > BOUNDS[field]) {
      invalid(`${field} must be an integer between 1 and ${BOUNDS[field]}`)
    }
    limits[field] = input[field]
  }
  if (limits.maxConsumerConcurrency > limits.maxConcurrency) invalid('maxConsumerConcurrency cannot exceed maxConcurrency')
  return limits
}

function deploymentLimits(input) {
  // Existing environment configurations predate the editor's narrower bounds.
  // Preserve their effective positive values until an explicit operator save;
  // in particular, a higher consumer ceiling simply remains bound by global
  // concurrency. Do not turn a new editor constraint into a startup failure.
  if (!object(input)) invalid('Provider deployment limits must be an object')
  return Object.fromEntries(FIELDS.map(field => {
    if (!Number.isSafeInteger(input[field]) || input[field] < 1) invalid(`${field} must be a positive safe integer`)
    return [field, input[field]]
  }))
}

function normalizeInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['expectedRevision', 'reason', 'limits'].includes(key))) {
    invalid('Only expectedRevision, reason and limits may be changed')
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= 2147483647) {
    invalid('expectedRevision must be the current non-negative revision')
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1000) {
    invalid('A reason of 1–1000 characters is required')
  }
  return { expectedRevision: input.expectedRevision, reason: input.reason.trim(), limits: normalizeLimits(input.limits) }
}

function fromRow(row) {
  if (!row) return null
  const revision = Number(row.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) throw unavailable()
  try {
    return { revision, limits: normalizeLimits({ maxConcurrency: row.max_concurrency,
      maxConsumerConcurrency: row.max_consumer_concurrency, maxRequestsPerMinute: row.max_requests_per_minute,
      maxWaitMs: row.max_wait_ms, maxPending: row.max_pending }), updatedAt: new Date(row.updated_at).toISOString() }
  } catch { throw unavailable() }
}

/** Admission settings never edit operation releases, prices, credentials or live counters. */
export class ExternalAdmissionPolicyStore {
  constructor({ pool = null, defaultsByProvider = {} } = {}) {
    this.pool = pool
    this.defaultsByProvider = Object.fromEntries(Object.entries(defaultsByProvider).map(([provider, limits]) => {
      if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(provider)) invalid('Invalid provider configuration')
      return [provider, Object.freeze(deploymentLimits(limits))]
    }))
    this.rows = new Map()
    this.events = []
  }

  #defaults(providerKey) {
    if (!Object.hasOwn(this.defaultsByProvider, providerKey)) {
      throw new AppError(404, 'external_admission_provider_not_found', 'Provider admission settings are not supported')
    }
    return this.defaultsByProvider[providerKey]
  }

  #view(providerKey, row) {
    const defaults = this.#defaults(providerKey)
    return { providerKey, source: row ? 'database' : 'deployment', revision: row?.revision ?? 0,
      limits: { ...(row?.limits ?? defaults) }, defaults: { ...defaults }, updatedAt: row?.updatedAt ?? null, scope: { ...SCOPE } }
  }

  async read(providerKey) {
    this.#defaults(providerKey)
    if (!this.pool) return this.#view(providerKey, this.rows.get(providerKey))
    try {
      const { rows } = await this.pool.query('SELECT * FROM control.external_platform_admission_policies WHERE provider_key=$1', [providerKey])
      return this.#view(providerKey, fromRow(rows[0]))
    } catch { throw unavailable() }
  }

  async resolve(providerKey) {
    // Read at each admission, including after a queue wait; a failed read must
    // not silently restore deployment limits or keep an obsolete exemption.
    const view = await this.read(providerKey)
    return { ...view.limits, revision: view.revision }
  }

  async save(providerKey, input, { actor, requestId } = {}) {
    if (actor !== 'admin-token') throw new AppError(403, 'admin_token_required', 'Only the Hub admin token may change admission settings')
    this.#defaults(providerKey)
    const normalized = normalizeInput(input)
    if (!UUID.test(requestId || '')) invalid('A request ID is required for the admission audit')
    const prepare = row => {
      const previous = this.#view(providerKey, row)
      if (previous.revision !== normalized.expectedRevision) {
        throw new AppError(409, 'external_admission_policy_changed', 'Admission settings changed; reload before saving', { currentRevision: previous.revision })
      }
      return { previous, next: { limits: normalized.limits, revision: previous.revision + 1, updatedAt: new Date().toISOString() } }
    }
    if (!this.pool) {
      const { previous, next } = prepare(this.rows.get(providerKey))
      this.rows.set(providerKey, next)
      this.events.push({ providerKey, previousRevision: previous.revision, revision: next.revision,
        previousSource: previous.source, previousLimits: previous.limits, limits: { ...next.limits }, actor,
        reason: normalized.reason, requestId, createdAt: next.updatedAt })
      return this.#view(providerKey, next)
    }
    let client
    let releaseError = null
    let commitStarted = false
    try {
      client = await this.pool.connect()
      await client.query('BEGIN')
      // Serializes the initial revision-0 insert as well as subsequent saves.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`external-admission:${providerKey}`])
      const { rows } = await client.query('SELECT * FROM control.external_platform_admission_policies WHERE provider_key=$1 FOR UPDATE', [providerKey])
      const { previous, next } = prepare(fromRow(rows[0]))
      const saved = await client.query(`INSERT INTO control.external_platform_admission_policies
        (provider_key,revision,max_concurrency,max_consumer_concurrency,max_requests_per_minute,max_wait_ms,max_pending,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
        ON CONFLICT (provider_key) DO UPDATE SET revision=EXCLUDED.revision,max_concurrency=EXCLUDED.max_concurrency,
        max_consumer_concurrency=EXCLUDED.max_consumer_concurrency,max_requests_per_minute=EXCLUDED.max_requests_per_minute,
        max_wait_ms=EXCLUDED.max_wait_ms,max_pending=EXCLUDED.max_pending,updated_at=EXCLUDED.updated_at RETURNING *`,
      [providerKey, next.revision, next.limits.maxConcurrency, next.limits.maxConsumerConcurrency,
        next.limits.maxRequestsPerMinute, next.limits.maxWaitMs, next.limits.maxPending])
      await client.query(`INSERT INTO control.external_platform_admission_policy_events
        (event_id,provider_key,previous_revision,revision,previous_source,previous_limits,limits,actor,reason,request_id)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [randomUUID(), providerKey, previous.revision, next.revision, previous.source,
        JSON.stringify(previous.limits), JSON.stringify(next.limits), actor, normalized.reason, requestId])
      const result = this.#view(providerKey, fromRow(saved.rows[0]))
      commitStarted = true
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (client) {
        if (commitStarted) releaseError = error
        else releaseError = await client.query('ROLLBACK').then(() => null, rollbackError => rollbackError)
      }
      if (error instanceof AppError) throw error
      throw unavailable()
    } finally { client?.release(releaseError) }
  }
}

export const createExternalAdmissionPolicyStore = options => new ExternalAdmissionPolicyStore(options)
export { ExternalAdmissionPolicyStore as AdmissionPolicyStore }
