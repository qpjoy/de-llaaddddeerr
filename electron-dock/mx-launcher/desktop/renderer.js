const api = window.mxLauncher;

const stateChip = document.getElementById('connection-state');
const hdoLaunch = document.getElementById('hdo-launch');
const hdoAdmin = document.getElementById('hdo-admin');
const hdoStatus = document.getElementById('hdo-status');
const serverInput = document.getElementById('server-input');
const platformStatus = document.getElementById('platform-status');

void boot();

hdoLaunch.addEventListener('click', () => {
  void launchHdo();
});

hdoAdmin.addEventListener('click', () => {
  void api.openAdmin(serverInput.value);
});

serverInput.addEventListener('change', () => {
  void persistConfig();
});

async function boot() {
  const config = await api.getConfig();
  serverInput.value = config.serverBaseUrl || '';
  await refreshProducts();
  const status = await api.getStatus();
  renderStatus(status);
}

async function refreshProducts() {
  const products = await api.getProducts();
  const hdo = products.find((product) => product.id === 'hdo');
  hdoStatus.textContent = hdo && hdo.status === 'installed' ? '已安装' : '未安装';
}

async function persistConfig() {
  const current = await api.getConfig();
  await api.saveConfig({
    serverBaseUrl: serverInput.value,
    productConfigs: current.productConfigs || {}
  });
}

async function launchHdo() {
  await persistConfig();
  stateChip.textContent = '启动中';
  stateChip.dataset.state = 'connecting';
  const result = await api.launchProduct({
    productId: 'hdo',
    serverBaseUrl: serverInput.value
  });
  if (!result.ok) {
    stateChip.textContent = '服务未安装';
    stateChip.dataset.state = 'error';
    platformStatus.textContent = result.error || '需要安装服务';
  }
}

function renderStatus(status) {
  if (status.connectionState === 'error') {
    stateChip.textContent = '服务未安装';
    stateChip.dataset.state = 'error';
    platformStatus.textContent = '需要安装服务';
    return;
  }
  stateChip.textContent = '就绪';
  stateChip.dataset.state = 'idle';
  platformStatus.textContent = status.service && status.service.installed ? '服务已安装' : '等待服务安装';
}
