import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { createUserCenterUser, createUserCenterUserCredential, resolveUserCenterUserForLogin, userCredentialSummary, userMatchesLogin, verifyUserCenterCredential } from '../store/domain.js';
import type { AppCenterApp, UserCenterUser, UserCenterUserCredential } from '../types.js';

export type RegistrationMode = 'closed' | 'invite_code' | 'open';
export interface RegistrationPolicy { mode: RegistrationMode; version: number }
export interface RegistrationInput { transactionId: string; clientId: string; policyVersion: number; account: string; password: string; inviteCode?: string; verifiedFeishuSubject?: string }
export class RegistrationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new RegistrationError(status, code, message); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const accountWriteLock = (manager: EntityManager, environment: string) =>
  manager.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [environment, 'mx-account-creation']);
export interface InvitationAppGrant { mode: 'policy' | 'selected' | 'all_current'; appIds: string[] }
export interface CreateInvitationInput { label: string; maxUses: number; days: number; appGrant?: InvitationAppGrant }
interface Invitation { id: string; label: string; clientId: string; codeHash: string; maxUses: number; uses: number; startsAt: string; expiresAt: string; revoked: boolean; createdAt: string; appGrant?: InvitationAppGrant }

/** Runs only in Internal API, the account writer. Identity calls it through a
 * narrow authenticated backchannel. Records share the existing durable backup. */
