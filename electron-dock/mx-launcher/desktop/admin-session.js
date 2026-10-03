export function adminAccessPresentation(error) {
  if (error?.code === 'management_forbidden') return {
    title: '已登录，等待管理授权', connection: '已连接', health: 'blocked', internal: '可达',
    next: '请由管理员在“成员与访问 → 用户与账号”中将需要管理工作台的账号设为 MX Admin（mx-admin），然后刷新。也可以退出后切换账号。'
  };
  if (['session_required', 'reauth_required'].includes(error?.code)) return {
    title: '请验证个人身份', connection: '需要登录', health: 'blocked', internal: '可达', next: '请在左侧个人账号区域登录或重新验证。'
  };
  return { title: 'Admin API unavailable', connection: 'Offline', health: 'failed', internal: 'offline', next: 'Reconnect Internal before running gated actions.' };
}

/** Same-origin BFF only. No bearer token or credential is stored in the browser. */
export function createAdminSessionUi({ serverBase, root = document }) {
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
  const render = () => {
    if (!panel) return;
    panel.hidden = false;
    login.hidden = !session?.enabled;
    logout.hidden = !session?.authenticated;
    if (switchAccount) switchAccount.hidden = !session?.authenticated;
    if (!sameOrigin()) status.textContent = '个人登录请打开服务器的 /admin/ 管理入口';
    else if (!session?.enabled) status.textContent = session?.unavailable ? '个人登录暂不可用 · 可使用应急访问' : '个人 SSO 待启用';
    else if (secureEntry()) status.textContent = '个人登录已就绪，请使用 HTTPS 管理入口';
    else if (!session.authenticated) status.textContent = '登录个人账号，使用已获授权的管理功能';
    else if (session.bindingRequired) status.textContent = '统一登录已验证 · 请关联已有 MX 账号';
    else status.textContent = `${session.user.displayName} · ${session.canManage ? '管理权限已生效' : '已登录，尚无工作台管理权限'}`;
    status.title = session?.authenticated && !session?.bindingRequired && !session?.canManage
      ? '请由管理员在“成员与访问 → 用户与账号”中授予 MX Admin（mx-admin）。普通应用账号不会自动成为管理员。可退出后登录其他账号。' : '';
    login.textContent = secureEntry() ? '打开安全管理入口' : session?.bindingRequired ? '关联已有账号' : session?.authenticated ? '重新验证' : '个人账号登录';
  };
  async function refresh() {
    const current = ++revision;
    if (!sameOrigin()) { session = null; render(); return; }
    try {
      const value = await request('/auth/admin/session');
      if (current !== revision || !sameOrigin()) return;
      session = value;
    } catch { if (current === revision) session = { unavailable: true }; }
    if (current === revision) render();
  }
  login?.addEventListener('click', () => {
    if (!sameOrigin()) return;
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
  switchAccount?.addEventListener('click', async () => {
    switchAccount.disabled = true;
    try {
      await request('/auth/admin/logout', {});
      session = null;
      location.assign('/auth/admin/login');
    } catch (error) { status.textContent = error.message; }
    finally { switchAccount.disabled = false; }
  });
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
        status.textContent = '登录验证未完成，请重新登录；原有账号不受影响。';
        url.searchParams.delete('sso_error');
        history.replaceState(null, '', url);
      }
    },
    reset() { revision++; session = null; dialog?.close(); render(); },
    prepare(url, headers, hasOpsToken) {
      if (!hasOpsToken && session?.authenticated && sameOrigin() && url.origin === location.origin
        && url.pathname.startsWith('/internal/v1/')) {
        url.pathname = `/admin-api${url.pathname}`;
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
