import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rendererSource = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');

function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(rendererSource);
  assert.ok(match, `${name} must exist`);
  const end = rendererSource.indexOf('\n}\n', match.index);
  assert.ok(end > match.index, `${name} must have a complete body`);
  return rendererSource.slice(match.index, end + 2);
}

const apps = [
  { appId: 'mx-rig', displayName: 'MX Rig', launcherMode: 'standalone', productNetworkId: 'mx-rig' },
  { appId: 'luopan', displayName: 'Luopan', launcherMode: 'standalone', productNetworkId: 'luopan' }
];
const products = [
  { productId: 'mx-rig', mode: 'standalone', serviceVip: '10.88.100.6' },
  { productId: 'luopan', mode: 'standalone', serviceVip: '10.88.100.2' }
];

function fixture() {
  const state = {
    appCenterApps: structuredClone(apps),
    launcherProducts: structuredClone(products),
    appCenterAppsError: null,
    launcherProductsError: null,
    workbenchCatalogLoadedAt: '2026-10-16T00:00:00.000Z',
    activeAppNode: 'mx-rig',
    activeView: 'app-center',
    mxH2iSurface: 'product',
    launcherNetworkServerBase: 'http://server-a.test',
    launcherNetworkServerOrigin: 'http://server-a.test',
    launcherNetworkRequestGeneration: 0,
    launcherLeases: [],
    launcherProductUserAccessByProduct: {},
    launcherProductUserAccessErrors: {},
    dnsCenter: {},
    userCenter: {},
    domesticRuntime: {},
    secretCenter: {},
    sdkGateway: {},
    setupRun: { active: false },
    adminSection: 'foundations'
  };
  const requests = [];
  let handler = async (path) => {
    if (path === '/internal/v1/app-center/apps') return { apps: structuredClone(apps) };
    if (path === '/internal/v1/launcher-network/products') return { products: structuredClone(products) };
    if (path === '/internal/v1/admin/dashboard') return { overview: { siteId: 'internal', storeDriver: 'postgres' } };
    if (path.endsWith('/domestic-product-cidrs/sync')) return {
      domesticProductCidrSync: { status: 'passed', changed: true, addedProductRelayCidrs: ['10.94.0.0/16'], productRelayCidrs: ['10.89.0.0/16', '10.94.0.0/16'] }
    };
    throw new Error(`Unexpected request: ${path}`);
  };
  let rendered;
  const noop = () => {};
  const deps = {
    state,
    MX_H2I_PRODUCT_ID: 'mx-h2i', APP_CENTER_PRODUCT_ID: 'appcenter', MX_INSIGHT_HUB_APP_ID: 'mx-insight-hub', LAUNCHER_NETWORK_ALL_PRODUCTS: 'all',
    asArray: value => Array.isArray(value) ? value : [],
    normalizeLauncherProductId: value => String(value || '').trim().toLowerCase(),
    normalizeServerBaseValue: value => String(value || '').replace(/\/+$/, ''),
    defaultServerBaseUrl: () => 'http://server-a.test',
    fetchJson: async (path, options = {}) => { requests.push({ path, method: options.method || 'GET' }); return handler(path, options); },
    loadLauncherNetworkLeases: async () => ({ leases: [] }),
    loadMxH2iProductUserAccessList: async () => ({}),
    loadDnsReverseProxyRoutes: async () => ({ routes: [] }),
    loadAppOnboardingTemplates: async () => ({ templates: [] }),
    loadLauncherServiceVipSmokes: async () => ({ smokes: [] }),
    applyLauncherProductUserAccessLists: noop,
    launcherNetworkSelectedProductId: () => 'all',
    ensureLauncherProductUserAccess: async () => {},
    renderLauncherFoundationOverview: noop,
    renderSelectedAppDetail: noop,
    renderAppCenterShell: () => { rendered = { ids: api.orderedAppCenterApps().map(app => app.appId), selected: api.activeAppCenterApp().appId, appsError: state.appCenterAppsError, productsError: state.launcherProductsError }; },
    persistConfig: async () => {}, renderAdminLoading: noop,
    loadSshProfiles: async () => ({ profiles: [] }),
    loadOverseaOverview: async () => ({}),
    loadUserCenterOverview: async () => ({}),
    loadDomesticRuntimeConfigs: async () => ({ configs: [] }),
    loadSecretCenter: async () => ({}),
    loadDnsPolicyCenter: async () => ({}),
    loadGatewayRuntimeConfig: async () => ({}),
    loadSdkGatewayManifest: async () => ({}),
    applySecretCenterPayload: noop, applyGatewayRuntimeConfig: noop,
    selectedSiteFromOverseaOverview: () => null,
    selectedOrActivePipelineForCurrentDeployment: () => null,
    primeSshProfileForm: noop, primeAwxProviderForm: noop,
    renderAdminDashboard: noop, renderEmptyPipeline: noop,
    setConnection: noop, renderAdminError: noop,
    adminAccessPresentation: () => ({ health: 'failed', connection: 'Offline', title: 'Unavailable' }),
    resetMxH2iTopologyRuntimeObservation: noop, resetMxH2iTopologyTrafficHistory: noop,
    launcherProductUserAccessRequests: new Map(), closeMxH2iLeaseDrawer: noop
  };
  const names = [
    'loadAppCenterApps', 'loadLauncherProductNetworks', 'refreshAppCenterNetwork', 'refreshAdmin',
    'syncLauncherServiceVipDomesticCidrs', 'captureLauncherNetworkRequestScope', 'isLauncherNetworkRequestScopeCurrent',
    'launcherNetworkServerIdentity', 'synchronizeLauncherNetworkServerScope',
    'fallbackAppCenterApps', 'orderedAppCenterApps', 'appCenterAppById', 'activeAppCenterApp', 'escapeHtml'
  ];
  for (const name of ['applyAppCenterRegistryPayloads', 'renderAppCenterRegistryRefreshError', 'bindAppCenterRegistryRefreshControls']) {
    if (rendererSource.includes(`function ${name}(`)) names.push(name);
  }
  const api = Function(...Object.keys(deps), `${names.map(functionSource).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
  return { state, api, requests, setHandler: value => { handler = value; }, get rendered() { return rendered; } };
}

test('CIDR sync keeps the selected Rig, other applications and products when registry refresh fails', async () => {
  const f = fixture();
  f.setHandler(async path => {
    if (path.endsWith('/domestic-product-cidrs/sync')) return { domesticProductCidrSync: { status: 'passed', changed: true } };
    throw new Error(`HTTP 503: ${path}`);
  });
  await f.api.syncLauncherServiceVipDomesticCidrs('domestic-main', 'mx-rig');
  assert.deepEqual(f.state.appCenterApps, apps);
  assert.deepEqual(f.state.launcherProducts, products);
  assert.equal(f.rendered.selected, 'mx-rig');
  assert.ok(f.rendered.ids.includes('luopan'));
  assert.match(f.rendered.appsError, /HTTP 503/);
  assert.match(f.rendered.productsError, /HTTP 503/);
  assert.equal(f.state.launcherServiceVipCidrSyncFeedback.kind, 'warning');
  assert.match(f.state.launcherServiceVipCidrSyncFeedback.detail, /HTTP 503/);
  assert.equal(f.state.launcherServiceVipCidrSyncBusy, null);
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 1, 'refresh does not apply runtime changes');
});

test('a successful empty registry removes custom entries instead of keeping stale applications', async () => {
  const f = fixture();
  f.setHandler(async path => path.endsWith('/apps') ? { apps: [] } : { products: [] });
  await f.api.refreshAppCenterNetwork();
  assert.deepEqual(f.state.appCenterApps, []);
  assert.deepEqual(f.state.launcherProducts, []);
  assert.ok(!f.rendered.ids.includes('mx-rig'));
  assert.ok(!f.rendered.ids.includes('luopan'));
  assert.equal(f.state.appCenterAppsError, null);
  assert.equal(f.state.launcherProductsError, null);
});

test('retry installs a valid new registry and clears refresh errors', async () => {
  const f = fixture();
  f.setHandler(async () => { throw new Error('connection unavailable'); });
  await f.api.refreshAppCenterNetwork();
  const recoveredApps = [{ ...apps[0], displayName: 'Recovered Rig' }];
  const recoveredProducts = [{ ...products[0], displayName: 'Recovered Rig' }];
  f.setHandler(async path => path.endsWith('/apps') ? { apps: recoveredApps } : { products: recoveredProducts });
  await f.api.refreshAppCenterNetwork();
  assert.deepEqual(f.state.appCenterApps, recoveredApps);
  assert.deepEqual(f.state.launcherProducts, recoveredProducts);
  assert.equal(f.rendered.selected, 'mx-rig');
  assert.equal(f.state.appCenterAppsError, null);
  assert.equal(f.state.launcherProductsError, null);
  assert.ok(f.state.workbenchCatalogLoadedAt);
});

test('a partial refresh updates the successful registry while retaining the failed one', async () => {
  for (const appsFail of [true, false]) {
    const f = fixture();
    f.setHandler(async path => {
      const isApps = path.endsWith('/apps');
      if (isApps === appsFail) throw new Error('one registry unavailable');
      return isApps ? { apps: [apps[0]] } : { products: [products[0]] };
    });
    await f.api.refreshAppCenterNetwork();
    assert.deepEqual(f.state.appCenterApps, appsFail ? apps : [apps[0]]);
    assert.deepEqual(f.state.launcherProducts, appsFail ? [products[0]] : products);
    assert.equal(f.rendered.selected, 'mx-rig');
    assert.equal(Boolean(f.state.appCenterAppsError), appsFail);
    assert.equal(Boolean(f.state.launcherProductsError), !appsFail);
  }
});

test('missing and non-array registry fields are failures rather than empty snapshots', async () => {
  for (const value of [undefined, null, {}, 'invalid']) {
    const f = fixture();
    f.setHandler(async path => path.endsWith('/apps') ? { apps: value } : { products: value });
    await f.api.refreshAppCenterNetwork();
    assert.deepEqual(f.state.appCenterApps, apps);
    assert.deepEqual(f.state.launcherProducts, products);
    assert.ok(f.state.appCenterAppsError);
    assert.ok(f.state.launcherProductsError);
  }
});

test('Admin refresh keeps registry snapshots when app reads or the dashboard fail', async () => {
  for (const dashboardFails of [false, true]) {
    const f = fixture();
    f.setHandler(async path => {
      if (path.endsWith('/dashboard') && !dashboardFails) return { overview: { siteId: 'internal', storeDriver: 'postgres' } };
      throw new Error('temporary Admin error');
    });
    await f.api.refreshAdmin();
    assert.deepEqual(f.state.appCenterApps, apps);
    assert.deepEqual(f.state.launcherProducts, products);
    assert.equal(f.rendered.selected, 'mx-rig');
    assert.match(f.state.appCenterAppsError, /temporary Admin error/);
    assert.match(f.state.launcherProductsError, /temporary Admin error/);
  }
});

test('server changes clear registry snapshots and ignore late responses from the old server', async () => {
  const f = fixture();
  const pending = [];
  f.setHandler(path => new Promise(resolve => pending.push({ path, resolve })));
  const refresh = f.api.refreshAppCenterNetwork();
  assert.equal(pending.length, 2);
  assert.equal(f.api.synchronizeLauncherNetworkServerScope('http://server-b.test'), true);
  assert.deepEqual(f.state.appCenterApps, []);
  assert.deepEqual(f.state.launcherProducts, []);
  assert.equal(f.state.workbenchCatalogLoadedAt, null);
  for (const request of pending) request.resolve(request.path.endsWith('/apps') ? { apps } : { products });
  await refresh;
  assert.deepEqual(f.state.appCenterApps, []);
  assert.deepEqual(f.state.launcherProducts, []);
  f.setHandler(async () => { throw new Error('server B unavailable'); });
  await f.api.refreshAppCenterNetwork();
  assert.ok(!f.rendered.ids.includes('mx-rig'), 'server B must not display server A custom applications');
  assert.deepEqual(f.state.launcherProducts, []);
});

test('registry errors are escaped and distinguish retained snapshots from an initial failed load', () => {
  const f = fixture();
  assert.equal(f.api.renderAppCenterRegistryRefreshError(), '');
  f.state.appCenterAppsError = '<img src=x onerror="alert(1)"> & failed';
  f.state.launcherProductsError = f.state.appCenterAppsError;
  const html = f.api.renderAppCenterRegistryRefreshError();
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; failed/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(html.match(/&lt;img/g).length, 1, 'identical failures should not be duplicated');
  assert.match(html, /保留上次成功读取/);
  assert.match(html, /data-app-registry-refresh/);
  f.state.workbenchCatalogLoadedAt = null;
  assert.match(f.api.renderAppCenterRegistryRefreshError(), /尚未完整读取/);
});

test('the retry button reads registries without repeating CIDR sync or applying runtime changes', async () => {
  const f = fixture();
  let click;
  const button = { disabled: false, addEventListener: (event, handler) => { assert.equal(event, 'click'); click = handler; } };
  f.api.bindAppCenterRegistryRefreshControls({ querySelectorAll: selector => {
    assert.equal(selector, '[data-app-registry-refresh]');
    return [button];
  } });
  const pending = [];
  f.setHandler(path => new Promise(resolve => pending.push({ path, resolve })));
  const retry = click();
  assert.equal(button.disabled, true);
  for (const request of pending) request.resolve(request.path.endsWith('/apps') ? { apps } : { products });
  await retry;
  assert.equal(button.disabled, false);
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(request => request.method === 'GET'));
  assert.ok(f.requests.every(request => !/sync|reconcile|apply/.test(request.path)));
  assert.equal(f.rendered.selected, 'mx-rig');
});
