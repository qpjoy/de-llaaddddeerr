import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.mjs';
import { withPgTransaction } from '../stores/postgres-store.mjs';
import { requireDataportAccess, requireOwner, isOwner } from './dataport-policy.mjs';
import { capabilitiesForRole } from '../identity/index.mjs';

const derive = promisify(scrypt);
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const fail = (status, code, message) => { throw new AppError(status, code, message); };
const accountName = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const accountValid = value => /^[a-z][a-z0-9_.-]{2,63}$/.test(value);
const passwordValid = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
let hashing = 0;
async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (hashing >= 4) fail(429, 'local_auth_busy', '登录请求较多，请稍后重试。');
  hashing++;
  try {
    const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    return `${salt}:${key.toString('hex')}`;
  } finally { hashing--; }
}
async function verifyPassword(password, encoded) {
  const parts = /^([a-f0-9]{32}):([a-f0-9]{64})$/.exec(encoded || '');
  // Unknown accounts still perform the same bounded password derivation.
  const candidate = await hashPassword(password, parts?.[1] || '0'.repeat(32));
  return !!parts && timingSafeEqual(Buffer.from(candidate.split(':')[1], 'hex'), Buffer.from(parts[2], 'hex'));
}

export class DataportLocalAccounts {
  constructor(dataport, pepper) { this.dataport = dataport; this.pool = dataport.pool; this.pepper = pepper; }
  key() {
    if (typeof this.pepper !== 'string' || this.pepper.length < 32)
      fail(503, 'dataport_accounts_not_configured', '数港子账号加密配置尚未就绪。');
    return createHmac('sha256', this.pepper).update('dataport-local-initial-password:v1').digest();
  }
  seal(password, memberId, tenantId) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(`${tenantId}:${memberId}`));
    const bytes = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), value: bytes.toString('hex') };
  }
  open(row) {
    try {
      const { iv, tag, value } = row.initial_cipher;
      const cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'hex'));
      cipher.setAAD(Buffer.from(`${row.tenant_id}:${row.member_id}`));
      cipher.setAuthTag(Buffer.from(tag, 'hex'));
      return Buffer.concat([cipher.update(Buffer.from(value, 'hex')), cipher.final()]).toString('utf8');
    } catch { fail(503, 'dataport_accounts_invalid_config', '数港子账号凭据无法读取，请保留原有加密配置。'); }
  }
  async lock(db, tenantId, commandId) {
    if (commandId) await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dataport-command:${commandId}`]);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dataport-members:${tenantId}`]);
  }
  async fresh(principal, tenantId, owner = false, db = this.pool) {
    const scoped = Object.assign(Object.create(this.dataport), {pool:db});
    const current = await scoped.enrich(principal, principal.dataportSession);
    if (owner) requireOwner(current, tenantId);
    else requireDataportAccess(current, tenantId, 'members.create');
    return current;
  }
  async previous(db, principal, tenantId, commandId, operation, fingerprint) {
    const previous = (await db.query('SELECT * FROM dataport.member_commands WHERE id=$1 FOR UPDATE', [commandId])).rows[0];
    if (previous && (previous.tenant_id !== tenantId || previous.actor !== principal.memberId || previous.operation !== operation || previous.fingerprint !== fingerprint))
      fail(409, 'member_command_conflict', '操作编号已被使用；旧账号请求请先核对受理结果。');
    return previous;
  }
  async complete(db, principal, tenantId, id, operation, fingerprint, document) {
    await db.query(`INSERT INTO dataport.member_commands(id,tenant_id,actor,operation,fingerprint,document,state)
      VALUES($1,$2,$3,$4,$5,$6,'completed')`, [id, tenantId, principal.memberId, operation, fingerprint, document]);
  }
  async create(principal, tenantId, body) {
    const account = accountName(body.account), displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!accountValid(account) || !displayName || displayName.length > 80)
      fail(400, 'invalid_local_account', '账号需为 3–64 位字母、数字、点、下划线或短横线，以字母开头；请填写员工名称。');
    const fingerprint = sha(JSON.stringify({operation:'create',account,displayName,roleId:body.roleId}));
    try {
      return await withPgTransaction(this.pool, async db => {
        await this.lock(db, tenantId, body.commandId);
        const fresh = await this.fresh(principal, tenantId, false, db);
        const role = await this.dataport.role(tenantId, body.roleId, db);
        if (!role || role.id === 'owner' || (!isOwner(fresh, tenantId) && role.permissions.some(p => !requireDataportAccess(fresh, tenantId).dataport.permissions.includes(p))))
          fail(403, 'role_exceeds_authority', '不能分配此角色。');
        const previous = await this.previous(db, principal, tenantId, body.commandId, 'create-local', fingerprint);
        if (previous) return previous.document;
        const memberId = randomUUID(), password = randomBytes(18).toString('base64url');
        const hash = await hashPassword(password), sealed = this.seal(password, memberId, tenantId);
        await db.query('INSERT INTO iam.members(id,display_name) VALUES($1,$2)', [memberId, displayName]);
        await db.query(`INSERT INTO iam.tenant_memberships(id,tenant_id,member_id,role,granted_by) VALUES($1,$2,$3,'viewer',$4)`, [randomUUID(), tenantId, memberId, principal.memberId]);
        await db.query('INSERT INTO dataport.member_roles(tenant_id,member_id,role_id) VALUES($1,$2,$3)', [tenantId, memberId, role.id]);
        await db.query(`INSERT INTO dataport.managed_accounts(tenant_id,member_id,user_id,account,managed,auth_mode) VALUES($1,$2,$3,$4,true,'local')`, [tenantId, memberId, `dataport:${memberId}`, account]);
        await db.query(`INSERT INTO dataport.local_credentials(member_id,tenant_id,account,password_hash,initial_cipher,initial_expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '48 hours')`, [memberId, tenantId, account, hash, sealed]);
        const result = { memberId, account, authMode: 'local' };
        await this.complete(db, principal, tenantId, body.commandId, 'create-local', fingerprint, result);
        await this.dataport.event(tenantId, principal.memberId, 'member.created', memberId, 201, { roleId: role.id, authMode: 'local' }, db);
        return result;
      });
    } catch (error) {
      if (error.code === '23505') fail(409, 'local_account_exists', '此数港子账号名已使用，请更换账号名。');
      throw error;
    }
  }
  async reset(principal, tenantId, memberId, commandId) {
    try {
      return await withPgTransaction(this.pool, async db => {
        await this.lock(db, tenantId, commandId);
        await this.fresh(principal, tenantId, true, db);
        const row = (await db.query(`SELECT ma.* FROM dataport.managed_accounts ma
          JOIN iam.tenant_memberships tm USING(tenant_id,member_id) JOIN iam.members m ON m.id=ma.member_id
          WHERE ma.tenant_id=$1 AND ma.member_id=$2 AND ma.managed AND tm.role<>'owner' AND tm.status='active' AND m.status='active' FOR UPDATE OF ma`, [tenantId, memberId])).rows[0];
        if (!row || memberId === principal.memberId) fail(403, 'managed_account_required', '仅可重置本企业有效托管子账号；已有 MX 账号请使用统一找回。');
        const fingerprint = sha(JSON.stringify([tenantId, principal.memberId, memberId, 'reset-local']));
        const previous = await this.previous(db, principal, tenantId, commandId, 'reset-local', fingerprint);
        if (previous) return previous.document;
        const account = accountName(row.account);
        if (!accountValid(account)) fail(409, 'local_account_name_invalid', '旧账号名不符合数港子账号规则，请联系管理员处理迁移。');
        const existing = (await db.query('SELECT tenant_id FROM dataport.local_credentials WHERE member_id=$1', [memberId])).rows[0];
        if (existing && existing.tenant_id !== tenantId) fail(409, 'local_account_scope_conflict', '该身份已属于另一企业的独立子账号，请联系管理员处理。');
        const password = randomBytes(18).toString('base64url'), hash = await hashPassword(password), sealed = this.seal(password, memberId, tenantId);
        await db.query(`INSERT INTO dataport.local_credentials(member_id,tenant_id,account,password_hash,initial_cipher,initial_expires_at)
          VALUES($1,$2,$3,$4,$5,now()+interval '48 hours') ON CONFLICT(member_id) DO UPDATE SET password_hash=excluded.password_hash,
          initial_cipher=excluded.initial_cipher,initial_expires_at=excluded.initial_expires_at,revision=dataport.local_credentials.revision+1,updated_at=now()`, [memberId, tenantId, account, hash, sealed]);
        await db.query(`UPDATE dataport.managed_accounts SET auth_mode='local' WHERE tenant_id=$1 AND member_id=$2`, [tenantId, memberId]);
        await db.query('DELETE FROM dataport.local_sessions WHERE member_id=$1', [memberId]);
        const result = { passwordReset: true, authMode: 'local', account };
        await this.complete(db, principal, tenantId, commandId, 'reset-local', fingerprint, result);
        await this.dataport.event(tenantId, principal.memberId, 'member.password.reset', memberId, 200, { authMode: 'local' }, db);
        return result;
      });
    } catch (error) {
      if (error.code === '23505') fail(409, 'local_account_exists', '此数港子账号名已使用，无法自动迁移，请联系管理员处理。');
      throw error;
    }
  }
  async initial(principal, tenantId, memberId) {
    await this.fresh(principal, tenantId, true);
    const row = (await this.pool.query(`SELECT c.* FROM dataport.local_credentials c JOIN iam.tenant_memberships tm USING(tenant_id,member_id)
      WHERE c.tenant_id=$1 AND c.member_id=$2 AND tm.status='active' AND tm.role<>'owner' AND c.initial_expires_at>now() AND c.initial_cipher IS NOT NULL`, [tenantId, memberId])).rows[0];
    if (!row) fail(404, 'initial_password_unavailable', '没有可查看的初始密码；旧托管账号请先重置为数港独立账号。');
    const password = this.open(row);
    await this.dataport.event(tenantId, principal.memberId, 'member.initial-password.viewed', memberId);
    return { password, expiresAt: row.initial_expires_at };
  }
  async throttle(key, max) {
    const row = (await this.pool.query(`INSERT INTO dataport.login_limits(bucket,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes')
      ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN dataport.login_limits.expires_at<=now() THEN 1 ELSE dataport.login_limits.attempts+1 END,
      expires_at=CASE WHEN dataport.login_limits.expires_at<=now() THEN excluded.expires_at ELSE dataport.login_limits.expires_at END RETURNING attempts`, [sha(key)])).rows[0];
    if (row.attempts > max) fail(429, 'local_login_limited', '尝试次数过多，请 15 分钟后重试或联系企业超管。');
  }
  async login(body) {
    if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k => !['account','password'].includes(k)) || !accountValid(accountName(body.account)) || typeof body.password !== 'string' || !body.password || body.password.length > 128)
      fail(400, 'invalid_local_login', '请填写数港子账号和密码。');
    const account = accountName(body.account);
    // Shared, persistent budgets also bound unknown-name churn across replicas.
    await this.throttle('login-global', 600);
    await this.pool.query('DELETE FROM dataport.login_limits WHERE bucket IN (SELECT bucket FROM dataport.login_limits WHERE expires_at<=now() LIMIT 1000)');
    await this.throttle(`login:${account}`, 10);
    const row = (await this.pool.query('SELECT * FROM dataport.local_credentials WHERE account=$1', [account])).rows[0];
    if (!await verifyPassword(body.password, row?.password_hash)) fail(401, 'local_login_failed', '账号或密码不正确，或账号不可用。');
    return withPgTransaction(this.pool, async db => {
      await this.lock(db, row.tenant_id);
      const current = (await db.query(`SELECT c.* FROM dataport.local_credentials c
        JOIN dataport.managed_accounts ma ON ma.tenant_id=c.tenant_id AND ma.member_id=c.member_id JOIN iam.tenant_memberships tm ON tm.tenant_id=c.tenant_id AND tm.member_id=c.member_id
        JOIN iam.members m ON m.id=c.member_id JOIN tenants t ON t.id=c.tenant_id
        WHERE c.member_id=$1 AND c.revision=$2 AND ma.auth_mode='local' AND ma.managed
        AND tm.status='active' AND tm.role<>'owner' AND m.status='active' AND t.status='active'
        AND (c.initial_cipher IS NULL OR c.initial_expires_at>now()) FOR UPDATE OF c`, [row.member_id, row.revision])).rows[0];
      if (!current) fail(401, 'local_login_failed', '账号或密码不正确，或账号不可用。');
      const token = random(), csrf = random();
      await db.query('DELETE FROM dataport.local_sessions WHERE member_id=$1 AND expires_at<=now()', [row.member_id]);
      await db.query(`INSERT INTO dataport.local_sessions(digest,member_id,credential_revision,csrf,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')`, [sha(token), row.member_id, row.revision, csrf]);
      // At most ten simultaneously valid sessions per account.
      await db.query(`DELETE FROM dataport.local_sessions WHERE member_id=$1 AND digest IN (SELECT digest FROM dataport.local_sessions WHERE member_id=$1 ORDER BY created_at DESC,digest DESC OFFSET 10)`, [row.member_id]);
      await this.dataport.event(row.tenant_id, row.member_id, 'member.login', row.member_id, 200, { authMode: 'local' }, db);
      return { token, csrf, expiresIn: 30 * 86400, mustChangePassword: !!current.initial_cipher };
    });
  }
  async resolveLogin(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'account') || typeof body.account !== 'string' || !body.account.trim() || body.account.length > 255)
      fail(400, 'invalid_local_login', '请填写账号。');
    await this.throttle('resolve-global', 600);
    await this.pool.query('DELETE FROM dataport.login_limits WHERE bucket IN (SELECT bucket FROM dataport.login_limits WHERE expires_at<=now() LIMIT 1000)');
    await this.throttle(`resolve:${accountName(body.account)}`, 10);
    const rows = await this.pool.query('SELECT 1 FROM dataport.local_credentials WHERE account=$1', [accountName(body.account)]);
    // Disabled/expired accounts remain reserved and must never fall through to MX.
    return { exists: rows.rows.length > 0 };
  }
  async principal(token, metadata, db = this.pool) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'login_required', '请重新登录数港子账号。');
    const row = (await db.query(`SELECT c.member_id,c.tenant_id,c.account,c.initial_cipher IS NOT NULL AS must_change_password,
      s.csrf,coalesce(mp.display_name,m.display_name) AS display_name,tm.id,tm.role,t.name AS tenant_name
      FROM dataport.local_sessions s JOIN dataport.local_credentials c ON c.member_id=s.member_id AND c.revision=s.credential_revision
      JOIN dataport.managed_accounts ma ON ma.tenant_id=c.tenant_id AND ma.member_id=c.member_id JOIN iam.tenant_memberships tm ON tm.tenant_id=c.tenant_id AND tm.member_id=c.member_id
      JOIN iam.members m ON m.id=c.member_id JOIN tenants t ON t.id=c.tenant_id
      LEFT JOIN dataport.member_profiles mp ON mp.tenant_id=c.tenant_id AND mp.member_id=c.member_id
      WHERE s.digest=$1 AND s.expires_at>now() AND ma.auth_mode='local' AND ma.managed
      AND tm.status='active' AND tm.role<>'owner' AND m.status='active' AND t.status='active'
      AND (c.initial_cipher IS NULL OR c.initial_expires_at>now())`, [sha(token)])).rows[0];
    if (!row) fail(401, 'login_required', '子账号会话已失效，请重新登录。');
    const membership = { id: row.id, tenantId: row.tenant_id, tenantName: row.tenant_name, role: row.role, status: 'active', capabilities: capabilitiesForRole(row.role) };
    return { kind: 'dataport-user', memberId: row.member_id, displayName: row.display_name, account: row.account,
      subject: `dataport:${row.member_id}`, issuer: 'dataport-local', platformAdmin: false, tenantIds: [row.tenant_id], memberships: [membership],
      capabilities: membership.capabilities, ...metadata, localCsrf: row.csrf, mustChangePassword: row.must_change_password };
  }
  async account(token, metadata, body) {
    const principal = await this.principal(token, metadata), tenantId = principal.tenantIds[0];
    if (body === undefined) {
      const sessions = (await this.pool.query('SELECT created_at AS "createdAt",expires_at AS "expiresAt" FROM dataport.local_sessions WHERE member_id=$1 AND expires_at>now() ORDER BY created_at DESC', [principal.memberId])).rows;
      return { account: principal.account, displayName: principal.displayName, csrf: principal.localCsrf, identityProvider: 'dataport-local', mustChangePassword: principal.mustChangePassword, sessions };
    }
    if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k => !['action','currentPassword','password','displayName','target'].includes(k)) || !['password','profile','revoke'].includes(body.action) || (body.action==='revoke' && body.target!=='all') || typeof body.currentPassword !== 'string' || body.currentPassword.length > 128)
      fail(400, 'invalid_local_account_update', '账号操作参数无效。');
    if (principal.mustChangePassword && body.action !== 'password') fail(403, 'password_change_required', '请先修改初始密码。');
    if (body.action === 'password' && (!passwordValid(body.password) || body.password === body.currentPassword))
      fail(400, 'invalid_password', '新密码需为 12–128 位，且不能与当前密码相同。');
    await this.throttle(`verify:${principal.memberId}`, 10);
    const before = (await this.pool.query('SELECT password_hash,revision FROM dataport.local_credentials WHERE member_id=$1', [principal.memberId])).rows[0];
    if (!await verifyPassword(body.currentPassword, before?.password_hash)) fail(403, 'current_password_invalid', '当前密码不正确。');
    const hash = body.action === 'password' ? await hashPassword(body.password) : null;
    return withPgTransaction(this.pool, async db => {
      await this.lock(db, tenantId);
      const fresh = await this.principal(token, metadata, db);
      const current = (await db.query('SELECT revision FROM dataport.local_credentials WHERE member_id=$1 FOR UPDATE', [principal.memberId])).rows[0];
      if (current.revision !== before.revision) fail(409, 'local_account_changed', '账号已变更，请重新登录。');
      if (body.action === 'profile') {
        if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.trim().length > 80)
          fail(400, 'invalid_display_name', '请填写不超过 80 字的名称。');
        await db.query(`INSERT INTO dataport.member_profiles(tenant_id,member_id,display_name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,member_id) DO UPDATE SET display_name=excluded.display_name`, [tenantId, fresh.memberId, body.displayName.trim()]);
      } else {
        await db.query(`UPDATE dataport.local_credentials SET revision=revision+1,updated_at=now()${hash ? ',password_hash=$2,initial_cipher=NULL,initial_expires_at=NULL' : ''} WHERE member_id=$1`, hash ? [principal.memberId, hash] : [principal.memberId]);
        await db.query('DELETE FROM dataport.local_sessions WHERE member_id=$1', [principal.memberId]);
      }
      await this.dataport.event(tenantId, principal.memberId, `member.${body.action === 'password' ? 'password.changed' : body.action === 'profile' ? 'profile.updated' : 'sessions.revoked'}`, principal.memberId, 200, {}, db);
      return { signedOut: body.action !== 'profile', saved: true };
    });
  }
  async logout(token) { await this.pool.query('DELETE FROM dataport.local_sessions WHERE digest=$1', [sha(token)]); return { signedOut: true }; }
}
