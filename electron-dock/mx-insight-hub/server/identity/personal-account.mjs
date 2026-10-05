import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'

export const canOpenPersonalAccount = (principal, pool) => Boolean(pool && principal?.kind === 'launcher-user' && principal.memberId)

// Explicit user action, never a side effect of authentication or invitation
// acceptance. No platform administrator role, product grant, Key or credit is issued.
export async function openPersonalAccount(pool, principal) {
  if (!canOpenPersonalAccount(principal, pool)) throw new AppError(403, 'personal_account_unavailable', '请使用 Launcher 个人账号登录后开户。')
  return withPgTransaction(pool, async client => {
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'")
    const member = (await client.query('SELECT status,display_name FROM iam.members WHERE id=$1 FOR UPDATE', [principal.memberId])).rows[0]
    if (member?.status !== 'active') throw new AppError(403, 'member_suspended', '此成员已停用。')
    let tenantId = (await client.query('SELECT tenant_id FROM iam.personal_accounts WHERE member_id=$1', [principal.memberId])).rows[0]?.tenant_id
    if (!tenantId) {
      const old = (await client.query("SELECT DISTINCT detail->>'tenantId' AS tenant_id FROM iam.identity_events WHERE member_id=$1 AND event_type='sso.personal-tenant-created'", [principal.memberId])).rows
      if (old.length > 1) throw new AppError(409, 'personal_account_conflict', '已有多个个人账户记录，请联系管理员核对。')
      tenantId = old[0]?.tenant_id
    }
    if (tenantId) {
      const existing = (await client.query(`SELECT t.status,m.status AS membership_status,m.role FROM tenants t
        LEFT JOIN iam.tenant_memberships m ON m.tenant_id=t.id AND m.member_id=$2 WHERE t.id=$1 FOR UPDATE OF t`, [tenantId, principal.memberId])).rows[0]
      if (existing?.status !== 'active' || existing.membership_status !== 'active' || !['owner','admin','billing'].includes(existing.role)) {
        throw new AppError(403, 'personal_account_restricted', '原个人账户或账务权限已停用，请联系管理员恢复；不会重复开户。')
      }
    } else {
      tenantId = randomUUID()
      await client.query("INSERT INTO tenants(id,name,status) VALUES($1,$2,'active')", [tenantId, `${(member.display_name || '我的账户').slice(0,100)} 的空间`])
      await client.query("INSERT INTO iam.tenant_memberships(id,member_id,tenant_id,role,granted_by) VALUES($1,$2,$3,'owner','self:personal-account')", [randomUUID(), principal.memberId, tenantId])
      await client.query("INSERT INTO iam.identity_events(member_id,event_type,detail) VALUES($1,'account.personal-created',$2)", [principal.memberId, {tenantId}])
    }
    await client.query('INSERT INTO iam.personal_accounts(member_id,tenant_id) VALUES($1,$2) ON CONFLICT(member_id) DO NOTHING', [principal.memberId, tenantId])
    return {tenantId}
  }, {outcomeUnknownCode: 'personal_account_outcome_unknown'})
}
