const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const api = '/internal/v1/admin/service-operations/identity';
const statusLabels = { active: 'Auth 已加载', pending: '待发布', unverified: '待核实', unknown: '状态未知' };
const time = value => value ? new Date(value).toLocaleString() : '—';

export function createIdentityApplications(root, { request, serverKey, onPublish }) {
  let generation = 0, scope = '', initialized = false, busy = false, data = null, feedback = '', validated = null, saved = false;
  let draft = { entry: 'public', appId: '', displayName: '', origin: '', audience: '' };
  const field = (name, label, placeholder, max = 256) => `<label class="service-field"><span>${label}</span><input name="${name}" value="${escape(draft[name])}" placeholder="${placeholder}" maxlength="${max}" required autocomplete="off" ${busy ? 'disabled' : ''}></label>`;
  function render() {
    if (!root) return;
    root.innerHTML = `<div class="service-page-heading"><div><span class="service-eyebrow">IDENTITY / APPLICATIONS</span><h3>接入应用</h3><p>管理统一认证的应用地址、回调和发布状态。</p></div><button class="secondary-button" type="button" data-identity="refresh" ${busy ? 'disabled' : ''}>刷新状态</button></div>
      <p class="identity-feedback" role="status" aria-live="polite">${escape(feedback || (busy ? '正在读取配置…' : ''))}</p>
      ${data?.configured ? `<div class="identity-entry-list">${data.entries.map(entry => `<section class="identity-entry" aria-label="${entry.entry === 'public' ? '公网认证' : '内网认证'}">
        <div class="identity-heading"><div><h4>${entry.entry === 'public' ? '公网认证' : '内网认证'}</h4><code>${escape(entry.origin)}</code></div><span class="identity-meta">${escape(entry.runtimeMessage)}</span></div>
        <div class="identity-app-list">${entry.apps.map(app => `<article class="identity-app">
          <div class="identity-heading"><div><strong>${escape(app.displayName)}</strong><span class="identity-meta">${escape(app.appId)}</span></div><span class="identity-status" data-state="${escape(app.status)}">${escape(statusLabels[app.status] || '状态未知')}</span></div>
          <dl><dt>应用地址</dt><dd>${escape(app.origin)}</dd><dt>登录回调</dt><dd><code>${escape(app.callbackUrl)}</code></dd></dl>
          <details><summary>接入详情</summary><dl><dt>Client ID</dt><dd><code>${escape(app.clientId)}</code></dd><dt>Audience</dt><dd>${escape(app.audience)}</dd><dt>保存时间</dt><dd>${escape(time(app.savedAt))}</dd><dt>运行实例启动</dt><dd>${escape(time(app.publishedAt))}</dd>${app.consumerFile ? `<dt>主机接入档案</dt><dd><code>${escape(app.consumerFile)}</code></dd>` : ''}</dl>${app.provisioning === 'incomplete' ? '<p class="identity-warning">接入档案保存未完成，请核对主机后重试原请求。</p>' : ''}</details>
        </article>`).join('')}</div>
        <details class="identity-policy"><summary>可信域名与飞书回调</summary><p>表单目标由已登记应用生成，发布后供 Auth 使用。</p><code>form-action ${escape(entry.formAction)}</code><p>飞书开发者后台需另行登记以下回调：</p><code>${escape(entry.feishuCallbackUrl)}</code><p>登记应用不会修改飞书凭据或组织限制。</p></details>
      </section>`).join('')}</div>
      <div class="identity-workspace"><form class="identity-register"><h4>新增接入应用</h4><p class="identity-meta">已有应用受保护；域名变更需按迁移流程处理。</p><fieldset ${busy ? 'disabled' : ''}>
        <label class="service-field"><span>认证入口</span><select name="entry">${data.entries.map(entry => `<option value="${entry.entry}" ${draft.entry === entry.entry ? 'selected' : ''}>${entry.entry === 'public' ? '公网认证' : '内网认证'}</option>`).join('')}</select></label>
        <div class="identity-field-pair">${field('displayName', '应用名称', '例如：MX Pay', 80)}${field('appId', '应用标识', '例如：mx-pay', 80)}</div>
        ${field('origin', '应用 HTTPS 地址', 'https://pay.example.com')}${field('audience', '权限标识 Audience', '与应用后端接入配置保持一致')}
        <div class="identity-actions"><button class="secondary-button" type="submit">校验配置</button><button class="primary-button" type="button" data-identity="save" ${!validated || saved ? 'disabled' : ''}>保存应用</button></div>
      </fieldset></form><section class="identity-preview" aria-label="校验与发布"><h4>校验与发布</h4>
        ${validated ? `<span class="identity-status" data-state="${saved ? 'pending' : 'active'}">${saved ? '已保存，待发布' : '配置校验通过'}</span><dl><dt>Client ID</dt><dd><code>${escape(validated.application.clientId)}</code></dd><dt>登录回调</dt><dd><code>${escape(validated.application.callbackUrl)}</code></dd><dt>账号交互</dt><dd><code>${escape(validated.application.interactionUrl)}</code></dd></dl>` : '<p class="identity-meta">填写应用信息并校验，即可预览固定回调地址。</p>'}
        <ol><li>校验并保存应用。</li><li>按现有 Launcher 发布流程加载 Auth 配置。</li><li>应用后端载入主机接入档案，验证登录回调。</li></ol><p class="identity-meta">保存不会重启服务。Auth 已加载仅表示认证配置已生效，应用自身仍需完成 SDK 接入。</p>
        <button class="secondary-button" type="button" data-identity="publish" ${busy ? 'disabled' : ''}>前往 Launcher 发布</button>
      </section></div><p class="identity-meta">状态检查于 ${escape(time(data.checkedAt))} · 密钥仅保存在主机，管理页不展示。</p>` : `<div class="identity-entry"><p>${escape(data?.message || '需要已接入的主机运维执行器。若刚升级 Launcher，请等待执行器完成更新后刷新。')}</p></div>`}`;
  }
  async function call(suffix = '', options) {
    const ticket = generation;
    const result = await request(api + suffix, options);
    if (ticket !== generation || scope !== serverKey()) throw new Error('环境已变化，已忽略旧响应。');
    return result;
  }
  async function refresh() {
    data = await call();
    data.entries?.sort((left, right) => Number(right.entry === 'public') - Number(left.entry === 'public'));
    if (!data.entries?.some(entry => entry.entry === draft.entry)) draft.entry = data.entries?.[0]?.entry || 'public';
  }
  async function perform(action) {
    if (busy) return;
    const ticket = generation;
    busy = true; feedback = ''; render();
    try {
      if (action === 'refresh') { await refresh(); validated = null; saved = false; feedback = '已刷新保存配置与 Auth 运行状态。'; }
      if (action === 'validate') {
        validated = null; saved = false;
        const input = { ...draft, revision: data.revision };
        const result = await call('/validate', { method: 'POST', body: input });
        validated = { input, application: result.application }; feedback = '配置校验通过，可以保存。';
      }
      if (action === 'save' && validated) {
        await call('/applications', { method: 'POST', body: validated.input });
        saved = true; feedback = '应用已保存；请完成发布并刷新确认 Auth 已加载。';
        try { await refresh(); } catch { feedback = '应用已保存，但运行状态暂不可用，请刷新核实。'; }
      }
    } catch (error) { if (ticket === generation) feedback = error.message; }
    finally { if (ticket === generation) { busy = false; render(); } }
  }
  root?.addEventListener('input', event => {
    const name = event.target.name;
    if (!Object.hasOwn(draft, name)) return;
    draft[name] = event.target.value; validated = null; saved = false;
    root.querySelector('[data-identity="save"]').disabled = true;
    const preview = root.querySelector('.identity-preview [data-state]');
    if (preview) { preview.dataset.state = 'pending'; preview.textContent = '配置已修改，请重新校验'; }
  });
  root?.addEventListener('submit', event => { event.preventDefault(); void perform('validate'); });
  root?.addEventListener('click', event => {
    const button = event.target.closest('[data-identity]');
    if (!button || button.disabled || busy) return;
    if (button.dataset.identity === 'publish') onPublish();
    else void perform(button.dataset.identity);
  });
  function reset() {
    generation++; scope = serverKey(); initialized = false; busy = false; data = null; validated = null; saved = false; feedback = '';
    draft = { entry: 'public', appId: '', displayName: '', origin: '', audience: '' }; render();
  }
  return { reset, show() { if (scope !== serverKey()) reset(); if (!initialized) { initialized = true; void perform('refresh'); } } };
}
