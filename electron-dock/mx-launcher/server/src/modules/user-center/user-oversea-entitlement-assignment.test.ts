import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryStore } from '../../store/memory.js';
import { loadConfig } from '../../config.js';
import { MX_H2I_PRODUCT_ID } from '../../store/domain.js';

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

test('the admin-set default site decides where a brand-new user lands', () => {
  const { store, user } = seed();
  // oversea-main was the hard-coded default; it has since been repurposed, so the
  // platform default has to be movable from the admin UI.
  store.upsertLauncherProductNetwork({
    productId: MX_H2I_PRODUCT_ID,
    defaultOverseaSiteId: 'mx-oversea-hk01',
    requestedBy: 'desktop-admin'
  });

  const entitlement = store.upsertUserOverseaEntitlement({ userId: user.userId, requestedBy: 'test' });
  assert.deepEqual(entitlement.siteIds, ['mx-oversea-hk01']);
});

test('an archived default site is skipped rather than handed out', () => {
  const { store, user } = seed();
  store.upsertLauncherProductNetwork({
    productId: MX_H2I_PRODUCT_ID,
    defaultOverseaSiteId: 'mx-oversea-hk01',
    requestedBy: 'desktop-admin'
  });
  store.archiveLauncherNetworkMihomoSite({
    siteId: 'mx-oversea-hk01',
    archived: true,
    requestedBy: 'test'
  });

  const entitlement = store.upsertUserOverseaEntitlement({ userId: user.userId, requestedBy: 'test' });
  assert.deepEqual(entitlement.siteIds, ['oversea-main'], 'falls back to a site that is still in service');
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

  const reenabled = store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['mx-oversea-hk01'],
    requestedBy: 'desktop-admin'
  });
  assert.equal(reenabled.status, 'active', 'an explicit UI assignment restores a disabled entitlement');
  assert.deepEqual(reenabled.siteIds, ['mx-oversea-hk01']);
  assert.deepEqual(reenabled.accounts.map((account) => account.siteId), ['mx-oversea-hk01']);

  const afterReenableRefresh = store.upsertUserOverseaEntitlement({ userId: user.userId, requestedBy: 'mx-h2i-h2o' });
  assert.equal(afterReenableRefresh.status, 'active');
  assert.deepEqual(afterReenableRefresh.siteIds, ['mx-oversea-hk01']);
});

test('the default site is listed first so the select group defaults to it', () => {
  const { store, user } = seed();
  store.upsertLauncherProductNetwork({
    productId: MX_H2I_PRODUCT_ID,
    defaultOverseaSiteId: 'mx-oversea-hk01',
    requestedBy: 'desktop-admin'
  });
  store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['oversea-main', 'mx-oversea-hk01'],
    requestedBy: 'test'
  });

  const yaml = store.renderUserOverseaMihomoSubscription(user.userId)?.yaml ?? '';
  const groups = yaml.slice(yaml.indexOf('proxy-groups:'));
  // Ordering IS the default-traffic decision: the fallback group tries its list in
  // order, and the select group defaults to its first entry. Both must follow the
  // admin default rather than the alphabet.
  assert.match(
    groups,
    /- name: Oversea-Auto\s*\n\s+type: fallback[\s\S]*?proxies:\s*\n\s+- "mx-oversea-hk01-hysteria2"\s*\n\s+- "oversea-main-hysteria2"/
  );
  assert.match(
    groups,
    /- name: Oversea\s*\n\s+type: select\s*\n\s+proxies:\s*\n\s+- "Oversea-Auto"\s*\n\s+- "mx-oversea-hk01-hysteria2"\s*\n\s+- "oversea-main-hysteria2"\s*\n\s+- DIRECT/
  );
});

test('a multi-node subscription fails over in order without user action', () => {
  const { store, user } = seed();
  store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['oversea-main', 'mx-oversea-hk01'],
    requestedBy: 'test'
  });

  const yaml = store.renderUserOverseaMihomoSubscription(user.userId)?.yaml ?? '';
  // fallback = 按顺序探测，当前不通就顺延；没有 url/interval 就不会真的探测。
  assert.match(yaml, /type: fallback/);
  assert.match(yaml, /url: "http:\/\/www\.gstatic\.com\/generate_204"/);
  assert.match(yaml, /interval: 300/);
  // MATCH 仍然指向 select 组，所以手动切换的入口没有被 Auto 顶掉。
  assert.match(yaml, /- MATCH,Oversea$/m);
});

test('a single-node subscription gets no auto group', () => {
  const { store, user } = seed();
  store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: ['oversea-main'], requestedBy: 'test' });

  const yaml = store.renderUserOverseaMihomoSubscription(user.userId)?.yaml ?? '';
  assert.doesNotMatch(yaml, /Oversea-Auto/, 'one node has nothing to fail over to');
  assert.match(yaml, /- name: Oversea\s*\n\s+type: select/);
});

