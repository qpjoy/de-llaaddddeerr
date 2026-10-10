import { randomUUID } from 'node:crypto'
import { PostgresSsoStore } from '@qpjoy/mx-common/identity/postgres'
import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'

export const identityLock = (issuer, subject, audience) => `identity:${JSON.stringify([issuer, subject, audience])}`

export class SsoStore extends PostgresSsoStore {
  constructor(pool, key) { super(pool, key, { table: 'iam.browser_sso_records' }) }

  // Only called after OIDC plus UserInfo verification. Two identities from the
  // same configured authority are prebound before any just-in-time creation.
  async provision({ issuer, subject, clientId, canonical, personalTenant, sharedAudience }) {
    const legacy = [canonical.issuer, canonical.subject, sharedAudience ?? canonical.audience]
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
