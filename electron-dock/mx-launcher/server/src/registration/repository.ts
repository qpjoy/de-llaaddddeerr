import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { createUserCenterUser, createUserCenterUserCredential, resolveUserCenterUserForLogin, userCredentialSummary, userMatchesLogin, verifyUserCenterCredential } from '../store/domain.js';
import type { AppCenterApp, UserCenterUser, UserCenterUserCredential } from '../types.js';

export type RegistrationMode = 'closed' | 'invite_code' | 'open';
export interface RegistrationPolicy { mode: RegistrationMode; version: number; hubMode?: RegistrationMode | 'inherit'; applicationModes?: Record<string, RegistrationMode> }
export type RegistrationSource = NonNullable<UserCenterUser['registration']>['source'];
export function validateRegistrationSource(source: RegistrationSource | undefined): void {
  if (source === undefined) return; // Old Auth replicas retain the default policy, without invented provenance.
  try {
    if (!source || typeof source.appId !== 'string' || !/^[-a-z0-9]{1,80}$/.test(source.appId) || typeof source.clientId !== 'string' || !source.clientId || source.clientId.length > 160) throw new Error();
    const issuer = new URL(source.issuer), origin = new URL(source.appOrigin);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/identity'
      || origin.protocol !== 'https:' || origin.origin !== source.appOrigin) throw new Error();
  } catch { fail(400,'invalid_registration_source','注册来源无效，请从应用重新发起。'); }
}
function effectivePolicy(policy: RegistrationPolicy, source?: RegistrationSource): RegistrationPolicy {
  return { ...policy, mode: policy.mode === 'closed' ? 'closed' : source?.appId === 'mx-harbor' ? (policy.applicationModes?.['mx-harbor'] ?? 'closed') : source?.appId === 'mx-insight-hub' && policy.hubMode && policy.hubMode !== 'inherit' ? policy.hubMode : policy.mode };
}
export interface EnterpriseInvitation { issuer: string; clientId: string; invitationId: string; expiresAt: string }
export interface RegistrationInput { transactionId: string; clientId: string; policyVersion: number; account: string; password: string; inviteCode?: string; verifiedFeishuSubject?: string; enterpriseInvitation?: EnterpriseInvitation; source?: RegistrationSource }
export class RegistrationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new RegistrationError(status, code, message); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const accountWriteLock = (manager: EntityManager, environment: string) =>
  manager.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [environment, 'mx-account-creation']);
