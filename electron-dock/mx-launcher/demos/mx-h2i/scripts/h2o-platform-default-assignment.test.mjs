#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main-runtime.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');

function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return text.slice(start, text.indexOf('\n}', start) + 2);
}

const sites = ['mx-oversea-jp01', 'mx-oversea-xjp01'];
const clone = value => JSON.parse(JSON.stringify(value));

// Execute the actual client orchestration against the ensure-subscription
// contract: explicit siteIds replace access; omitted siteIds preserve it.
function fixture({ entitlement = { status: 'active', siteIds: sites }, failRead = false, failSync = false, beforeEnsure } = {}) {
  let grant = clone(entitlement);
  const requests = [];
  const hydrates = [];
  const context = vm.createContext({
    runtime: { connection: { internalBaseUrl: 'https://internal.example' } },
    normalizeBaseUrl: value => value || null,
    nullableString: value => value || null,
    arrayValue: (value, fallback) => Array.isArray(value) ? value : fallback,
    uniqueStrings: value => [...new Set(value)],
    h2oCurrentUserId: async () => 'usr_fixture',
    h2oRequestInternalJson: async () => {
      if (failRead) throw new Error('lookup unavailable');
      return { payload: { entitlement: clone(grant) } };
    },
    discoverH2oOverseaSiteIds: async () => sites,
    appCenterCatalogHeaders: () => ({ Authorization: 'Bearer fixture-only' }),
    makeRequestId: () => 'fixture-request',
    joinApiUrl: (base, path) => base + path,
    requestJson: async (url, options) => {
      requests.push({ url, ...clone(options) });
      if (failSync) throw new Error('sync unavailable');
      if (beforeEnsure) grant = beforeEnsure(grant);
      const selected = options.body.assignmentMode === 'platform-default'
        ? [sites[0]]
        : options.body.siteIds ?? grant?.siteIds ?? [sites[0]];
      grant = { status: selected.length ? 'active' : 'disabled', siteIds: [...selected] };
      return { entitlement: clone(grant), sync: { status: 'passed' } };
    },
    hydrateH2oSystemSubscriptionsForUser: async options => hydrates.push(clone(options)),
    pushAppLog: () => {},
    errorMessage: error => error.message
  });
  for (const name of ['provisionH2oOverseaForCurrentUser', 'h2oOverseaProvisionSiteAttempts']) {
    vm.runInContext(`async ${functionSource(source, name)}`, context);
  }
  return { context, requests, hydrates, grant: () => grant };
}

test('existing multi-node access cannot be reset by client assignment parameters', async () => {
  const f = fixture();
  await f.context.provisionH2oOverseaForCurrentUser({ assignmentMode: 'platform-default', siteIds: [sites[0]] });
  assert.deepEqual(f.grant().siteIds, sites);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.assignmentMode, undefined);
  assert.equal(f.requests[0].body.siteIds, undefined);
  assert.equal(f.hydrates.length, 1, 'subscription content is refreshed after ensure');
});

test('an admin grant added during refresh is not overwritten by a stale client list', async () => {
  const latestSites = [...sites, 'mx-oversea-new'];
  const f = fixture({ beforeEnsure: grant => ({ ...grant, siteIds: latestSites }) });
  await f.context.provisionH2oOverseaForCurrentUser({ siteIds: sites });
  assert.deepEqual(f.grant().siteIds, latestSites);
});

test('failed multi-site sync never retries by dropping to a single node', async () => {
  const f = fixture({ failSync: true });
  await assert.rejects(f.context.provisionH2oOverseaForCurrentUser(), /sync unavailable/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.grant().siteIds, sites);
});

test('failed entitlement lookup cannot trigger new access assignment', async () => {
  const f = fixture({ failRead: true });
  await assert.rejects(f.context.provisionH2oOverseaForCurrentUser(), /lookup unavailable/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.grant().siteIds, sites);
});

test('admin-disabled access remains disabled after client ensure', async () => {
  const f = fixture({ entitlement: { status: 'disabled', siteIds: [] } });
  await assert.rejects(f.context.provisionH2oOverseaForCurrentUser(), /active oversea entitlement/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.grant().status, 'disabled');
  assert.deepEqual(f.grant().siteIds, []);
});

test('a brand-new user still automatically receives the platform default', async () => {
  const f = fixture({ entitlement: null });
  await f.context.provisionH2oOverseaForCurrentUser();
  assert.deepEqual(f.grant().siteIds, [sites[0]]);
  assert.equal(f.requests[0].body.siteIds, undefined);
  assert.equal(f.requests[0].body.syncRuntime, true);
  assert.equal(f.hydrates.length, 1);
});

test('legacy provision IPC only refreshes and ignores reset parameters', async () => {
  const handlers = new Map();
  const hydrates = [];
  const runtime = { apps: { h2o: { installed: true, runtime: { activeSubscription: { nodes: 2 } } } } };
  const context = vm.createContext({
    runtime,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    runtimeHasUserIdentity: () => true,
    hydrateH2oSystemSubscriptionsForUser: async options => hydrates.push(clone(options)),
    h2oHasUsableSubscription: value => value.nodes > 0,
    touchRuntime: () => {},
    saveAndBroadcast: async () => {},
    visibleRuntime: () => runtime
  });
  const start = source.indexOf("ipcMain.handle('mx-h2i:provision-h2o-oversea'");
  const end = source.indexOf('ipcMain.handle(', start + 1);
  vm.runInContext(source.slice(start, end), context);
  await handlers.get('mx-h2i:provision-h2o-oversea')({}, { assignmentMode: 'platform-default', siteIds: [sites[0]] });
  assert.deepEqual(hydrates, [{ showInitializing: true }]);
  assert.equal(runtime.apps.h2o.runtime.activeSubscription.nodes, 2);
  assert.equal(runtime.feedback.tone, 'success');
});

test('H2O offers refresh and protects managed subscriptions while custom entries remain editable', () => {
  const panel = functionSource(renderer, 'renderH2oSubscriptionManager');
  assert.doesNotMatch(panel, /provisionH2oOversea|分配系统默认/);
  assert.match(panel, /refreshH2oSubscription/);
  const context = vm.createContext({});
  vm.runInContext(functionSource(renderer, 'h2oSubscriptionCanDelete'), context);
  for (const id of ['h2o-default', ...sites]) {
    assert.equal(context.h2oSubscriptionCanDelete({ id, source: 'internal', requiresUser: true }), false);
  }
  assert.equal(context.h2oSubscriptionCanDelete({ id: 'custom-1', source: 'custom' }), true);
  assert.equal(context.h2oSubscriptionCanDelete({ id: 'external-1', source: 'external' }), true);
});
