import { USER_SESSION_TTL_SECONDS } from '../lib/session-lifetime.js';
import { passwordSessionActive } from '../lib/web-session-security.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlatformStore } from '../store/platform-store.js';
import { resolveUserCenterUserForLogin } from '../store/domain.js';
import { authenticationRateLimitBucketKey } from '../lib/auth-rate-limit.js';
import { internalAdminContext } from '../lib/internal-admin-context.js';
import type { AdminSsoConfig } from './config.js';
import type { AdminOidcClient, LoginTransaction, OidcIdentity } from './oidc.js';
import { bindingKey, digest, type SsoRepository, type SsoRecord } from './repository.js';

const SESSION_COOKIE = '__Host-mx-admin-session';
const TRANSACTION_COOKIE = '__Host-mx-admin-login';
const FIVE_MINUTES = 300_000;
const SESSION_LIFETIME = USER_SESSION_TTL_SECONDS * 1000;
// Historical bootstrap identities have shipped preset credentials. Preserve
// their legacy behavior, but never turn them into personal console principals.
const BOOTSTRAP_USERS = new Set(['usr_demo_admin', 'usr_demo_user']);
interface Request extends IncomingMessage { body?: Record<string, unknown>; ip?: string }
interface Session extends SsoRecord, OidcIdentity {
  csrf: string;
  expiresAt: string;
  bindingId: string | null;
  scope: string;
  opsTokenHash?: string;
}
class SsoError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const unauthorized = () => new SsoError(401, 'session_required', '请重新登录个人账号。');
const random = () => randomBytes(32).toString('base64url');
function cookie(req: Request, name: string): string {
  const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return '';
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
function setCookie(res: ServerResponse, name: string, value: string, seconds: number): void {
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous.map(String) : previous ? [String(previous)] : []),
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`]);
}
function same(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 303; res.setHeader('Location', location); res.end();
}

export function createAdminSsoMiddleware(deps: {
  config: AdminSsoConfig | null;
  unavailable?: boolean;
  repository?: SsoRepository;
  oidc?: AdminOidcClient;
  store: PlatformStore;
}) {
  const { config, store, repository, oidc } = deps;
  const scope = config ? digest(JSON.stringify([config.issuer, config.clientId, config.origin])) : '';
  async function rateLimit(req: Request, purpose: string, subject?: string) {
    const decisions = await store.consumeAuthenticationRateLimits([
      { bucketKey: authenticationRateLimitBucketKey(`admin-sso.${purpose}.ip`, (config?.ingressToken ? String(req.headers['x-mx-client-ip'] ?? 'unknown') : req.ip ?? req.socket.remoteAddress ?? 'unknown')), limit: 30, windowSeconds: 300 },
      ...(subject ? [{ bucketKey: authenticationRateLimitBucketKey(`admin-sso.${purpose}.subject`, subject), limit: 5, windowSeconds: 300 }] : [])
    ]);
    if (decisions.some((decision) => !decision.allowed)) throw new SsoError(429, 'rate_limited', '尝试过于频繁，请 5 分钟后重试。');
  }
  function assertCsrf(req: Request, session: Session) {
    const origin = req.headers.origin;
    const csrf = req.headers['x-mx-admin-csrf'];
    if (!config || (origin && origin !== config.origin)
      || (!['GET', 'HEAD'].includes(req.method ?? '') && origin !== config.origin)
      || req.headers['sec-fetch-site'] === 'cross-site'
      || typeof csrf !== 'string' || !same(csrf, session.csrf)) {
      throw new SsoError(403, 'csrf_rejected', '请求来源或会话验证失败，请刷新页面。');
    }
  }
  function assertRecent(session: Session) {
    if (Date.now() / 1000 - session.authTime > 300 || session.authTime > Date.now() / 1000 + 30) {
      throw new SsoError(401, 'reauth_required', '此操作需要最近 5 分钟内验证身份，请点击“重新验证”。');
    }
  }
  async function sessionFor(req: Request): Promise<Session | null> {
    const token = cookie(req, SESSION_COOKIE);
    if (!token || !repository) return null;
    const session = await repository.touchSession(digest(token)) as Session | null;
    if (!session || session.scope !== scope || Date.parse(session.expiresAt) <= Date.now()) return null;
    if (session.opsTokenHash && !same(session.opsTokenHash, digest(process.env.MX_INTERNAL_OPS_TOKEN?.trim() ?? ''))) return null;
    return session;
  }
  async function userFor(session: Session) {
    if (!session.bindingId || !repository) return null;
    const binding = await repository.read('admin-sso-binding', bindingKey(session.issuer, session.subject));
    if (!binding || binding.bindingId !== session.bindingId) return null;
    const user = (await store.listUserCenterUsers()).find((item) => item.userId === binding.userId);
    if (!user || user.status !== 'active' || BOOTSTRAP_USERS.has(user.userId) || user.appAccess.deniedAppIds.includes('mx-launcher') || !passwordSessionActive(user, session.authTime)) return null;
    if (config?.localSubjects && repository.webSessionActive && !await repository.webSessionActive(user.userId, session)) return null;
    return user;
  }
  async function issueSession(req: Request, res: ServerResponse, identity: OidcIdentity, bindingId: string | null) {
    const token = random();
    const lifetime = bindingId ? SESSION_LIFETIME : FIVE_MINUTES;
    const session: Session = { ...identity, scope, bindingId, csrf: random(), expiresAt: new Date(Date.now() + lifetime).toISOString() };
    if (!await repository!.insert('admin-sso-session', digest(token), session)) throw new Error('Session collision');
    const previous = cookie(req, SESSION_COOKIE);
    if (previous) await repository!.remove('admin-sso-session', digest(previous));
    setCookie(res, SESSION_COOKIE, token, lifetime / 1000);
  }
  async function handle(req: Request, res: ServerResponse, next: () => void) {
    const path = (req.url ?? '').split('?')[0];
    const authPath = path.startsWith('/auth/admin/');
    const bffPath = path.startsWith('/admin-api/');
    if (!authPath && !bffPath) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === '/auth/admin/session' && req.method === 'GET' && !config) {
      return json(res, 200, { enabled: false, authenticated: false, unavailable: Boolean(deps.unavailable) });
    }
    if (!config || !repository || !oidc) throw new SsoError(503, 'sso_unavailable', '个人 SSO 登录尚未启用，现有应急访问仍可使用。');
    if (config.ingressToken && !same(String(req.headers['x-mx-identity-gateway'] ?? ''), config.ingressToken)) throw new SsoError(403, 'gateway_required', '请从配置的公网管理入口访问。');
    if (req.headers.origin && req.headers.origin !== config.origin) throw new SsoError(403, 'origin_rejected', '请从配置的管理入口访问。');
    if (path === '/auth/admin/ops-login' && req.method === 'POST') {
      if (req.headers.origin !== config.origin || req.headers['sec-fetch-site'] === 'cross-site') throw new SsoError(403, 'origin_rejected', '请从管理入口验证 Token。');
      await rateLimit(req, 'ops-login');
      const supplied = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      const expected = process.env.MX_INTERNAL_OPS_TOKEN?.trim();
      if (!expected || !supplied || supplied.length > 4096 || !same(supplied, expected)) throw new SsoError(401, 'invalid_ops_token', 'Internal Ops Token 不正确或尚未配置。');
      const token = random();
      if (!await repository.insert('admin-sso-session', digest(token), {
        scope, issuer: config.issuer, subject: 'internal-ops', bindingId: null,
        csrf: random(), authTime: Date.now() / 1000, opsTokenHash: digest(expected),
        expiresAt: new Date(Date.now() + SESSION_LIFETIME).toISOString()
      })) throw new Error('Session collision');
      const previous = cookie(req, SESSION_COOKIE);
      if (previous) await repository.remove('admin-sso-session', digest(previous));
      setCookie(res, SESSION_COOKIE, token, USER_SESSION_TTL_SECONDS);
      return json(res, 200, { ok: true });
    }
    if (path === '/auth/admin/login' && req.method === 'GET') {
      await rateLimit(req, 'login');
      const existing = await sessionFor(req);
      const currentUser = existing ? await userFor(existing) : null;
      const switching = new URL(req.url!, config.origin).searchParams.get('switch') === '1';
      const selecting = new URL(req.url!, config.origin).searchParams.get('select') === '1';
      const transaction: LoginTransaction = {
        state: random(), nonce: random(), verifier: random(), scope,
        expiresAt: new Date(Date.now() + FIVE_MINUTES).toISOString(),
        // Reauthentication cannot silently switch the administrator/account.
        expectedUserId: switching || selecting ? null : currentUser?.userId ?? null,
        reauthenticate: switching || (Boolean(existing) && !selecting),
        selectAccount: selecting
      };
      const url = await oidc.authorize(transaction);
      const token = random();
      const previous = cookie(req, TRANSACTION_COOKIE);
      if (previous) await repository.remove('admin-sso-transaction', digest(previous));
      await repository.insert('admin-sso-transaction', digest(token), transaction);
      setCookie(res, TRANSACTION_COOKIE, token, 300);
      return redirect(res, url.href);
    }
    if (path === '/auth/admin/callback' && req.method === 'GET') {
      setCookie(res, TRANSACTION_COOKIE, '', 0);
      try {
        const token = cookie(req, TRANSACTION_COOKIE);
        const transaction = token ? await repository.take('admin-sso-transaction', digest(token)) as LoginTransaction | null : null;
        if (!transaction || transaction.scope !== scope || Date.parse(transaction.expiresAt) <= Date.now()) throw unauthorized();
        const callback = new URL(config.callbackUrl);
        callback.search = new URL(req.url!, config.origin).search;
        const identity = await oidc.redeem(callback, transaction);
        const identityKey = bindingKey(identity.issuer, identity.subject);
        let binding = await repository.read('admin-sso-binding', identityKey);
        if (!binding && config.localSubjects) {
          // Only the explicitly managed issuer emits the existing immutable MX
          // userId as sub. External IdPs still require proven account linking.
          const user = (await store.listUserCenterUsers()).find(item => item.userId === identity.subject);
          if (!user || user.status !== 'active' || BOOTSTRAP_USERS.has(user.userId)) throw unauthorized();
          await repository.insert('admin-sso-binding', identityKey, {
            issuer: identity.issuer, subject: identity.subject, userId: user.userId,
            bindingId: randomUUID(), createdAt: new Date().toISOString(), source: 'managed-identity'
          });
          binding = await repository.read('admin-sso-binding', identityKey);
          if (binding?.userId !== user.userId) throw unauthorized();
        }
        if (config.localSubjects && binding?.userId !== identity.subject) throw unauthorized();
        if (transaction.expectedUserId && transaction.expectedUserId !== binding?.userId) throw unauthorized();
        if (binding) {
          const user = (await store.listUserCenterUsers()).find((item) => item.userId === binding.userId);
          if (!user || user.status !== 'active' || BOOTSTRAP_USERS.has(user.userId)) throw unauthorized();
        }
        await store.recordAudit({ eventType: 'admin.sso.login', actorKind: 'user', userId: binding?.userId as string ?? null,
          metadata: { issuer: identity.issuer, bindingRequired: !binding } });
        await issueSession(req, res, identity, binding?.bindingId as string ?? null);
        return redirect(res, '/admin/');
      } catch {
        // Never echo provider errors, codes, secrets, or token payloads.
        console.warn(JSON.stringify({ event: 'admin.sso.callback-rejected' }));
        return redirect(res, '/admin/?sso_error=login_failed');
      }
    }
    const session = await sessionFor(req);
    if (path === '/auth/admin/session' && req.method === 'GET') {
      const entry = { enabled: true, loginOrigin: config.origin, accessMode: config.ingressToken ? 'sso-only' : 'sso-or-ops',
        ...(config.localSubjects ? { securityUrl: `${config.issuer}/sessions` } : {}) };
      if (!session) return json(res, 200, { ...entry, authenticated: false });
      if (session.opsTokenHash) return json(res, 200, { ...entry, authenticated: true, csrf: session.csrf,
        authMethod: 'ops-token', canManage: true, user: { userId: null, displayName: 'Internal Ops Token' } });
      if (!session.bindingId) return json(res, 200, { ...entry, authenticated: true, bindingRequired: true, csrf: session.csrf });
      const user = await userFor(session);
      if (!user) {
        await repository.remove('admin-sso-session', digest(cookie(req, SESSION_COOKIE)));
        setCookie(res, SESSION_COOKIE, '', 0);
        return json(res, 200, { ...entry, authenticated: false });
      }
      return json(res, 200, { ...entry, authenticated: true, csrf: session.csrf,
        user: { userId: user.userId, displayName: user.displayName }, canManage: user.roleIds.includes('mx-admin'),
        needsReauthentication: Date.now() / 1000 - session.authTime > 300 });
    }
    if (!session) throw unauthorized();
    assertCsrf(req, session);
    if (path === '/auth/admin/logout' && req.method === 'POST') {
      await repository.remove('admin-sso-session', digest(cookie(req, SESSION_COOKIE)));
      const transaction = cookie(req, TRANSACTION_COOKIE);
      if (transaction) await repository.remove('admin-sso-transaction', digest(transaction));
      setCookie(res, SESSION_COOKIE, '', 0);
      setCookie(res, TRANSACTION_COOKIE, '', 0);
      return json(res, 200, { ok: true });
    }
    if (path === '/auth/admin/link' && req.method === 'POST') {
      assertRecent(session);
      if (session.bindingId || session.opsTokenHash) throw new SsoError(409, 'already_bound', '当前统一身份已绑定账号。');
      const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!login || login.length > 255 || !password || password.length > 1024) throw new SsoError(400, 'invalid_credentials', '请填写已有 MX 账号和密码。');
      const user = resolveUserCenterUserForLogin(await store.listUserCenterUsers(), login);
      await rateLimit(req, 'link', user?.userId ?? login);
      await rateLimit(req, 'link-identity', bindingKey(session.issuer, session.subject));
      if (!user || user.status !== 'active' || BOOTSTRAP_USERS.has(user.userId)
        || !(await store.verifyUserCenterPassword({ userId: user.userId, password, requestId: randomUUID() })).ok) {
        throw new SsoError(401, 'invalid_credentials', '账号或密码不正确，或账号不可用。');
      }
      const bindingId = randomUUID();
      const created = await repository.insert('admin-sso-binding', bindingKey(session.issuer, session.subject), {
        issuer: session.issuer, subject: session.subject, userId: user.userId, bindingId, createdAt: new Date().toISOString()
      });
      if (!created) throw new SsoError(409, 'binding_conflict', '此统一身份已绑定，请重新登录。');
      await store.recordAudit({ eventType: 'admin.sso.account-linked', actorKind: 'user', userId: user.userId,
        metadata: { issuer: session.issuer, bindingId } });
      await issueSession(req, res, session, bindingId);
      return json(res, 200, { ok: true });
    }
    if (bffPath && /^\/admin-api\/internal\/v1\//.test(path)) {
      if (session.opsTokenHash) {
        // The cookie contains only an opaque session id. Use the current server
        // credential after checking its fingerprint, so rotation revokes it.
        if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method ?? '')) throw new SsoError(405, 'method_not_allowed', '不支持此操作。');
        req.headers['x-mx-ops-token'] = process.env.MX_INTERNAL_OPS_TOKEN!.trim();
        req.url = req.url!.slice('/admin-api'.length);
        return next();
      }
      const user = await userFor(session);
      if (!user) throw unauthorized();
      if (!user.roleIds.includes('mx-admin')) throw new SsoError(403, 'management_forbidden', '已登录；此账号尚未获得 Launcher 管理权限。');
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method ?? '')) throw new SsoError(405, 'method_not_allowed', '不支持此操作。');
      if (!['GET', 'HEAD'].includes(req.method!)) assertRecent(session);
      const requestId = randomUUID();
      const apiPath = path.slice('/admin-api'.length);
      await store.recordAudit({ eventType: 'admin.sso.request', actorKind: 'user', userId: user.userId, requestId,
        metadata: { method: req.method, path: apiPath } });
      res.setHeader('X-Request-Id', requestId);
      res.once('finish', () => {
        void Promise.resolve().then(() => store.recordAudit({ eventType: 'admin.sso.response', actorKind: 'user', userId: user.userId, requestId,
          metadata: { method: req.method, path: apiPath, status: res.statusCode } })).catch(() => {
          console.warn(JSON.stringify({ event: 'admin.sso.audit-unavailable', requestId }));
        });
      });
      delete req.headers['x-mx-ops-token'];
      req.headers['x-request-id'] = requestId;
      req.url = req.url!.slice('/admin-api'.length);
      return internalAdminContext.run({ userId: user.userId, requestId }, next);
    }
    throw new SsoError(404, 'not_found', '操作不存在。');
  }
  return (req: Request, res: ServerResponse, next: () => void): void => {
    void handle(req, res, next).catch((error: unknown) => {
      if (res.writableEnded) return;
      if (error instanceof SsoError) json(res, error.status, { code: error.code, message: error.message });
      else json(res, 503, { code: 'sso_unavailable', message: '个人登录暂不可用，请稍后重试；应急访问入口仍保留。' });
    });
  };
}
