import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'
import { requireTenantCapability, requirePlatformAdmin } from './index.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const unavailable = () => new AppError(410, 'invitation_unavailable', '邀请已失效、已被使用或邀请人已失去管理权限，请联系邀请人。')
const safe = row => ({ id:row.id, tenantId:row.tenant_id, tenantName:row.tenant_name, role:row.role, label:row.label,
  allowRegistration:row.allow_registration, expiresAt:row.expires_at, createdAt:row.created_at, acceptedAt:row.accepted_at,
  status:row.revoked_at ? 'revoked' : row.accepted_at ? 'accepted' : new Date(row.expires_at) <= new Date() ? 'expired' : 'pending' })

export class TenantInvitations {
  constructor({ pool, sessions, origin, adminToken }) {
    Object.assign(this, { pool, sessions, origin })
    this.adminKey = adminToken ? `token:${hash(adminToken)}` : null
  }
  creatorKey(principal) {
    if (principal.kind === 'admin-token' && this.adminKey) return this.adminKey
    if (principal.memberId && uuid(principal.memberId)) return `member:${principal.memberId}`
    throw new AppError(403, 'invitation_creator_invalid', '请使用有效的管理员身份创建邀请。')
  }
  async audit(client, type, row, memberId = null) {
    await client.query('INSERT INTO iam.identity_events(member_id,event_type,detail) VALUES($1,$2,$3)',
      [memberId,`invitation.${type}`,{ invitationId:row.id,tenantId:row.tenant_id,role:row.role,creatorId:row.creator_id }])
  }
  async active(client, row) {
    if (!row || row.revoked_at || row.accepted_at || new Date(row.expires_at) <= new Date()) throw unavailable()
    const tenant = (await client.query('SELECT name,status FROM tenants WHERE id=$1 FOR SHARE', [row.tenant_id])).rows[0]
    if (tenant?.status !== 'active') throw unavailable()
    if (row.creator_key.startsWith('token:')) {
      if (row.creator_key !== this.adminKey) throw unavailable()
    } else {
      const member = (await client.query("SELECT id FROM iam.members WHERE id=$1 AND status='active' FOR SHARE",[row.creator_id])).rows[0]
      const admin = (await client.query('SELECT member_id FROM iam.platform_admins WHERE member_id=$1 FOR SHARE',[row.creator_id])).rows[0]
      const owner = (await client.query("SELECT id FROM iam.tenant_memberships WHERE member_id=$1 AND tenant_id=$2 AND status='active' AND role='owner' FOR SHARE",[row.creator_id,row.tenant_id])).rows[0]
      if (!member || (!admin && !owner)) throw unavailable()
    }
    return { ...row, tenant_name:tenant.name }
  }
  async list(principal, tenantId) {
    if (!uuid(tenantId)) throw new AppError(400,'invalid_tenant','请选择租户。')
    requireTenantCapability(principal,tenantId,'membership.write')
    return (await this.pool.query(`SELECT i.*,t.name tenant_name FROM iam.tenant_invitations i JOIN tenants t ON t.id=i.tenant_id
      WHERE i.tenant_id=$1 ORDER BY i.created_at DESC LIMIT 100`,[tenantId])).rows.map(safe)
  }
  async create(principal, input) {
    const label = typeof input.label === 'string' ? input.label.trim() : ''
    const tenantName = typeof input.tenantName === 'string' ? input.tenantName.trim() : ''
    const tenantId = input.tenantId || null, days = input.days, role = input.role
    if (!uuid(input.requestId) || !label || label.length>80 || !['owner','admin','analyst','viewer','billing'].includes(role)
      || !Number.isInteger(days) || days<1 || days>30 || typeof input.allowRegistration !== 'boolean'
      || (tenantId ? !uuid(tenantId) || Boolean(tenantName) : !tenantName || tenantName.length>120))
      throw new AppError(400,'invalid_invitation','请填写邀请备注、租户、角色和 1–30 天有效期。')
    if (tenantId) requireTenantCapability(principal,tenantId,'membership.write')
    else requirePlatformAdmin(principal)
    const creatorKey=this.creatorKey(principal), requestHash=hash(JSON.stringify({label,tenantName,tenantId,days,role,allowRegistration:input.allowRegistration}))
    return withPgTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tenant-invitation:${creatorKey}:${input.requestId}`])
      const previous=(await client.query('SELECT i.*,t.name tenant_name FROM iam.tenant_invitations i JOIN tenants t ON t.id=i.tenant_id WHERE creator_key=$1 AND request_id=$2',[creatorKey,input.requestId])).rows[0]
      let row=previous
      if (row && row.request_hash!==requestHash) throw new AppError(409,'invitation_request_changed','本次邀请内容已变化，请重新发起。')
      if (!row) {
        const target=tenantId || randomUUID()
        if (!tenantId) await client.query("INSERT INTO tenants(id,name,status) VALUES($1,$2,'active')",[target,tenantName])
        const id=randomUUID(), token=randomBytes(32).toString('base64url')
        row=(await client.query(`INSERT INTO iam.tenant_invitations(id,tenant_id,role,label,token_hash,token_sealed,creator_id,creator_key,request_id,request_hash,allow_registration,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+$12*interval '1 day') RETURNING *`,
          [id,target,role,label,hash(token),this.sessions.seal('tenant-invitation',id,{token}),principal.memberId || null,creatorKey,input.requestId,requestHash,input.allowRegistration,days])).rows[0]
        row=await this.active(client,row)
        await this.audit(client,'created',row,principal.memberId)
      } else row=await this.active(client,row)
      const {token}=this.sessions.open('tenant-invitation',row.id,row.token_sealed)
      return { ...safe(row), url:`${this.origin}/#/join?invitation=${token}` }
    })
  }
  async revoke(principal,id) {
    if (!uuid(id)) throw new AppError(400,'invalid_invitation','邀请编号无效。')
    return withPgTransaction(this.pool, async client => {
      const row=(await client.query('SELECT * FROM iam.tenant_invitations WHERE id=$1 FOR UPDATE',[id])).rows[0]
      if (!row) throw unavailable()
      requireTenantCapability(principal,row.tenant_id,'membership.write')
      if (row.accepted_at) throw new AppError(409,'invitation_accepted','邀请已经接受；如需撤权，请单独解除成员绑定。')
      if (!row.revoked_at) {
        await client.query('UPDATE iam.tenant_invitations SET revoked_at=now() WHERE id=$1',[id])
        await this.audit(client,'revoked',row,principal.memberId)
      }
      return {id,status:'revoked'}
    })
  }
  async inspect(token, memberId = null) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw unavailable()
    return withPgTransaction(this.pool,async client => {
      const row=(await client.query('SELECT * FROM iam.tenant_invitations WHERE token_hash=$1',[hash(token)])).rows[0]
      if (row?.accepted_at && row.accepted_by===memberId) {
        const member=(await client.query(`SELECT m.role,t.name FROM iam.tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
          WHERE m.member_id=$1 AND m.tenant_id=$2 AND m.status='active' AND t.status='active'`,[memberId,row.tenant_id])).rows[0]
        if (!member) throw unavailable()
        return safe({...row,tenant_name:member.name,role:member.role})
      }
      return safe(await this.active(client,row))
    })
  }
  async registrationProof(id) {
    if (!uuid(id)) throw unavailable()
    return withPgTransaction(this.pool,async client => {
      const row=(await client.query('SELECT * FROM iam.tenant_invitations WHERE id=$1',[id])).rows[0]
      const active=await this.active(client,row)
      if (!active.allow_registration) throw new AppError(403,'invitation_registration_disabled','此邀请仅供已有 MX 账号使用。')
      return {invitationId:active.id,issuer:this.origin,expiresAt:new Date(active.expires_at).toISOString()}
    })
  }
  async accept(principal,token) {
    if (!uuid(principal.memberId) || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw new AppError(401,'member_required','请先使用自己的 MX 账号登录。')
    return withPgTransaction(this.pool,async client => {
      const row=(await client.query('SELECT * FROM iam.tenant_invitations WHERE token_hash=$1 FOR UPDATE',[hash(token)])).rows[0]
      if (!row) throw unavailable()
      const member=(await client.query("SELECT id FROM iam.members WHERE id=$1 AND status='active' FOR SHARE",[principal.memberId])).rows[0]
      if (!member) throw new AppError(403,'member_suspended','此成员已停用。')
      // Serialize acceptance with another invitation for this same member/tenant.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`invitation-membership:${principal.memberId}:${row.tenant_id}`])
      const existing=(await client.query('SELECT * FROM iam.tenant_memberships WHERE member_id=$1 AND tenant_id=$2 FOR UPDATE',[principal.memberId,row.tenant_id])).rows[0]
      if (row.accepted_at) {
        if (row.accepted_by!==principal.memberId) throw unavailable()
        if (!existing || existing.status!=='active') throw new AppError(403,'membership_suspended','成员权限已撤销，请联系租户负责人。')
        const tenant=(await client.query('SELECT status FROM tenants WHERE id=$1 FOR SHARE',[row.tenant_id])).rows[0]
        if (tenant?.status!=='active') throw unavailable()
        return {tenantId:row.tenant_id,role:existing.role,alreadyMember:true}
      }
      await this.active(client,row)
      if (existing && existing.status!=='active') throw new AppError(403,'membership_suspended','你在此租户的权限已被停用，请联系负责人恢复。')
      // Existing membership and role always win; invitations cannot undo revocation or silently change a role.
      if (!existing) await client.query(`INSERT INTO iam.tenant_memberships(id,member_id,tenant_id,role,granted_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(member_id,tenant_id) DO NOTHING`,[randomUUID(),principal.memberId,row.tenant_id,row.role,`invitation:${row.id}`])
      const effective=(await client.query('SELECT * FROM iam.tenant_memberships WHERE member_id=$1 AND tenant_id=$2 FOR UPDATE',[principal.memberId,row.tenant_id])).rows[0]
      if (effective.status!=='active') throw new AppError(403,'membership_suspended','成员权限已被停用。')
      await client.query('UPDATE iam.tenant_invitations SET accepted_by=$2,accepted_at=now() WHERE id=$1',[row.id,principal.memberId])
      await this.audit(client,'accepted',row,principal.memberId)
      return {tenantId:row.tenant_id,role:effective.role,alreadyMember:Boolean(existing)}
    })
  }
}
