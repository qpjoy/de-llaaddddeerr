import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { Agent, fetch as secureFetch } from 'undici'
import * as oidc from 'openid-client'
import { AppError } from '../core/errors.mjs'
import { SsoStore } from './sso-store.mjs'

const random = () => randomBytes(32).toString('base64url')
const fingerprint = value => createHash('sha256').update(value).digest('hex')
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const SID = '__Host-mx_hub_sso', TX = '__Host-mx_hub_login'
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`
const cookies = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(v => v.trim().split('=')))
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export { readSsoProfile } from './sso-config.mjs'

export function createSso({ settings, pool, identity, oidcConfiguration }) {
  if (!settings) return null
  if (!pool) throw new Error('Hub SSO requires PostgreSQL')
  const store = new SsoStore(pool, settings.sessionKey)
  const providers = new Map([settings, ...(settings.previousProviders ?? [])].map(p => [p.issuer,p]))
  const discoveries = new Map()
  async function configuration(issuer = settings.issuer) {
    const p = providers.get(issuer)
    if (!p) throw new AppError(401, 'sso_issuer_unknown', '统一登录来源已失效。')
    if (!discoveries.has(issuer)) discoveries.set(issuer, (async () => {
      const dispatcher = new Agent({ connect: { ca:p.caCert ? [...rootCertificates,p.caCert] : rootCertificates } })
      const config = (issuer === settings.issuer ? oidcConfiguration : null) ?? await oidc.discovery(new URL(issuer), p.clientId,
        { client_secret:p.clientSecret,id_token_signed_response_alg:'RS256' },oidc.ClientSecretBasic(p.clientSecret),
        { timeout:8,[oidc.customFetch]:(url,options) => {
          if (new URL(url).origin !== new URL(issuer).origin) throw new Error('Unexpected identity endpoint origin')
          return secureFetch(url,{...options,dispatcher,redirect:'error'})
        } })
      oidc.enableNonRepudiationChecks(config)
      return config
    })().catch(error => { discoveries.delete(issuer);throw error }))
    return discoveries.get(issuer)
  }
  const cache = new Map()
  async function verified(session) {
    const issuer = session.issuer ?? settings.previousProviders?.[0]?.issuer ?? settings.issuer
    const cacheKey = fingerprint(`${issuer}:${session.accessToken}`)
    const existing = cache.get(cacheKey)
    if (existing && existing.until > Date.now()) return existing.value
    let info
    try { info = await oidc.fetchUserInfo(await configuration(issuer), session.accessToken, session.subject) }
    catch (error) {
      if ([400, 401, 403].includes(error.status)) throw new AppError(401, 'sso_session_invalid', '统一登录已过期或被禁止，请重新登录。')
      throw new AppError(503, 'sso_unavailable', '统一身份暂不可验证，请稍后重试；原会话仍保留。')
    }
    const value = info.mx_identity
    if (value?.issuer !== settings.legacyIssuer || value.subject !== `user:${session.subject}` || value.audience !== settings.audience
      || value.principal?.userId !== session.subject || value.principal.kind !== 'user' || !Array.isArray(value.principal.scopes)
      || !Array.isArray(value.principal.organizationIds)) throw new AppError(401, 'sso_identity_invalid', '统一身份验证不匹配。')
    if (cache.size >= 1000) cache.delete(cache.keys().next().value)
    cache.set(cacheKey, { value, until: Date.now() + 30000 })
    return value
  }
  function checkOrigin(request) {
    if (request.headers.origin !== settings.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'sso_csrf', '请从 Hub 页面重新发起操作。')
  }
  async function sessionFor(request) {
    return store.get('session', cookies(request)[SID])
  }
  return {
    store,
    async principal(request) {
      const session = await sessionFor(request)
      if (!session) return null
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        checkOrigin(request)
        if (!equal(session.csrf, request.headers['x-mx-hub-csrf'])) throw new AppError(403, 'sso_csrf', '页面会话已变化，请刷新后重试。')
      }
      return identity.resolveVerified(await verified(session))
    },
    async handle(request, response, url) {
      if (!url.pathname.startsWith('/auth/sso/')) return false
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer')
      const path = url.pathname
      const redirect = location => { response.writeHead(303, { location }); response.end() }
      if (path === '/auth/sso/login' && request.method === 'GET') {
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'sso_csrf', '请从 Hub 发起登录。')
        const old = cookies(request)[TX]; if (old) await store.remove('login', old)
        const id = random(), transaction = { state: random(), nonce: random(), verifier: random() }
        const target = oidc.buildAuthorizationUrl(await configuration(), {
          redirect_uri: `${settings.origin}/auth/sso/callback`, response_type: 'code', response_mode: 'query', scope: 'openid mx:hub',
          state: transaction.state, nonce: transaction.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier), code_challenge_method: 'S256',
          ...(url.searchParams.get('switch') === '1' ? { prompt: 'login', max_age: '0' } : {})
        })
        await store.put('login', id, transaction, 300)
        response.setHeader('Set-Cookie', cookie(TX, id, 300)); redirect(target.toString()); return true
      }
      if (path === '/auth/sso/callback' && request.method === 'GET') {
        const transaction = await store.get('login', cookies(request)[TX], true)
        response.setHeader('Set-Cookie', cookie(TX, '', 0))
        if (!transaction) throw new AppError(400, 'sso_login_expired', '登录请求已失效，请重新发起。')
        let tokens
        try { tokens = await oidc.authorizationCodeGrant(await configuration(), new URL(request.url, settings.origin), {
          pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true
        }) } catch { throw new AppError(400, 'sso_login_invalid', '统一登录验证失败，请重新发起。') }
        const claims = tokens.claims()
        if (claims?.iss !== settings.issuer || typeof claims.sub !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new AppError(400, 'sso_login_invalid', '统一身份响应无效。')
        const session = { issuer:settings.issuer, subject: claims.sub, accessToken: tokens.access_token, csrf: random() }
        const canonical = await verified(session)
        await store.provision({ issuer: settings.issuer, subject: claims.sub, clientId: settings.clientId, canonical, personalTenant: settings.personalTenant === true })
        const old = cookies(request)[SID]; if (old) await store.remove('session', old)
        const sid = random(), seconds = Math.min(SESSION_TTL_SECONDS, tokens.expires_in)
        await store.put('session', sid, session, seconds)
        response.setHeader('Set-Cookie', [cookie(TX, '', 0), cookie(SID, sid, seconds)])
        redirect('/?sso=ready'); return true
      }
      if (path === '/auth/sso/session' && request.method === 'GET') {
        const session = await sessionFor(request)
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ active: Boolean(session), csrf: session?.csrf ?? null }))
        return true
      }
      if (path === '/auth/sso/logout' && request.method === 'POST') {
        checkOrigin(request)
        const session = await sessionFor(request)
        if (session && !equal(session.csrf, request.headers['x-mx-hub-csrf'])) throw new AppError(403, 'sso_csrf', '退出验证失败，请刷新。')
        if (session) cache.delete(fingerprint(`${session.issuer ?? settings.previousProviders?.[0]?.issuer ?? settings.issuer}:${session.accessToken}`))
        await store.remove('session', cookies(request)[SID])
        response.setHeader('Set-Cookie', cookie(SID, '', 0)); response.writeHead(204).end(); return true
      }
      throw new AppError(404, 'not_found', 'Route not found')
    }
  }
}
