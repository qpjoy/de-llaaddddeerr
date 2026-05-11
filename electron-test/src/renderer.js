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
  presetButtons: [...document.querySelectorAll('[data-preset]')]
};

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

function renderSnapshot(snapshot) {
  const status = snapshot?.status ?? snapshot;
  if (!status) {
    elements.running.textContent = '未初始化';
    elements.mode.textContent = '-';
    elements.proxy.textContent = '-';
    elements.admin.textContent = '-';
    elements.tun.textContent = '-';
    elements.snapshot.textContent = '{}';
    renderRules([]);
    return;
  }

  elements.running.textContent = status.running ? '运行中' : '已停止';
  elements.mode.textContent = modeLabels[status.mode] ?? status.mode;
  elements.proxy.textContent = `127.0.0.1:${status.ports.mixed}`;
  elements.admin.textContent = formatAdminUrl(status.adminUrl);
  elements.tun.textContent = status.tunInstalled ? '已安装' : '未安装';
  elements.snapshot.textContent = JSON.stringify(snapshot, null, 2);
  renderRules(snapshot.rules ?? []);
}

async function refresh() {
  renderSnapshot(await window.qpjoyTunnelTest.snapshot());
}

async function run(action) {
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
  void run(async () => {
    await window.qpjoyTunnelTest.addRule({
      kind: elements.ruleKind.value,
      domain: elements.ruleDomain.value
    });
    elements.ruleDomain.value = '';
  });
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
    void run(() => window.qpjoyTunnelTest.addPreset(button.dataset.preset));
  });
}

elements.testForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(() => window.qpjoyTunnelTest.openTestWindow(elements.testUrl.value));
});

window.qpjoyTunnelTest.onEvent(() => {
  void refresh();
});

setInterval(() => {
  void refresh();
}, 3000);

void refresh();
