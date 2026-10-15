import {createApplicationSso} from '@qpjoy/mx-common/identity/sso'
import {readApplicationSsoProfile} from '@qpjoy/mx-common/identity/profile'
import {SsoStore} from '../identity/sso-store.mjs'
import {capabilitiesForRole} from '../identity/index.mjs'
import {AppError} from '../core/errors.mjs'
import {secureEqual} from '../core/crypto.mjs'
import {readFileSync} from 'node:fs'
// This Symbol is never derived from headers, cookies, query parameters or JSON.
export const portalPrincipal = Symbol('verified-harbor-principal')
const reads = new Set(['/session','/me/usage','/documentation','/commerce/products','/payments/return-order'])
export function harborRoute(method,path,searchParams) {
  const read=method==='GET'&&(reads.has(path)||/^\/commerce\/tenants\/[0-9a-f-]{36}\/messages$/.test(path))
  const write=method==='POST'&&/^\/commerce\/tenants\/[0-9a-f-]{36}\/messages\/[1-9][0-9]{0,17}\/read$/.test(path)
  if(!read&&!write)throw new AppError(404,'portal_route_unavailable','此客户功能尚未开放。')
  if(write&&searchParams.size)throw new AppError(400,'invalid_query','此操作不接受查询参数。')
  if(path==='/documentation'&&(searchParams.size!==2||searchParams.getAll('tenantId').length!==1||!searchParams.get('tenantId')||searchParams.get('path')!=='/docs/openapi.json'))throw new AppError(404,'not_found','请使用数港接口文档。')
  return `/internal/v1/admin${path}`
}
/** Disabled unless explicitly configured. Verifies both the BFF credential and a fresh,
 * subject/audience-bound Auth UserInfo response; never trusts asserted roles. */
function configuredPortal({pool,store,settings,token,hubSettings,oidcConfiguration}) {
  if(!pool||!hubSettings||typeof token!=='string'||token.length<32)throw new Error('Harbor portal requires database, retained Hub identity settings and a dedicated gateway credential')
  if(!settings)throw new Error('Harbor profile required')
  if(settings.appId!=='mx-harbor'||settings.audience===hubSettings.audience||settings.issuer!==hubSettings.issuer)throw new Error('Harbor portal identity does not match the configured shared authority')
  const sessions=new SsoStore(pool,settings.sessionKey)
  const verifier=createApplicationSso({settings,store:sessions,oidcConfiguration,ErrorClass:AppError,validateIdentity(value){if(value.mxIdentity.issuer!==hubSettings.legacyIssuer)throw new AppError(401,'invalid_identity','统一身份来源不匹配。')}})
  return {
    async resolve(request, {catalogOnly=false}={}) {
      if(!secureEqual(request.headers['x-mx-harbor-gateway'],token))throw new AppError(401,'portal_auth_required','客户服务认证失败。')
      if(catalogOnly)return null
      const accessToken=/^Bearer ([^\s]+)$/.exec(String(request.headers.authorization||''))?.[1],subject=request.headers['x-mx-harbor-subject']
      if(!accessToken||typeof subject!=='string'||subject.length>160)throw new AppError(401,'portal_session_required','请重新登录。')
      const verified=await verifier.verifySession({accessToken,subject,issuer:settings.issuer},true)
      const memberId=await sessions.provision({issuer:settings.issuer,subject,clientId:settings.clientId,canonical:verified.mxIdentity,sharedAudience:hubSettings.audience,personalTenant:false})
      const memberships=(await store.listTenantMemberships(memberId)).filter(m=>m.status==='active').map(m=>({...m,capabilities:capabilitiesForRole(m.role)}))
      return {kind:'launcher-user',memberId,displayName:verified.displayName,subject:verified.mxIdentity.subject,issuer:verified.mxIdentity.issuer,platformAdmin:false,dataportPlatformAdmin:verified.mxIdentity.principal.scopes.includes('mx:dataport:admin'),tenantIds:memberships.map(m=>m.tenantId),memberships,capabilities:[...new Set(memberships.flatMap(m=>m.capabilities))],portalOrigin:settings.origin,portalAudience:hubSettings.audience}
    }
  }
}

// Optional enrollment must never block Hub startup or its own browser SSO.
// Secret volumes can appear/change after deployment; revalidate on each Portal request.
export function createHarborPortal({profileFile,token,tokenFile,...options}) {
  if(!profileFile&&!token&&!tokenFile)return null
  let cached,revision
  return {
    async resolve(request, resolveOptions) {
      let portal
      try {
        const settings=readApplicationSsoProfile(profileFile)
        const credential=tokenFile?readFileSync(tokenFile,'utf8').trim():token
        const next=JSON.stringify([settings,credential])
        if(!cached||next!==revision){
          cached=configuredPortal({...options,settings,token:credential})
          revision=next
        }
        portal=cached
      } catch {
        throw new AppError(503,'portal_unavailable','数港客户服务尚未接入或配置无效。')
      }
      return portal.resolve(request, resolveOptions)
    }
  }
}
