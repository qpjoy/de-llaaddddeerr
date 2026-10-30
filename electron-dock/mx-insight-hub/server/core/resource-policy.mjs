import { randomUUID } from 'node:crypto'
import { AppError } from './errors.mjs'
import { RESOURCE_DEFAULTS, RESOURCE_BOUNDS } from './resource-admission.mjs'
const invalid = message => { throw new AppError(400, 'invalid_resource_policy', message) }
const unavailable = () => new AppError(503, 'resource_policy_unavailable', '资源限速配置暂不可用', { layer: 'hub', stage: 'resource_admission', currentAttemptStarted: false, retryAfterMs: 1000 })
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function normalizeResourceLimits(value) {
  if (!object(value) || Object.keys(value).length !== 4) invalid('Provide all four resource limits')
  for (const [name, maximum] of Object.entries(RESOURCE_BOUNDS)) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 1 || value[name] > maximum) invalid(`Invalid ${name}`)
  }
  if (value.maxKeyConcurrency > value.maxConcurrency || value.keyRequestsPerSecond > value.requestsPerSecond) invalid('Key limits cannot exceed shared limits')
  return { ...value }
}
export class ResourcePolicy {
  constructor({ pool = null, catalog = { products: [], apis: [] }, clock = Date.now } = {}) {
    this.pool = pool; this.catalog = catalog; this.clock = clock
    this.value = { revision: 0, defaults: { ...RESOURCE_DEFAULTS }, rules: [] }
    this.loadedAt = pool ? 0 : clock(); this.ready = !pool; this.pending = null; this.events = []
    if (pool) {
      this.refresh().catch(() => {})
      this.timer = setInterval(() => this.refresh().catch(() => {}), 5000)
      this.timer.unref()
    }
  }
  close() { clearInterval(this.timer) }
  status() { return { revision: this.value.revision, loadedAt: this.loadedAt || null, stale: !this.ready || this.clock() - this.loadedAt > 30000, refreshMs: 5000 } }
  current() {
    if (this.pool && this.status().stale) throw unavailable()
    return this.value
  }
  async refresh() {
    if (!this.pool) return this.value
    if (this.pending) return this.pending
    this.pending = (async () => {
      const { rows } = await this.pool.query('SELECT revision, configuration FROM control.resource_admission_policy WHERE singleton=true')
      const row = rows[0]
      if (!row) throw unavailable()
      const config = this.validateConfiguration(row.configuration)
      if (Number(row.revision) >= this.value.revision) this.value = { revision: Number(row.revision), ...config }
      this.loadedAt = this.clock(); this.ready = true
      return this.value
    })().finally(() => { this.pending = null })
    return this.pending
  }
  validateConfiguration(input) {
    if (!object(input) || !Array.isArray(input.rules) || input.rules.length > 256) invalid('Invalid resource configuration')
    const ids = new Set()
    const rules = input.rules.map(rule => {
      if (!object(rule) || Object.keys(rule).some(key => !['id', 'kind', 'target', 'keyId', 'limits'].includes(key))) invalid('Invalid resource rule')
      if (!uuid(rule.id) || ids.has(rule.id)) invalid('Rule IDs must be unique UUIDs')
      ids.add(rule.id)
      if (!['product', 'api'].includes(rule.kind) || !(rule.keyId === '*' || uuid(rule.keyId))) invalid('Invalid rule scope')
      const known = rule.kind === 'product' ? this.catalog.products.some(row => row.id === rule.target) : this.catalog.apis.some(row => row.id === rule.target)
      if (!known) invalid('Choose a registered product or API')
      return { ...rule, limits: normalizeResourceLimits(rule.limits) }
    })
    if (new Set(rules.map(row => `${row.kind}:${row.target}:${row.keyId}`)).size !== rules.length) invalid('Duplicate resource scope')
    return { defaults: normalizeResourceLimits(input.defaults), rules }
  }
  async read() { await this.refresh(); return { ...structuredClone(this.value), scope: 'api_process', catalog: this.catalog, bounds: RESOURCE_BOUNDS, status: this.status() } }
  async save(input, { actor, requestId } = {}) {
    if (actor !== 'admin-token') throw new AppError(403, 'admin_token_required', 'Admin token required')
    if (!object(input) || Object.keys(input).some(key => !['expectedRevision', 'defaults', 'rules', 'reason'].includes(key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= 2147483647 || !uuid(requestId) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) invalid('Current revision and reason required')
    const config = this.validateConfiguration(input)
    const check = revision => { if (revision !== input.expectedRevision) throw new AppError(409, 'resource_policy_changed', '限速已变化，请重新读取后保存') }
    let revision
    if (!this.pool) {
      check(this.value.revision); revision = this.value.revision + 1
      this.events.push({ previous: structuredClone(this.value), configuration: structuredClone(config), reason: input.reason.trim(), actor, requestId })
    } else {
      const client = await this.pool.connect()
      let releaseError = null, committing = false
      try {
        await client.query('BEGIN')
        const { rows } = await client.query('SELECT revision, configuration FROM control.resource_admission_policy WHERE singleton=true FOR UPDATE')
        if (!rows[0]) throw unavailable()
        check(Number(rows[0].revision)); revision = Number(rows[0].revision) + 1
        await client.query('UPDATE control.resource_admission_policy SET revision=$1, configuration=$2::jsonb, updated_at=clock_timestamp() WHERE singleton=true', [revision, JSON.stringify(config)])
        await client.query('INSERT INTO control.resource_admission_events (id, revision, previous_configuration, configuration, actor, reason, request_id) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)', [randomUUID(), revision, JSON.stringify(rows[0].configuration), JSON.stringify(config), actor, input.reason.trim(), requestId])
        committing = true; await client.query('COMMIT')
      } catch (error) {
        if (committing) releaseError = error
        else releaseError = await client.query('ROLLBACK').then(() => null, cause => cause)
        throw error
      } finally { client.release(releaseError) }
    }
    this.value = { revision, ...config }; this.loadedAt = this.clock(); this.ready = true
    return this.read()
  }
}
