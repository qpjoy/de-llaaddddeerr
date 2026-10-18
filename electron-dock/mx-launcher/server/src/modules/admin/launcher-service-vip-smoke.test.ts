import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { AdminLauncherServiceVipSmoke, DnsReverseProxyRouteInput } from '../../types.js';
import { AdminController } from './admin.controller.js';

const rigVip = '10.88.100.6';
const rigHostname = 'mx-rig.mxinfo-inc.cn';
const rigUpstream = 'http://192.168.1.2:30891';

function fixture() {
  const store = new MemoryStore(loadConfig());
  const product = store.upsertLauncherProductNetwork({
    productId: 'mx-rig',
    displayName: 'MX Rig',
    mode: 'standalone',
    networkScope: 'owner',
    productIndex: 4,
    serviceVip: rigVip,
    userCidr: '10.94.0.0/16',
    feishuCidr: '10.94.0.0/16',
    anonymousCidr: '10.94.0.0/16'
  });
  assert.equal(product.internalControlIp, rigVip, 'standalone Rig defaults its Internal context to its own VIP');
  store.upsertAppCenterApp({
    appId: 'mx-rig', displayName: 'MX Rig', packageName: '@qpjoy/mx-rig',
    launcherMode: 'standalone', productNetworkId: 'mx-rig', enabled: true
  });
  const controller = new AdminController(store);
  const route = (input: DnsReverseProxyRouteInput = {}) => store.upsertDnsReverseProxyRoute({
    host: rigVip, dnsTarget: rigVip, targetUrl: rigUpstream, enabled: true,
    ...input
  });
  const smoke = async (appId = 'mx-rig') => {
    const dashboard = await controller.dashboard();
    const result = dashboard.launcherServiceVipSmokes.find(item => item.appId === appId);
    assert.ok(result, `dashboard must include ${appId}`);
    return result;
  };
  return { store, controller, route, smoke };
}

function check(smoke: AdminLauncherServiceVipSmoke, checkId: string) {
  const result = smoke.checks.find(item => item.checkId === checkId);
  assert.ok(result, `smoke must include ${checkId}`);
  return result;
}

test('Rig standalone smoke accepts the exact service VIP Host and its NodePort upstream', async () => {
  const f = fixture();
  const route = f.route();
  const smoke = await f.smoke();
  assert.equal(smoke.dnsHost, rigVip);
  assert.equal(smoke.dnsRouteId, route.routeId);
  assert.equal(smoke.upstreamUrl, rigUpstream);
  for (const id of ['dns-route', 'dns-target', 'gateway-upstream']) assert.equal(check(smoke, id).status, 'passed');
});

test('an exact VIP Host takes precedence over an existing legacy hostname route', async () => {
  const f = fixture();
  f.route({ host: rigHostname, targetUrl: 'http://legacy-service:8080' });
  const vipRoute = f.route();
  const smoke = await f.smoke();
  assert.equal(smoke.dnsRouteId, vipRoute.routeId);
  assert.equal(smoke.dnsHost, rigVip);
  assert.equal(smoke.upstreamUrl, rigUpstream);
});

test('legacy standalone hostname routes remain valid when no exact VIP Host exists', async () => {
  const f = fixture();
  const route = f.route({ host: rigHostname });
  const smoke = await f.smoke();
  assert.equal(smoke.dnsHost, rigHostname);
  assert.equal(smoke.dnsRouteId, route.routeId);
  for (const id of ['dns-route', 'dns-target', 'gateway-upstream']) assert.equal(check(smoke, id).status, 'passed');
});

test('a disabled exact VIP route is reported instead of masked by an enabled hostname route', async () => {
  const f = fixture();
  f.route({ host: rigHostname });
  const disabled = f.route({ enabled: false });
  const smoke = await f.smoke();
  assert.equal(smoke.dnsRouteId, disabled.routeId);
  assert.equal(smoke.dnsHost, rigVip);
  assert.equal(check(smoke, 'dns-route').status, 'warning');
  assert.match(check(smoke, 'dns-route').detail, /disabled/);
});

