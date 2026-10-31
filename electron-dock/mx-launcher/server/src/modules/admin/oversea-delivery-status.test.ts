import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { AdminController } from './admin.controller.js';

test('Oversea overview distinguishes static delivery requirements from verified delivery and blockers', async () => {
  const siteId = 'oversea-delivery-test';
  const store = new MemoryStore(loadConfig());
  store.issueSiteSlotAccessAccounts({ siteId, issueDefaults: true, publicHost: '192.0.2.1', requestedBy: 'test' });
  const original = store.getLauncherNetworkMihomoReachability(siteId);
  assert.ok(original);
  assert.equal(original.verdict, 'h-endpoint-blocked');
  const controller = new AdminController(store as unknown as PlatformStore);
  const overview = controller as unknown as {
    buildOverseaSiteOverview(siteId: string, profiles: [], pipelines: []): Promise<{
      services: Array<{ name: string; status: string }>;
    }>;
  };
  const deliveryStatus = async () => (await overview.buildOverseaSiteOverview(siteId, [], []))
    .services.find((service) => service.name === 'H Delivery')?.status;

  assert.equal(await deliveryStatus(), 'pending-evidence');
  assert.deepEqual(store.getLauncherNetworkMihomoReachability(siteId)?.stages, original.stages,
    'presentation must not change the reachability plan or its execution gates');

  store.getLauncherNetworkMihomoReachability = () => ({ ...original, verdict: 'blocked' });
  assert.equal(await deliveryStatus(), 'blocked');
  store.getLauncherNetworkMihomoReachability = () => ({ ...original, currentBoundary: 'domestic-relay' });
  assert.equal(await deliveryStatus(), 'blocked', 'a different boundary is not the legacy static plan');
  store.getLauncherNetworkMihomoReachability = () => ({ ...original, verdict: 'h-endpoint-ready', currentBoundary: 'h-endpoint' });
  assert.equal(await deliveryStatus(), 'ready');
  store.getLauncherNetworkMihomoReachability = () => null;
  assert.equal(await deliveryStatus(), 'pending-evidence', 'absent evidence is not a runtime failure');
});
