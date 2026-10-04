export function adminAccessPresentation(error) {
  if (error?.code === 'management_forbidden') return {
    title: '已登录，等待管理授权', connection: '已连接', health: 'blocked', internal: '可达',
    next: '请由管理员在“成员与访问 → 用户与账号”中将需要管理工作台的账号设为 MX Admin（mx-admin），然后刷新。也可以退出后切换账号。'
  };
  if (['session_required', 'reauth_required'].includes(error?.code)) return {
    title: '请验证个人身份', connection: '需要登录', health: 'blocked', internal: '可达', next: '请在右上角账号菜单登录或重新验证。'
  };
  if (error?.code === 'binding_required') return {
    title: '请关联已有账号', connection: '需要关联', health: 'blocked', internal: '可达', next: '请在右上角账号菜单完成账号关联。'
  };
  if (error?.code === 'sso_unavailable') return {
    title: '个人登录暂不可用', connection: '待重试', health: 'failed', internal: '待确认', next: '请刷新页面重试，或检查身份服务连接。'
  };
  return { title: 'Admin API unavailable', connection: 'Offline', health: 'failed', internal: 'offline', next: 'Reconnect Internal before running gated actions.' };
}

/** Same-origin BFF only. No bearer token or credential is stored in the browser. */
export function createAdminSessionUi({ serverBase, root = document, onChange = () => {} }) {
  const panel = root.getElementById('admin-account');
  const status = root.getElementById('admin-account-status');
  const login = root.getElementById('admin-account-login');
  const logout = root.getElementById('admin-account-logout');
  const switchAccount = root.getElementById('admin-account-switch');
  const dialog = root.getElementById('admin-account-link');
  const form = root.getElementById('admin-account-link-form');
  const feedback = root.getElementById('admin-account-link-feedback');
  let session = null;
  let revision = 0;
  let refreshing = null;
  const sameOrigin = () => {
    try { return ['http:', 'https:'].includes(location.protocol) && new URL(serverBase()).origin === location.origin; }
    catch { return false; }
  };
  const secureEntry = () => {
    try {
      const url = new URL(session?.loginOrigin);
      return url.protocol === 'https:' && !url.username && !url.password && url.origin !== location.origin ? `${url.origin}/admin/` : null;
    } catch { return null; }
  };
  const request = async (path, body) => {
    if (!sameOrigin()) throw new Error('请在 MX Server 同源的 /admin/ 页面使用个人登录。');
    const response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(body ? 15000 : 5000),
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-mx-admin-csrf': session?.csrf || '' }, body: JSON.stringify(body) } : {})
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '个人登录请求失败');
    return payload;
  };
  const accessError = (hasOpsToken = false) => {
    if (!sameOrigin() || secureEntry() || (hasOpsToken && session?.accessMode !== 'sso-only')) return null;
    if (session?.unavailable) return Object.assign(new Error('个人登录状态暂不可用，请刷新页面重试。'), { code: 'sso_unavailable', status: 503 });
    if (!session?.enabled) return null;
    if (!session.authenticated) return Object.assign(new Error('请先在右上角登录个人账号，再读取管理数据。'), { code: 'session_required', status: 401 });
    if (session.bindingRequired) return Object.assign(new Error('请先关联已有 MX 账号，再读取管理数据。'), { code: 'binding_required', status: 401 });
    if (!session.canManage) return Object.assign(new Error('已登录；此账号尚未获得 Launcher 管理权限。'), { code: 'management_forbidden', status: 403 });
    return null;
  };
  const render = () => {
    if (!panel) return;
    panel.hidden = false;
    login.hidden = !session?.enabled;
    logout.hidden = !session?.authenticated;
    if (switchAccount) switchAccount.hidden = !session?.authenticated;
    const sessionsLink = root.getElementById('admin-account-sessions');
    if (sessionsLink) {
      const visible = session?.authenticated && session.authMethod !== 'ops-token' && session.securityUrl;
      sessionsLink.hidden = !visible;
      if (visible) sessionsLink.href = session.securityUrl;
      else sessionsLink.removeAttribute('href');
    }
    if (!sameOrigin()) status.textContent = '个人登录请打开服务器的 /admin/ 管理入口';
    else if (session?.unavailable) status.textContent = '个人登录状态暂不可用，请刷新页面重试';
    else if (!session?.enabled) status.textContent = '个人 SSO 待启用';
    else if (secureEntry()) status.textContent = '个人登录已就绪，请使用 HTTPS 管理入口';
    else if (!session.authenticated) status.textContent = '登录个人账号，使用已获授权的管理功能';
    else if (session.bindingRequired) status.textContent = '统一登录已验证 · 请关联已有 MX 账号';
    else status.textContent = `${session.user.displayName} · ${session.canManage ? '管理权限已生效' : '已登录，尚无工作台管理权限'}`;
    status.title = session?.authenticated && !session?.bindingRequired && !session?.canManage
      ? '请由管理员在“成员与访问 → 用户与账号”中授予 MX Admin（mx-admin）。普通应用账号不会自动成为管理员。可退出后登录其他账号。' : '';
    login.textContent = secureEntry() ? '打开安全管理入口' : session?.bindingRequired ? '关联已有账号' : session?.authenticated ? '重新验证' : '个人账号登录';
    onChange();
  };
  async function loadSession() {
    const current = ++revision;
    if (!sameOrigin()) { session = null; render(); return; }
    try {
      const value = await request('/auth/admin/session');
      if (current !== revision || !sameOrigin()) return;
      session = value;
    } catch { if (current === revision) session = { ...session, authenticated: false, unavailable: true }; }
    if (current === revision) render();
  }
  function refresh() {
    if (refreshing) return refreshing;
    const pending = loadSession().finally(() => { if (refreshing === pending) refreshing = null; });
    refreshing = pending;
    return pending;
  }
  login?.addEventListener('click', () => {
    if (!sameOrigin()) return;
    if (session?.authMethod === 'ops-token') { logout.click(); return; }
    if (secureEntry()) location.assign(secureEntry());
    else if (session?.bindingRequired) { feedback.textContent = ''; dialog.showModal(); }
    else location.assign('/auth/admin/login');
  });
  logout?.addEventListener('click', async () => {
    logout.disabled = true;
    try { await request('/auth/admin/logout', {}); location.reload(); }
    catch (error) { status.textContent = error.message; }
    finally { logout.disabled = false; }
  });
  switchAccount?.addEventListener('click', () => { location.assign('/auth/admin/login?select=1'); });
  root.getElementById('admin-account-link-cancel')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('close', () => form.reset());
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    feedback.textContent = '正在验证账号…';
    try {
      await request('/auth/admin/link', { login: form.elements.login.value, password: form.elements.password.value });
      form.reset();
      location.reload();
    } catch (error) { feedback.textContent = error.message; form.elements.password.value = ''; }
    finally { button.disabled = false; }
  });
  return {
    async refresh() {
      await refresh();
      const url = new URL(location.href);
      if (url.searchParams.has('sso_error')) {
        session = { ...session, errorMessage: '登录验证未完成，请重新登录；原有账号不受影响。' };
        render();
        status.textContent = session.errorMessage;
        url.searchParams.delete('sso_error');
        history.replaceState(null, '', url);
      }
    },
    reset() { revision++; session = null; refreshing = null; dialog?.close(); render(); },
    entry() { return sameOrigin() ? session : null; },
    async signInWithOps(token) { await request('/auth/admin/ops-login', { token }); await refresh(); },
    accessError,
    async prepare(url, headers, hasOpsToken) {
      if (!sameOrigin() || url.origin !== location.origin || !url.pathname.startsWith('/internal/v1/')) return false;
      if (!session || refreshing) {
        const pending = refresh(), expectedRevision = revision;
        await pending;
        if (revision !== expectedRevision) throw new Error('连接地址已变化，请重新操作。');
      }
      if (!sameOrigin() || url.origin !== new URL(serverBase()).origin) throw new Error('连接地址已变化，请重新操作。');
      const error = accessError(hasOpsToken);
      if (error) throw error;
      // Public management never falls back to the raw Internal API, including
      // after logout/expiry or when an emergency token was entered by mistake.
      if (session?.enabled && !secureEntry() && (!hasOpsToken || session.accessMode === 'sso-only')) {
        url.pathname = `/admin-api${url.pathname}`;
        for (const name of Object.keys(headers)) if (name.toLowerCase() === 'x-mx-ops-token') delete headers[name];
        headers['x-mx-admin-csrf'] = session.csrf;
        return true;
      }
      return false;
    },
    async rejected(payload) {
      // Never replay an operation after authentication changes.
      if (payload?.code === 'reauth_required') { status.textContent = payload.message; login.hidden = false; login.textContent = '重新验证'; }
      else if (['session_required', 'management_forbidden'].includes(payload?.code)) await refresh();
    }
  };
}
