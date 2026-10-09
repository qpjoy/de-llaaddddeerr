import { AppError } from '../core/errors.mjs'

const missing = () => new AppError(404, 'peripheral_not_found', '外设不存在')
const clone = value => structuredClone(value)

// All device/job/session writes take the same device row lock. No HTTP inside a transaction.
export class PeripheralStore {
  constructor(pool) { this.pool = pool }
  async list() {
    return (await this.pool.query('SELECT document FROM peripherals.devices ORDER BY id')).rows.map(row => row.document)
  }
  async get(id) {
    return (await this.pool.query('SELECT document FROM peripherals.devices WHERE id=$1', [id])).rows[0]?.document
  }
  async candidates() {
    return (await this.pool.query("SELECT document - 'probe' AS document FROM peripherals.devices WHERE document->>'enabled'='true' OR document->>'state'='running' ORDER BY id")).rows.map(row => row.document)
  }
  async create(device) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Only registration serializes globally, never execution on different devices.
      await client.query('SELECT pg_advisory_xact_lock(1297633879)')
      const count = await client.query('SELECT count(*)::int AS n FROM peripherals.devices')
      if (count.rows[0].n >= 200) throw new AppError(409, 'peripheral_capacity', '当前版本最多管理 200 台外设')
      await client.query('INSERT INTO peripherals.devices VALUES ($1,$2,$3,$4,$5)',
        [device.id, device.serial, device.accountKey, device.origin, device])
      await client.query('INSERT INTO peripherals.events(device_id,document) VALUES ($1,$2)',
        [device.id, { action: 'register', actor: 'admin-token', revision: device.revision }])
      await client.query('COMMIT')
      return device
    } catch (error) {
      await client.query('ROLLBACK')
      if (error.code === '23505') throw new AppError(409, 'peripheral_duplicate', '手机序列号、账号资源或连接地址已被注册')
      throw error
    } finally { client.release() }
  }
  async transaction(id, fn) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '2s'")
      await client.query("SET LOCAL statement_timeout = '5s'")
      const row = (await client.query('SELECT document FROM peripherals.devices WHERE id=$1 FOR UPDATE', [id])).rows[0]
      if (!row) throw missing()
      const now = Number((await client.query('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now')).rows[0].now)
      const tx = {
        device: row.document, now,
        job: async key => (await client.query('SELECT document FROM peripherals.jobs WHERE device_id=$1 AND idempotency_key=$2', [id, key])).rows[0]?.document,
        active: async () => (await client.query("SELECT document FROM peripherals.jobs WHERE device_id=$1 AND status IN ('queued','running') ORDER BY created_at,id", [id])).rows.map(row => row.document),
        save: async job => { await client.query(`INSERT INTO peripherals.jobs(id,device_id,idempotency_key,status,document) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status,document=excluded.document`, [job.id, id, job.idempotencyKey, job.status, job]) },
        event: async event => { await client.query('INSERT INTO peripherals.events(device_id,document) VALUES($1,$2)', [id, { ...event, at: now }]) },
      }
      const result = await fn(tx)
      await client.query('UPDATE peripherals.devices SET document=$2,serial=$3,account_key=$4,origin=$5 WHERE id=$1',
        [id, tx.device, tx.device.serial, tx.device.accountKey, tx.device.origin])
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      if (error.code === '23505') throw new AppError(409, 'peripheral_duplicate', '手机序列号、账号资源或连接地址已被注册')
      throw error
    } finally { client.release() }
  }
  async history(id, before = null) {
    return (await this.pool.query(`SELECT document - 'responseText' - 'result' - 'lateEvidence' AS document FROM peripherals.jobs WHERE device_id=$1
      AND ($2::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM peripherals.jobs WHERE id=$2 AND device_id=$1))
      ORDER BY created_at DESC,id DESC LIMIT 51`, [id, before])).rows.map(row => row.document)
  }
  async getJob(id, jobId) {
    return (await this.pool.query('SELECT document FROM peripherals.jobs WHERE device_id=$1 AND id=$2', [id, jobId])).rows[0]?.document
  }
  async events(id) {
    return (await this.pool.query('SELECT document FROM peripherals.events WHERE device_id=$1 ORDER BY id DESC LIMIT 50', [id])).rows.map(row => row.document)
  }
}

// For isolated mock tests only; production execution requires PostgreSQL.
export class MemoryPeripheralStore {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.devices = new Map(); this.jobs = new Map(); this.audit = []; this.tail = Promise.resolve() }
  async list() { return clone([...this.devices.values()]) }
  async get(id) { return clone(this.devices.get(id)) }
  async candidates() { return (await this.list()).filter(d => d.enabled || d.state === 'running') }
  async create(device) {
    if ([...this.devices.values()].some(d => d.serial === device.serial || d.accountKey === device.accountKey || d.origin === device.origin)) {
      throw new AppError(409, 'peripheral_duplicate', '手机序列号、账号资源或连接地址已被注册')
    }
    this.devices.set(device.id, clone(device)); return clone(device)
  }
  async transaction(id, fn) {
    const previous = this.tail
    let release
    this.tail = new Promise(resolve => { release = resolve })
    await previous
    try {
      if (!this.devices.has(id)) throw missing()
      const jobs = clone(this.jobs), events = [], device = clone(this.devices.get(id))
      const tx = { device, now: this.clock(),
        job: async key => [...jobs.values()].find(j => j.deviceId === id && j.idempotencyKey === key),
        active: async () => [...jobs.values()].filter(j => j.deviceId === id && ['queued','running'].includes(j.status)),
        save: async job => { jobs.set(job.id, clone(job)) }, event: async event => { events.push({ ...event, deviceId: id, at: this.clock() }) },
      }
      const result = await fn(tx)
      if ([...this.devices.values()].some(d => d.id !== id && (d.serial === device.serial || d.accountKey === device.accountKey || d.origin === device.origin))) {
        throw new AppError(409, 'peripheral_duplicate', '手机序列号、账号资源或连接地址已被注册')
      }
      this.devices.set(id, clone(device)); this.jobs = jobs; this.audit.push(...events)
      return clone(result)
    } finally { release() }
  }
  async history(id, before) {
    const jobs = [...this.jobs.values()].filter(j => j.deviceId === id).reverse()
    return clone(jobs.slice(before ? jobs.findIndex(j => j.id === before) + 1 : 0).slice(0, 51))
  }
  async getJob(id, jobId) { const job = this.jobs.get(jobId); return job?.deviceId === id ? clone(job) : null }
  async events(id) { return clone(this.audit.filter(e => e.deviceId === id).slice(-50).reverse()) }
}
