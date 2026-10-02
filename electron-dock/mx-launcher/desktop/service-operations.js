import { SERVICE_CATALOG, SERVICE_CATALOG_VERSION, defaultServiceProfile, buildServiceCommand } from './service-operations-catalog.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const statusLabels = { queued: '等待执行', running: '执行中', succeeded: '命令完成', failed: '命令失败', needs_reconciliation: '需要核对', reconciled: '已人工核对' };
const terminal = new Set(['succeeded', 'failed', 'needs_reconciliation', 'reconciled']);
const apiRoot = '/internal/v1/admin/service-operations';

async function copyCommand(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Internal HTTP may not grant Clipboard API access. */ }
  }
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(field); field.select();
  try { if (!document.execCommand('copy')) throw new Error('浏览器不允许复制，请选中命令手动复制。'); }
  finally { field.remove(); }
}

export function createServiceOperations(root, { request, serverKey, isVisible }) {
  let scope = '', generation = 0, initialized = false, connected = false, busy = false, timer = null;
  let service = 'launcher', action = 'status', profiles = {}, instances = [], history = [], plan = null, operation = null, log = '', feedback = '';
  let uncertain = false, currentId = null, acknowledged = false, executorUpdate = null;
  const storageKey = name => `mx.service-operations.v1:${scope}:${name}`;
  const readStored = name => { try { return JSON.parse(localStorage.getItem(storageKey(name))); } catch { return null; } };
  const saveStored = (name, value) => { try { if (value === null) localStorage.removeItem(storageKey(name)); else localStorage.setItem(storageKey(name), JSON.stringify(value)); } catch { /* Private browser: the draft still works in memory. */ } };
  const instance = () => instances.find(item => item.service === service);
  function reset() {
    generation++; clearTimeout(timer); timer = null; scope = serverKey(); initialized = false; connected = false; busy = false;
    profiles = Object.fromEntries(Object.keys(SERVICE_CATALOG).map(key => [key, readStored(key) || defaultServiceProfile(key)]));
    instances = []; history = []; plan = null; operation = null; log = ''; feedback = ''; uncertain = false; acknowledged = false; executorUpdate = null;
    currentId = readStored('last-operation') || null;
    render();
  }
  function preview() { return buildServiceCommand(service, action, profiles[service]); }
  const field = (key, label, type = 'text', hint = '') => `<label class="service-field"><span>${label}</span><input data-service-field="${key}" type="${type}" value="${escape(profiles[service][key])}" autocomplete="off" ${key === 'proxyPort' ? 'min="1" max="65535"' : ''} />${hint ? `<small>${hint}</small>` : ''}</label>`;
  const toggle = (key, label, hint) => `<label class="service-switch"><input data-service-field="${key}" type="checkbox" role="switch" ${profiles[service][key] ? 'checked' : ''} /><span><strong>${label}</strong><small>${hint}</small></span></label>`;
  function render() {
    if (!root) return;
    const definition = SERVICE_CATALOG[service];
    const configured = instance();
    const deploy = action === 'deploy' || action === 'predeploy';
    const p = profiles[service] || defaultServiceProfile(service);
    root.innerHTML = `
      <div class="service-page-heading"><div><span class="service-eyebrow">SERVICE OPERATIONS</span><h3>服务与部署</h3><p>选择服务，调整参数，查看命令与执行结果。</p></div><button type="button" class="secondary-button" data-service-command="refresh" ${busy ? 'disabled' : ''}>刷新执行器与任务</button></div>
      <div class="service-connection" role="status"><span class="service-connection-dot ${connected ? 'is-connected' : ''}"></span>${connected ? `独立执行器已连接 · ${escape(instances[0]?.host || 'mx-internal-server')}` : '执行器尚未连接 · 可编辑并复制命令'}<span>${executorUpdate ? '执行器更新等待任务结束；切换后请刷新。待核对任务需先处理。' : '连接状态不代表服务健康'}</span></div>
      <div class="service-picker" role="group" aria-label="选择服务">${Object.entries(SERVICE_CATALOG).map(([key, item]) => `<button type="button" class="service-choice ${key === service ? 'is-selected' : ''}" data-service-select="${key}" aria-pressed="${key === service}"><strong>${item.label}</strong><span>${item.description}</span></button>`).join('')}</div>
      <div class="service-workspace">
        <section class="service-form-panel" aria-label="操作配置">
          <div class="service-panel-heading"><h4>操作配置</h4><span>${configured ? '已登记到主机' : '预填配置'}</span></div>
          <label class="service-field"><span>操作</span><select data-service-action aria-label="服务操作">${Object.entries(definition.actions).map(([key, value]) => `<option value="${key}" ${key === action ? 'selected' : ''}>${value.label}</option>`).join('')}</select></label>
          ${field('cwd', '项目目录', 'text', '在线执行须与主机登记目录一致。编辑只改变草稿。')}
          ${deploy ? `
            <label class="service-field"><span>下载与构建代理</span><select data-service-field="proxyMode"><option value="saved" ${p.proxyMode === 'saved' ? 'selected' : ''}>沿用脚本已有配置</option><option value="custom" ${p.proxyMode === 'custom' ? 'selected' : ''}>指定代理</option><option value="direct" ${p.proxyMode === 'direct' ? 'selected' : ''}>本次直连</option></select></label>
            ${p.proxyMode === 'custom' ? `<div class="service-proxy-fields"><label class="service-field"><span>协议</span><select data-service-field="proxyProtocol"><option ${p.proxyProtocol === 'http' ? 'selected' : ''}>http</option><option ${p.proxyProtocol === 'https' ? 'selected' : ''}>https</option></select></label>${field('proxyHost', '代理主机')}${field('proxyPort', '端口', 'number')}</div>` : ''}
            ${service === 'launcher' && action === 'deploy' ? `
              ${field('tmpDir', '临时目录', 'text', '主机上已存在的可写目录，例如 /data/tmp。')}
              <div class="service-field-pair">${field('hostname', 'Kubernetes 节点名称')}${field('advertiseAddress', 'API Server IPv4')}</div>
              <div class="service-field-pair">${field('keepStorage', '构建缓存上限')}${field('pruneUntil', '缓存保留时间')}</div>
              ${toggle('installRunner', '安装 / 更新原主机 Runner', '对应现有 deploy 默认行为；本次独立执行器继续运行。')}
            ` : ''}
            ${service === 'embedding' ? toggle('keepGpu', '沿用现有共享 GPU', '仅部署使用 --keep-gpu；核验运行中实例的 UUID 和资源上限。') : ''}
            ${field('expectedRevision', '指定代码版本（可选）', 'text', '完整 Git commit SHA；留空则预检锁定主机当前版本，不自动拉取代码。')}
          ` : '<p class="service-hint">此操作使用实例现有配置。修改部署参数后，需选择部署操作才能应用。</p>'}
          <div class="service-form-actions"><button class="secondary-button" type="button" data-service-command="save" ${!connected || !configured || busy ? 'disabled' : ''}>保存到主机</button><button class="secondary-button" type="button" data-service-command="restore" ${busy ? 'disabled' : ''}>${configured ? '载入主机配置' : '恢复预填配置'}</button></div>
          <p class="service-hint">编辑自动保留为当前服务器的浏览器草稿。保存配置不会部署或重启服务。</p>
        </section>
        <section class="service-command-panel" aria-label="命令预览与计划">
          <div class="service-panel-heading"><h4>命令预览</h4><button type="button" class="secondary-button" data-service-command="copy">复制命令</button></div>
          <pre class="service-command-code" data-service-preview tabindex="0"></pre>
          <div class="service-validation" data-service-validation role="status"></div>
          <p class="service-impact" data-service-impact></p>
          <p class="service-hint">复制命令在目标主机执行，使用该目录的检出代码。在线执行会先锁定版本、配置和目标，计划有效期 5 分钟。</p>
          <div data-service-plan></div>
          <div class="service-form-actions"><button type="button" class="secondary-button" data-service-command="plan">预检并生成计划</button><button type="button" class="primary-button" data-service-command="execute">执行计划</button></div>
          <p class="service-feedback" data-service-feedback role="status"></p>
        </section>
      </div>
      <section class="service-task-panel" aria-label="执行任务">
        <div class="service-panel-heading"><h4>执行任务</h4><button type="button" class="secondary-button" data-service-command="task-refresh">查询原任务</button></div>
        <div data-service-task></div>
        <div class="service-history" data-service-history></div>
      </section>
      <details class="service-setup"><summary>执行器随 Launcher 部署自动接入</summary><p>在目标 Linux 主机按原流程执行 Launcher 的 deploy，会自动安装或更新独立执行器，并登记 API 连接配置。无需先运行单独安装命令。</p><p>首次沿用部署时检测到的主机内网地址、端口 19290；后续保留已有地址、端口、令牌、实例参数和任务记录。同版本不重启，有更新则等当前任务结束并保存结果后自动切换。</p><p>需要 Node.js 22+、systemd 和安装权限，端口应对 Launcher Pod 可达。任务保存在 /var/lib/mx-service-operations。可用 MX_SERVICE_OPERATIONS_BIND / MX_SERVICE_OPERATIONS_PORT 设置首次接入地址，或以 MX_SERVICE_OPERATIONS_INSTALL=0 跳过本次安装，保留已有服务和连接。</p></details>
    `;
    updatePreview(); renderTask();
  }
  function updatePreview() {
    if (!root?.querySelector('[data-service-preview]')) return;
    root.querySelector('.service-connection').innerHTML = `<span class="service-connection-dot ${connected ? 'is-connected' : ''}"></span>${connected ? `独立执行器已连接 · ${escape(instances[0]?.host || 'mx-internal-server')}` : '执行器尚未连接 · 可编辑并复制命令'}<span>${executorUpdate ? '执行器更新等待任务结束；切换后请刷新。待核对任务需先处理。' : '连接状态不代表服务健康'}</span>`;
    let spec, error = '';
    try { spec = preview(); } catch (cause) { error = cause.message; }
    root.querySelector('[data-service-preview]').textContent = spec?.command || '请修正配置后生成命令。';
    root.querySelector('[data-service-validation]').textContent = error;
    root.querySelector('[data-service-impact]').dataset.impact = spec?.impact ? 'write' : 'read';
    root.querySelector('[data-service-impact]').textContent = spec?.impact || '读取所选服务信息，不自动修复或重启。';
    root.querySelector('[data-service-feedback]').textContent = feedback;
    const validPlan = plan && Date.parse(plan.expiresAt) > Date.now();
    root.querySelector('[data-service-plan]').innerHTML = plan ? `<div class="service-plan"><strong>${validPlan ? '计划已就绪' : '计划已过期，请重新预检'}</strong><span>版本 ${escape(plan.revision)}${plan.dirty ? ' · 工作区有改动（只读操作）' : ''}</span><span>有效期至 ${escape(new Date(plan.expiresAt).toLocaleTimeString())}</span>${plan.requiresAcknowledgement ? `<label class="service-ack"><input type="checkbox" data-service-ack ${acknowledged ? 'checked' : ''} />我已核对目标与上述影响；需要排空的任务已处理。</label>` : ''}</div>` : '';
    root.querySelector('[data-service-command="copy"]').disabled = Boolean(error);
    root.querySelector('[data-service-command="plan"]').disabled = Boolean(error) || !connected || !instance() || busy || uncertain || Boolean(executorUpdate);
    root.querySelector('[data-service-command="execute"]').disabled = !validPlan || busy || Boolean(executorUpdate) || (plan.requiresAcknowledgement && !acknowledged);
    root.querySelector('[data-service-command="task-refresh"]').disabled = !currentId || busy;
    for (const control of root.querySelectorAll('[data-service-field], [data-service-action], [data-service-ack]')) control.disabled = busy;
  }
  function renderTask() {
    if (!root?.querySelector('[data-service-task]')) return;
    root.querySelector('[data-service-task]').innerHTML = operation ? `<div class="service-task-summary"><strong>${escape(statusLabels[operation.status] || operation.status)}</strong><span>${escape(SERVICE_CATALOG[operation.service]?.label)} · ${escape(SERVICE_CATALOG[operation.service]?.actions[operation.action]?.label || operation.action)}</span><code>${escape(operation.id)}</code><p>${escape(operation.message)}</p><small>${escape(operation.updatedAt)}</small></div><pre class="service-task-log" tabindex="0">${escape(log || '暂时没有日志。')}</pre>${operation.status === 'needs_reconciliation' ? `<label class="service-field"><span>人工核对记录</span><input data-service-reconcile-note placeholder="记录检查的实际运行状态与处理结果（至少 8 字）" /></label><button type="button" class="secondary-button" data-service-command="reconcile">记录核对结果并解除阻塞</button>` : ''}` : `<p class="service-hint">${uncertain ? '提交结果尚未确认，请查询原任务；不要重复创建新部署。' : '执行后在此查看结果。关闭页面不会取消主机任务。'}</p>`;
    root.querySelector('[data-service-history]').innerHTML = history.length ? `<h5>最近任务</h5>${history.map(item => `<button type="button" data-service-task-id="${escape(item.id)}"><span>${escape(SERVICE_CATALOG[item.service]?.label || item.service)} · ${escape(SERVICE_CATALOG[item.service]?.actions[item.action]?.label || item.action)}</span><span>${escape(statusLabels[item.status] || item.status)}</span><small>${escape(new Date(item.createdAt).toLocaleString())}</small></button>`).join('')}` : '';
  }
  async function call(path, options) {
    const ticket = generation;
    const result = await request(`${apiRoot}/${path}`, options);
    if (ticket !== generation || scope !== serverKey()) throw new Error('服务器已切换，已忽略旧环境的响应');
    return result;
  }
  async function refresh() {
    const data = await call('instances');
    if (data?.catalogVersion !== SERVICE_CATALOG_VERSION || !Array.isArray(data.instances)) throw new Error('执行器版本不匹配或尚未接入，请完成安装');
    executorUpdate = data.lifecycle?.updateRequested || null;
    instances = data.instances.map(item => ({ ...item, host: data.host })); connected = true;
    for (const item of instances) if (SERVICE_CATALOG[item.service] && !readStored(item.service)) profiles[item.service] = item.profile;
    const result = await call('operations'); history = result.operations || [];
    feedback = '执行器和任务已刷新；服务健康请运行相应状态检查。';
    if (currentId) await refreshTask();
  }
  function schedulePoll() {
    clearTimeout(timer);
    if (currentId && !terminal.has(operation?.status)) timer = setTimeout(async () => {
      if (!isVisible()) return;
      const ticket = generation;
      try { await refreshTask(); } catch (error) { if (ticket === generation) { feedback = error.message; connected = false; updatePreview(); } }
      if (ticket === generation) schedulePoll();
    }, 5000);
  }
  async function refreshTask() {
    if (!currentId) return;
    const id = currentId;
    const result = await call(`operations/${encodeURIComponent(id)}`);
    if (id !== currentId) return;
    operation = result.operation; log = result.log || ''; uncertain = false; connected = true;
    if (operation) {
      feedback = operation.message;
      history = [operation, ...history.filter(item => item.id !== operation.id)].slice(0, 30);
      if (plan?.id === operation.id) { plan = null; acknowledged = false; }
    }
    renderTask(); updatePreview(); schedulePoll();
  }
  async function perform(command) {
    if (busy) return;
    const ticket = generation;
    busy = true; updatePreview();
    try {
      if (command === 'copy') {
        await copyCommand(preview().command); feedback = '命令已复制。';
      } else if (command === 'refresh') await refresh();
      else if (command === 'save') {
        const result = await call('profiles', { method: 'POST', body: { instanceId: instance().id, profile: preview().profile } });
        instance().profile = result.profile; profiles[service] = result.profile; saveStored(service, null); plan = null; feedback = '配置已保存到主机，未执行部署。';
      } else if (command === 'restore') {
        profiles[service] = { ...(instance()?.profile || defaultServiceProfile(service)) }; saveStored(service, null); plan = null; feedback = '已载入配置。';
      } else if (command === 'plan') {
        const result = await call('plans', { method: 'POST', body: { instanceId: instance().id, action, profile: preview().profile } });
        plan = result; acknowledged = false; feedback = '请核对版本和影响后执行。';
      } else if (command === 'execute') {
        if (!plan || Date.parse(plan.expiresAt) <= Date.now()) throw new Error('计划已过期，请重新预检');
        currentId = plan.id; saveStored('last-operation', currentId); uncertain = true; operation = null; log = '';
        const result = await call('execute', { method: 'POST', body: { planId: plan.id, acknowledged } });
        operation = result; uncertain = false; plan = null; acknowledged = false;
        feedback = '任务已提交，关闭页面不会取消执行。'; await refreshTask();
      } else if (command === 'task-refresh') await refreshTask();
      else if (command === 'reconcile') {
        const note = root.querySelector('[data-service-reconcile-note]').value;
        await call('reconcile', { method: 'POST', body: { operationId: currentId, note } }); await refreshTask();
      }
    } catch (error) {
      if (ticket === generation) {
        feedback = error.message;
        if (command === 'refresh' || /network error|暂不可达|未接入/.test(error.message)) connected = false;
        // Definite rejections leave no task; transport errors retain the original plan ID.
        if (command === 'execute' && /计划已过期|请确认|已变化|未提交改动|未授权|A valid Internal ops token|主机已有|正在提交|执行器正在等待更新|执行器版本已变化/.test(error.message)) {
          uncertain = false; currentId = null; saveStored('last-operation', null); plan = null;
        }
      }
    } finally {
      if (ticket === generation) { busy = false; render(); schedulePoll(); }
    }
  }
  root?.addEventListener('input', event => {
    const input = event.target.closest('[data-service-field]');
    if (!input || busy) return;
    profiles[service][input.dataset.serviceField] = input.type === 'checkbox' ? input.checked : input.value;
    plan = null; acknowledged = false; feedback = '已更新当前服务器的浏览器草稿，尚未部署。'; saveStored(service, profiles[service]); updatePreview();
  });
  root?.addEventListener('change', event => {
    const input = event.target;
    if (input.matches('[data-service-ack]')) { acknowledged = input.checked; updatePreview(); }
    if (input.matches('[data-service-action]')) { action = input.value; plan = null; acknowledged = false; render(); }
    if (input.dataset.serviceField === 'proxyMode') render();
  });
  root?.addEventListener('click', event => {
    const select = event.target.closest('[data-service-select]');
    if (select && !busy) { service = select.dataset.serviceSelect; if (!SERVICE_CATALOG[service].actions[action]) action = 'status'; plan = null; acknowledged = false; render(); }
    const button = event.target.closest('[data-service-command]');
    if (button && !button.disabled) void perform(button.dataset.serviceCommand);
    const task = event.target.closest('[data-service-task-id]');
    if (task && !busy) { currentId = task.dataset.serviceTaskId; saveStored('last-operation', currentId); void perform('task-refresh'); }
  });
  return {
    reset,
    show() {
      if (scope !== serverKey()) reset();
      if (!initialized) { initialized = true; void perform('refresh'); }
      else { updatePreview(); schedulePoll(); }
    }
  };
}
