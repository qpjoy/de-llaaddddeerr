const modeLabels = {
  'system-tun': '虚拟网卡',
  'app-global': '全局模式',
  'app-rule': 'App 模式'
};

const elements = {
  running: document.querySelector('#running'),
  mode: document.querySelector('#mode'),
  proxy: document.querySelector('#proxy'),
  admin: document.querySelector('#admin'),
  tun: document.querySelector('#tun'),
  snapshot: document.querySelector('#snapshot'),
  refresh: document.querySelector('#refresh'),
  adminButton: document.querySelector('#adminButton'),
  ruleForm: document.querySelector('#ruleForm'),
  ruleKind: document.querySelector('#ruleKind'),
  ruleDomain: document.querySelector('#ruleDomain'),
  ruleList: document.querySelector('#ruleList'),
  testForm: document.querySelector('#testForm'),
  testUrl: document.querySelector('#testUrl'),
  presetButtons: [...document.querySelectorAll('[data-preset]')],
  tabs: [...document.querySelectorAll('.tabbar .tab')],
  marketPanel: document.querySelector('#marketPanel'),
  marketFrame: document.querySelector('#marketFrame'),
  tunnelPanel: document.querySelector('#tunnelPanel'),
  marketBreadcrumb: document.querySelector('#marketBreadcrumb')
};

/* ── tab switching ──────────────────────────────────────────────────────── */

function activateTab(name) {
  elements.tabs.forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  });
  const isMarket = name === 'market';
  elements.marketPanel.hidden = !isMarket;
  elements.tunnelPanel.hidden = isMarket;
}

elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

/* ── plugin-market postMessage bridge ───────────────────────────────────── */
// Protocol: see electron-market/docs/EMBED_PROTOCOL.md
function sendToMarket(type, payload) {
  if (!elements.marketFrame?.contentWindow) return;
  elements.marketFrame.contentWindow.postMessage(
    { source: 'qpjoy-plugin-market', type, payload },
    '*'
  );
}

window.addEventListener('message', (ev) => {
  if (ev.data?.source !== 'qpjoy-plugin-market') return;
  switch (ev.data.type) {
    case 'ready':
      // The SPA already read URL params for theme on first load; this is
      // where we could push runtime overrides.
      sendToMarket('set-theme', { mode: 'light', primary: '#1578ff' });
      break;
    case 'route-change': {
      const path = ev.data.payload?.path ?? '/';
      elements.marketBreadcrumb.textContent = `market ${path}`;
      break;
    }
    case 'request-close':
      // Back arrow at the top level → switch back to the tunnel tab.
      activateTab('tunnel');
      break;
    case 'notify':
      // Forward to the host's own console for now.
      // eslint-disable-next-line no-console
      console.log('[market notify]', ev.data.payload);
      break;
  }
});

function setBusy(busy) {
  for (const button of [
    elements.refresh,
    elements.adminButton,
    ...elements.presetButtons,
    ...document.querySelectorAll('button[type="submit"]')
  ]) {
    button.disabled = busy;
  }
  elements.ruleKind.disabled = busy;
  elements.ruleDomain.disabled = busy;
  elements.testUrl.disabled = busy;
}

function formatAdminUrl(url) {
  return url.replace('http://127.0.0.1', '127.0.0.1');
}

function renderRules(rules = []) {
  elements.ruleList.replaceChildren();

  if (rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无规则';
    elements.ruleList.append(empty);
    return;
  }

  for (const rule of rules) {
    const item = document.createElement('article');
    item.className = 'rule-item';

    const kind = document.createElement('span');
    kind.className = `rule-kind ${rule.kind}`;
    kind.textContent = rule.kind === 'allow' ? '白名单' : '黑名单';

    const domain = document.createElement('strong');
    domain.textContent = rule.domain;

    const source = document.createElement('small');
    source.textContent = rule.source;

    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.dataset.ruleRemove = String(rule.id);
    remove.textContent = '移除';

    item.append(kind, domain, source, remove);
    elements.ruleList.append(item);
  }
}

// Set globally by `setInactive` / `setActive` to gate the controls.
let tunnelActive = false;

