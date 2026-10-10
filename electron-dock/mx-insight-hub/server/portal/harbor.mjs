import {createApplicationSso} from '@qpjoy/mx-common/identity/sso'
import {readApplicationSsoProfile} from '@qpjoy/mx-common/identity/profile'
import {SsoStore} from '../identity/sso-store.mjs'
import {capabilitiesForRole} from '../identity/index.mjs'
import {AppError} from '../core/errors.mjs'
import {secureEqual} from '../core/crypto.mjs'
// This Symbol is never derived from headers, cookies, query parameters or JSON.
export const portalPrincipal = Symbol('verified-harbor-principal')
const reads = new Set(['/session','/me/overview','/api-keys','/tenants','/consumers','/usage','/documentation','/commerce/products'])
export function harborRoute(method,path,searchParams) {
  if(method!=='GET'||(!reads.has(path)&&!/^\/commerce\/tenants\/[0-9a-f-]{36}$/.test(path)))throw new AppError(404,'portal_route_unavailable','此客户功能尚未开放。')
  if(path==='/documentation'&&(searchParams.size!==1||searchParams.get('path')!=='/docs/openapi.json'))throw new AppError(404,'not_found','请使用数港接口文档。')
  return `/internal/v1/admin${path}`
}
/** Disabled unless explicitly configured. Verifies both the BFF credential and a fresh,
 * subject/audience-bound Auth UserInfo response; never trusts asserted roles. */
export function createHarborPortal({pool,store,profileFile,token,hubSettings,oidcConfiguration}) {
  if(!profileFile&&!token)return null
  if(!pool||!hubSettings||typeof token!=='string'||token.length<32)throw new Error('Harbor portal requires database, retained Hub identity settings and a dedicated gateway credential')
  const settings=readApplicationSsoProfile(profileFile)
  if(settings.appId!=='mx-harbor'||settings.audience===hubSettings.audience||settings.issuer!==hubSettings.issuer)throw new Error('Harbor portal identity does not match the configured shared authority')
  const sessions=new SsoStore(pool,settings.sessionKey)
  const verifier=createApplicationSso({settings,store:sessions,oidcConfiguration,ErrorClass:AppError,validateIdentity(value){if(value.mxIdentity.issuer!==hubSettings.legacyIssuer)throw new AppError(401,'invalid_identity','统一身份来源不匹配。')}})
  return {
    async resolve(request) {
      if(!secureEqual(request.headers['x-mx-harbor-gateway'],token))throw new AppError(401,'portal_auth_required','客户服务认证失败。')
      const accessToken=/^Bearer ([^\s]+)$/.exec(String(request.headers.authorization||''))?.[1],subject=request.headers['x-mx-harbor-subject']
      if(!accessToken||typeof subject!=='string'||subject.length>160)throw new AppError(401,'portal_session_required','请重新登录。')
      const verified=await verifier.verifySession({accessToken,subject,issuer:settings.issuer},true)
      const memberId=await sessions.provision({issuer:settings.issuer,subject,clientId:settings.clientId,canonical:verified.mxIdentity,sharedAudience:hubSettings.audience,personalTenant:hubSettings.personalTenant===true})
      const memberships=(await store.listTenantMemberships(memberId)).filter(m=>m.status==='active').map(m=>({...m,capabilities:capabilitiesForRole(m.role)}))
      return {kind:'launcher-user',memberId,displayName:verified.displayName,subject:verified.mxIdentity.subject,issuer:verified.mxIdentity.issuer,platformAdmin:false,tenantIds:memberships.map(m=>m.tenantId),memberships,capabilities:[...new Set(memberships.flatMap(m=>m.capabilities))],portalOrigin:settings.origin}
    }
  }
}
