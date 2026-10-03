import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, { type Configuration } from 'oidc-provider';
import type { IdentityAccounts } from './repository.js';
import { RegistrationClientError, type RegistrationClient } from '../registration/backchannel.js';
import type { RegistrationPolicy } from '../registration/repository.js';

export interface IdentitySettings {
  issuer: string;
  origin: string;
  clientId: string;
  clientSecret: string;
  cookieKeys: string[];
  jwks: NonNullable<Configuration['jwks']>;
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function page(action: string, csrf: string, message = '', policy?: RegistrationPolicy, registering = false) {
  const registrationAllowed = policy && policy.mode !== 'closed';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${registering ? '注册' : '登录'} · MX</title>
  <style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#141417;color:#e2e2e2;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  main{width:100%;max-width:440px;min-width:0;padding:28px;background:#1a1b23;border:1px solid #303747;border-radius:16px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.02em}
  .mark{display:grid;place-items:center;width:36px;height:36px;background:#2bf6d2;color:#062a25;border-radius:10px;font-size:15px;font-weight:800}
  h1{font-size:24px;line-height:1.3;letter-spacing:-.02em;margin:20px 0 8px}
  .intro{color:#a7b3bf;margin:0 0 24px}
  form{display:grid;gap:16px}
  .field{min-width:0}
  label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
  input,button{width:100%;min-width:0;min-height:44px;border-radius:8px;font:inherit}
  input{padding:9px 12px;background:#21232d;border:1px solid #435166;color:#fff;font-size:16px;line-height:24px}
  input:hover{border-color:#647386}
  input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #2bf6d2;outline-offset:3px}
  .hint{display:block;font-size:12px;color:#a7b3bf;margin-top:6px}
  button{margin-top:4px;padding:10px 16px;border:0;background:#2bf6d2;color:#052823;font-weight:600;cursor:pointer}
  button:hover{background:#11cdb5}
  .message{color:#ffb7a7;background:#33242a;border:1px solid #734049;border-radius:8px;padding:10px 12px;margin:0 0 20px;overflow-wrap:anywhere}
  .alternate{margin:20px 0 0;text-align:center}
  footer{display:grid;gap:6px;border-top:1px solid #303747;padding-top:16px;margin-top:20px;font-size:12px;color:#a7b3bf;text-align:center}
  a{color:#70e9d8;text-decoration:none;text-underline-offset:3px}
  a:hover{text-decoration:underline}
  @media(max-width:480px){body{padding:16px}main{padding:22px}h1{font-size:22px}}
  @media(max-height:700px){body{align-items:start}}
  </style></head><body>
  <main aria-labelledby="page-title">
  <div class="brand"><span class="mark" aria-hidden="true">MX</span><span>MX 统一账号</span></div>
  <h1 id="page-title">${registering ? '创建 MX 账号' : '登录 MX 工作台'}</h1>
  <p class="intro">${registering ? '使用统一账号访问已开通的应用。工作台管理权限需单独授权。' : '使用已有 MX 账号，继续进入 Launcher。'}</p>
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
    </div>${policy?.mode === 'invite_code' ? `<div class="field">
      <label for="inviteCode">邀请码</label>
      <input id="inviteCode" name="inviteCode" autocomplete="off" maxlength="128" required>
    </div>` : ''}` : ''}
    <button type="submit">${registering ? '注册并继续' : '登录并继续'}</button>
  </form>
  <p class="alternate">${registering ? `<a href="${escape(action)}">已有账号，返回登录</a>` : registrationAllowed ? `<a href="${escape(action)}?view=register">${policy.mode === 'invite_code' ? '使用邀请码注册' : '创建账号'}</a>` : '新账号注册暂未开放'}</p>
  <footer><span>账号与权限由成员与访问中心管理。</span><a href="/admin/">返回管理工作台</a></footer>
  </main></body></html>`;
}
export function createIdentityProvider(settings: IdentitySettings, accounts: IdentityAccounts, adapter: Configuration['adapter'], registration?: RegistrationClient) {
  const provider: Provider = new Provider(settings.issuer, {
    adapter, jwks: settings.jwks,
    clients: [{ client_id: settings.clientId, client_secret: settings.clientSecret,
      redirect_uris: [`${settings.origin}/auth/admin/callback`], response_types: ['code'],
      grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_basic',
      id_token_signed_response_alg: 'RS256' }],
    responseTypes: ['code'], clientAuthMethods: ['client_secret_basic'],
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false }, registration: { enabled: false },
      userinfo: { enabled: false }, introspection: { enabled: false }, revocation: { enabled: false } },
    claims: { openid: ['sub'] }, scopes: ['openid'],
    cookies: { keys: settings.cookieKeys, names: { session: 'mx_identity', interaction: 'mx_identity_interaction', resume: 'mx_identity_resume' },
      long: { secure: true, httpOnly: true, sameSite: 'lax' }, short: { secure: true, httpOnly: true, sameSite: 'lax' } },
    ttl: { AuthorizationCode: 60, AccessToken: 300, IdToken: 300, Interaction: 300, Session: 43200, Grant: 43200 },
    interactions: { url: (_ctx, interaction) => `/identity/interaction/${interaction.uid}` },
    findAccount: async (_ctx, id) => {
      const user = await accounts.account(id);
      return user ? { accountId: user.userId, claims: async () => ({ sub: user.userId }) } : undefined;
    },
    async loadExistingGrant(ctx) {
      const id = ctx.oidc.result?.consent?.grantId ?? ctx.oidc.session?.grantIdFor(settings.clientId);
      if (id) {
        const grant = await provider.Grant.find(id);
        if (grant) return grant;
      }
      const accountId = ctx.oidc.session?.accountId;
      if (!accountId || !await accounts.account(accountId)) return undefined;
      // Only our statically registered first-party client and openid scope.
      const grant = new provider.Grant({ accountId, clientId: settings.clientId });
      grant.addOIDCScope('openid');
      await grant.save();
      return grant;
    },
    renderError: async (ctx) => { ctx.type = 'html'; ctx.body = '<!doctype html><meta charset="utf-8"><p>登录请求无效或已过期，请返回工作台重新登录。</p><a href="/admin/">返回工作台</a>'; }
  });
  provider.on('server_error', () => console.warn(JSON.stringify({ event: 'identity.request-failed' })));
  const csrfFor = (uid: string) => createHmac('sha256', settings.cookieKeys[0]).update(`login:${uid}`).digest('base64url');
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    Object.assign(req, { originalUrl: req.url, baseUrl: '/identity' });
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    // oidc-provider appends the exact script hash to an explicit script-src
    // for its account-switch form. Without this directive default-src blocks
    // that transition, leaving a blank page when the identity changes.
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const path = (req.url ?? '').split('?')[0];
    const match = /^\/identity\/interaction\/([A-Za-z0-9_-]+)$/.exec(path);
    if (match) {
      try {
        const interaction = await provider.interactionDetails(req, res);
        if (match[1] !== interaction.uid || interaction.params.client_id !== settings.clientId || interaction.prompt.name !== 'login') throw new Error('Invalid interaction');
        const registering = new URL(req.url!, settings.origin).searchParams.get('view') === 'register';
        let policy: RegistrationPolicy | undefined;
        if (req.method === 'GET') { try { policy = await registration?.policy(); } catch { /* Login stays available if signup is down. */ } }
        const render = (message = '', status = 200) => {
          res.statusCode = status;
          // Native form POSTs under no-referrer carry Origin:null in browsers.
          // Preserve same-origin provenance without allowing cross-site refs.
          res.setHeader('Referrer-Policy', 'same-origin');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(page(path, csrfFor(interaction.uid), message, policy, registering && Boolean(policy && policy.mode !== 'closed')));
        };
        if (req.method === 'GET') return render();
        if (req.method !== 'POST' || req.headers.origin !== settings.origin || req.headers['sec-fetch-site'] === 'cross-site'
          || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error('Invalid request');
        let text = '';
        for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 8192) throw new Error('Body too large'); }
        const body = new URLSearchParams(text);
        const csrf = Buffer.from(body.get('csrf') ?? ''); const expected = Buffer.from(csrfFor(interaction.uid));
        if (csrf.length !== expected.length || !timingSafeEqual(csrf, expected)) throw new Error('Invalid CSRF');
        const login = (body.get('login') ?? '').trim(); const password = body.get('password') ?? '';
        if (registering) {
          if (!registration || !accounts.allowRegistrationAttempt) return render('注册暂不可用，请使用已有账号登录。', 503);
          if (!await accounts.allowRegistrationAttempt(req.socket.remoteAddress ?? 'unknown', login)) return render('注册尝试过于频繁，请稍后重试。', 429);
          try {
            policy = await registration.policy();
            if (policy.mode === 'closed') return render('暂未开放新账号注册，已有账号可正常登录。', 403);
            if (password !== body.get('passwordConfirm')) return render('两次输入的密码不一致。', 400);
            const result = await registration.register({ transactionId: interaction.uid, policyVersion: Number(body.get('policyVersion')),
              account: login, password, inviteCode: body.get('inviteCode') ?? '' });
            return provider.interactionFinished(req, res, { login: { accountId: result.userId } }, { mergeWithLastSubmission: false });
          } catch (error) {
            return render(error instanceof RegistrationClientError ? error.message : '注册暂不可用，请稍后重试。', error instanceof RegistrationClientError && error.status < 500 ? error.status : 503);
          }
        }
        if (!login || login.length > 255 || !password || password.length > 1024) return render('请填写账号和密码。', 400);
        if (!await accounts.allowAttempt(req.socket.remoteAddress ?? 'unknown', login)) return render('尝试过于频繁，请稍后重试。', 429);
        const user = await accounts.authenticate(login, password);
        if (!user) return render('账号或密码不正确，或账号不可用。', 401);
        console.info(JSON.stringify({ event: 'identity.password-login', userId: user.userId }));
        return provider.interactionFinished(req, res, { login: { accountId: user.userId } }, { mergeWithLastSubmission: false });
      } catch {
        res.statusCode = 400; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('登录请求已失效，请返回工作台重新登录。'); return;
      }
    }
    // Mounted at /identity; the provider derives its issuer path from settings.
    req.url = req.url?.slice('/identity'.length) || '/';
    return provider.callback()(req, res);
  };
  return { provider, handle };
}
