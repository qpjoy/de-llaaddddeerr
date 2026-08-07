import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryStore } from '../../store/memory.js';
import { loadConfig } from '../../config.js';
import { renderUserOverseaMihomoSubscription } from '../../store/domain.js';
import type { SiteSlotAccessAccount } from '../../types.js';

const SITES = ['oversea-main', 'oversea-mx', 'oversea-sg-1'];

function seedStore() {
  const store = new MemoryStore(loadConfig());
  for (const siteId of SITES) {
    store.upsertLauncherNetworkMihomoSite({
      siteId,
      publicHost: `${siteId}.example.com`,
      serverPorts: '51289',
      requestedBy: 'test'
    });
    store.issueSiteSlotAccessAccounts({
      siteId,
      accountNames: [`${siteId}-alice`],
      requestedBy: 'test'
    });
  }
  return store;
}

/** The renderer only emits proxies for active accounts, which is the whole mechanism. */
function subscriptionNodeNames(store: MemoryStore, userId: string): string[] {
  const entitlement = store.listUserOverseaEntitlements().find((row) => row.userId === userId);
  if (!entitlement) return [];
  const entries = entitlement.siteIds.flatMap((siteId) => {
    const site = store.getLauncherNetworkMihomoSite(siteId);
    const account = store
      .listSiteSlotAccessAccounts(siteId)
      .find((row: SiteSlotAccessAccount) => row.username.endsWith('-alice'));
    return site && account ? [{ site, account }] : [];
  });
  const user = { userId, account: userId, email: null } as never;
  const render = renderUserOverseaMihomoSubscription(user, entitlement, entries);
  return proxyNamesFromSubscriptionYaml(render.yaml);
}

/**
 * Read the `proxies:` block only. A bare `- name:` grep would also match
 * `proxy-groups:`, and a YAML parser would pull a dependency into the server
 * package purely for a test -- which is what broke the production image build.
 */
function proxyNamesFromSubscriptionYaml(yaml: string): string[] {
  const names: string[] = [];
  let insideProxies = false;
  for (const line of yaml.split('\n')) {
    if (/^[^\s#]/.test(line)) {
      insideProxies = line.startsWith('proxies:');
      continue;
    }
    if (!insideProxies) continue;
    const match = /^\s+-\s+name:\s*(.+?)\s*$/.exec(line);
    if (match) names.push(match[1].replace(/^"|"$/g, ''));
  }
  return names;
}

test('a site with no archive flag reads as active', () => {
  const store = seedStore();
  const site = store.getLauncherNetworkMihomoSite('oversea-main');
  assert.equal(site?.status, 'active');
  assert.equal(site?.archivedAt, null);
});

test('archiving a site pauses its access accounts', () => {
  const store = seedStore();
  const before = store.listSiteSlotAccessAccounts('oversea-mx');
  assert.ok(before.length > 0);
  assert.ok(before.every((account) => account.status === 'active'));

  const result = store.archiveLauncherNetworkMihomoSite({
    siteId: 'oversea-mx',
    archived: true,
    requestedBy: 'admin'
  });

  assert.equal(result.site.status, 'archived');
  assert.equal(result.site.archivedBy, 'admin');
  assert.ok(result.pausedAccounts.length > 0);
  assert.ok(
    store.listSiteSlotAccessAccounts('oversea-mx').every((account) => account.status === 'paused'),
    'every access account on the retired machine is paused'
  );
  // Other sites are untouched.
  assert.ok(store.listSiteSlotAccessAccounts('oversea-main').every((account) => account.status === 'active'));
});

test('archiving drops the node from an entitled user subscription without touching the entitlement', () => {
  const store = seedStore();
  const user = store.createUserCenterUser({ account: 'alice', displayName: 'Alice' });
  assert.ok(user);
  store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: SITES, requestedBy: 'test' });

  assert.deepEqual(
    subscriptionNodeNames(store, user.userId).sort(),
    SITES.map((siteId) => `${siteId}-hysteria2`).sort(),
    'all three machines start in the subscription'
  );

  const result = store.archiveLauncherNetworkMihomoSite({
    siteId: 'oversea-mx',
    archived: true,
    requestedBy: 'admin'
  });

  assert.deepEqual(result.affectedUserIds, [user.userId], 'the admin is told who is affected');
  assert.deepEqual(
    subscriptionNodeNames(store, user.userId).sort(),
    ['oversea-main-hysteria2', 'oversea-sg-1-hysteria2'],
    'the retired machine disappears from the subscription'
  );

  const entitlement = store.listUserOverseaEntitlements().find((row) => row.userId === user.userId);
  assert.deepEqual(entitlement?.siteIds, SITES, 'the entitlement itself is preserved for restore');
});

test('unarchiving restores the node', () => {
  const store = seedStore();
  const user = store.createUserCenterUser({ account: 'bob', displayName: 'Bob' });
  assert.ok(user);
  store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: SITES, requestedBy: 'test' });

  store.archiveLauncherNetworkMihomoSite({ siteId: 'oversea-sg-1', archived: true, requestedBy: 'admin' });
  assert.ok(!subscriptionNodeNames(store, user.userId).includes('oversea-sg-1-hysteria2'));

  const restored = store.archiveLauncherNetworkMihomoSite({
    siteId: 'oversea-sg-1',
    archived: false,
    requestedBy: 'admin'
  });
  assert.equal(restored.site.status, 'active');
  assert.equal(restored.site.archivedAt, null);
  assert.ok(restored.reactivatedAccounts.length > 0);
  assert.ok(
    subscriptionNodeNames(store, user.userId).includes('oversea-sg-1-hysteria2'),
    'the node comes back for entitled users'
  );
});

test('re-running upsert on an archived site does not silently revive it', () => {
  const store = seedStore();
  store.archiveLauncherNetworkMihomoSite({ siteId: 'oversea-mx', archived: true, requestedBy: 'admin' });

  // Reconfiguring host/ports on a retired machine must not bring it back;
  // only an explicit unarchive may do that.
  const site = store.upsertLauncherNetworkMihomoSite({
    siteId: 'oversea-mx',
    publicHost: 'new-host.example.com',
    requestedBy: 'test'
  });
  assert.equal(site.status, 'archived');
  assert.equal(site.publicHost, 'new-host.example.com');
});
