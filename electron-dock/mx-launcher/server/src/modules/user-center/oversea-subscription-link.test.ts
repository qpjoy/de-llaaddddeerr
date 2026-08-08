import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryStore } from '../../store/memory.js';
import { loadConfig } from '../../config.js';
import {
  USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE,
  USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE,
  isUserOverseaSubscriptionLinkToken,
  userOverseaSubscriptionLinkPath
} from '../../store/domain.js';

function seed() {
  const store = new MemoryStore(loadConfig());
  store.upsertLauncherNetworkMihomoSite({
    siteId: 'oversea-main',
    publicHost: 'oversea-main.example.com',
    serverPorts: '51289',
    requestedBy: 'test'
  });
  store.issueSiteSlotAccessAccounts({ siteId: 'oversea-main', accountNames: ['seed'], requestedBy: 'test' });
  const user = store.createUserCenterUser({ account: 'linkuser', displayName: 'Link User' });
  store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: ['oversea-main'], requestedBy: 'test' });
  return { store, user };
}

test('an issued link resolves back to exactly its owner', () => {
  const { store, user } = seed();
  const issued = store.issueUserOverseaSubscriptionLink(user.userId, { requestedBy: 'admin' });

  assert.ok(isUserOverseaSubscriptionLinkToken(issued.token));
  assert.equal(issued.path, userOverseaSubscriptionLinkPath(issued.token));
  assert.equal(store.resolveUserOverseaSubscriptionLink(issued.token), user.userId);
  assert.equal(issued.record.audience, USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE);
  assert.deepEqual(issued.record.scopes, [USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE]);
});

test('the token survives a URL path segment without escaping', () => {
  const { store, user } = seed();
  const { token, path } = store.issueUserOverseaSubscriptionLink(user.userId);
  // Clash pastes this verbatim; a token needing percent-encoding would break it.
  assert.equal(encodeURIComponent(token), token);
  assert.equal(path, `/internal/v1/oversea-subscriptions/${token}.yaml`);
});

test('rotating revokes the previous link so a leaked URL stops working', () => {
  const { store, user } = seed();
  const first = store.issueUserOverseaSubscriptionLink(user.userId);
  const second = store.issueUserOverseaSubscriptionLink(user.userId);

  assert.notEqual(first.token, second.token);
  assert.equal(store.resolveUserOverseaSubscriptionLink(first.token), null, 'the old link is dead');
  assert.equal(store.resolveUserOverseaSubscriptionLink(second.token), user.userId);
});

test('revoking kills the link without touching the user session', () => {
  const { store, user } = seed();
  const issued = store.issueUserOverseaSubscriptionLink(user.userId);
  assert.equal(store.revokeUserOverseaSubscriptionLink(user.userId), 1);
  assert.equal(store.resolveUserOverseaSubscriptionLink(issued.token), null);
  assert.equal(store.revokeUserOverseaSubscriptionLink(user.userId), 0, 'revoking twice is a no-op');
});

test('a login token cannot be used as a subscription link', () => {
  const { store, user } = seed();
  // This is the whole point of the separate audience: a session token is far more
  // powerful and lives in more places, so it must not render subscriptions.
  const login = store.issueUserCenterToken({
    subjectKind: 'user',
    subjectId: user.userId,
    audience: 'mx-sdk',
    scopes: ['oversea.subscription.ensure']
  });
  assert.ok(login.token);
  assert.equal(store.resolveUserOverseaSubscriptionLink(login.token), null);
});

test('malformed, unknown and empty tokens all resolve to nothing', () => {
  const { store } = seed();
  for (const candidate of ['', '   ', 'not-a-token', 'mx-v1-short', 'mx-v1-' + 'A'.repeat(32), '../../etc/passwd']) {
    assert.equal(store.resolveUserOverseaSubscriptionLink(candidate), null, `rejects ${JSON.stringify(candidate)}`);
  }
});

test('describe exposes metadata only, never the token', () => {
  const { store, user } = seed();
  assert.equal(store.describeUserOverseaSubscriptionLink(user.userId), null, 'nothing before issuing');
  const issued = store.issueUserOverseaSubscriptionLink(user.userId);
  const described = store.describeUserOverseaSubscriptionLink(user.userId);

  assert.deepEqual(Object.keys(described ?? {}).sort(), ['expiresAt', 'issuedAt']);
  assert.equal(described?.issuedAt, issued.record.issuedAt);
  assert.ok(!JSON.stringify(described).includes(issued.token), 'the plaintext token is not retrievable');
});

test('the link renders the same multi-node subscription H2O sees', () => {
  const { store, user } = seed();
  store.upsertLauncherNetworkMihomoSite({
    siteId: 'mx-oversea-hk01',
    publicHost: 'hk01.example.com',
    serverPorts: '51289',
    requestedBy: 'test'
  });
  store.issueSiteSlotAccessAccounts({ siteId: 'mx-oversea-hk01', accountNames: ['seed'], requestedBy: 'test' });
  store.upsertUserOverseaEntitlement({
    userId: user.userId,
    siteIds: ['oversea-main', 'mx-oversea-hk01'],
    requestedBy: 'test'
  });

  const issued = store.issueUserOverseaSubscriptionLink(user.userId);
  const resolved = store.resolveUserOverseaSubscriptionLink(issued.token);
  assert.equal(resolved, user.userId);

  const yaml = store.renderUserOverseaMihomoSubscription(resolved!)?.yaml ?? '';
  assert.match(yaml, /oversea-main-hysteria2/);
  assert.match(yaml, /mx-oversea-hk01-hysteria2/, 'both nodes are present so Clash can switch');
  assert.match(yaml, /MATCH,Oversea/, 'rules target the select group, not a single node');
});
