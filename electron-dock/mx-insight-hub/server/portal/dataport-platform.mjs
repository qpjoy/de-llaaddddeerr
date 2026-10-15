import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.mjs';
import { withPgTransaction } from '../stores/postgres-store.mjs';
import { uuid, paging, digest } from './dataport-store.mjs';
export function requireDataportPlatformAdmin(principal) {
    if (principal?.kind !== 'launcher-user' || principal.dataportPlatformAdmin !== true)
        throw new AppError(403, 'dataport_platform_admin_required', '仅数港平台管理员可以执行此操作。');
}
const invalid = message => { throw new AppError(400, 'invalid_platform_command', message); };
export function platformRouteAllowed(method, path) {
    if (path === '/platform/enterprises')
        return ['GET', 'POST'].includes(method);
    return method === 'POST' && /^\/platform\/enterprises\/[0-9a-f-]{36}\/(?:owners|owners\/[0-9a-f-]{36}\/(?:code|initial-password))$/.test(path)
        && path.split('/').filter(part => part.length === 36).every(uuid);
}
export class DataportPlatform {
    constructor(dataport, accounts) { this.store = dataport; this.accounts = accounts; }
    async list(principal, search) {
        requireDataportPlatformAdmin(principal);
        if ([...search.keys()].some(k => !['page', 'pageSize', 'q'].includes(k)) || [...new Set(search.keys())].some(k => search.getAll(k).length !== 1))
            invalid('查询参数无效。');
        const { page, pageSize, offset } = paging(search);
        const q = search.get('q') || '';
        if (q.length > 100)
            invalid('企业名称最多 100 字。');
        const args = [q];
        const total = (await this.store.pool.query("SELECT count(*)::int AS n FROM tenants WHERE status='active' AND ($1='' OR position(lower($1) in lower(name))>0)", args)).rows[0].n;
        const items = (await this.store.pool.query(`SELECT id,name FROM tenants WHERE status='active' AND ($1='' OR position(lower($1) in lower(name))>0) ORDER BY name,id LIMIT $2 OFFSET $3`, [q, pageSize, offset])).rows;
        for (const item of items)
            item.owners = (await this.store.pool.query(`SELECT m.id AS "memberId",m.display_name AS "displayName",a.account,a.managed,c.revision IS NOT NULL AS "codeConfigured"
      FROM iam.tenant_memberships tm JOIN iam.members m ON m.id=tm.member_id
      LEFT JOIN dataport.managed_accounts a ON a.tenant_id=tm.tenant_id AND a.member_id=m.id
      LEFT JOIN dataport.owner_codes c ON c.tenant_id=tm.tenant_id AND c.member_id=m.id
      WHERE tm.tenant_id=$1 AND tm.role='owner' AND tm.status='active' AND m.status='active' ORDER BY m.display_name,m.id`, [item.id])).rows;
        return { items, total, page, pageSize };
    }
    async create(principal, body) {
        requireDataportPlatformAdmin(principal);
        if (Object.keys(body).some(k => !['commandId', 'name'].includes(k)) || !uuid(body.commandId) || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100)
            invalid('请填写企业名称（最多 100 字）。');
        const name = body.name.trim(), tenantId = body.commandId;
        return withPgTransaction(this.store.pool, async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dataport-platform:${tenantId}`]);
            const previous = (await db.query('SELECT actor,name FROM dataport.platform_enterprises WHERE tenant_id=$1', [tenantId])).rows[0];
            if (previous) {
                if (previous.actor !== principal.memberId || previous.name !== name)
                    throw new AppError(409, 'platform_command_conflict', '操作编号已被使用。');
                return { tenantId, name };
            }
            await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, name]);
            await db.query('INSERT INTO dataport.platform_enterprises(tenant_id,actor,name) VALUES($1,$2,$3)', [tenantId, principal.memberId, name]);
            await this.store.event(tenantId, principal.memberId, 'enterprise.created', tenantId, 201, {}, db);
            return { tenantId, name };
        });
    }
    async owner(principal, tenantId, body, audience) {
        requireDataportPlatformAdmin(principal);
        if (Object.keys(body).some(k => !['commandId', 'operation', 'account', 'displayName'].includes(k)) || !uuid(body.commandId) || !['create', 'invite'].includes(body.operation) || typeof body.account !== 'string' || !/^[A-Za-z][A-Za-z0-9_.@+-]{2,127}$/.test(body.account.trim()) || (body.displayName !== undefined && (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 80)))
            invalid('请填写有效的 MX 账号及姓名。');
        const { commandId, operation, displayName } = body, account = body.account.trim();
        const fingerprint = digest(JSON.stringify({ operation, account, displayName, roleId: 'owner' }));
        if (!(await this.store.pool.query("SELECT 1 FROM tenants WHERE id=$1 AND status='active'", [tenantId])).rowCount)
            throw new AppError(404, 'tenant_not_found', '企业不存在或已停用。');
        await this.store.pool.query(`INSERT INTO dataport.member_commands(id,tenant_id,actor,operation,fingerprint,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [commandId, tenantId, principal.memberId, operation, fingerprint, { roleId: 'owner', platform: true }]);
        const command = (await this.store.pool.query('SELECT * FROM dataport.member_commands WHERE id=$1', [commandId])).rows[0];
        if (command.tenant_id !== tenantId || command.actor !== principal.memberId || command.fingerprint !== fingerprint || command.document.platform !== true)
            throw new AppError(409, 'platform_command_conflict', '操作编号已被使用。');
        const identity = await this.accounts.execute({ operation, requestId: commandId, tenantId, actor: principal.memberId, account, displayName });
        // Recheck MX role after the remote operation as well; retries cannot finish
        // an enrollment after the operator has lost the application grant.
        if (!await this.accounts.isPlatformAdmin(principal.subject.replace(/^user:/, ''), principal.issuer))
            throw new AppError(403, 'dataport_platform_admin_required', '数港平台管理员授权已失效。');
        return withPgTransaction(this.store.pool, async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dataport-members:${tenantId}`]);
            if (!(await db.query("SELECT 1 FROM tenants WHERE id=$1 AND status='active' FOR SHARE", [tenantId])).rowCount)
                throw new AppError(404, 'tenant_not_found', '企业已停用。');
            if (operation === 'invite') {
                const token = this.accounts.invitation(commandId, tenantId);
                await db.query(`INSERT INTO dataport.joins(digest,tenant_id,role_id,requested_by,account,issuer,subject,expires_at,platform_authorizer) VALUES($1,$2,'owner',$3,$4,$5,$6,now()+interval '24 hours',$7) ON CONFLICT DO NOTHING`, [digest(token), tenantId, principal.memberId, identity.account, identity.issuer, identity.subject, { issuer: principal.issuer, subject: principal.subject }]);
                const join = (await db.query('SELECT expires_at,consumed_by FROM dataport.joins WHERE digest=$1', [digest(token)])).rows[0];
                await db.query("UPDATE dataport.member_commands SET state='completed' WHERE id=$1", [commandId]);
                await this.store.event(tenantId, principal.memberId, 'owner.invited', identity.userId, 200, {}, db);
                return { joinToken: token, expiresAt: join.expires_at, consumed: !!join.consumed_by };
            }
            const memberId = await this.store.bindManaged(db, tenantId, identity, audience, 'owner', principal.memberId, true, true);
            await db.query("UPDATE dataport.member_commands SET state='completed' WHERE id=$1", [commandId]);
            await this.store.event(tenantId, principal.memberId, 'owner.created', memberId, 201, {}, db);
            return { memberId, account: identity.account };
        });
    }
    async password(principal, tenantId, memberId) {
        requireDataportPlatformAdmin(principal);
        const managed = (await this.store.pool.query(`SELECT a.user_id FROM dataport.managed_accounts a JOIN iam.tenant_memberships m ON m.member_id=a.member_id AND m.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.member_id=$2 AND a.managed AND m.role='owner' AND m.status='active'`, [tenantId, memberId])).rows[0];
        if (!managed)
            throw new AppError(404, 'initial_password_unavailable', '此超管没有可查看的初始密码。');
        const result = await this.accounts.execute({ operation: 'initial-password', requestId: randomUUID(), tenantId, actor: principal.memberId, userId: managed.user_id });
        await this.store.event(tenantId, principal.memberId, 'owner.initial-password.viewed', memberId);
        return result;
    }
}
