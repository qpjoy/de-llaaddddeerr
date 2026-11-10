'use strict';

const failure = (code, message, status = 0) => Object.assign(new Error(message), { code, status, mincaveAccessError: true });
const userId = (auth) => String(auth?.subject || '').replace(/^user:/, '');
const emptyAccess = () => ({ status: 'checking', allowed: false, canManage: false, role: null });

// Bearer remains in the main process. These are MinCave routes, not Launcher SSO/BFF routes.
function createMincaveAdminBridge({
  getRuntime,
  fetch,
  resolveBaseUrl,
  onChange = () => {},
  onDenied = () => {},
}) {
  let verified = null;
  let state = emptyAccess();
  let stateToken = null;
  let refreshing = null;
  let cleanupToken = null;
  async function json(token, path, options = {}, baseUrl) {
    if (!token) throw failure('feishu_login_required', '请使用飞书重新登录。', 401);
    const base = baseUrl || (await resolveBaseUrl());
    const response = await fetch(new URL(`/internal/v1/mincave/${path}`, base).toString(), {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      ...options,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw failure(
        body.code || `http_${response.status}`,
        typeof body.message === 'string' ? body.message : 'MinCave 服务暂不可用。',
        response.status,
      );
    return body;
  }
  function current(token) {
    if (!token || getRuntime().auth?.accessToken !== token)
      throw failure('identity_changed', '当前登录已变化，请重试。', 401);
  }
  async function checkLogin(auth, baseUrl, options = {}) {
    if (auth?.provider !== 'feishu')
      throw failure('feishu_login_required', '请使用飞书登录 MinCave。', 401);
    const result = await json(auth.accessToken, 'session', { method: 'POST', body: '{}' }, baseUrl);
    if (
      result.allowed !== true ||
      !['admin', 'employee'].includes(result.role) ||
      result.canManage !== (result.role === 'admin') ||
      result.userId !== userId(auth)
    ) {
      throw failure('invalid_access_response', 'MinCave 权限校验失败。', 403);
    }
    if (options.requireCurrent) current(auth.accessToken);
    verified = {
      token: auth.accessToken,
      access: {
        status: 'allowed',
        allowed: true,
        canManage: result.canManage,
        role: result.role,
        userId: result.userId,
      },
    };
    cleanupToken = null;
    state = verified.access;
    stateToken = auth.accessToken;
    onChange();
    return state;
  }
  function snapshot() {
    const token = getRuntime().auth?.accessToken;
    return token && token === stateToken ? { ...state } : emptyAccess();
  }
  async function refresh() {
    const auth = getRuntime().auth;
    const token = auth?.accessToken;
    if (!token) {
      verified = null;
      stateToken = null;
      state = emptyAccess();
      return snapshot();
    }
    if (refreshing?.token === token) return refreshing.promise;
    const promise = (async () => {
      try {
        const result = await checkLogin(auth, undefined, { requireCurrent: true });
        current(token);
        return result;
      } catch (error) {
        if (getRuntime().auth?.accessToken !== token) return snapshot();
        const rejected = [401, 403].includes(error.status);
        const retained =
          !rejected &&
          verified?.token === token &&
          (getRuntime().connection?.state === 'connected' ||
            getRuntime().connection?.wireGuard?.active === true);
        stateToken = token;
        state = {
          status: rejected ? 'denied' : 'unavailable',
          allowed: Boolean(retained),
          canManage: false,
          role: retained ? verified.access.role : null,
          code: error.code || 'unavailable',
          message: rejected ? error.message : 'MinCave 服务暂不可用，请稍后重试。',
        };
        if (rejected) verified = null;
        onChange();
        // Cleanup runs independently; snapshot must remain denied while OS authorization is pending.
        if (rejected && cleanupToken !== token) {
          cleanupToken = token;
          void Promise.resolve()
            .then(() => onDenied(token, error))
            .then((started) => {
              if (started === false && cleanupToken === token) cleanupToken = null;
            })
            .catch(() => {});
        }
        return snapshot();
      }
    })();
    refreshing = { token, promise };
    try {
      return await promise;
    } finally {
      if (refreshing?.promise === promise) refreshing = null;
    }
  }
  async function request(input) {
    const token = getRuntime().auth?.accessToken;
    try {
      if (!input || !['workspace', 'saveMember'].includes(input.action))
        throw failure('invalid_action', '不支持此操作。');
      const access = await refresh();
      current(token);
      if (!access.canManage || access.status !== 'allowed')
        throw failure('management_forbidden', '暂无 MinCave 管理权限。');
      let value;
      if (input.action === 'workspace') value = await json(token, 'members');
      else {
        if (
          typeof input.id !== 'string' ||
          !input.id ||
          input.id.length > 200 ||
          !input.value ||
          !['admin', 'employee'].includes(input.value.role) ||
          typeof input.value.enabled !== 'boolean' ||
          Object.keys(input.value).some((key) => !['role', 'enabled'].includes(key))
        )
          throw failure('invalid_input', '只能修改 MinCave 角色和使用权限。');
        value = await json(token, `members/${encodeURIComponent(input.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: input.value.role, enabled: input.value.enabled }),
        });
        await refresh();
      }
      current(token);
      return { ok: true, value };
    } catch (error) {
      if ([401, 403].includes(error.status) && getRuntime().auth?.accessToken === token) {
        state = {
          ...emptyAccess(),
          status: error.status === 401 ? 'denied' : 'allowed',
          allowed: error.status !== 401,
          code: error.code,
          message: error.message,
        };
        stateToken = token;
        onChange();
        void refresh();
      }
      return {
        ok: false,
        error: {
          code: error.code || 'unavailable',
          message: error.code ? error.message : 'MinCave 服务暂不可用。',
        },
      };
    }
  }
  return { request, refresh, snapshot, checkLogin };
}
module.exports = { createMincaveAdminBridge };
