const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const modes = { closed: '关闭注册', invite_code: '邀请码注册', open: '开放注册' };
const appModes = { policy: '遵循应用策略（默认）', selected: '额外开通指定应用', all_current: '额外开通当前全部应用' };
const emptyInvite = () => ({ label: '', maxUses: 1, days: 7, admissionAppId: '', appGrant: { mode: 'policy', appIds: [] } });
export function createRegistrationUi({ request, reauthenticate, root = document }) {
  const dialog = root.createElement('dialog');
  dialog.className = 'admin-account-dialog registration-dialog';
  dialog.setAttribute('aria-label', '注册与邀请');
  root.body.append(dialog);
  let data = null, code = '', message = '', busy = false, revision = 0;
  let needsReauthentication = false, policyDraft = null;
  let inviteDraft = emptyInvite();
  const endpoint = '/internal/v1/user-center/registration';
  function render() {
    const policy = policyDraft || data?.policy;
    dialog.innerHTML = `<div class="app-section-title"><strong>注册与邀请</strong><button type="button" class="secondary-button" data-close>关闭</button></div>
      <p>新账号使用统一 MX 身份。注册不授予工作台管理权限，也不改变现有账号和应用的访问设置。</p>
      <p role="status" aria-live="polite">${escape(message)}</p>
      ${needsReauthentication && reauthenticate ? `<div role="group" aria-label="验证管理员身份"><button type="button" class="primary-button" data-reauthenticate ${busy ? 'disabled' : ''}>重新验证</button><p>验证完成后，请重新打开“注册与邀请”，确认设置并保存。${code ? '离开前请先保存已生成的邀请码。' : ''}</p></div>` : ''}
      ${data ? `<form data-policy><fieldset ${busy ? 'disabled' : ''}><legend>默认注册方式</legend><div class="registration-modes">
        ${Object.entries(modes).map(([value, label]) => `<label><input type="radio" name="mode" value="${value}" ${policy.mode === value ? 'checked' : ''}>${label}</label>`).join('')}
        </div><label class="app-form-field"><span>Hub 注册方式</span><select name="hubMode" aria-label="Hub 注册方式">${Object.entries({inherit:'跟随默认',...modes}).map(([value,label])=>`<option value="${value}" ${(policy.hubMode || 'inherit')===value?'selected':''}>${label}</option>`).join('')}</select></label>
        <label class="app-form-field"><span>Harbor 注册方式</span><select name="harborMode" aria-label="Harbor 注册方式">${Object.entries({closed:'关闭注册',invite_code:'邀请码注册'}).map(([value,label])=>`<option value="${value}" ${(policy.applicationModes?.['mx-harbor'] || 'closed')===value?'selected':''}>${label}</option>`).join('')}</select></label>
        <p>Harbor 首次进入须专用邀请或管理员开通，已有 Hub 账号也适用。新账号不授予 H2I、Luopan 网络访问。</p>
        <p>默认选择“关闭注册”会暂停所有统一账号新注册。需要只开放 Hub 时，默认保留“邀请码注册”，Hub 选择“开放注册”。已有账号登录、H2I 和 Luopan 原有注册入口保持不变。</p>
        <p>新 Hub 账号默认不准入 MX-H2I 与 Luopan 网络；需要使用时，由管理员在成员的应用访问设置中明确授权。注册来源只用于记录，不作为权限依据。</p>
        <button type="submit" class="primary-button">保存注册方式</button></fieldset></form>
      <form data-invite><fieldset ${busy ? 'disabled' : ''}><legend>创建邀请码</legend><div class="app-editor-grid">
        <label class="app-form-field"><span>邀请用途</span><select name="admissionAppId"><option value="">统一账号注册</option><option value="mx-harbor" ${inviteDraft.admissionAppId==='mx-harbor'?'selected':''}>Harbor 注册与首次进入（仅开通 Harbor）</option></select></label>
        <label class="app-form-field"><span>邀请名称</span><input name="label" maxlength="80" placeholder="例如：第一批体验用户" value="${escape(inviteDraft.label)}" required></label>
        <label class="app-form-field"><span>注册名额</span><input name="maxUses" type="number" min="1" max="1000" value="${escape(inviteDraft.maxUses)}" required></label>
        <label class="app-form-field"><span>有效天数</span><input name="days" type="number" min="1" max="90" value="${escape(inviteDraft.days)}" required></label>
        <label class="app-form-field app-form-wide"><span>应用范围</span><select name="appGrantMode" aria-label="应用范围">${Object.entries(appModes).map(([value, label]) => `<option value="${value}" ${inviteDraft.appGrant.mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <div class="app-form-field app-form-wide" data-app-picker ${inviteDraft.admissionAppId === 'mx-harbor' || inviteDraft.appGrant.mode !== 'selected' ? 'hidden' : ''}>
          <label for="invite-apps">选择额外开通的应用</label>
          <select id="invite-apps" name="appIds" multiple aria-label="选择额外开通的应用" data-placeholder="搜索并选择应用" ${inviteDraft.admissionAppId === 'mx-harbor' || inviteDraft.appGrant.mode !== 'selected' ? 'disabled' : ''} required>
            ${(data.apps || []).filter(app => app.appId !== 'mx-harbor').map(app => `<option value="${escape(app.appId)}" ${app.enabled === false ? 'disabled' : ''} ${inviteDraft.appGrant.appIds.includes(app.appId) ? 'selected' : ''}>${escape(app.displayName || app.appId)} · ${escape(app.appId)}${app.enabled === false ? '（已停用）' : ''}</option>`).join('')}
          </select>
        </div>
      </div><p class="registration-app-help">默认按应用原策略访问，公开应用不必逐个授权。额外开通仅用于 Launcher 应用目录和已接入的访问检查，不授予管理、网络或 Hub 租户权限；直接登录仍由各应用控制。“全部”以创建时已启用的应用为准，不包含以后新增的应用；Harbor 需单独创建专用邀请。</p>
      <button type="submit" class="secondary-button">生成邀请码</button></fieldset></form>
      ${code ? `<section class="registration-code"><strong>请保存邀请码，关闭后不再显示完整值</strong><code>${escape(code)}</code><button type="button" class="secondary-button" data-copy>复制邀请码</button></section>` : ''}
      <h3>最近的邀请码</h3><div class="registration-invites">${data.invitations.length ? data.invitations.map(invite => `<article>
        <div><strong>${escape(invite.label)}${invite.admissionAppId === 'mx-harbor' ? ' · Harbor 专用' : ''}</strong><small>已用 ${invite.uses} / ${invite.maxUses} · 到期 ${escape(new Date(invite.expiresAt).toLocaleString())}</small><small>${escape(appModes[invite.appGrant?.mode || 'policy'])}${invite.appGrant?.appIds?.length ? `：${invite.appGrant.appIds.map(id => escape((data.apps || []).find(app => app.appId === id)?.displayName || id)).join('、')}` : ''}</small></div>
        <span>${invite.revoked ? '已停用' : Date.parse(invite.expiresAt) <= Date.now() ? '已到期' : invite.uses >= invite.maxUses ? '已用完' : '可使用'}</span>
        <button type="button" class="secondary-button" data-revoke="${escape(invite.id)}" ${invite.revoked || busy ? 'disabled' : ''}>停用</button></article>`).join('') : '<p>尚无邀请码。</p>'}</div>` : '<button type="button" class="secondary-button" data-reload>重新加载</button>'}`;
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.querySelector('[data-reauthenticate]')?.addEventListener('click', () => { dialog.close(); reauthenticate(); });
    dialog.querySelector('[data-reload]')?.addEventListener('click', () => void load());
    const policyForm = dialog.querySelector('[data-policy]');
    const readPolicy = () => ({ mode: policyForm.elements.mode.value, hubMode: policyForm.elements.hubMode.value, version: data.policy.version, applicationModes: {...data.policy.applicationModes, 'mx-harbor': policyForm.elements.harborMode.value} });
    policyForm?.addEventListener('change', () => { policyDraft = readPolicy(); });
    policyForm?.addEventListener('submit', event => {
      event.preventDefault(); const input = policyDraft = readPolicy();
      void perform(() => request(`${endpoint}/policy`, { method: 'POST', body: input }), '注册方式已保存，已有账号不受影响。', true);
    });
    const inviteForm = dialog.querySelector('[data-invite]');
    const readInvite = () => ({ ...(inviteForm.elements.admissionAppId.value ? {admissionAppId: inviteForm.elements.admissionAppId.value} : {}), label: inviteForm.elements.label.value, maxUses: Number(inviteForm.elements.maxUses.value), days: Number(inviteForm.elements.days.value),
      appGrant: { mode: inviteForm.elements.appGrantMode.value, appIds: [...inviteForm.elements.appIds.selectedOptions].map(option => option.value) } });
    inviteForm?.addEventListener('input', () => { inviteDraft = readInvite(); });
    inviteForm?.addEventListener('change', () => {
      inviteDraft = readInvite(); const selected = inviteDraft.admissionAppId !== 'mx-harbor' && inviteDraft.appGrant.mode === 'selected';
      inviteForm.querySelector('[data-app-picker]').hidden = !selected;
      inviteForm.elements.appIds.disabled = !selected;
    });
    inviteForm?.addEventListener('submit', event => {
      event.preventDefault(); const draft = readInvite();
      const input = { ...draft, appGrant: { ...draft.appGrant, appIds: draft.appGrant.mode === 'selected' ? draft.appGrant.appIds : [] } };
      void perform(() => request(`${endpoint}/invitations`, { method: 'POST', body: input }), '邀请码已生成。');
    });
    dialog.querySelectorAll('[data-revoke]').forEach(button => button.addEventListener('click', () => void perform(
      () => request(`${endpoint}/invitations/revoke`, { method: 'POST', body: { id: button.dataset.revoke } }), '邀请码已停用，已注册账号保留。')));
    dialog.querySelector('[data-copy]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); message = '邀请码已复制。'; } catch { message = '复制失败，请选中邀请码手动复制。'; }
      render();
    });
  }
  function showError(error) {
    message = error.message;
    needsReauthentication = error.code === 'reauth_required';
  }
  async function perform(operation, success, resetPolicy = false) {
    if (busy) return;
    const current = revision; busy = true; message = '正在保存…'; render();
    try {
      const result = await operation();
      if (current !== revision) return;
      if (result?.code) code = result.code;
      const value = await request(endpoint);
      if (current !== revision) return;
      data = value; message = success; needsReauthentication = false;
      if (resetPolicy) policyDraft = null;
    }
    catch (error) { if (current === revision) showError(error); }
    finally { if (current === revision) { busy = false; render(); } }
  }
  async function load() {
    const current = ++revision; message = '正在读取注册策略…'; render();
    try { const value = await request(endpoint); if (current !== revision) return; data = value; message = ''; needsReauthentication = false; }
    catch (error) { if (current === revision) showError(error); }
    if (current === revision) render();
  }
  dialog.addEventListener('close', () => { revision++; data = null; code = ''; message = ''; busy = false; needsReauthentication = false; policyDraft = null; inviteDraft = emptyInvite(); dialog.replaceChildren(); });
  return { open() { dialog.showModal(); void load(); }, reset() { dialog.close(); } };
}
