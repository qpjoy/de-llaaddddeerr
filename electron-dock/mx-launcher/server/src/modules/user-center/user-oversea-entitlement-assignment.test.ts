import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryStore } from '../../store/memory.js';
import { loadConfig } from '../../config.js';

function seed() {
  const store = new MemoryStore(loadConfig());
  for (const siteId of ['oversea-main', 'mx-oversea-hk01']) {
    store.upsertLauncherNetworkMihomoSite({
      siteId,
      publicHost: `${siteId}.example.com`,
      serverPorts: '51289',
      requestedBy: 'test'
    });
    store.issueSiteSlotAccessAccounts({ siteId, accountNames: ['seed'], requestedBy: 'test' });
  }
  const user = store.createUserCenterUser({ account: 'assignuser', displayName: 'Assign User' });
  return { store, user };
}

test('a first entitlement with no siteIds falls back to the platform default', () => {
  const { store, user } = seed();
  const entitlement = store.upsertUserOverseaEntitlement({ userId: user.userId, requestedBy: 'test' });

  assert.ok(entitlement.siteIds.length > 0, 'a brand-new user still gets a default site');
});

test('re-provisioning without siteIds keeps the admin assignment', () => {
  const { store, user } = seed();
  store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['mx-oversea-hk01'],
    requestedBy: 'desktop-admin'
  });

  // This is what H2O's ensure-subscription posts on every refresh. It used to
  // reset the user back to the platform default site (oversea-main).
  const refreshed = store.upsertUserOverseaEntitlement({ userId: user.userId, requestedBy: 'mx-h2i-h2o' });

  assert.deepEqual(refreshed.siteIds, ['mx-oversea-hk01']);
  assert.deepEqual(refreshed.accounts.map((account) => account.siteId), ['mx-oversea-hk01']);
});

test('an explicit siteIds still reassigns, and an empty list still disables', () => {
  const { store, user } = seed();
  store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: ['oversea-main'], requestedBy: 'test' });

  const reassigned = store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['mx-oversea-hk01'],
    requestedBy: 'test'
  });
  assert.deepEqual(reassigned.siteIds, ['mx-oversea-hk01']);

  const disabled = store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: [], requestedBy: 'test' });
  assert.equal(disabled.status, 'disabled');

  // Preserving "no assignment" matters as much as preserving one: a later refresh
  // must not silently re-grant access the admin just revoked.
  const afterRefresh = store.upsertUserOverseaEntitlement({ userId: user.userId, requestedBy: 'mx-h2i-h2o' });
  assert.deepEqual(afterRefresh.siteIds, []);
  assert.equal(afterRefresh.status, 'disabled');
});

test('a multi-site assignment survives a refresh so the subscription stays multi-node', () => {
  const { store, user } = seed();
  store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['oversea-main', 'mx-oversea-hk01'],
    requestedBy: 'desktop-admin'
  });

  const refreshed = store.upsertUserOverseaEntitlement({ userId: user.userId, requestedBy: 'mx-h2i-h2o' });
  assert.deepEqual(refreshed.siteIds, ['mx-oversea-hk01', 'oversea-main']);

  const yaml = store.renderUserOverseaMihomoSubscription(user.userId)?.yaml ?? '';
  assert.match(yaml, /oversea-main-hysteria2/);
  assert.match(yaml, /mx-oversea-hk01-hysteria2/);
});