test('migration is a dry run until confirmed, then rewrites the matched users', () => {
  const { store, user } = seed();
  store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: ['oversea-main'], requestedBy: 'test' });

  const preview = store.migrateUserOverseaEntitlements({
    fromSiteId: 'oversea-main',
    toSiteId: 'mx-oversea-hk01',
    requestedBy: 'test'
  });
  assert.equal(preview.applied, false);
  assert.equal(preview.matched, 1);
  assert.equal(preview.changed, 0);
  assert.deepEqual(preview.changes[0].after, ['mx-oversea-hk01']);
  assert.deepEqual(
    store.getUserOverseaEntitlement(user.userId)?.siteIds,
    ['oversea-main'],
    'a dry run must not touch anything'
  );

  const applied = store.migrateUserOverseaEntitlements({
    fromSiteId: 'oversea-main',
    toSiteId: 'mx-oversea-hk01',
    confirm: true,
    requestedBy: 'test'
  });
  assert.equal(applied.changed, 1);
  assert.equal(applied.failed, 0);
  assert.deepEqual(store.getUserOverseaEntitlement(user.userId)?.siteIds, ['mx-oversea-hk01']);

  const again = store.migrateUserOverseaEntitlements({
    fromSiteId: 'oversea-main',
    toSiteId: 'mx-oversea-hk01',
    confirm: true,
    requestedBy: 'test'
  });
  assert.equal(again.matched, 0, 're-running is a no-op once nobody is left on the old site');
});

test('migration apply only changes the userIds frozen by Preview', () => {
  const { store, user } = seed();
  const laterUser = store.createUserCenterUser({ account: 'lateruser', displayName: 'Later User' });
  for (const userId of [user.userId, laterUser.userId]) {
    store.upsertUserOverseaEntitlement({
      userId,
      siteIds: ['oversea-main'],
      requestedBy: 'test'
    });
  }

  const preview = store.migrateUserOverseaEntitlements({
    fromSiteId: 'oversea-main',
    toSiteId: 'mx-oversea-hk01',
    requestedBy: 'desktop-admin'
  });
  assert.equal(preview.matched, 2, 'the unscoped Preview sees both current source users');

  const applied = store.migrateUserOverseaEntitlements({
    fromSiteId: 'oversea-main',
    toSiteId: 'mx-oversea-hk01',
    userIds: [user.userId],
    confirm: true,
    requestedBy: 'desktop-admin'
  });

  assert.equal(applied.matched, 1);
  assert.equal(applied.changed, 1);
  assert.deepEqual(applied.changes.map((change) => change.userId), [user.userId]);
  assert.deepEqual(store.getUserOverseaEntitlement(user.userId)?.siteIds, ['mx-oversea-hk01']);
  assert.deepEqual(
    store.getUserOverseaEntitlement(laterUser.userId)?.siteIds,
    ['oversea-main'],
    'a source user outside the Preview scope is never swept into Apply'
  );
});

test('migration in add mode keeps the old site, and refuses a dead target', () => {
  const { store, user } = seed();
  store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: ['oversea-main'], requestedBy: 'test' });

  const added = store.migrateUserOverseaEntitlements({
    fromSiteId: 'oversea-main',
    toSiteId: 'mx-oversea-hk01',
    mode: 'add',
    confirm: true,
    requestedBy: 'test'
  });
  assert.deepEqual(added.changes[0].after, ['mx-oversea-hk01', 'oversea-main']);

  store.archiveLauncherNetworkMihomoSite({ siteId: 'mx-oversea-hk01', archived: true, requestedBy: 'test' });
  assert.throws(
    () => store.migrateUserOverseaEntitlements({
      fromSiteId: 'oversea-main',
      toSiteId: 'mx-oversea-hk01',
      confirm: true,
      requestedBy: 'test'
    }),
    /not serviceable/,
    'never move users onto a retired site'
  );
});

test('an archived or stopped source stays paused while users are rescued onto a live target', () => {
  const { store, user } = seed();
  const assigned = store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['oversea-main'],
    requestedBy: 'test'
  });
  const sourceUsername = assigned.accounts[0]?.username;
  assert.ok(sourceUsername);

  store.archiveLauncherNetworkMihomoSite({ siteId: 'oversea-main', archived: true, requestedBy: 'test' });
  const rescued = store.migrateUserOverseaEntitlements({
    fromSiteId: 'oversea-main',
    toSiteId: 'mx-oversea-hk01',
    mode: 'add',
    confirm: true,
    requestedBy: 'desktop-admin'
  });

  assert.equal(rescued.failed, 0);
  assert.deepEqual(
    store.getUserOverseaEntitlement(user.userId)?.siteIds,
    ['mx-oversea-hk01', 'oversea-main'],
    'the offline source remains control-plane history until Cut Over'
  );
  assert.equal(
    store.getSiteSlotAccessAccount('oversea-main', sourceUsername)?.status,
    'paused',
    'entitlement maintenance must not reactivate an archived source'
  );
  const yaml = store.renderUserOverseaMihomoSubscription(user.userId)?.yaml ?? '';
  assert.match(yaml, /mx-oversea-hk01-hysteria2/);
  assert.doesNotMatch(yaml, /oversea-main-hysteria2/, 'the stopped source stays out of generated subscriptions');
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