test('missing routes, missing upstreams and incorrect targets remain actionable failures', async () => {
  const missing = fixture();
  assert.equal(check(await missing.smoke(), 'dns-route').status, 'blocked');

  const noUpstream = fixture();
  noUpstream.route({ targetUrl: null });
  const upstreamSmoke = await noUpstream.smoke();
  assert.equal(check(upstreamSmoke, 'dns-route').status, 'passed');
  assert.equal(check(upstreamSmoke, 'gateway-upstream').status, 'blocked');

  const wrongTarget = fixture();
  wrongTarget.route({ dnsTarget: '10.88.88.88' });
  const targetSmoke = await wrongTarget.smoke();
  assert.equal(check(targetSmoke, 'dns-route').status, 'passed');
  assert.equal(check(targetSmoke, 'dns-target').status, 'warning');
  assert.equal(check(targetSmoke, 'dns-target').expected, rigVip);
  assert.equal(check(targetSmoke, 'dns-target').actual, '10.88.88.88');
});

test('an embed app keeps its hostname and never borrows the broker service VIP route', async () => {
  const f = fixture();
  const broker = f.store.getLauncherProductNetwork('mx-h2i');
  assert.ok(broker);
  f.route({ host: broker.serviceVip, dnsTarget: broker.internalControlIp, targetUrl: 'http://h2i-service:8080' });
  f.store.upsertAppCenterApp({
    appId: 'rig-embedded-tools', displayName: 'Embedded tools', launcherMode: 'embed',
    standaloneChannelProductId: 'mx-h2i', productNetworkId: 'rig-embedded-tools',
    packageName: '@qpjoy/rig-embedded-tools', enabled: true
  });
  const missing = await f.smoke('rig-embedded-tools');
  assert.equal(missing.dnsHost, 'rig-embedded-tools.mxinfo-inc.cn');
  assert.equal(missing.dnsRouteId, null);
  assert.equal(check(missing, 'dns-route').status, 'blocked');
  const embedRoute = f.route({ host: missing.dnsHost, dnsTarget: broker.internalControlIp, targetUrl: 'http://embed-service:8080' });
  const configured = await f.smoke('rig-embedded-tools');
  assert.equal(configured.dnsRouteId, embedRoute.routeId);
  assert.equal(check(configured, 'dns-route').status, 'passed');
});

test('MX-H2I hostname checks retain their existing Internal target', async () => {
  const f = fixture();
  const h2i = f.store.getLauncherProductNetwork('mx-h2i');
  assert.ok(h2i);
  assert.equal(h2i.internalControlIp, '10.88.88.88');
  const route = f.route({ host: 'mx-h2i.mxinfo-inc.cn', dnsTarget: h2i.internalControlIp, targetUrl: 'http://127.0.0.1:8080' });
  const smoke = await f.smoke('mx-h2i');
  assert.equal(smoke.dnsHost, 'mx-h2i.mxinfo-inc.cn');
  assert.equal(smoke.dnsRouteId, route.routeId);
  assert.equal(check(smoke, 'dns-target').expected, '10.88.88.88');
  for (const id of ['dns-route', 'dns-target', 'gateway-upstream']) assert.equal(check(smoke, id).status, 'passed');
});

test('reading dashboard smokes never modifies applications, product networks, leases or routes', async () => {
  const f = fixture();
  f.route();
  const lease = f.store.enrollLauncherNetworkLease({
    appId: 'mx-h2i', productId: 'mx-h2i', mode: 'standalone', identityKind: 'anonymous', leaseProfile: 'anonymous',
    installId: 'inst_vip_smoke_existing_h2i', deviceId: 'dev_vip_smoke_existing_h2i', publicKey: 'public-key-vip-smoke-existing-h2i'
  });
  const snapshot = () => structuredClone({
    apps: f.store.listAppCenterApps({ includeHidden: true, includeDisabled: true }),
    products: f.store.listLauncherProductNetworks(),
    leases: f.store.listLauncherNetworkLeases(),
    routes: f.store.listDnsReverseProxyRoutes(),
    audits: f.store.listAuditEvents({ metadataLeaseId: lease.leaseId })
  });
  const before = snapshot();
  await f.controller.dashboard();
  await f.controller.dashboard();
  assert.deepEqual(snapshot(), before);
});