export class RegistrationRepository {
  private db: DataSource;
  private initializing?: Promise<DataSource>;
  constructor(url: string, private environment: string, private clientId: string, private siteId: string) {
    this.db = new DataSource({ type: 'postgres', url, synchronize: false,
      extra: { max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 } });
  }
  private async ready() {
    if (!this.initializing) this.initializing = this.db.initialize().catch(error => { this.initializing = undefined; throw error; });
    return this.initializing;
  }
  async close() { if (this.initializing) await this.initializing; if (this.db.isInitialized) await this.db.destroy(); }
  private async read<T>(manager: EntityManager, kind: string, id: string): Promise<T | undefined> {
    const rows = await manager.query('SELECT data FROM mx_platform_records WHERE environment=$1 AND kind=$2 AND id=$3', [this.environment, kind, id]);
    return rows[0]?.data;
  }
  private async write(manager: EntityManager, kind: string, id: string, value: unknown) {
    await manager.query(`INSERT INTO mx_platform_records (environment,kind,id,site_id,data) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (environment,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`, [this.environment, kind, id, this.siteId, value]);
  }
  private async lock(manager: EntityManager) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [this.environment, 'mx-registration']);
  }
  private async audit(manager: EntityManager, eventType: string, metadata: Record<string, unknown>, userId: string | null = null) {
    const eventId = `aud_${randomUUID()}`;
    await this.write(manager, 'audit-event', eventId, { eventId, eventType, provenance: 'server', actorKind: 'registration',
      userId, environment: this.environment, siteId: this.siteId, metadata, createdAt: new Date().toISOString() });
  }
  private async policyFor(manager: EntityManager): Promise<RegistrationPolicy> {
    return await this.read(manager, 'registration-policy', 'platform') ?? { mode: 'invite_code', version: 0 };
  }
  async policy() { await this.ready(); return this.policyFor(this.db.manager); }
  private validFeishu(subject: string) {
    if (!/^[A-Za-z0-9_-]{1,160}:[A-Za-z0-9_-]{1,160}$/.test(subject)) fail(400, 'invalid_feishu_identity', '飞书身份验证无效。');
  }
  async feishuAccount(subject: string) {
    this.validFeishu(subject); await this.ready();
    const rows = await this.db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user' AND data->'profile'->'externalIds'->>'feishuSubject'=$2", [this.environment, subject]);
    if (rows.length > 1) fail(409, 'feishu_binding_conflict', '飞书已存在冲突绑定，请联系管理员核对。');
    if (rows[0] && rows[0].data.status !== 'active') fail(403, 'feishu_account_disabled', '此飞书关联账号已停用。');
    return { userId: rows[0]?.data.userId ?? null };
  }
  async bindFeishu(subject: string, login: string, password: string) {
    this.validFeishu(subject); await this.ready();
    return this.db.transaction(async manager => {
      await accountWriteLock(manager, this.environment);
      const rows: Array<{ data: UserCenterUser }> = await manager.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user'", [this.environment]);
      const user = resolveUserCenterUserForLogin(rows.map(row => row.data), login);
      const credential = user ? await this.read<UserCenterUserCredential>(manager, 'iam-user-credential', user.userId) : undefined;
      if (!user || user.status !== 'active' || ['usr_demo_admin','usr_demo_user'].includes(user.userId) || !credential || !verifyUserCenterCredential(password, credential))
        fail(401, 'invalid_binding_credentials', 'MX 账号或密码不正确，或账号不可用。');
      const linked = rows.filter(row => row.data.profile.externalIds.feishuSubject === subject);
      if (linked.some(row => row.data.userId !== user!.userId) || (user!.profile.externalIds.feishuSubject && user!.profile.externalIds.feishuSubject !== subject))
        fail(409, 'feishu_binding_conflict', '飞书或 MX 账号已有其他绑定；不会自动合并账号、租户或权限，请联系管理员核对。');
      if (!linked.length) {
        await this.write(manager, 'iam-user', user!.userId, { ...user, updatedAt: new Date().toISOString(),
          credential: { ...user!.credential, providers: [...new Set([...user!.credential.providers, 'feishu'])] },
          profile: { ...user!.profile, externalIds: { ...user!.profile.externalIds, feishuSubject: subject } } });
        await this.audit(manager, 'identity.feishu.bound', { provider: 'feishu' }, user!.userId);
      }
      return { userId: user!.userId };
    });
  }
  async updatePolicy(input: RegistrationPolicy) {
    if (!['closed', 'invite_code', 'open'].includes(input.mode) || !Number.isSafeInteger(input.version)) fail(400, 'invalid_policy', '注册策略无效。');
    await this.ready();
    return this.db.transaction(async manager => {
      await this.lock(manager);
      const old = await this.policyFor(manager);
      if (input.version !== old.version) fail(409, 'policy_changed', '注册策略已更新，请刷新后重试。');
      const policy = { mode: input.mode, version: old.version + 1 };
      await this.write(manager, 'registration-policy', 'platform', policy);
      await this.audit(manager, 'identity.registration-policy.updated', { ...policy });
      return policy;
    });
  }
  async invitations(): Promise<Array<Omit<Invitation, 'codeHash'>>> {
    await this.ready();
    const rows = await this.db.query("SELECT data - 'codeHash' AS data FROM mx_platform_records WHERE environment=$1 AND kind='registration-invite' ORDER BY created_at DESC LIMIT 100", [this.environment]);
    return rows.map((row: { data: Omit<Invitation, 'codeHash'> }) => row.data);
  }
  private async appsFor(manager: EntityManager) {
    const rows: Array<{ data: AppCenterApp }> = await manager.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='app-center-app' ORDER BY id", [this.environment]);
    return rows.map(({ data }) => ({ appId: data.appId, displayName: data.displayName, enabled: data.enabled !== false, defaultDecision: data.accessPolicy?.defaultDecision ?? 'private' }));
  }
  async apps() { await this.ready(); return this.appsFor(this.db.manager); }
  private async invitationGrant(manager: EntityManager, input?: InvitationAppGrant): Promise<InvitationAppGrant> {
    if (input === undefined) return { mode: 'policy', appIds: [] };
    if (!input || !['policy', 'selected', 'all_current'].includes(input.mode) || !Array.isArray(input.appIds)
      || input.appIds.length > 1000 || input.appIds.some(id => typeof id !== 'string' || !id.trim()))
      fail(400, 'invalid_app_grant', '应用范围无效，请重新选择。');
    if (input.mode !== 'selected' && input.appIds.length) fail(400, 'invalid_app_grant', '此模式由系统确定应用范围，请勿额外提交应用。');
    if (input.mode === 'policy') return { mode: 'policy', appIds: [] };
    const enabled = (await this.appsFor(manager)).filter(app => app.enabled).map(app => app.appId);
    const appIds = input.mode === 'all_current' ? enabled : [...new Set(input.appIds)];
    if (!appIds.length || appIds.some(id => !enabled.includes(id))) fail(400, 'invalid_app_grant', '请选择至少一个已登记且启用的应用，或选择遵循应用策略。');
    return { mode: input.mode, appIds };
  }
  async createInvitation(input: CreateInvitationInput) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > 80 || !Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 1000
      || !Number.isInteger(input.days) || input.days < 1 || input.days > 90) fail(400, 'invalid_invitation', '请填写名称、1–1000 个名额和 1–90 天有效期。');
    const code = `mxi_${randomBytes(24).toString('base64url')}`;
    const now = new Date();
    const invitation: Invitation = { id: randomUUID(), label, clientId: this.clientId, codeHash: hash(code), maxUses: input.maxUses,
      uses: 0, startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + input.days * 86400000).toISOString(), revoked: false, createdAt: now.toISOString() };
    await this.ready();
    await this.db.transaction(async manager => {
      await this.lock(manager);
      invitation.appGrant = await this.invitationGrant(manager, input.appGrant);
      await this.write(manager, 'registration-invite', invitation.id, invitation);
      await this.audit(manager, 'identity.invitation.created', { invitationId: invitation.id, clientId: this.clientId, maxUses: input.maxUses, appGrant: invitation.appGrant });
    });
    const { codeHash: _, ...safe } = invitation;
    return { invitation: safe, code };
  }
  async revokeInvitation(id: string) {
    await this.ready();
    await this.db.transaction(async manager => {
      await this.lock(manager);
      const invitation = await this.read<Invitation>(manager, 'registration-invite', id);
      if (!invitation) fail(404, 'invitation_missing', '邀请码不存在。');
      if (invitation!.revoked) return;
      await this.write(manager, 'registration-invite', id, { ...invitation, revoked: true });
      await this.audit(manager, 'identity.invitation.revoked', { invitationId: id });
    });
  }
  async register(input: RegistrationInput) {
    const account = typeof input.account === 'string' ? input.account.trim() : '';
    if (input.clientId !== this.clientId || !/^[A-Za-z0-9_-]{16,128}$/.test(input.transactionId ?? '')
      || !Number.isSafeInteger(input.policyVersion)) fail(400, 'invalid_transaction', '注册请求已失效，请重新打开登录页。');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/.test(account) || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128)
      fail(400, 'invalid_registration', '账号需为 3–64 位字母、数字、点、下划线或短横线，并以字母开头；密码需为 8–128 位。');
    const userId = `usr_${randomUUID()}`;
    const credential = createUserCenterUserCredential(userId, input.password);
    const transactionId = hash(`${input.clientId}:${input.transactionId}`);
    await this.ready();
    return this.db.transaction(async manager => {
      await accountWriteLock(manager, this.environment); await this.lock(manager);
      const previous = await this.read<{ userId: string }>(manager, 'registration-redemption', transactionId);
      if (previous) {
        const user = await this.read<UserCenterUser>(manager, 'iam-user', previous.userId);
        const stored = await this.read<UserCenterUserCredential>(manager, 'iam-user-credential', previous.userId);
        if (!user || user.status !== 'active' || user.account !== account || !stored || !verifyUserCenterCredential(input.password, stored))
          fail(409, 'registration_conflict', '此注册请求已完成，请使用原账号登录。');
        if (input.verifiedFeishuSubject && user!.profile.externalIds.feishuSubject !== input.verifiedFeishuSubject) fail(409, 'feishu_binding_conflict', '注册身份已变化，请重新登录。');
        return { userId: previous.userId };
      }
      const policy = await this.policyFor(manager);
      if (policy.mode === 'closed') fail(403, 'registration_closed', '暂未开放新账号注册，已有账号可正常登录。');
      if (policy.version !== input.policyVersion) fail(409, 'policy_changed', '注册策略已更新，请刷新页面后重试。');
      let invitation: Invitation | undefined;
      if (policy.mode === 'invite_code') {
        const codeHash = hash(typeof input.inviteCode === 'string' ? input.inviteCode.trim() : '');
        const rows = await manager.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='registration-invite' AND data->>'codeHash'=$2", [this.environment, codeHash]);
        invitation = rows[0]?.data;
        if (!invitation || invitation.clientId !== input.clientId || invitation.revoked || invitation.uses >= invitation.maxUses
          || Date.parse(invitation.startsAt) > Date.now() || Date.parse(invitation.expiresAt) <= Date.now()) fail(400, 'invitation_unavailable', '邀请码无效、已停用、已到期或名额已用完。');
      }
      const rows = await manager.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user'", [this.environment]);
      if (input.verifiedFeishuSubject) {
        this.validFeishu(input.verifiedFeishuSubject);
        if (rows.some((row: { data: UserCenterUser }) => row.data.profile.externalIds.feishuSubject === input.verifiedFeishuSubject)) fail(409, 'feishu_binding_conflict', '此飞书已绑定其他 MX 账号，请直接登录或联系管理员。');
      }
      if (rows.some((row: { data: UserCenterUser }) => userMatchesLogin(row.data, account))) fail(409, 'account_unavailable', '此账号不可用，请更换账号；已有账号请直接登录。');
      // No admin role, network entitlement, tenant membership, paid quota or
      // client-supplied role is inherited from ordinary identity registration.
      // This is an immutable, server-owned snapshot. Empty and legacy invites
      // inherit application policies; they do not mean an all-app wildcard.
      const allowedAppIds = invitation?.appGrant?.appIds ?? [];
      const user = createUserCenterUser({ userId, account, displayName: account, roleIds: ['mx-user'], registeredByAppId: 'mx-identity', allowedAppIds,
        ...(input.verifiedFeishuSubject ? { externalIds: { feishuSubject: input.verifiedFeishuSubject } } : {}) }, null, userCredentialSummary(credential));
      await this.write(manager, 'iam-user', userId, user);
      await this.write(manager, 'iam-user-credential', userId, credential);
      if (invitation) await this.write(manager, 'registration-invite', invitation.id, { ...invitation, uses: invitation.uses + 1 });
      await this.write(manager, 'registration-redemption', transactionId, { userId, clientId: input.clientId, policyVersion: policy.version, invitationId: invitation?.id ?? null, createdAt: new Date().toISOString() });
      await this.audit(manager, 'identity.account.registered', { clientId: input.clientId, policyVersion: policy.version, invitationId: invitation?.id ?? null, allowedAppIds }, userId);
      return { userId };
    });
  }
}
