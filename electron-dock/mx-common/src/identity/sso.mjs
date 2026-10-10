import { rootCertificates } from 'node:tls'
import { Agent, fetch as secureFetch } from 'undici'
import * as oidc from 'openid-client'
import { createIdentityAccountClient } from './client.mjs'
import { random, fingerprint, cookie, cookies, equal, readSsoJson, SsoError } from './http.mjs'
import { validateApplicationSsoSettings } from './profile.mjs'

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/** Server-only OIDC/BFF integration. Authentication never grants product permissions.
 * store implements put/get/remove/update; get(kind,id,true) must consume atomically.
 * Application hooks run only on the backend. No callback or role comes from the browser.
 */
export function createApplicationSso({ settings, store, oidcConfiguration,
  ErrorClass: AppError = SsoError, resolvePrincipal = identity => identity,
  validateIdentity, prepareLogin, onAuthenticated,
  navigation = {}, cookieNames, csrfHeader = 'x-mx-csrf', applicationName = '应用',
  clientIp = request => request.socket.remoteAddress || 'unknown' }) {
  if (!settings) return null
  validateApplicationSsoSettings(settings)
  if (!store || ['put','get','remove','update'].some(method => typeof store[method] !== 'function')) throw new Error('SSO session store required')
  const SID = cookieNames?.session ?? `__Host-${settings.appId}_sso`
  const TX = cookieNames?.login ?? `__Host-${settings.appId}_login`
  if (SID === TX || ![SID,TX].every(name => /^__Host-[A-Za-z0-9._-]+$/.test(name))) throw new Error('Distinct host-only SSO cookies required')
  if (!/^[a-z0-9-]+$/.test(csrfHeader)) throw new Error('Invalid SSO CSRF header')
  const readJson = (request, limit) => readSsoJson(request, limit, AppError)
  const mounts = navigation.mounts ?? ['/']
  if (!mounts.length || mounts.some(path => !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(path))) throw new Error('Invalid application UI mounts')
  const uiPath = path => mounts.includes(path) ? path : mounts[0]
  const localRedirect = location => {
    const url = new URL(location, settings.origin)
    if (url.origin !== settings.origin || url.username || url.password) throw new Error('SSO return must stay in the application')
    return `${url.pathname}${url.search}${url.hash}`
  }
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
    const canonical = info.mx_identity
    if (canonical?.subject !== `user:${session.subject}` || canonical.audience !== settings.audience
      || typeof canonical.issuer !== 'string' || !canonical.issuer.startsWith('mx-user-center:')
      || canonical.principal?.userId !== session.subject || canonical.principal.kind !== 'user'
      || !Array.isArray(canonical.principal.scopes) || !Array.isArray(canonical.principal.organizationIds)) {
      cache.delete(cacheKey)
      throw new AppError(401, 'sso_identity_invalid', '统一身份验证不匹配。')
    }
    const value = { issuer, subject: session.subject, clientId: providers.get(issuer).clientId,
      displayName: canonical.principal.displayName || session.subject, mxIdentity: canonical }
    try { await validateIdentity?.(value) }
    catch (error) { cache.delete(cacheKey); throw error }
    if (cache.size >= 1000) cache.delete(cache.keys().next().value)
    cache.set(cacheKey, { value, until: Date.now() + 30000 })
    return value
  }
  function checkOrigin(request) {
    if (request.headers.origin !== settings.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'sso_csrf', `请从${applicationName}页面重新发起操作。`)
  }
  async function sessionFor(request) {
    return store.get('session', cookies(request)[SID])
  }
  return {
    store,
    sessionFor,
    verifySession: verified,
    checkOrigin,
    async principal(request) {
      const session = await sessionFor(request)
      if (!session) return null
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        checkOrigin(request)
        if (!equal(session.csrf, request.headers[csrfHeader])) throw new AppError(403, 'sso_csrf', '页面会话已变化，请刷新后重试。')
      }
      return resolvePrincipal(await verified(session, !['GET', 'HEAD', 'OPTIONS'].includes(request.method)))
    },
    async handle(request, response, url) {
      if (!url.pathname.startsWith('/auth/sso/')) return false
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer')
      const path = url.pathname
      const redirect = location => { response.writeHead(303, { location }); response.end() }
      const json = value => { response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(value)); return true }
      const nativeStart = navigation.applicationForm === true && path === '/auth/sso/start' && request.method === 'POST'
      if (nativeStart || (path === '/auth/sso/login' && request.method === 'GET')) {
        if (nativeStart) checkOrigin(request)
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'sso_csrf', `请从${applicationName}发起登录。`)
        if (navigation.applicationForm === true) {
          // Check the running Auth client, not merely the locally mounted profile.
          // Opt-in only: existing consumers retain their original login behavior.
          let capabilities
          try { capabilities = await accountClient()('capabilities') } catch {
            throw new AppError(503, 'sso_application_unavailable', `账号服务尚未完成${applicationName}接入或暂不可用，请联系管理员。`)
          }
          if (capabilities.nativeForm !== true || capabilities.appId !== settings.appId || capabilities.origin !== settings.origin || capabilities.audience !== settings.audience)
            throw new AppError(503, 'sso_application_mismatch', `${applicationName}账号接入配置不一致，请联系管理员。`)
        }
        const old = cookies(request)[TX]; if (old) await store.remove('login', old)
        const id = random(), transaction = { state: random(), nonce: random(), verifier: random(), formCsrf: random(), view: url.searchParams.get('view') === 'register' ? 'register' : 'login', returnTo: url.searchParams.get('return') === 'account' ? 'account' : null }
        transaction.uiPath = uiPath(url.searchParams.get('ui'))
        if (transaction.returnTo === 'account') transaction.expectedSubject = (await sessionFor(request))?.subject
        const extraParameters = await prepareLogin?.({ request, url, transaction }) ?? {}
        const target = oidc.buildAuthorizationUrl(await configuration(), {
          ...extraParameters,
          redirect_uri: `${settings.origin}/auth/sso/callback`, response_type: 'code', response_mode: 'query', scope: settings.scope ?? 'openid mx:identity',
          state: transaction.state, nonce: transaction.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier), code_challenge_method: 'S256',
          ...(navigation.applicationForm === true || url.searchParams.get('surface') === 'application' ? { mx_surface: 'application' } : {}),
          ...(url.searchParams.get('select') === '1' && navigation.applicationForm === true ? { prompt: 'select_account' }
            : nativeStart || url.searchParams.get('switch') === '1' ? { prompt: 'login', max_age: '0' } : url.searchParams.get('select') === '1' ? { prompt: 'select_account' } : {})
        })
        await store.put('login', id, transaction, 300)
        response.setHeader('Set-Cookie', cookie(TX, id, 300))
        if (nativeStart) return json({ redirect: target.toString() })
        redirect(target.toString()); return true
      }
      if (path === '/auth/sso/interaction' && request.method === 'GET') {
        const id = cookies(request)[TX], transaction = await store.get('login', id)
        const flow = url.searchParams.get('flow')
        if (!transaction || !equal(transaction.state, url.searchParams.get('state')) || !/^[A-Za-z0-9_-]{43}$/.test(flow ?? ''))
          throw new AppError(400, 'account_flow_invalid', `登录页面已过期，请从${applicationName}重新登录。`)
        // Auth validates its own cookie; this separate state check binds the same browser to the application.
        transaction.flow = flow
        if (!await store.update('login', id, transaction)) throw new AppError(410, 'account_flow_expired', '登录已超时，请重新开始。')
        redirect(`${uiPath(transaction.uiPath)}?account=1${url.searchParams.get('error') === 'feishu' ? '&accountError=feishu' : ''}#/account`); return true
      }
      if (path === '/auth/sso/form' && ['GET', 'POST'].includes(request.method)) {
        const transaction = await store.get('login', cookies(request)[TX])
        if (!transaction?.flow) throw new AppError(410, 'account_flow_expired', '登录已超时，请重新开始。')
        if (request.method === 'GET') {
          const result = await accountClient()('options', { flow: transaction.flow, clientIp: clientIp(request) })
          return json({ ...result, csrf: transaction.formCsrf, formId: fingerprint(transaction.flow), view: transaction.view, ...(navigation.formContext?.(transaction) ?? {}) })
        }
        checkOrigin(request)
        const body = await readJson(request, 8192)
        if (!equal(transaction.formCsrf, request.headers[csrfHeader]) || !equal(fingerprint(transaction.flow), body.formId))
          throw new AppError(409, 'account_form_changed', '另一个页面已切换登录，请刷新后重试。')
        if (!['login', 'register', 'feishu', 'feishu-link'].includes(body.action)) throw new AppError(400, 'account_action_invalid', '操作无效。')
        const result = await accountClient()(body.action, { flow: transaction.flow, clientIp: clientIp(request),
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
        if (!equal(session.csrf, request.headers[csrfHeader])) throw new AppError(403, 'sso_csrf', '页面已过期，请刷新。')
        const body = await readJson(request, 4096)
        if (!['profile', 'password', 'unlink-feishu', 'revoke'].includes(body.action)) throw new AppError(400, 'account_action_invalid', '操作无效。')
        const result = await client(body.action, { accessToken: session.accessToken, clientIp: clientIp(request),
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
        const identity = await verified(session)
        const completion = await onAuthenticated?.({ identity, session, transaction }) ?? {}
        const returnUrl = localRedirect(completion.returnUrl ?? `${uiPath(transaction.uiPath)}?sso=ready${transaction.returnTo === 'account' ? '#/account' : ''}`)
        const old = cookies(request)[SID]; if (old) await store.remove('session', old)
        const sid = random(), seconds = Math.min(SESSION_TTL_SECONDS, tokens.expires_in)
        await store.put('session', sid, session, seconds)
        response.setHeader('Set-Cookie', [cookie(TX, '', 0), cookie(SID, sid, seconds), ...(completion.cookies ?? [])])
        redirect(returnUrl); return true
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
        if (session && !equal(session.csrf, request.headers[csrfHeader])) throw new AppError(403, 'sso_csrf', '退出验证失败，请刷新。')
        if (session) cache.delete(fingerprint(`${session.issuer ?? settings.previousProviders?.[0]?.issuer ?? settings.issuer}:${session.accessToken}`))
        await store.remove('session', cookies(request)[SID])
        response.setHeader('Set-Cookie', cookie(SID, '', 0)); response.writeHead(204).end(); return true
      }
      throw new AppError(404, 'not_found', 'Route not found')
    }
  }
}
