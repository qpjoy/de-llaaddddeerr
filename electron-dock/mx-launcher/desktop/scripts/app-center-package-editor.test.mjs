import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../renderer.js', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const createDraft = Function(`
const MX_H2I_PRODUCT_ID = 'mx-h2i';
const APP_CENTER_PRODUCT_ID = 'appcenter';
const persistedApp = {
  appId: 'mx-autotest',
  displayName: 'MX AutoTest',
  packageName: '@qpjoy/mx-autotest',
  launcherMode: 'standalone',
  productNetworkId: 'mx-autotest',
  permissions: [],
  requiredCapabilities: [],
  channels: ['stable'],
  accessPolicy: {}
};
function asArray(value) { return Array.isArray(value) ? value : []; }
function appCenterAppById(appId) { return appId === persistedApp.appId ? persistedApp : null; }
function cleanLauncherProductId(value) { return String(value || '').trim(); }
function launcherModeForApp(app) { return app.launcherMode; }
function productNetworkIdForApp(app) { return app.productNetworkId; }
function launcherProductNetworkForDefault() { return {}; }
function productSecondOctetFromProduct() { return 92; }
function nextAvailableProductSecondOctet() { return 92; }
function launcherAppExistingDnsRoute() { return null; }
function inferLauncherAppTemplate() { return 'standalone-service'; }
function standaloneChannelIdForApp(app) { return app.standaloneChannelProductId || MX_H2I_PRODUCT_ID; }
function textFromStringList() { return ''; }
function launcherAppDnsRouteId() { return 'route-mx-autotest'; }
function launcherAppDefaultDnsHost() { return 'mx-autotest.mxinfo-inc.cn'; }
function materializedVipForStandaloneDraft() { return '10.88.100.4'; }
function launcherAppDefaultUpstreamUrl() { return 'http://127.0.0.1:8080'; }
function applyLauncherAppTemplateToDraft(draft) { return draft; }
${functionSource(rendererSource, 'createAppCatalogEditorDraft')}
return createAppCatalogEditorDraft;
`)();

assert.equal(
  createDraft('edit', 'mx-autotest').packageName,
  '@qpjoy/mx-autotest',
  'editing a saved AppCenter app must hydrate Package from the persisted response'
);

const saveAppSource = functionSource(rendererSource, 'saveAppCenterAppFromEditor');
assert.ok(
  saveAppSource.includes('await refreshAppCenterNetwork();'),
  'saving an app must refresh the dashboard-derived Service VIP smoke snapshot'
);
assert.ok(
  saveAppSource.indexOf('await refreshAppCenterNetwork();') > saveAppSource.indexOf('state.activeAppNode = app.appId;'),
  'the saved app must be selected before its refreshed Service VIP state is rendered'
);
assert.doesNotMatch(
  saveAppSource,
  /reconcileLauncherServiceVip|launcher-service-vip-smokes\/reconcile/,
  'saving an app must never apply Service VIP runtime changes automatically'
);

console.log('AppCenter package editor hydration contract: ok');
