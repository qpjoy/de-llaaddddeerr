import { USER_SESSION_TTL_SECONDS } from '../lib/session-lifetime.js';
import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, { type Configuration } from 'oidc-provider';
import type { IdentityAccounts } from './repository.js';
import { createAppAccount } from './app-account.js';
import { sessionsPage } from './sessions-page.js';
import { resolveHubInvitation } from './hub-invitation.js';
import { RegistrationClientError, type RegistrationClient } from '../registration/backchannel.js';
import type { RegistrationPolicy, RegistrationSource } from '../registration/repository.js';

export interface IdentitySettings {
  issuer: string;
  adminOrigin?: string;
  transportOrigin?: string;
  ingressToken?: string;
  publicEntry?: IdentitySettings;
  origin: string;
  clientId: string;
  clientSecret: string;
  cookieKeys: string[];
  jwks: NonNullable<Configuration['jwks']>;
  applications?: Array<{ clientId: string; clientSecret: string; origin: string; appId: string; audience: string }>;
}
const sourceIp = (req: IncomingMessage, settings: IdentitySettings) => settings.adminOrigin ? String(req.headers['x-mx-client-ip'] ?? req.socket.remoteAddress ?? 'unknown') : req.socket.remoteAddress ?? 'unknown';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function page(action: string, csrf: string, message = '', policy?: RegistrationPolicy, registering = false, web: { enabled?: boolean; pending?: boolean; appName?: string; returnUrl?: string; enterprise?: boolean } = {}) {
  const registrationAllowed = policy && policy.mode !== 'closed';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${registering ? '注册' : '登录'} · MX</title>
  <style>
  :root{color-scheme:dark;--bg:#141417;--panel:#21232d;--input:#252936;--line:#3c4658;--text:#e2e2e2;--muted:#a7b3bf;--accent:#2bf6d2;--on-accent:#052823}
  *{box-sizing:border-box}
  body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  main{width:100%;max-width:460px;min-width:0;padding:32px;background:var(--panel);border:1px solid var(--line);border-radius:16px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.02em}
  .mark{display:grid;place-items:center;width:36px;height:36px;background:#2bf6d2;color:#062a25;border-radius:10px;font-size:15px;font-weight:800}
  h1{font-size:24px;line-height:1.3;letter-spacing:-.02em;margin:20px 0 8px}
  .intro{color:var(--muted);margin:0 0 24px}
  form{display:grid;gap:16px}
  .field{min-width:0}
  label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
  input,button{width:100%;min-width:0;min-height:44px;border-radius:8px;font:inherit}
  input{padding:9px 12px;background:var(--input);border:1px solid var(--line);color:var(--text);font-size:16px;line-height:24px}
  input:hover{border-color:#647386}
  input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #2bf6d2;outline-offset:3px}
  .hint{display:block;font-size:12px;color:var(--muted);margin-top:6px}
  button{margin-top:4px;padding:10px 16px;border:0;background:var(--accent);color:var(--on-accent);font-weight:600;cursor:pointer}
  button:hover{background:#11cdb5}
  button.secondary{background:var(--input);border:1px solid var(--line);color:var(--text)}
  button.secondary:hover{border-color:var(--accent)}
  button.link-button{margin:0;padding:4px;background:transparent;color:var(--accent);font-size:13px;font-weight:400;min-height:32px}
  button.link-button:hover{text-decoration:underline}
  .message{color:#ffb7a7;background:#33242a;border:1px solid #734049;border-radius:8px;padding:10px 12px;margin:0 0 20px;overflow-wrap:anywhere}
  .alternate{margin:20px 0 0;text-align:center}
  footer{display:grid;gap:6px;border-top:1px solid var(--line);padding-top:16px;margin-top:20px;font-size:12px;color:var(--muted);text-align:center}
  a{color:var(--accent);text-decoration:none;text-underline-offset:3px}
  a:hover{text-decoration:underline}
  details{margin-top:8px;text-align:center}summary{cursor:pointer;color:var(--muted);font-size:13px}
  @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3f7fa;--panel:#f8fbfd;--input:#edf3f6;--line:#c7d8df;--text:#192b3a;--muted:#657584;--accent:#008d82;--on-accent:#fff}.message{color:#8e293b;background:#fbecef;border-color:#e9bcc4}.mark{background:var(--accent);color:#fff}}
  @media(max-width:480px){body{padding:16px}main{padding:22px}h1{font-size:22px}}
  @media(max-height:700px){body{align-items:start}}
  </style></head><body>
  <main aria-labelledby="page-title">
  <div class="brand"><span class="mark" aria-hidden="true">MX</span><span>MX 统一账号</span></div>
  <h1 id="page-title">${registering ? '创建 MX 账号' : web.pending ? '绑定你的 MX 账号' : '登录 MX 账号'}</h1>
  <p class="intro">${web.enterprise ? '此邀请已包含注册资格。使用已有 MX 账号登录，或创建账号后返回 Hub 确认加入企业。' : registering ? '使用统一账号访问已开通的应用。工作台管理权限需单独授权。' : web.pending ? '飞书身份已验证。验证已有 MX 账号完成绑定，或使用邀请码创建账号。' : `使用已有 MX 账号，继续进入 ${escape(web.appName ?? 'Launcher')}。`}</p>
  ${message ? `<div class="message" role="alert">${escape(message)}</div>` : ''}
  <form method="post" action="${escape(action)}${registering ? '?view=register' : ''}">
    <input type="hidden" name="csrf" value="${csrf}">
    ${registering ? `<input type="hidden" name="policyVersion" value="${policy?.version}">` : ''}
    <div class="field">
      <label for="login">账号</label>
      <input id="login" name="login" autocomplete="username" maxlength="255" ${registering ? 'aria-describedby="account-hint"' : ''} required autofocus>
      ${registering ? '<small class="hint" id="account-hint">以字母开头，3–64 位，可用数字、点、下划线和短横线。</small>' : ''}
    </div>
    <div class="field">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" ${registering ? 'minlength="8" maxlength="128" aria-describedby="password-hint"' : 'maxlength="1024"'} required>
      ${registering ? '<small class="hint" id="password-hint">8–128 位，建议组合字母、数字或符号。</small>' : ''}
    </div>
    ${registering ? `<div class="field">
      <label for="passwordConfirm">确认密码</label>
      <input id="passwordConfirm" name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
    </div>${policy?.mode === 'invite_code' && !web.enterprise ? `<div class="field">
      <label for="inviteCode">邀请码</label>
      <input id="inviteCode" name="inviteCode" autocomplete="off" maxlength="128" required>
    </div>` : ''}` : ''}
    <button type="submit">${registering ? (web.pending ? '注册并绑定飞书' : '注册并继续') : (web.pending ? '验证账号并绑定' : '登录并继续')}</button>
    ${web.enabled && !web.pending && !registering ? '<button class="secondary" type="submit" name="intent" value="feishu" formnovalidate>使用飞书登录</button><details><summary>绑定已有账号</summary><button class="link-button" type="submit" name="intent" value="feishu-link" formnovalidate>绑定飞书到已有 MX 账号</button></details>' : ''}
  </form>
  <p class="alternate">${registering ? `<a href="${escape(action)}">已有账号，返回登录</a>` : registrationAllowed ? `<a href="${escape(action)}?view=register">${web.enterprise ? '通过企业邀请创建账号' : policy.mode === 'invite_code' ? '使用邀请码注册' : '创建账号'}</a>` : '新账号注册暂未开放'}</p>
  <footer><span>使用原有账号即可登录，无需重新注册。登录保持 30 天。</span><a href="${escape(web.returnUrl ?? '/admin/')}">返回应用</a></footer>
  </main></body></html>`;
}
export function createIdentityProvider(settings: IdentitySettings, accounts: IdentityAccounts, adapter: Configuration['adapter'], registration?: RegistrationClient) {
  const applications = new Map((settings.applications ?? []).map(app => [app.clientId, app]));
  for (const app of applications.values()) {
    if (app.clientId === settings.clientId || new URL(app.origin).origin !== app.origin || !app.origin.startsWith('https://') || !/^[-a-z0-9]{1,80}$/.test(app.appId) || !app.audience) throw new Error('Invalid first-party identity client');
  }
  // Browsers check form-action through the POST/303 chain, including the
  // final application callback. Use only statically registered client origins,
  // never a request's redirect_uri/Host. OIDC still validates the exact callback.
  const formActionOrigins = new Set([settings.adminOrigin ?? settings.origin, ...[...applications.values()].map(app => app.origin)]
    .map(origin => new URL(origin).origin));
  formActionOrigins.delete(new URL(settings.origin).origin);
  const formAction = ["'self'", ...formActionOrigins].join(' ');
  const allowed = (user: Awaited<ReturnType<IdentityAccounts['account']>>, clientId: string) => user && !user.appAccess?.deniedAppIds?.includes(applications.get(clientId)?.appId ?? 'mx-launcher');
  const provider: Provider = new Provider(settings.issuer, {
    adapter, jwks: settings.jwks,
    clients: [{ client_id: settings.clientId, client_secret: settings.clientSecret,
      redirect_uris: [`${settings.adminOrigin ?? settings.origin}/auth/admin/callback`], response_types: ['code'],
      grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_basic',
      id_token_signed_response_alg: 'RS256' }, ...[...applications.values()].map(app => ({
        client_id: app.clientId, client_secret: app.clientSecret, redirect_uris: [`${app.origin}/auth/sso/callback`],
        response_types: ['code'] as const, grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_basic' as const,
        id_token_signed_response_alg: 'RS256' as const, scope: app.appId === 'mx-insight-hub' ? 'openid mx:hub' : 'openid mx:identity'
      }))],
    responseTypes: ['code'], clientAuthMethods: ['client_secret_basic'],
    extraParams: ['mx_invitation', 'mx_surface'],
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false }, registration: { enabled: false },
      userinfo: { enabled: true }, introspection: { enabled: false }, revocation: { enabled: false } },
    claims: { openid: ['sub', 'mx_session_uid'], 'mx:hub': ['mx_identity'], 'mx:identity': ['mx_identity'] }, scopes: ['openid', 'mx:hub', 'mx:identity'],
    extraTokenClaims: ctx => ({ mx_auth_time: ctx.oidc.authorizationCode?.authTime ?? ctx.oidc.session?.loginTs }),
    cookies: { keys: settings.cookieKeys, names: { session: 'mx_identity', interaction: 'mx_identity_interaction', resume: 'mx_identity_resume' },
      long: { secure: true, httpOnly: true, sameSite: 'lax' }, short: { secure: true, httpOnly: true, sameSite: 'lax' } },
    ttl: { AuthorizationCode: 60, AccessToken: (_ctx, _token, client) => applications.has(client.clientId) ? USER_SESSION_TTL_SECONDS : 300, IdToken: 300, Interaction: 300, Session: USER_SESSION_TTL_SECONDS, Grant: USER_SESSION_TTL_SECONDS },
    interactions: { url: (_ctx, interaction) => `/identity/interaction/${interaction.uid}` },
    findAccount: async (ctx, id) => {
      const user = await accounts.account(id);
      const clientId = ctx.oidc.client?.clientId ?? ctx.oidc.accessToken?.clientId ?? '';
      const app = applications.get(clientId);
      return allowed(user, clientId) && user ? { accountId: user.userId, claims: async () => ({ sub: user.userId,
        mx_session_uid: ctx.oidc.authorizationCode?.sessionUid ?? ctx.oidc.accessToken?.sessionUid ?? ctx.oidc.session?.uid,
        ...(app && accounts.hubIdentity ? { mx_identity: await accounts.hubIdentity(user, app.audience) } : {}) }) } : undefined;
    },
    async loadExistingGrant(ctx) {
      const clientId = ctx.oidc.client?.clientId;
      if (!clientId || (clientId !== settings.clientId && !applications.has(clientId))) return undefined;
      const id = ctx.oidc.result?.consent?.grantId ?? ctx.oidc.session?.grantIdFor(clientId);
      if (id) {
        const grant = await provider.Grant.find(id);
        if (grant) return grant;
      }
      const accountId = ctx.oidc.session?.accountId;
      if (!accountId || !allowed(await accounts.account(accountId), clientId)) return undefined;
      // Only our statically registered first-party client and openid scope.
      const grant = new provider.Grant({ accountId, clientId });
      grant.addOIDCScope(applications.has(clientId) ? (applications.get(clientId)!.appId === 'mx-insight-hub' ? 'openid mx:hub' : 'openid mx:identity') : 'openid');
      await grant.save();
      return grant;
    },
    renderError: async (ctx) => { ctx.type = 'html'; ctx.body = `<!doctype html><meta charset="utf-8"><p>登录请求无效或已过期，请返回工作台重新登录。</p><a href="${escape(settings.adminOrigin ?? settings.origin)}/admin/">返回工作台</a>`; }
  });
  // The public listener is reachable only through the private gateway; HTTPS is terminated at the edge.
  provider.proxy = Boolean(settings.adminOrigin);
  provider.on('server_error', () => console.warn(JSON.stringify({ event: 'identity.request-failed' })));
  const csrfFor = (uid: string) => createHmac('sha256', settings.cookieKeys[0]).update(`login:${uid}`).digest('base64url');
  const appAccount = createAppAccount(provider, settings, accounts, registration);
  const startFeishu = async (req: IncomingMessage, res: ServerResponse, uid: string, link: boolean) => {
    if (!accounts.webState || !registration?.feishu) throw new RegistrationClientError(503, '飞书登录尚未配置。');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const authorization = await registration.feishu('authorize', { state, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), sourceKey: sourceIp(req, settings) });
    await accounts.webState.remove('proof', uid);
    const interaction = await provider.Interaction.find(uid);
    const app = interaction?.params.mx_surface === 'application' ? applications.get(String(interaction.params.client_id)) : undefined;
    await accounts.webState.put('transaction', state, { uid, verifier, exchangeHandle: authorization.exchangeHandle, link, ...(app ? { appReturn: app.origin } : {}) });
    res.setHeader('Set-Cookie', `__Host-mx_feishu=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`);
    res.writeHead(303, { location: String(authorization.authorizationUrl) }).end();
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    Object.assign(req, { originalUrl: req.url, baseUrl: '/identity' });
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    // oidc-provider appends the exact script hash to an explicit script-src
    // for its account-switch form. Without this directive default-src blocks
    // that transition, leaving a blank page when the identity changes.
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
    const path = (req.url ?? '').split('?')[0];
    if (path === '/identity/app-account') return appAccount.handle(req, res);
    if (path === '/identity/sessions' && accounts.browserSessions && accounts.revokeBrowserSessions) {
      const session = await provider.Session.get(provider.app.createContext(req, res));
      const user = session.accountId ? await accounts.account(session.accountId) : undefined;
      const csrf = csrfFor(`sessions:${session.uid}:${session.loginTs}`);
      const recent = Boolean(user && typeof session.loginTs === 'number' && Date.now() / 1000 - session.loginTs <= 300);
      if (req.method === 'POST') {
        if (!recent || req.headers.origin !== settings.origin || req.headers['sec-fetch-site'] === 'cross-site'
          || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { res.writeHead(403).end('请重新验证身份后，从会话管理页面操作。'); return; }
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2048) { res.writeHead(413).end(); return; } }
        const fields = new URLSearchParams(body), supplied = Buffer.from(fields.get('csrf') ?? ''), expected = Buffer.from(csrf);
        const target = fields.get('target') ?? '';
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || (target !== 'all' && !/^[a-f0-9]{64}$/.test(target))) { res.writeHead(403).end('会话验证失败，请刷新页面。'); return; }
        if (!await accounts.allowAttempt(`browser-revoke:${sourceIp(req, settings)}`, `browser-revoke:${user!.userId}`)) { res.writeHead(429).end('操作过于频繁，请稍后重试。'); return; }
        await accounts.revokeBrowserSessions(user!.userId, target, createHash('sha256').update(`${csrf}:${target}`).digest('hex'));
        res.writeHead(303, { location: '/identity/sessions?done=1' }).end(); return;
      }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      const links = [{ name: 'Launcher', url: `${settings.adminOrigin ?? settings.origin}/admin/`, reauthenticate: `${settings.adminOrigin ?? settings.origin}/auth/admin/login?switch=1` },
        ...[...applications.values()].map(app => ({ name: app.appId === 'mx-insight-hub' ? 'Hub' : app.appId, url: app.origin, reauthenticate: `${app.origin}/auth/sso/login?switch=1` }))];
      res.setHeader('Referrer-Policy', 'same-origin');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(sessionsPage({ name: user?.displayName,
        sessions: user ? await accounts.browserSessions(user.userId, session.uid) : [], csrf, recent, links, done: new URL(req.url!, settings.origin).searchParams.get('done') === '1' })); return;
    }
    if (path === '/identity/feishu/callback' && req.method === 'GET') {
      let appReturn: string | undefined;
      let returnInteraction: string | undefined;
      try {
        if (!accounts.webState || !registration?.feishu) throw new Error('Web login unavailable');
        const query = new URL(req.url!, settings.origin).searchParams;
        const state = query.get('state') ?? '';
        const bound = /(?:^|;\s*)__Host-mx_feishu=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
        if (!bound || bound !== state) throw new Error('Invalid OAuth state');
        const transaction = await accounts.webState.read('transaction', state, true);
        if (typeof transaction?.appReturn === 'string' && [...applications.values()].some(app => app.origin === transaction.appReturn)) appReturn = transaction.appReturn;
        if (appReturn && typeof transaction?.uid === 'string') returnInteraction = transaction.uid;
        if (!transaction || query.has('error') || !query.get('code')) throw new Error('OAuth rejected or expired');
        const proof = await registration.feishu('exchange', { code: query.get('code'), verifier: transaction.verifier, exchangeHandle: transaction.exchangeHandle, sourceKey: sourceIp(req, settings) });
        await accounts.webState.put('proof', String(transaction.uid), { ...proof, verifiedAt: Date.now() / 1000, link: transaction.link });
        res.setHeader('Set-Cookie', '__Host-mx_feishu=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
        res.writeHead(303, { location: `/identity/interaction/${transaction.uid}` }).end();
      } catch {
        if (appReturn && returnInteraction) { res.writeHead(303, { location: `/identity/interaction/${returnInteraction}?app_error=feishu` }).end(); return; }
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end('<meta charset="utf-8"><p>飞书验证失败、已取消或已过期，请返回应用重新登录。</p>');
      }
      return;
    }
    const match = /^\/identity\/interaction\/([A-Za-z0-9_-]+)$/.exec(path);
    if (match) {
      const authenticationStartedAt = Date.now() / 1000;
      let appReturn: string | undefined;
      try {
        const interaction = await provider.interactionDetails(req, res);
        const clientId = String(interaction.params.client_id);
        if (match[1] !== interaction.uid || (clientId !== settings.clientId && !applications.has(clientId)) || interaction.prompt.name !== 'login') throw new Error('Invalid interaction');
        const registering = new URL(req.url!, settings.origin).searchParams.get('view') === 'register';
        const invitationHandle = typeof interaction.params.mx_invitation === 'string' ? interaction.params.mx_invitation : '';
        const invitationApp = applications.get(clientId);
        if (interaction.params.mx_surface === 'application') appReturn = invitationApp?.origin;
        const source: RegistrationSource = { issuer: settings.issuer, clientId, appId: invitationApp?.appId ?? 'mx-launcher', appOrigin: invitationApp?.origin ?? settings.adminOrigin ?? settings.origin };
        let enterprise: Awaited<ReturnType<typeof resolveHubInvitation>> | undefined;
        let policy: RegistrationPolicy | undefined;
        const proof = await accounts.webState?.read('proof', interaction.uid);
        if (req.method === 'GET' && proof?.userId && !proof.link) {
          const linked = await accounts.account(String(proof.userId));
          if (!allowed(linked, clientId) || linked?.profile.externalIds.feishuSubject !== proof.subject) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('此账号已被停用或禁止访问该应用，请联系管理员。'); return; }
          await accounts.webState!.read('proof', interaction.uid, true);
          return provider.interactionFinished(req, res, { login: { accountId: String(proof.userId), ts: Number(proof.verifiedAt ?? authenticationStartedAt) } }, { mergeWithLastSubmission: false });
        }
        if (req.method === 'GET' && invitationApp && interaction.params.mx_surface === 'application') {
          const complete = new URL(req.url!, settings.origin).searchParams.get('app_complete');
          if (complete) {
            const result = await appAccount.completion(interaction.uid, complete);
            if (result.intent) return startFeishu(req, res, interaction.uid, result.intent === 'feishu-link');
            return provider.interactionFinished(req, res, { login: { accountId: String(result.userId), ts: Number(result.authTime) } }, { mergeWithLastSubmission: false });
          }
          const target = await appAccount.begin(interaction.uid, clientId, String(interaction.params.state), new URL(req.url!, settings.origin).searchParams.get('app_error') ?? undefined);
          if (target) { res.writeHead(303, { location: target }).end(); return; }
        }
        let feishuEnabled = false;
        if (req.method === 'GET') {
          // Optional sign-up/provider discovery must not serially delay password login.
          const [policyResult, feishuResult] = await Promise.allSettled([
            registration?.policy(source), accounts.webState ? registration?.feishu?.('info', {}) : undefined
          ]);
          if (policyResult.status === 'fulfilled') policy = policyResult.value;
          if (feishuResult.status === 'fulfilled') feishuEnabled = feishuResult.value?.enabled === true;
        }
        const render = (message = '', status = 200) => {
          res.statusCode = status;
          // Native form POSTs under no-referrer carry Origin:null in browsers.
          // Preserve same-origin provenance without allowing cross-site refs.
          res.setHeader('Referrer-Policy', 'same-origin');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(page(path, csrfFor(interaction.uid), message, policy, registering && Boolean(policy && policy.mode !== 'closed'), { enabled: feishuEnabled, pending: Boolean(proof), enterprise: Boolean(enterprise), appName: invitationApp ? (invitationApp.appId === 'mx-insight-hub' ? 'Insight Hub' : invitationApp.appId) : 'Launcher', returnUrl: invitationHandle && invitationApp ? `${invitationApp.origin}/#/join` : applications.get(clientId)?.origin ?? `${settings.adminOrigin ?? settings.origin}/admin/` }));
        };
        if (req.method === 'GET') {
          if (invitationHandle && invitationApp && policy?.mode !== 'closed') {
            try { enterprise = await resolveHubInvitation(invitationApp,settings.issuer,invitationHandle); }
            catch { return render('企业邀请已失效或暂不可验证。已有账号仍可登录；注册请返回 Hub 重新打开邀请。'); }
          }
          return render();
        }
        if (req.method !== 'POST' || req.headers.origin !== settings.origin || req.headers['sec-fetch-site'] === 'cross-site'
          || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error('Invalid request');
        let text = '';
        for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 8192) throw new Error('Body too large'); }
        const body = new URLSearchParams(text);
        const csrf = Buffer.from(body.get('csrf') ?? ''); const expected = Buffer.from(csrfFor(interaction.uid));
        if (csrf.length !== expected.length || !timingSafeEqual(csrf, expected)) throw new Error('Invalid CSRF');
        if (['feishu', 'feishu-link'].includes(body.get('intent') ?? '')) {
          if (!accounts.webState || !registration?.feishu) return render('飞书 Web 登录尚未配置。', 503);
          return startFeishu(req, res, interaction.uid, body.get('intent') === 'feishu-link');
        }
        const login = (body.get('login') ?? '').trim(); const password = body.get('password') ?? '';
        if (registering) {
          if (!registration || !accounts.allowRegistrationAttempt) return render('注册暂不可用，请使用已有账号登录。', 503);
          if (!await accounts.allowRegistrationAttempt(sourceIp(req, settings), login)) return render('注册尝试过于频繁，请稍后重试。', 429);
          try {
            policy = await registration.policy(source);
            if (policy.mode === 'closed') return render('暂未开放新账号注册，已有账号可正常登录。', 403);
            if (invitationHandle && invitationApp) {
              try { enterprise = await resolveHubInvitation(invitationApp,settings.issuer,invitationHandle); }
              catch { return render('企业邀请已失效或暂不可验证，请返回 Hub 重新打开邀请。',409); }
            }
            if (password !== body.get('passwordConfirm')) return render('两次输入的密码不一致。', 400);
            const result = await registration.register({ transactionId: interaction.uid, policyVersion: Number(body.get('policyVersion')), source,
              account: login, password, inviteCode: body.get('inviteCode') ?? '', ...(enterprise ? {enterpriseInvitation:enterprise} : {}), ...(proof ? { verifiedFeishuSubject: String(proof.subject) } : {}) });
            await accounts.webState?.remove('proof', interaction.uid);
            return provider.interactionFinished(req, res, { login: { accountId: result.userId, ts: authenticationStartedAt } }, { mergeWithLastSubmission: false });
          } catch (error) {
            return render(error instanceof RegistrationClientError ? error.message : '注册暂不可用，请稍后重试。', error instanceof RegistrationClientError && error.status < 500 ? error.status : 503);
          }
        }
        if (!login || login.length > 255 || !password || password.length > 1024) return render('请填写账号和密码。', 400);
        if (!await accounts.allowAttempt(sourceIp(req, settings), login)) return render('尝试过于频繁，请稍后重试。', 429);
        if (proof && registration?.feishu) {
          try {
            const bound = await registration.feishu('bind', { subject: proof.subject, login, password });
            const linked = await accounts.account(String(bound.userId));
            if (!allowed(linked, clientId)) return render('此账号已被禁止访问该应用，请联系管理员。', 403);
            await accounts.webState?.remove('proof', interaction.uid);
            return provider.interactionFinished(req, res, { login: { accountId: String(bound.userId), ts: authenticationStartedAt } }, { mergeWithLastSubmission: false });
          } catch (error) { return render(error instanceof RegistrationClientError ? error.message : '绑定暂不可用，请稍后重试。', error instanceof RegistrationClientError ? error.status : 503); }
        }
        const user = await accounts.authenticate(login, password);
        if (!user) return render('账号或密码不正确，或账号不可用。', 401);
        if (!allowed(user, clientId)) return render('此账号已被禁止访问该应用，请联系管理员。', 403);
        console.info(JSON.stringify({ event: 'identity.password-login', userId: user.userId }));
        return provider.interactionFinished(req, res, { login: { accountId: user.userId, ts: authenticationStartedAt } }, { mergeWithLastSubmission: false });
      } catch {
        if (appReturn) { res.writeHead(303, { location: `${appReturn}/?account=1&accountError=expired#/account` }).end(); return; }
        res.statusCode = 400; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('登录请求已失效，请返回工作台重新登录。'); return;
      }
    }
    // Mounted at /identity; the provider derives its issuer path from settings.
    req.url = req.url?.slice('/identity'.length) || '/';
    return provider.callback()(req, res);
  };
  return { provider, handle: (req: IncomingMessage, res: ServerResponse) => accounts.withBrowserRequest
    ? accounts.withBrowserRequest(String(req.headers['user-agent'] ?? ''), () => handle(req, res)) : handle(req, res) };
}
