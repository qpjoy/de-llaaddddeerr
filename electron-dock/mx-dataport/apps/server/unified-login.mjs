import { SsoError, readSsoJson } from '@qpjoy/mx-common/identity/http';
import { localOrigin } from './local-auth.mjs';

// Routing is private to the BFF. Never send a password to both identity stores
// or try a different identity after an authentication failure.
export async function unifiedLogin(req, res, url, integration, localAuth, sso, json) {
  const preparing = url.pathname === '/auth/login/prepare';
  if (url.pathname !== '/auth/login' && !preparing) return false;
  if (req.method !== 'POST') throw new SsoError(405, 'method_not_allowed', '请使用登录表单。');
  if (url.search) throw new SsoError(400, 'invalid_query', '此账号操作不接受查询参数。');
  localOrigin(req, integration);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new SsoError(415, 'invalid_content_type', '请使用 JSON 请求。');
  const body = await readSsoJson(req, 4096);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !(preparing ? ['login'] : ['login','password','inviteCode','formId']).includes(k))
    || typeof body.login !== 'string' || !body.login.trim() || body.login.length > 255
    || (!preparing && (typeof body.password !== 'string' || !body.password || body.password.length > 128))
    || (body.inviteCode !== undefined && (typeof body.inviteCode !== 'string' || body.inviteCode.length > 128))
    || (body.formId !== undefined && (typeof body.formId !== 'string' || body.formId.length > 128)))
    throw new SsoError(400, 'invalid_login', '请填写有效账号和密码。');
  if (!sso?.resolveLogin || !sso?.login) throw new SsoError(503, 'account_routing_unavailable', '账号服务需要更新，请联系管理员。');
  body.login = body.login.trim();
  body.inviteCode = body.inviteCode?.trim();
  const [local, mx] = await Promise.all([
    localAuth.resolveLogin(integration, req, body.login),
    sso.resolveLogin(req, body.login),
  ]);
  if (local && mx) throw new SsoError(409, 'account_name_conflict', '账号在两套认证系统中重名，请联系管理员处理。');
  if (preparing) {
    if (mx) {
      if (!sso.prepareLogin) throw new SsoError(503, 'account_routing_unavailable', '账号服务需要更新，请联系管理员。');
      return sso.prepareLogin(req, res, body.login);
    }
    json(200, {ready:true});
    return true;
  }
  if (!local && !mx) throw new SsoError(401, 'login_failed', '账号或密码不正确，或账号不可用。');
  if (local) return localAuth.login(integration, req, res, {account:body.login,password:body.password}, json);
  return sso.login(req, res, body);
}
