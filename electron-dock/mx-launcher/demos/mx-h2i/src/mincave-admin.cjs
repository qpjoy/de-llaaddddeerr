'use strict';

const failure = (code, message, status = 0) => Object.assign(new Error(message), { code, status, mincaveAccessError: true });
const userId = (auth) => String(auth?.subject || '').replace(/^user:/, '');
const emptyAccess = () => ({ status: 'checking', allowed: false, canManage: false, role: null });

function projectApplications(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).filter(app => {
    try {
      const url = new URL(app.url);
      return typeof app.id === 'string' && typeof app.name === 'string' &&
        typeof app.category === 'string' && typeof app.url === 'string' &&
        ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }).map(({ id, name, category, url, icon, color }) => ({
    id, name, category, url,
    icon: ['apps', 'triangle', 'layers', 'moon', 'compass', 'search', 'shield'].includes(icon) ? icon : 'apps',
    color: ['blue', 'purple', 'indigo', 'mint'].includes(color) ? color : 'purple',
  }));
}

// Bearer remains in the main process. These are MinCave routes, not Launcher SSO/BFF routes.
function createMincaveAdminBridge({
  getRuntime,
  getDevice = () => getRuntime().installation,
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
    const installation = getDevice();
    const device = installation?.deviceId ? Object.fromEntries(
      ['deviceId', 'deviceLabel', 'platform', 'deviceModel', 'osVersion'].map(key => [key, installation[key] || null]),
    ) : undefined;
    const result = await json(auth.accessToken, 'session', { method: 'POST', body: JSON.stringify(device ? { device } : {}) }, baseUrl);
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
        ...(result.applications !== undefined ? { applications: projectApplications(result.applications) } : {}),
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
          ...(retained && verified.access.applications ? { applications: verified.access.applications } : {}),
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
  async function devices() {
    const token = getRuntime().auth?.accessToken;
    const owner = userId(getRuntime().auth);
    try {
      const access = await refresh();
      current(token);
      if (access.status !== 'allowed' || !access.allowed)
        throw failure('devices_unavailable', '暂时无法获取设备，请稍后重试。');
      const value = await json(token, 'devices');
      current(token);
      if (value.userId !== owner || !Array.isArray(value.devices))
        throw failure('invalid_devices_response', '设备信息校验失败，请重试。');
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: error.code || 'unavailable', message: '暂时无法获取设备，请稍后重试。' } };
    }
  }
  async function request(input) {
    const token = getRuntime().auth?.accessToken;
    try {
      if (!input || !['workspace', 'saveMember', 'saveApplication', 'savePolicy'].includes(input.action))
        throw failure('invalid_action', '不支持此操作。');
      const access = await refresh();
      current(token);
      if (!access.canManage || access.status !== 'allowed')
        throw failure('management_forbidden', '暂无 MinCave 管理权限。');
      let value;
      if (input.action === 'workspace') value = await json(token, 'members');
      else if (input.action === 'saveApplication' || input.action === 'savePolicy') {
        const keys = input.action === 'saveApplication' ? ['name', 'url', 'category', 'published'] : ['name', 'department', 'appIds', 'action', 'enabled'];
        if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
            (input.id !== undefined && (typeof input.id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(input.id))) ||
            !input.value || typeof input.value !== 'object' || Array.isArray(input.value) ||
            Object.keys(input.value).some(key => !keys.includes(key)))
          throw failure('invalid_input', '管理信息不完整。');
        value = await json(token, 'workspace', { method: 'PATCH', body: JSON.stringify({
          revision: input.revision, kind: input.action === 'saveApplication' ? 'application' : 'policy',
          ...(input.id ? { id: input.id } : {}), value: input.value,
        }) });
        await refresh();
      } else {
        if (
          typeof input.id !== 'string' ||
          !input.id ||
          input.id.length > 200 ||
          !input.value ||
          !['admin', 'employee'].includes(input.value.role) ||
          typeof input.value.enabled !== 'boolean' ||
          Object.keys(input.value).some((key) => !['role', 'enabled', 'appIds'].includes(key)) ||
          (input.value.appIds !== undefined && (!Array.isArray(input.value.appIds) || input.value.appIds.length > 200 || input.value.appIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(id))))
        )
          throw failure('invalid_input', '只能修改 MinCave 角色、使用权限和应用授权。');
        value = await json(token, `members/${encodeURIComponent(input.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: input.value.role, enabled: input.value.enabled, ...(input.value.appIds !== undefined ? { appIds: input.value.appIds } : {}) }),
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
  return { request, devices, refresh, snapshot, checkLogin };
}
module.exports = { createMincaveAdminBridge };
