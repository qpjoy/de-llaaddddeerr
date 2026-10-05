import { createHmac } from 'node:crypto'
import { createApplicationSso } from '@qpjoy/mx-common/identity/sso'
import { random, cookie, cookies, equal } from '@qpjoy/mx-common/identity/http'
import { AppError } from '../core/errors.mjs'
import { SsoStore } from './sso-store.mjs'
import { TenantInvitations } from './tenant-invitations.mjs'
import { readJson } from '../core/http.mjs'
import { hubUiPath } from '../../shared/account-navigation.mjs'

export { readSsoProfile } from './sso-config.mjs'
const INV = '__Host-mx_hub_invitation'

// Hub owns legacy member binding, tenant provisioning and explicit invitations.
// The common SSO module owns the protocol, cookies, account operations and sessions.
export function createSso({ settings, pool, identity, oidcConfiguration, adminToken }) {
  if (!settings) return null
  if (!pool) throw new Error('Hub SSO requires PostgreSQL')
  const store = new SsoStore(pool, settings.sessionKey)
  const invitations = new TenantInvitations({pool,sessions:store,origin:settings.origin,adminToken})
  const invitationAttempts = new Map()
  // Only the verified, audience-bound browser SSO identity can delegate this application role.
  const resolveIdentity = canonical => identity.resolveVerified(canonical, {
    applicationAdmin: canonical.audience === settings.audience && canonical.principal.scopes.includes('mx:hub:admin')
  })
  const sso = createApplicationSso({
    settings: { ...settings, appId: 'mx-insight-hub', scope: 'openid mx:hub' }, store, oidcConfiguration,
    clientIp: request => String(request.headers['x-forwarded-for'] || request.socket.remoteAddress).split(',')[0].trim(),
    ErrorClass: AppError, applicationName: 'Hub', csrfHeader: 'x-mx-hub-csrf',
    cookieNames: { session: '__Host-mx_hub_sso', login: '__Host-mx_hub_login' },
    navigation: { mounts: ['/', '/admin/'], formContext: transaction => ({ invited: Boolean(transaction.invitation) }) },
    validateIdentity(value) {
      if (value.mxIdentity.issuer !== settings.legacyIssuer) throw new AppError(401, 'sso_identity_invalid', '统一身份验证不匹配。')
    },
    resolvePrincipal: value => resolveIdentity(value.mxIdentity),
    async prepareLogin({ request, url, transaction }) {
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
      return registrationHandle ? { mx_invitation: registrationHandle } : {}
    },
    async onAuthenticated({ identity: value, session, transaction }) {
      await store.provision({ issuer: settings.issuer, subject: session.subject, clientId: settings.clientId,
        canonical: value.mxIdentity, personalTenant: settings.personalTenant === true && !transaction.invitation })
      return {
        cookies: transaction.invitation ? [cookie(INV,transaction.invitation,1800)] : [],
        returnUrl: `${hubUiPath(transaction.uiPath)}?sso=ready${transaction.invitation ? '#/join' : transaction.returnTo === 'account' ? '#/account' : ''}`
      }
    }
  })
  const { sessionFor, checkOrigin } = sso
  const verified = async (session, fresh) => (await sso.verifySession(session, fresh)).mxIdentity
  return {
    store, invitations, principal: sso.principal,
    async handle(request, response, url) {
      if (!url.pathname.startsWith('/auth/sso/invitation')) return sso.handle(request, response, url)
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer')
      const path = url.pathname
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
          try { principal = await resolveIdentity(await verified(session,true)) }
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
        const principal = await resolveIdentity(await verified(session,true))
        const accepted = await invitations.accept(principal,context.token)
        identity.client?.invalidate?.()
        // Keep the short context for idempotent retry if the success response is lost.
        return json({...accepted,returnUrl:`${hubUiPath(body.ui)}?sso=ready#/${accepted.role==='billing' ? 'payments' : 'my'}?tenantId=${accepted.tenantId}`})
      }
      throw new AppError(404, 'not_found', 'Route not found')
    }
  }
}