export interface InvitationAppGrant { mode: 'policy' | 'selected' | 'all_current'; appIds: string[] }
export interface CreateInvitationInput { label: string; maxUses: number; days: number; appGrant?: InvitationAppGrant; admissionAppId?: 'mx-harbor' }
interface Invitation { id: string; label: string; clientId: string; codeHash: string; maxUses: number; uses: number; startsAt: string; expiresAt: string; revoked: boolean; createdAt: string; appGrant?: InvitationAppGrant; admissionAppId?: 'mx-harbor' }

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
  async policy(source?: RegistrationSource) { validateRegistrationSource(source); await this.ready(); return effectivePolicy(await this.policyFor(this.db.manager),source); }
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
    if (input.hubMode !== undefined && !['inherit','closed','invite_code','open'].includes(input.hubMode)) fail(400,'invalid_policy','Hub 注册方式无效。');
    if (input.applicationModes !== undefined && (!input.applicationModes || Array.isArray(input.applicationModes) || Object.entries(input.applicationModes).some(([app, mode]) => app !== 'mx-harbor' || !['closed','invite_code'].includes(mode)))) fail(400, 'invalid_policy', 'Harbor 当前仅支持关闭或邀请码注册。');
    await this.ready();
    return this.db.transaction(async manager => {
      await this.lock(manager);
      const old = await this.policyFor(manager);
      if (input.version !== old.version) fail(409, 'policy_changed', '注册策略已更新，请刷新后重试。');
      const hubMode = input.hubMode ?? old.hubMode;
      const policy: RegistrationPolicy = { mode: input.mode, version: old.version + 1, ...(hubMode !== undefined ? {hubMode} : {}), ...((input.applicationModes ?? old.applicationModes) ? {applicationModes: {...old.applicationModes, ...input.applicationModes}} : {}) };
      await this.write(manager, 'registration-policy', 'platform', policy);
      await this.audit(manager, 'identity.registration-policy.updated', { ...policy });
      return policy;
    });
  }
  async updateAccount(action: string, input: Record<string, unknown>) {
    await this.ready();
    return this.db.transaction(async manager => {
      await accountWriteLock(manager, this.environment);
      const user = await this.read<UserCenterUser>(manager, 'iam-user', String(input.userId));
      const credential = user ? await this.read<UserCenterUserCredential>(manager, 'iam-user-credential', user.userId) : undefined;
      if (!user || user.status !== 'active' || ['usr_demo_admin','usr_demo_user'].includes(user.userId) || !credential
        || typeof input.currentPassword !== 'string' || !verifyUserCenterCredential(input.currentPassword, credential))
        fail(401, 'invalid_account_credentials', '当前密码不正确或账号不可用。');
      const now = new Date().toISOString();
      const updated = { ...user!, updatedAt: now };
      if (action === 'profile') {
        if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 80) fail(400, 'invalid_account_update', '显示名称需为 1–80 个字符。');
        updated.displayName = (input.displayName as string).trim();
      } else if (action === 'password') {
        if (typeof input.password !== 'string' || input.password.trim().length < 8 || input.password.length > 128) fail(400, 'invalid_account_update', '密码需为 8–128 位。');
        const next = createUserCenterUserCredential(user!.userId, input.password as string, {}, credential!, now);
        await this.write(manager, 'iam-user-credential', user!.userId, next);
        updated.credential = userCredentialSummary(next); updated.webSessionsInvalidBefore = now;
        // Match the original explicit password-change policy. No lease or peer writes.
        await manager.query(`UPDATE mx_platform_records SET data=jsonb_set(data,'{revokedAt}',to_jsonb($3::text)),updated_at=now()
          WHERE environment=$1 AND kind='iam-token' AND data->>'subjectKind'='user' AND data->>'subjectId'=$2 AND COALESCE(data->>'revokedAt','')=''`, [this.environment, user!.userId, now]);
      } else if (action === 'unlink-feishu') {
        updated.profile = { ...user!.profile, externalIds: { ...user!.profile.externalIds } };
        delete updated.profile.externalIds.feishuSubject;
        updated.credential = { ...user!.credential, providers: user!.credential.providers.filter(p => p !== 'feishu') };
      } else fail(400, 'invalid_account_update', '不支持的账号操作。');
      await this.write(manager, 'iam-user', user!.userId, updated);
      await this.audit(manager, `identity.account.${action}`, {}, user!.userId);
      return { ok: true };
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
    const appIds = input.mode === 'all_current' ? enabled.filter(id => id !== 'mx-harbor') : [...new Set(input.appIds)];
    if (!appIds.length || appIds.some(id => !enabled.includes(id))) fail(400, 'invalid_app_grant', '请选择至少一个已登记且启用的应用，或选择遵循应用策略。');
    return { mode: input.mode, appIds };
  }
  async createInvitation(input: CreateInvitationInput) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > 80 || !Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 1000
      || !Number.isInteger(input.days) || input.days < 1 || input.days > 90) fail(400, 'invalid_invitation', '请填写名称、1–1000 个名额和 1–90 天有效期。');
    if (input.admissionAppId !== undefined && input.admissionAppId !== 'mx-harbor') fail(400, 'invalid_app_grant', '邀请应用无效。');
    const code = `mxi_${randomBytes(24).toString('base64url')}`;
    const now = new Date();
    const invitation: Invitation = { id: randomUUID(), label, clientId: this.clientId, codeHash: hash(code), maxUses: input.maxUses,
      uses: 0, startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + input.days * 86400000).toISOString(), revoked: false, createdAt: now.toISOString(), ...(input.admissionAppId ? {admissionAppId: input.admissionAppId} : {}) };
    await this.ready();
    await this.db.transaction(async manager => {
      await this.lock(manager);
      invitation.appGrant = input.admissionAppId === 'mx-harbor' ? {mode: 'selected', appIds: ['mx-harbor']} : await this.invitationGrant(manager, input.appGrant);
      if (!input.admissionAppId && invitation.appGrant.appIds.includes('mx-harbor')) fail(400, 'invalid_app_grant', '请创建 Harbor 专用邀请。');
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
  /** Called only after Auth password verification on a registered Harbor interaction. */
  async redeemAdmission(input: {userId: string; inviteCode: string; source: RegistrationSource}) {
    validateRegistrationSource(input.source);
    if (input.source?.appId !== 'mx-harbor') fail(400, 'invalid_registration_source', '邀请应用不匹配。');
    await this.ready();
    return this.db.transaction(async manager => {
      await accountWriteLock(manager, this.environment); await this.lock(manager);
      const user = await this.read<UserCenterUser>(manager, 'iam-user', input.userId);
      if (!user || user.status !== 'active' || user.appAccess.deniedAppIds.includes('mx-harbor')) fail(403, 'admission_denied', '此账号不可访问 Harbor，请联系管理员。');
      // Retrying a successful redemption never consumes another seat or changes other app grants.
      if (user!.appAccess.allowedAppIds.includes('mx-harbor')) return {userId: user!.userId};
      const policy = effectivePolicy(await this.policyFor(manager), input.source);
      if (policy.mode !== 'invite_code') fail(403, 'registration_closed', 'Harbor 暂未开放邀请，请联系管理员开通。');
      const rows = await manager.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='registration-invite' AND data->>'codeHash'=$2", [this.environment, hash(typeof input.inviteCode === 'string' ? input.inviteCode.trim() : '')]);
      const invite: Invitation | undefined = rows[0]?.data;
      if (!invite || invite.clientId !== this.clientId || invite.admissionAppId !== 'mx-harbor' || invite.revoked || invite.uses >= invite.maxUses || Date.parse(invite.startsAt) > Date.now() || Date.parse(invite.expiresAt) <= Date.now()) fail(400, 'invitation_unavailable', 'Harbor 邀请码无效、已到期或名额已用完。');
      await this.write(manager, 'iam-user', user!.userId, {...user, updatedAt: new Date().toISOString(), appAccess: {...user!.appAccess, allowedAppIds: [...user!.appAccess.allowedAppIds, 'mx-harbor']}});
      await this.write(manager, 'registration-invite', invite!.id, {...invite, uses: invite!.uses + 1});
      await this.audit(manager, 'identity.application.admitted', {appId: 'mx-harbor', invitationId: invite!.id, source: input.source}, user!.userId);
      return {userId: user!.userId};
    });
  }
  async register(input: RegistrationInput) {
    validateRegistrationSource(input.source);
    if (input.source?.appId === 'mx-harbor' && (input.verifiedFeishuSubject || input.enterpriseInvitation)) fail(403, 'invalid_registration_source', 'Harbor 仅支持专用邀请码注册。');
    const account = typeof input.account === 'string' ? input.account.trim() : '';
    if (input.clientId !== this.clientId || !/^[A-Za-z0-9_-]{16,128}$/.test(input.transactionId ?? '')
      || !Number.isSafeInteger(input.policyVersion)) fail(400, 'invalid_transaction', '注册请求已失效，请重新打开登录页。');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/.test(account) || typeof input.password !== 'string' || input.password.trim().length < 8 || input.password.length > 128)
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
      const policy = effectivePolicy(await this.policyFor(manager),input.source);
      if (policy.hubMode && policy.hubMode !== 'inherit' && !input.source) fail(400,'invalid_registration_source','请从应用重新发起注册，身份服务需要支持注册来源。');
      if (policy.mode === 'closed') fail(403, 'registration_closed', '暂未开放新账号注册，已有账号可正常登录。');
      if (policy.version !== input.policyVersion) fail(409, 'policy_changed', '注册策略已更新，请刷新页面后重试。');
      const enterprise = input.enterpriseInvitation;
      let enterpriseKey: string | undefined;
      if (enterprise) {
        if (input.source && (input.source.appId !== 'mx-insight-hub' || enterprise.issuer !== input.source.appOrigin || enterprise.clientId !== input.source.clientId))
          fail(400,'invalid_registration_source','企业邀请与注册应用不匹配。');
        // Auth alone supplies this verified proof, via its signed backchannel.
        // One minimal MX account per invitation; no tenant/network grants here.
        if (typeof enterprise.issuer !== 'string' || !enterprise.issuer.startsWith('https://') || new URL(enterprise.issuer).origin !== enterprise.issuer
          || typeof enterprise.clientId !== 'string' || !enterprise.clientId || !/^[a-f0-9-]{36}$/i.test(enterprise.invitationId)
          || !Number.isFinite(Date.parse(enterprise.expiresAt)) || Date.parse(enterprise.expiresAt) <= Date.now()
          || Date.parse(enterprise.expiresAt) > Date.now()+31*86400000) fail(400,'invitation_unavailable','企业邀请已失效。');
        enterpriseKey = hash(JSON.stringify([enterprise.issuer,enterprise.clientId,enterprise.invitationId]));
        const used = await this.read<{userId:string}>(manager,'registration-enterprise-redemption',enterpriseKey);
        if (used) {
          const user = await this.read<UserCenterUser>(manager,'iam-user',used.userId);
          const stored = await this.read<UserCenterUserCredential>(manager,'iam-user-credential',used.userId);
          if (!user || user.status!=='active' || user.account!==account || !stored || !verifyUserCenterCredential(input.password,stored)
            || (input.verifiedFeishuSubject && user.profile.externalIds.feishuSubject!==input.verifiedFeishuSubject)) fail(409,'registration_conflict','此邀请已注册账号，请使用原账号登录。');
          return {userId:used.userId};
        }
      }
      let invitation: Invitation | undefined;
      if (policy.mode === 'invite_code' && !enterprise) {
        const codeHash = hash(typeof input.inviteCode === 'string' ? input.inviteCode.trim() : '');
        const rows = await manager.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='registration-invite' AND data->>'codeHash'=$2", [this.environment, codeHash]);
        invitation = rows[0]?.data;
        if (!invitation || (input.source?.appId === 'mx-harbor' ? invitation.admissionAppId !== 'mx-harbor' : Boolean(invitation.admissionAppId)) || invitation.clientId !== input.clientId || invitation.revoked || invitation.uses >= invitation.maxUses
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
      const allowedAppIds = (invitation?.appGrant?.appIds ?? []).filter(id => id !== 'mx-harbor' || invitation?.admissionAppId === 'mx-harbor');
      const user = createUserCenterUser({ userId, account, displayName: account, roleIds: ['mx-user'], registeredByAppId: 'mx-identity', allowedAppIds,
        ...(['mx-insight-hub','mx-harbor'].includes(input.source?.appId ?? '') ? { deniedAppIds: ['mx-h2i','luopan'] } : {}),
        ...(input.verifiedFeishuSubject ? { externalIds: { feishuSubject: input.verifiedFeishuSubject } } : {}) }, null, userCredentialSummary(credential));
      if (input.source) user.registration = { source: input.source, method: input.verifiedFeishuSubject ? 'feishu' : 'password', policyVersion: policy.version, registeredAt: user.createdAt };
      await this.write(manager, 'iam-user', userId, user);
      await this.write(manager, 'iam-user-credential', userId, credential);
      if (invitation) await this.write(manager, 'registration-invite', invitation.id, { ...invitation, uses: invitation.uses + 1 });
      await this.write(manager, 'registration-redemption', transactionId, { userId, clientId: input.clientId, policyVersion: policy.version, invitationId: invitation?.id ?? null, ...(user.registration ? {registration:user.registration} : {}), createdAt: new Date().toISOString() });
      if (enterpriseKey) await this.write(manager,'registration-enterprise-redemption',enterpriseKey,{userId,issuer:enterprise!.issuer,clientId:enterprise!.clientId,invitationId:enterprise!.invitationId,createdAt:new Date().toISOString()});
      await this.audit(manager, 'identity.account.registered', { clientId: input.clientId, policyVersion: policy.version, invitationId: invitation?.id ?? null, allowedAppIds,
        ...(user.registration ? {registration:user.registration,defaultDeniedAppIds:user.appAccess.deniedAppIds} : {}),
        ...(enterprise ? { enterpriseInvitation: { issuer: enterprise.issuer, clientId: enterprise.clientId, invitationId: enterprise.invitationId } } : {}) }, userId);
      return { userId };
    });
  }
}
