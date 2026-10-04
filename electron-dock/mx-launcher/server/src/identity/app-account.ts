import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Provider from 'oidc-provider';
import type { IdentitySettings } from './provider.js';
import type { IdentityAccounts } from './repository.js';
import { RegistrationClientError, type RegistrationClient } from '../registration/backchannel.js';
import { resolveHubInvitation } from './hub-invitation.js';

const fail = (status: number, message: string): never => { throw new RegistrationClientError(status, message); };
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const random = () => randomBytes(32).toString('base64url');

/** First-party application UI transport. OIDC cookies and completion stay in the browser on the issuer. */
export function createAppAccount(provider: Provider, settings: IdentitySettings, accounts: IdentityAccounts, registration?: RegistrationClient) {
  const apps = new Map((settings.applications ?? []).map(app => [app.clientId, app]));
  const state = accounts.webState;
  const allowed = async (id: string, appId: string) => {
    const user = await accounts.account(id);
    if (!user || user.status !== 'active' || user.appAccess?.deniedAppIds?.includes(appId)) fail(403, '此账号不可用或没有该应用的访问权限。');
    return user!;
  };
  return {
    async begin(uid: string, clientId: string, oidcState: string, error?: string, loginHint?: string) {
      if (!state || !apps.has(clientId)) return null;
      // A new handle invalidates older tabs for this interaction. Passwords never enter this store.
      const handle = random();
      await state.put('app-flow', handle, { uid, clientId, loginHint });
      await state.put('app-completion-lock', handle, {});
      await state.put('app-active', uid, { handle });
      return `${apps.get(clientId)!.origin}/auth/sso/interaction?flow=${handle}&state=${encodeURIComponent(oidcState)}${error === 'feishu' ? '&error=feishu' : ''}`;
    },
    async completion(uid: string, handle: string) {
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(handle)) fail(400, '登录请求已失效。');
      const flow = await state!.read('app-flow', handle);
      const active = await state!.read('app-active', uid);
      if (!flow || flow.uid !== uid || active?.handle !== handle) fail(400, '登录页面已变化，请重新登录。');
      const result = await state!.read('app-result', handle, true);
      if (!result || result.handle !== handle) fail(409, '登录请求已完成或已失效。');
      if (result!.userId) await allowed(String(result!.userId), apps.get(String(flow!.clientId))!.appId);
      return result!;
    },
    async handle(req: IncomingMessage, res: ServerResponse) {
      const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); };
      try {
        if (req.method !== 'POST' || req.headers.origin || !state || !req.headers['content-type']?.startsWith('application/json')) fail(403, '请从应用重新发起操作。');
        const credentials = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        const colon = credentials.indexOf(':'), clientId = credentials.slice(0, colon), app = apps.get(clientId);
        if (!app || colon < 1 || !same(credentials.slice(colon + 1), app.clientSecret)) fail(401, '应用认证失败。');
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) fail(413, '请求过大。'); }
        const { action, input = {} } = JSON.parse(raw);
        if (typeof action !== 'string' || !input || typeof input !== 'object') fail(400, '请求无效。');
        if (['account', 'profile', 'password', 'unlink-feishu', 'sessions', 'revoke'].includes(action)) {
          const token = typeof input.accessToken === 'string' ? await provider.AccessToken.find(input.accessToken) : undefined;
          if (!token || token.clientId !== clientId || !token.accountId) fail(401, '登录已过期，请重新登录。');
          const user = await allowed(token!.accountId!, app!.appId);
          if (action === 'account') return json(200, { account: user.account, displayName: user.displayName, feishuLinked: Boolean(user.profile.externalIds.feishuSubject) });
          if (action === 'sessions') return json(200, { sessions: await accounts.browserSessions?.(user.userId, token!.sessionUid ?? '') ?? [] });
          // Reconfirm the same account, not a caller-supplied user ID or a platform-admin credential.
          if (!await accounts.allowAttempt(`account:${clientId}:${String(input.clientIp ?? '').slice(0, 100)}`, `account:${user.userId}`)) fail(429, '验证过于频繁，请稍后重试。');
          const verified = await accounts.authenticate(user.account, typeof input.currentPassword === 'string' ? input.currentPassword : '');
          if (verified?.userId !== user.userId) fail(401, '当前密码不正确，请重新验证。');
          if (action === 'revoke') {
            if (!accounts.browserSessions || !accounts.revokeBrowserSessions) fail(503, '会话管理暂不可用。');
            if (input.target !== 'all' && !/^[a-f0-9]{64}$/.test(String(input.target))) fail(400, '登录设备无效。');
            const devices = await accounts.browserSessions?.(user.userId, token!.sessionUid ?? '') ?? [];
            const signedOut = input.target === 'all' || devices.some(device => device.id === input.target && device.current);
            await accounts.revokeBrowserSessions?.(user.userId, input.target, random());
            return json(200, { ok: true, signedOut });
          }
          if (!registration?.account) fail(503, '账号服务需要更新，请稍后重试。');
          const result = await registration!.account!(action, { userId: user.userId, currentPassword: input.currentPassword,
            ...(action === 'profile' ? { displayName: input.displayName } : action === 'password' ? { password: input.password } : {}) });
          return json(200, result);
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(String(input.flow))) fail(400, '登录请求无效，请重新开始。');
        const flow = await state!.read('app-flow', input.flow);
        const active = flow ? await state!.read('app-active', String(flow.uid)) : undefined;
        if (!flow || flow.clientId !== clientId || active?.handle !== input.flow) fail(410, '登录已超时，请重新开始。');
        const interaction = await provider.Interaction.find(String(flow!.uid));
        if (!interaction || interaction.params.client_id !== clientId || interaction.params.mx_surface !== 'application') fail(410, '登录已超时，请重新开始。');
        const uid = String(flow!.uid), source = { issuer: settings.issuer, clientId, appId: app!.appId, appOrigin: app!.origin };
        const proof = await state!.read('proof', uid);
        const invitationHandle = typeof interaction!.params.mx_invitation === 'string' ? interaction!.params.mx_invitation : '';
        const enterpriseProof = async () => invitationHandle ? resolveHubInvitation(app!, settings.issuer, invitationHandle) : undefined;
        if (action === 'options') {
          const [policy, feishu] = await Promise.allSettled([registration?.policy(source), registration?.feishu?.('info', {})]);
          let enterprise = false, invitationError = '';
          if (invitationHandle) { try { enterprise = Boolean(await enterpriseProof()); } catch { invitationError = '邀请已失效，请返回原邀请链接重新开始。'; } }
          return json(200, { policy: policy.status === 'fulfilled' ? policy.value : null,
            feishu: feishu.status === 'fulfilled' && feishu.value?.enabled === true, pending: Boolean(proof), enterprise, invitationError, loginHint: flow!.loginHint ?? '' });
        }
        if (!['login', 'register', 'feishu', 'feishu-link'].includes(action)) fail(400, '不支持的账号操作。');
        const completed = await state!.read('app-result', input.flow);
        if (completed) fail(409, '登录请求已提交，请重新开始。');
        const returnUrl = `${settings.origin}/identity/interaction/${uid}?app_complete=${input.flow}`;
        if (action === 'feishu' || action === 'feishu-link') {
          // Issuer browser visit sets the Feishu state cookie; the application cannot set it.
          if (!await state!.read('app-completion-lock', input.flow, true)) fail(409, '登录请求已提交。');
          await state!.put('app-result', input.flow, { handle: input.flow, intent: action });
          return json(200, { redirect: returnUrl });
        }
        const login = typeof input.login === 'string' ? input.login.trim() : '', password = typeof input.password === 'string' ? input.password : '';
        if (!login || login.length > 255 || !password || password.length > 1024) fail(400, '请填写账号和密码。');
        const ip = `app:${clientId}:${String(input.clientIp ?? '').slice(0, 100)}`;
        const authTime = Date.now() / 1000;
        let userId: string;
        if (input.expectedSubject) {
          if (action !== 'login') fail(409, '请使用原账号完成绑定。');
          if (!await accounts.allowAttempt(`binding:${ip}`, `binding:${login}`)) fail(429, '验证过于频繁，请稍后重试。');
          const expected = await accounts.authenticate(login, password);
          if (expected?.userId !== input.expectedSubject) fail(409, '请使用原账号完成绑定。');
        }
        if (action === 'register') {
          if (!registration || !accounts.allowRegistrationAttempt || !await accounts.allowRegistrationAttempt(ip, login)) fail(429, '暂时无法注册，请稍后重试。');
          const policy = await registration!.policy(source);
          if (policy.mode === 'closed') fail(403, '暂未开放注册，已有账号可以登录。');
          if (password !== input.passwordConfirm) fail(400, '两次输入的密码不一致。');
          const enterprise = await enterpriseProof();
          const result = await registration!.register({ transactionId: uid, source, policyVersion: Number(input.policyVersion), account: login, password,
            inviteCode: typeof input.inviteCode === 'string' ? input.inviteCode : '', ...(enterprise ? { enterpriseInvitation: enterprise } : {}),
            ...(proof ? { verifiedFeishuSubject: String(proof.subject) } : {}) });
          userId = result.userId;
        } else {
          if (!await accounts.allowAttempt(ip, login)) fail(429, '尝试过于频繁，请稍后重试。');
          if (proof && registration?.feishu) {
            const result = await registration.feishu('bind', { subject: proof.subject, login, password }); userId = String(result.userId);
          } else {
            const user = await accounts.authenticate(login, password);
            if (!user) fail(401, '账号或密码不正确，或账号不可用。');
            userId = user!.userId;
          }
        }
        await allowed(userId, app!.appId);
        if (!await state!.read('app-completion-lock', input.flow, true)) fail(409, '登录请求已提交，请重新开始。');
        await state!.put('app-result', input.flow, { handle: input.flow, userId, authTime });
        await state!.remove('proof', uid);
        json(200, { redirect: returnUrl });
      } catch (error) {
        json(error instanceof RegistrationClientError ? error.status : 503, { code: 'account_request_failed', message: error instanceof RegistrationClientError ? error.message : '账号服务暂不可用，请稍后重试。' });
      }
    }
  };
}
