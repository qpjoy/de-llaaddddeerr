import { randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { Agent, fetch as secureFetch } from 'undici'
import * as oidc from 'openid-client'
import { AppError } from '../core/errors.mjs'
import { SsoStore } from './sso-store.mjs'
import { TenantInvitations } from './tenant-invitations.mjs'
import { readJson } from '../core/http.mjs'
import { createIdentityAccountClient } from '@qpjoy/mx-common/identity'

const random = () => randomBytes(32).toString('base64url')
const fingerprint = value => createHash('sha256').update(value).digest('hex')
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const SID = '__Host-mx_hub_sso', TX = '__Host-mx_hub_login'
const INV = '__Host-mx_hub_invitation'
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`
const cookies = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(v => v.trim().split('=')))
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export { readSsoProfile } from './sso-config.mjs'

export function createSso({ settings, pool, identity, oidcConfiguration, adminToken }) {
  if (!settings) return null
  if (!pool) throw new Error('Hub SSO requires PostgreSQL')
  const store = new SsoStore(pool, settings.sessionKey)
  const invitations = new TenantInvitations({pool,sessions:store,origin:settings.origin,adminToken})
  const invitationAttempts = new Map()
  const providers = new Map([settings, ...(settings.previousProviders ?? [])].map(p => [p.issuer,p]))
  const discoveries = new Map()
  const accountClients = new Map()
  function accountClient(issuer = settings.issuer) {
    const p = providers.get(issuer)
    if (!p) throw new AppError(401, 'sso_issuer_unknown', '请重新登录。')
    if (!accountClients.has(issuer)) {
      const dispatcher = new Agent({ connect: { ca: p.caCert ? [...rootCertificates, p.caCert] : rootCertificates } })
      const client = createIdentityAccountClient({ ...p, fetch: (url, options) => secureFetch(url, { ...options, dispatcher }) })
      accountClients.set(issuer, async (action, input) => {
        try { return await client(action, input) }
        catch (error) {
          if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
            throw new AppError(error.status, error.code || 'account_request_failed', error.message)
          }
          throw new AppError(503, 'account_unavailable', '账号服务暂不可用，请稍后重试。')
        }
      })
    }
    return accountClients.get(issuer)
  }
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
  async function verified(session, fresh = false) {
    const issuer = session.issuer ?? settings.previousProviders?.[0]?.issuer ?? settings.issuer
    const cacheKey = fingerprint(`${issuer}:${session.accessToken}`)
    const existing = cache.get(cacheKey)
    if (!fresh && existing && existing.until > Date.now()) return existing.value
    let info
    try { info = await oidc.fetchUserInfo(await configuration(issuer), session.accessToken, session.subject) }
    catch (error) {
      if ([400, 401, 403].includes(error.status)) {
        cache.delete(cacheKey)
        throw new AppError(401, 'sso_session_invalid', '统一登录已过期或被禁止，请重新登录。')
      }
      throw new AppError(503, 'sso_unavailable', '统一身份暂不可验证，请稍后重试；原会话仍保留。')
    }
    const value = info.mx_identity
    if (value?.issuer !== settings.legacyIssuer || value.subject !== `user:${session.subject}` || value.audience !== settings.audience
      || value.principal?.userId !== session.subject || value.principal.kind !== 'user' || !Array.isArray(value.principal.scopes)
      || !Array.isArray(value.principal.organizationIds)) {
      cache.delete(cacheKey)
      throw new AppError(401, 'sso_identity_invalid', '统一身份验证不匹配。')
    }
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
    invitations,
    async principal(request) {
      const session = await sessionFor(request)
      if (!session) return null
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        checkOrigin(request)
        if (!equal(session.csrf, request.headers['x-mx-hub-csrf'])) throw new AppError(403, 'sso_csrf', '页面会话已变化，请刷新后重试。')
      }
      return identity.resolveVerified(await verified(session, !['GET', 'HEAD', 'OPTIONS'].includes(request.method)))
    },
    async handle(request, response, url) {
      if (!url.pathname.startsWith('/auth/sso/')) return false
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer')
      const path = url.pathname
      const redirect = location => { response.writeHead(303, { location }); response.end() }
      const json = value => { response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(value)); return true }
      if (path === '/auth/sso/invitation-proof' && request.method === 'POST') {
        const body = await readJson(request,4096)
        const signature = createHmac('sha256',settings.clientSecret).update(`mx-hub-invitation-proof-v1:${JSON.stringify(body)}`).digest('hex')
        if (body.clientId!==settings.clientId || body.issuer!==settings.issuer || !Number.isSafeInteger(body.timestamp) || Math.abs(Date.now()-body.timestamp)>30000
          || !equal(signature,request.headers['x-mx-invitation-signature'])) throw new AppError(401,'invalid_identity_client','邀请验证失败。')
        const context = await store.get('invitation-registration',body.handle)
        if (!context) throw new AppError(410,'invitation_context_expired','邀请登录已超时，请返回邀请链接重试。')
        return json({...await invitations.registrationProof(context.invitationId),clientId:settings.clientId})
      }
      if (path === '/auth/sso/invitation/start' && request.method === 'POST') {
        checkOrigin(request)
        const ip=request.socket.remoteAddress || 'unknown', now=Date.now()
        const attempt=invitationAttempts.get(ip)
        if (attempt && now-attempt.start<60000 && attempt.count>=30) throw new AppError(429,'invitation_rate_limited','邀请操作过于频繁，请稍后重试。')
        if (invitationAttempts.size>=1000 && !attempt) invitationAttempts.delete(invitationAttempts.keys().next().value)
        invitationAttempts.set(ip,attempt && now-attempt.start<60000 ? {...attempt,count:attempt.count+1} : {start:now,count:1})
        const body = await readJson(request,4096), invitation = await invitations.inspect(body.token)
        const old = cookies(request)[INV]; if (old) await store.remove('invitation',old)
        const id = random(); await store.put('invitation',id,{token:body.token,invitationId:invitation.id},1800)
        response.setHeader('Set-Cookie',cookie(INV,id,1800))
        return json(invitation)
      }
      if (path === '/auth/sso/invitation' && request.method === 'GET') {
        const context = await store.get('invitation',cookies(request)[INV])
        if (!context) throw new AppError(410,'invitation_context_expired','邀请已超时，请重新打开原邀请链接。')
        const session = await sessionFor(request)
        let principal = null
        if (session) {
          try { principal = await identity.resolveVerified(await verified(session,true)) }
          catch (error) { if (error.status!==401) throw error }
        }
        const invitation = await invitations.inspect(context.token,principal?.memberId)
        return json({invitation,user:principal ? {displayName:principal.displayName,memberId:principal.memberId} : null,csrf:principal ? session.csrf : null})
      }
      if (path === '/auth/sso/invitation/accept' && request.method === 'POST') {
        checkOrigin(request)
        const context = await store.get('invitation',cookies(request)[INV]), session = await sessionFor(request)
        if (!context || !session) throw new AppError(401,'login_required','请先从此邀请登录。')
        if (!equal(session.csrf,request.headers['x-mx-hub-csrf'])) throw new AppError(403,'sso_csrf','页面会话已变化，请刷新后重试。')
        const body=await readJson(request,4096)
        if (body?.invitationId!==context.invitationId) throw new AppError(409,'invitation_context_changed','另一个页面已切换邀请，请重新检查目标租户后确认。')
        const principal = await identity.resolveVerified(await verified(session,true))
        const accepted = await invitations.accept(principal,context.token)
        identity.client?.invalidate?.()
        // Keep the short context for idempotent retry if the success response is lost.
        return json({...accepted,returnUrl:`/?sso=ready#/${accepted.role==='billing' ? 'payments' : 'my'}?tenantId=${accepted.tenantId}`})
      }
      if (path === '/auth/sso/login' && request.method === 'GET') {
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'sso_csrf', '请从 Hub 发起登录。')
        const old = cookies(request)[TX]; if (old) await store.remove('login', old)
        const id = random(), transaction = { state: random(), nonce: random(), verifier: random(), formCsrf: random(), view: url.searchParams.get('view') === 'register' ? 'register' : 'login', returnTo: url.searchParams.get('return') === 'account' ? 'account' : null }
        if (transaction.returnTo === 'account') transaction.expectedSubject = (await sessionFor(request))?.subject
        let registrationHandle
        if (url.searchParams.get('invitation') === '1') {
          const joinId=cookies(request)[INV], context=await store.get('invitation',joinId)
          if (!context) throw new AppError(410,'invitation_context_expired','请重新打开邀请链接。')
          const invitation=await invitations.inspect(context.token)
          transaction.invitation=joinId
          if (invitation.allowRegistration) {
            registrationHandle=random()
            await store.put('invitation-registration',registrationHandle,{invitationId:invitation.id},300)
          }
        }
        const target = oidc.buildAuthorizationUrl(await configuration(), {
          redirect_uri: `${settings.origin}/auth/sso/callback`, response_type: 'code', response_mode: 'query', scope: 'openid mx:hub',
          state: transaction.state, nonce: transaction.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier), code_challenge_method: 'S256',
          ...(url.searchParams.get('surface') === 'application' ? { mx_surface: 'application' } : {}),
          ...(registrationHandle ? {mx_invitation:registrationHandle} : {}),
          ...(url.searchParams.get('switch') === '1' ? { prompt: 'login', max_age: '0' } : {})
        })
        await store.put('login', id, transaction, 300)
        response.setHeader('Set-Cookie', cookie(TX, id, 300)); redirect(target.toString()); return true
      }
      if (path === '/auth/sso/interaction' && request.method === 'GET') {
        const id = cookies(request)[TX], transaction = await store.get('login', id)
        const flow = url.searchParams.get('flow')
        if (!transaction || !equal(transaction.state, url.searchParams.get('state')) || !/^[A-Za-z0-9_-]{43}$/.test(flow ?? ''))
          throw new AppError(400, 'account_flow_invalid', '登录页面已过期，请从 Hub 重新登录。')
        // Auth validates its own cookie; this separate state check binds the same browser to Hub.
        transaction.flow = flow
        if (!await store.update('login', id, transaction)) throw new AppError(410, 'account_flow_expired', '登录已超时，请重新开始。')
        redirect(`/?account=1${url.searchParams.get('error') === 'feishu' ? '&accountError=feishu' : ''}#/account`); return true
      }
      if (path === '/auth/sso/form' && ['GET', 'POST'].includes(request.method)) {
        const transaction = await store.get('login', cookies(request)[TX])
        if (!transaction?.flow) throw new AppError(410, 'account_flow_expired', '登录已超时，请重新开始。')
        if (request.method === 'GET') {
          const result = await accountClient()('options', { flow: transaction.flow, clientIp: String(request.headers['x-forwarded-for'] || request.socket.remoteAddress).split(',')[0].trim() })
          return json({ ...result, csrf: transaction.formCsrf, formId: fingerprint(transaction.flow), view: transaction.view, invited: Boolean(transaction.invitation) })
        }
        checkOrigin(request)
        const body = await readJson(request, 8192)
        if (!equal(transaction.formCsrf, request.headers['x-mx-hub-csrf']) || !equal(fingerprint(transaction.flow), body.formId))
          throw new AppError(409, 'account_form_changed', '另一个页面已切换登录，请刷新后重试。')
        if (!['login', 'register', 'feishu', 'feishu-link'].includes(body.action)) throw new AppError(400, 'account_action_invalid', '操作无效。')
        const result = await accountClient()(body.action, { flow: transaction.flow, clientIp: String(request.headers['x-forwarded-for'] || request.socket.remoteAddress).split(',')[0].trim(),
          expectedSubject: transaction.expectedSubject,
          login: body.login, password: body.password, passwordConfirm: body.passwordConfirm, inviteCode: body.inviteCode, policyVersion: body.policyVersion })
        return json(result)
      }
      if (path === '/auth/sso/account' && ['GET', 'POST'].includes(request.method)) {
        const session = await sessionFor(request)
        if (!session) throw new AppError(401, 'login_required', '请先登录。')
        await verified(session, true)
        const client = accountClient(session.issuer ?? settings.issuer)
        if (request.method === 'GET') {
          const [account, devices] = await Promise.all([client('account', { accessToken: session.accessToken }), client('sessions', { accessToken: session.accessToken })])
          return json({ ...account, ...devices })
        }
        checkOrigin(request)
        if (!equal(session.csrf, request.headers['x-mx-hub-csrf'])) throw new AppError(403, 'sso_csrf', '页面已过期，请刷新。')
        const body = await readJson(request, 4096)
        if (!['profile', 'password', 'unlink-feishu', 'revoke'].includes(body.action)) throw new AppError(400, 'account_action_invalid', '操作无效。')
        const result = await client(body.action, { accessToken: session.accessToken, clientIp: String(request.headers['x-forwarded-for'] || request.socket.remoteAddress).split(',')[0].trim(),
          currentPassword: body.currentPassword, password: body.password, displayName: body.displayName, target: body.target })
        if (body.action === 'password' || result.signedOut) {
          cache.delete(fingerprint(`${session.issuer ?? settings.issuer}:${session.accessToken}`))
          await store.remove('session', cookies(request)[SID]); response.setHeader('Set-Cookie', cookie(SID, '', 0))
          return json({ ...result, signedOut: true })
        }
        return json(result)
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
        if (transaction.expectedSubject && claims.sub !== transaction.expectedSubject) throw new AppError(409, 'account_changed', '请使用原账号完成绑定。')
        const session = { issuer:settings.issuer, subject: claims.sub, accessToken: tokens.access_token, csrf: random() }
        const canonical = await verified(session)
        await store.provision({ issuer: settings.issuer, subject: claims.sub, clientId: settings.clientId, canonical, personalTenant: settings.personalTenant === true && !transaction.invitation })
        const old = cookies(request)[SID]; if (old) await store.remove('session', old)
        const sid = random(), seconds = Math.min(SESSION_TTL_SECONDS, tokens.expires_in)
        await store.put('session', sid, session, seconds)
        response.setHeader('Set-Cookie', [cookie(TX, '', 0), cookie(SID, sid, seconds), ...(transaction.invitation ? [cookie(INV,transaction.invitation,1800)] : [])])
        redirect(transaction.invitation ? '/?sso=ready#/join' : transaction.returnTo === 'account' ? '/?sso=ready#/account' : '/?sso=ready'); return true
      }
      if (path === '/auth/sso/session' && request.method === 'GET') {
        let session = await sessionFor(request)
        if (session) {
          try { await verified(session, true) }
          catch (error) {
            if (error.status !== 401) throw error
            await store.remove('session', cookies(request)[SID]); session = null
            response.setHeader('Set-Cookie', cookie(SID, '', 0))
          }
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ active: Boolean(session), csrf: session?.csrf ?? null, securityUrl: `${settings.issuer}/sessions` }))
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
