const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const modes = { closed: '关闭注册', invite_code: '邀请码注册', open: '开放注册' };
export function createRegistrationUi({ request, root = document }) {
  const dialog = root.createElement('dialog');
  dialog.className = 'admin-account-dialog registration-dialog';
  dialog.setAttribute('aria-label', '注册与邀请');
  root.body.append(dialog);
  let data = null, code = '', message = '', busy = false, revision = 0;
  const endpoint = '/internal/v1/user-center/registration';
  function render() {
    dialog.innerHTML = `<div class="app-section-title"><strong>注册与邀请</strong><button type="button" class="secondary-button" data-close>关闭</button></div>
      <p>新账号使用统一 MX 身份。注册不授予工作台管理权限，也不改变现有账号和应用的访问设置。</p>
      <p role="status" aria-live="polite">${escape(message)}</p>
      ${data ? `<form data-policy><fieldset ${busy ? 'disabled' : ''}><legend>新账号注册方式</legend><div class="registration-modes">
        ${Object.entries(modes).map(([value, label]) => `<label><input type="radio" name="mode" value="${value}" ${data.policy.mode === value ? 'checked' : ''}>${label}</label>`).join('')}
        </div><button type="submit" class="primary-button">保存注册方式</button></fieldset></form>
      <form data-invite><fieldset ${busy ? 'disabled' : ''}><legend>创建邀请码</legend><div class="app-editor-grid">
        <label class="app-form-field"><span>邀请名称</span><input name="label" maxlength="80" placeholder="例如：第一批体验用户" required></label>
        <label class="app-form-field"><span>注册名额</span><input name="maxUses" type="number" min="1" max="1000" value="1" required></label>
        <label class="app-form-field"><span>有效天数</span><input name="days" type="number" min="1" max="90" value="7" required></label>
      </div><button type="submit" class="secondary-button">生成邀请码</button></fieldset></form>
      ${code ? `<section class="registration-code"><strong>请保存邀请码，关闭后不再显示完整值</strong><code>${escape(code)}</code><button type="button" class="secondary-button" data-copy>复制邀请码</button></section>` : ''}
      <h3>最近的邀请码</h3><div class="registration-invites">${data.invitations.length ? data.invitations.map(invite => `<article>
        <div><strong>${escape(invite.label)}</strong><small>已用 ${invite.uses} / ${invite.maxUses} · 到期 ${escape(new Date(invite.expiresAt).toLocaleString())}</small></div>
        <span>${invite.revoked ? '已停用' : Date.parse(invite.expiresAt) <= Date.now() ? '已到期' : invite.uses >= invite.maxUses ? '已用完' : '可使用'}</span>
        <button type="button" class="secondary-button" data-revoke="${escape(invite.id)}" ${invite.revoked || busy ? 'disabled' : ''}>停用</button></article>`).join('') : '<p>尚无邀请码。</p>'}</div>` : '<button type="button" class="secondary-button" data-reload>重新加载</button>'}`;
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.querySelector('[data-reload]')?.addEventListener('click', () => void load());
    dialog.querySelector('[data-policy]')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget;
      void perform(async () => { await request(`${endpoint}/policy`, { method: 'POST', body: { mode: form.elements.mode.value, version: data.policy.version } }); }, '注册方式已保存，已有账号不受影响。');
    });
    dialog.querySelector('[data-invite]')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget;
      const input = { label: form.elements.label.value, maxUses: Number(form.elements.maxUses.value), days: Number(form.elements.days.value) };
      void perform(() => request(`${endpoint}/invitations`, { method: 'POST', body: input }), '邀请码已生成。');
    });
    dialog.querySelectorAll('[data-revoke]').forEach(button => button.addEventListener('click', () => void perform(
      () => request(`${endpoint}/invitations/revoke`, { method: 'POST', body: { id: button.dataset.revoke } }), '邀请码已停用，已注册账号保留。')));
    dialog.querySelector('[data-copy]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); message = '邀请码已复制。'; } catch { message = '复制失败，请选中邀请码手动复制。'; }
      render();
    });
  }
  async function perform(operation, success) {
    if (busy) return;
    const current = revision; busy = true; message = '正在保存…'; render();
    try {
      const result = await operation();
      if (current !== revision) return;
      if (result?.code) code = result.code;
      const value = await request(endpoint);
      if (current !== revision) return;
      data = value; message = success;
    }
    catch (error) { if (current === revision) message = error.message; }
    finally { if (current === revision) { busy = false; render(); } }
  }
  async function load() {
    const current = ++revision; message = '正在读取注册策略…'; render();
    try { const value = await request(endpoint); if (current !== revision) return; data = value; message = ''; }
    catch (error) { if (current === revision) message = error.message; }
    if (current === revision) render();
  }
  dialog.addEventListener('close', () => { revision++; data = null; code = ''; message = ''; busy = false; dialog.replaceChildren(); });
  return { open() { dialog.showModal(); void load(); }, reset() { dialog.close(); } };
}
