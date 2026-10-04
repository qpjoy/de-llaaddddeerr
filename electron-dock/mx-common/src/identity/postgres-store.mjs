import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')

export class PostgresSsoStore {
  constructor(pool, key, { table = 'app_auth.browser_sso_records' } = {}) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) throw new Error('Invalid SSO table')
    this.table = table
    this.pool = pool
    this.key = Buffer.from(key, 'base64url')
    if (this.key.length !== 32) throw new Error('SSO session key must be 32 bytes')
  }
  seal(kind, id, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(`${kind}:${id}`))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
  }
  open(kind, id, value) {
    const bytes = Buffer.from(value, 'base64url'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
    cipher.setAAD(Buffer.from(`${kind}:${id}`)); cipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString())
  }
  async put(kind, id, value, seconds) {
    const key = hash(id)
    await this.pool.query(`INSERT INTO ${this.table}(kind,id,payload,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 second')`,
      [kind, key, this.seal(kind, key, value), seconds])
    // Bounded opportunistic retention, also works after restart without a scheduler.
    await this.pool.query(`DELETE FROM ${this.table} WHERE (kind,id) IN (SELECT kind,id FROM ${this.table} WHERE expires_at<=now() LIMIT 100)`)
  }
  async get(kind, id, consume = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id ?? '')) return null
    const key = hash(id)
    const { rows } = await this.pool.query(consume
      ? `DELETE FROM ${this.table} WHERE kind=$1 AND id=$2 AND expires_at>now() RETURNING payload`
      : `SELECT payload FROM ${this.table} WHERE kind=$1 AND id=$2 AND expires_at>now()`, [kind, key])
    return rows[0] ? this.open(kind, key, rows[0].payload) : null
  }
  async remove(kind, id) { await this.pool.query(`DELETE FROM ${this.table} WHERE kind=$1 AND id=$2`, [kind, hash(id ?? '')]) }
  async update(kind, id, value) {
    const key = hash(id)
    // Do not extend the original login deadline when returning from another origin.
    const result = await this.pool.query(`UPDATE ${this.table} SET payload=$3 WHERE kind=$1 AND id=$2 AND expires_at>now()`, [kind, key, this.seal(kind, key, value)])
    return result.rowCount === 1
  }

}