function setInactive() {
  tunnelActive = false;
  elements.running.textContent = '插件未激活';
  elements.mode.textContent = '-';
  elements.proxy.textContent = '-';
  elements.admin.textContent = '-';
  elements.tun.textContent = '-';
  elements.snapshot.textContent =
    '// QPJoy Tunnel 当前未运行。\n// 切到「插件市场」标签 → 在已安装/市场里启用或重新预装即可。\n';
  renderRules([]);
  for (const button of elements.presetButtons) {
    button.classList.remove('active');
    button.title = '插件未激活';
  }
  setControlsEnabled(false);
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    // tunnel inactive — IPC returned null, NOT an error.
    setInactive();
    return;
  }
  const status = snapshot.status ?? snapshot;
  if (!status) {
    setInactive();
    return;
  }
  tunnelActive = true;
  setControlsEnabled(true);

  elements.running.textContent = status.running ? '运行中' : '已停止';
  elements.mode.textContent = modeLabels[status.mode] ?? status.mode;
  elements.proxy.textContent = `127.0.0.1:${status.ports.mixed}`;
  elements.admin.textContent = formatAdminUrl(status.adminUrl);
  elements.tun.textContent = status.tunInstalled ? '已安装' : '未安装';
  elements.snapshot.textContent = JSON.stringify(snapshot, null, 2);
  renderRules(snapshot.rules ?? []);
  for (const button of elements.presetButtons) {
    const active = (snapshot.rules ?? []).some((rule) => rule.source === `preset:${button.dataset.preset}`);
    button.classList.toggle('active', active);
    button.title = active ? '再次点击移除这一组白名单' : '点击加入这一组白名单';
  }
}

/**
 * Toggle interactive controls based on tunnel availability. Read-only
 * elements (refresh button, plugin-market open button) stay enabled.
 */
function setControlsEnabled(enabled) {
  for (const button of [
    elements.adminButton,
    ...elements.presetButtons,
    ...document.querySelectorAll('button[type="submit"]')
  ]) {
    button.disabled = !enabled;
  }
  elements.ruleKind.disabled = !enabled;
  elements.ruleDomain.disabled = !enabled;
  elements.testUrl.disabled = !enabled;
}

async function refresh() {
  try {
    const snap = await window.qpjoyTunnelTest.snapshot();
    renderSnapshot(snap);
  } catch (err) {
    // The host CAN throw for non-tunnel reasons (e.g. host shutting down).
    // We surface that into the snapshot pane and stop further polling
    // for this tick instead of letting the error percolate to the console.
    elements.snapshot.textContent = err instanceof Error ? err.message : String(err);
  }
}

async function run(action) {
  if (!tunnelActive) {
    elements.snapshot.textContent = '插件未激活，请先在插件市场启用。';
    return;
  }
  setBusy(true);
  try {
    await action();
    await refresh();
  } catch (error) {
    elements.snapshot.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
}

elements.refresh.addEventListener('click', () => {
  void refresh();
});

elements.adminButton.addEventListener('click', () => {
  void window.qpjoyTunnelTest.openAdmin();
});

elements.ruleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  // Guard empty input — the tunnel IPC handler validates strictly and would
  // otherwise reject with `Error: domain is required`, surfacing in the
  // terminal as an unhelpful "error occurred in handler" trace.
  const domain = elements.ruleDomain.value.trim();
  if (!domain) {
    elements.ruleDomain.focus();
    elements.ruleDomain.setCustomValidity('请输入域名');
    elements.ruleDomain.reportValidity();
    return;
  }
  elements.ruleDomain.setCustomValidity('');
  void run(async () => {
    await window.qpjoyTunnelTest.addRule({
      kind: elements.ruleKind.value,
      domain
    });
    elements.ruleDomain.value = '';
  });
});

// Clear the custom validity message as soon as the user starts typing again.
elements.ruleDomain.addEventListener('input', () => {
  if (elements.ruleDomain.validationMessage) {
    elements.ruleDomain.setCustomValidity('');
  }
});

elements.ruleList.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.dataset.ruleRemove) {
    return;
  }
  void run(() => window.qpjoyTunnelTest.removeRule(Number(target.dataset.ruleRemove)));
});

for (const button of elements.presetButtons) {
  button.addEventListener('click', () => {
    const active = [...elements.ruleList.querySelectorAll('.rule-item small')]
      .some((source) => source.textContent === `preset:${button.dataset.preset}`);
    void run(() => active
      ? window.qpjoyTunnelTest.removePreset(button.dataset.preset)
      : window.qpjoyTunnelTest.addPreset(button.dataset.preset));
  });
}

elements.testForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(() => window.qpjoyTunnelTest.openTestWindow(elements.testUrl.value));
});

window.qpjoyTunnelTest.onEvent(() => {
  void refresh();
});

// React to plugin lifecycle changes pushed from main.cjs. Refresh
// immediately on flip so the UI doesn't lag the 3-second poll.
window.qpjoyTunnelTest.onActiveChange((active) => {
  tunnelActive = active;
  void refresh();
});

setInterval(() => {
  void refresh();
}, 3000);

void refresh();
