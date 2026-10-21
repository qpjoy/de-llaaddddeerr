import { SsoError, cookies, cookie, equal, readSsoJson } from '@qpjoy/mx-common/identity/http';

export const LOCAL_COOKIE = '__Host-mx_dataport_local';
export const localToken = req => cookies(req)[LOCAL_COOKIE];
export function localOrigin(req, integration) {
  if (!integration.sso?.origin || req.headers.origin !== integration.sso.origin || req.headers['sec-fetch-site'] === 'cross-site')
    throw new SsoError(403, 'sso_origin', '请从数港页面提交操作。');
}
export function createLocalAuth(fetcher) {
  async function call(integration, req, path, body) {
    if (!integration.upstream || !integration.gatewayToken)
      throw new SsoError(503, 'customer_service_unavailable', '数港账号服务尚未就绪。');
    let response, value;
    try {
      response = await fetcher(`${integration.upstream}/internal/v1/portal/local/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'x-mx-harbor-gateway': integration.gatewayToken,
          ...(localToken(req) ? {'x-mx-dataport-local-session': localToken(req)} : {}),
          ...(req.headers['x-mx-csrf'] ? {'x-mx-csrf': String(req.headers['x-mx-csrf'])} : {}),
          ...(body !== undefined ? {'content-type':'application/json'} : {}) },
        ...(body !== undefined ? {body:JSON.stringify(body)} : {})
      });
      value = await response.json();
    } catch { throw new SsoError(503, 'local_auth_unconfirmed', '账号服务响应尚未确认，请稍后重试。'); }
    if (!response.ok) {
      const code=value.code || value.error?.code || 'local_auth_unavailable';
      // Never expose upstream server internals or credentials.
      throw new SsoError(response.status, code, response.status >= 500 ? '数港账号服务暂不可用，请稍后重试。' : value.message || value.error?.message || '账号操作失败。');
    }
    if (!value.data || typeof value.data !== 'object') throw new SsoError(503,'local_auth_unavailable','账号服务响应无效。');
    return value.data;
  }
  return {
    session: (integration,req) => call(integration,req,'session'),
    async handle(req,res,url,integration,json) {
      const token=localToken(req), path=url.pathname;
      const login=path==='/auth/local/login';
      const localAccount=token && ['/auth/sso/session','/auth/sso/account','/auth/sso/logout'].includes(path);
      if (!login && !localAccount) return false;
      if (url.search) throw new SsoError(400,'invalid_query','此账号操作不接受查询参数。');
      if (login) {
        if (req.method !== 'POST') throw new SsoError(405,'method_not_allowed','请使用登录表单。');
        localOrigin(req,integration);
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new SsoError(415,'invalid_content_type','请使用 JSON 请求。');
        const result=await call(integration,req,'login',await readSsoJson(req,2048));
        if (!/^[A-Za-z0-9_-]{43}$/.test(result.token || '') || typeof result.csrf!=='string') throw new SsoError(503,'local_auth_unavailable','账号服务响应无效。');
        res.setHeader('set-cookie',[cookie(LOCAL_COOKIE,result.token,30*86400),cookie('__Host-mx-harbor_sso','',0),cookie('__Host-mx-harbor_login','',0)]);
        json(200,{redirect:'/#/intelligence'});
        return true;
      }
      if (path==='/auth/sso/session' && req.method==='GET') {
        try {
          const session=await call(integration,req,'session');
          json(200,{active:true,csrf:session.csrf,identityProvider:'dataport-local'});
        } catch(error) {
          if(error.status!==401)throw error;
          res.setHeader('set-cookie',cookie(LOCAL_COOKIE,'',0));
          json(200,{active:false});
        }
        return true;
      }
      if (req.method==='POST') {
        localOrigin(req,integration);
        const session=await call(integration,req,'session');
        if(!equal(session.csrf,req.headers['x-mx-csrf']))throw new SsoError(403,'sso_csrf','页面会话已变化，请刷新后重试。');
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new SsoError(415,'invalid_content_type','请使用 JSON 请求。');
        const result=await call(integration,req,path.endsWith('/logout')?'logout':'account',await readSsoJson(req,4096));
        if(result.signedOut)res.setHeader('set-cookie',[cookie(LOCAL_COOKIE,'',0),cookie('__Host-mx-harbor_sso','',0)]);
        json(200,result);
        return true;
      }
      if (path==='/auth/sso/account' && req.method==='GET') { json(200,await call(integration,req,'account')); return true; }
      throw new SsoError(405,'method_not_allowed','账号操作方式无效。');
    }
  };
}
