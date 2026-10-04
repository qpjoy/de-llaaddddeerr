import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'

export const identityLock = (issuer, subject, audience) => `identity:${JSON.stringify([issuer, subject, audience])}`
const hash = value => createHash('sha256').update(value).digest('hex')

export class SsoStore {
  constructor(pool, key) {
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
    await this.pool.query('INSERT INTO iam.browser_sso_records(kind,id,payload,expires_at) VALUES($1,$2,$3,now()+$4*interval \'1 second\')',
      [kind, key, this.seal(kind, key, value), seconds])
    // Bounded opportunistic retention, also works after restart without a scheduler.
    await this.pool.query('DELETE FROM iam.browser_sso_records WHERE (kind,id) IN (SELECT kind,id FROM iam.browser_sso_records WHERE expires_at<=now() LIMIT 100)')
  }
  async get(kind, id, consume = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id ?? '')) return null
    const key = hash(id)
    const { rows } = await this.pool.query(consume
      ? 'DELETE FROM iam.browser_sso_records WHERE kind=$1 AND id=$2 AND expires_at>now() RETURNING payload'
      : 'SELECT payload FROM iam.browser_sso_records WHERE kind=$1 AND id=$2 AND expires_at>now()', [kind, key])
    return rows[0] ? this.open(kind, key, rows[0].payload) : null
  }
  async remove(kind, id) { await this.pool.query('DELETE FROM iam.browser_sso_records WHERE kind=$1 AND id=$2', [kind, hash(id ?? '')]) }
  async update(kind, id, value) {
    const key = hash(id)
    // Do not extend the original login deadline when returning from another origin.
    const result = await this.pool.query('UPDATE iam.browser_sso_records SET payload=$3 WHERE kind=$1 AND id=$2 AND expires_at>now()', [kind, key, this.seal(kind, key, value)])
    return result.rowCount === 1
  }

  // Only called after OIDC plus UserInfo verification. Two identities from the
  // same configured authority are prebound before any just-in-time creation.
  async provision({ issuer, subject, clientId, canonical, personalTenant }) {
    const legacy = [canonical.issuer, canonical.subject, canonical.audience]
    return withPgTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identityLock(...legacy)])
      const select = async tuple => (await client.query(`SELECT b.member_id,m.status FROM iam.external_identity_bindings b
        JOIN iam.members m ON m.id=b.member_id WHERE b.issuer=$1 AND b.subject=$2 AND b.audience=$3`, tuple)).rows[0]
      const original = await select(legacy), sso = await select([issuer, subject, clientId])
      if (sso && (!original || original.member_id !== sso.member_id)) throw new AppError(409, 'sso_identity_conflict', 'SSO 身份与原成员不一致，已停止自动开户。')
      if (original && original.status !== 'active') throw new AppError(403, 'member_suspended', '此 Hub 成员已停用。')
      const memberId = original?.member_id ?? randomUUID()
      const displayName = canonical.principal.displayName || subject
      if (!original) {
        await client.query('INSERT INTO iam.members(id,display_name) VALUES($1,$2)', [memberId, displayName])
        await client.query(`INSERT INTO iam.external_identity_bindings(id,member_id,issuer,subject,audience,auth_provider,last_seen_at)
          VALUES($1,$2,$3,$4,$5,'oidc',now())`, [randomUUID(), memberId, ...legacy])
        if (personalTenant) {
          const tenantId = randomUUID()
          await client.query('INSERT INTO tenants(id,name,status) VALUES($1,$2,\'active\')', [tenantId, `${displayName.slice(0, 100)} 的空间`])
          await client.query(`INSERT INTO iam.tenant_memberships(id,member_id,tenant_id,role,granted_by)
            VALUES($1,$2,$3,'owner','sso:personal-onboarding')`, [randomUUID(), memberId, tenantId])
          // No consumer, API Key, wallet credit or service grant is created here.
          await client.query(`INSERT INTO iam.identity_events(member_id,event_type,detail) VALUES($1,'sso.personal-tenant-created',$2)`, [memberId, { tenantId }])
        }
      }
      if (!sso) {
        await client.query(`INSERT INTO iam.external_identity_bindings(id,member_id,issuer,subject,audience,auth_provider,last_seen_at)
          VALUES($1,$2,$3,$4,$5,'oidc',now())`, [randomUUID(), memberId, issuer, subject, clientId])
        await client.query(`INSERT INTO iam.identity_events(member_id,event_type,issuer,subject,detail)
          VALUES($1,'sso.identity-bound',$2,$3,$4)`, [memberId, issuer, subject, { reused: Boolean(original), audience: clientId }])
      }
      return memberId
    })
  }
}
