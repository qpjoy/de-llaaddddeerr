import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { launcherNetworkLeaseIsActive } from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import { LauncherNetworkController } from './launcher-network.controller.js';

const config = loadConfig();

test('product user ban is ops-only, releases only matching leases, and keeps Luopan isolated', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'product-user-access-test';
  context.after(() => {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  });

  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const blockedUser = store.createUserCenterUser({
    userId: 'usr_product_blocked',
    account: 'product-blocked',
    password: 'product-blocked-password',
    requestedBy: 'product-user-access-test'
  });
  const otherUser = store.createUserCenterUser({
    userId: 'usr_product_other',
    account: 'product-other',
    password: 'product-other-password',
    requestedBy: 'product-user-access-test'
  });
  const blockedToken = issueUserToken(store, blockedUser.userId);
  const feishuToken = store.issueUserCenterToken({
    subjectKind: 'user',
    subjectId: blockedUser.userId,
    audience: 'mx-sdk',
    scopes: ['auth.read'],
    authProvider: 'feishu',
    requestId: `feishu-token-${blockedUser.userId}`
  }).token;
  const otherToken = issueUserToken(store, otherUser.userId);
  const appAccessBefore = structuredClone(blockedUser.appAccess);
  const mxH2iAppDecisionBefore = store.evaluateAppCenterAccess({
    appId: 'mx-h2i',
    userId: blockedUser.userId
  });

  const mxH2i = await enrollUser(controller, blockedToken, blockedUser.userId, 'mx-h2i', 'blocked-mx-h2i');
  const luopan = await enrollUser(controller, blockedToken, blockedUser.userId, 'luopan', 'blocked-luopan');
  const otherMxH2i = await enrollUser(controller, otherToken, otherUser.userId, 'mx-h2i', 'other-mx-h2i');

  await assert.rejects(
    controller.setProductUserAccess('mx-h2i', blockedUser.userId, 'wrong-token', { blocked: true }),
    /valid Internal ops token/
  );
  await assert.rejects(
    controller.listProductUserAccess('mx-h2i', undefined),
    /valid Internal ops token/
  );

  const banned = await controller.setProductUserAccess(
    'mx-h2i',
    blockedUser.userId,
    'product-user-access-test',
    { blocked: true, reason: 'drawer ban test', requestId: 'drawer-ban-test' }
  );
  assert.equal(banned.productUserAccess.blocked, true);
  assert.equal(banned.productUserAccess.changed, true);
  assert.deepEqual(banned.productUserAccess.controlPlane.releasedLeaseIds, [mxH2i.lease.leaseId]);
  assert.equal(banned.productUserAccess.controlPlane.userStatusChanged, false);
  assert.equal(banned.productUserAccess.controlPlane.tokensRevoked, 0);
  assert.equal(banned.productUserAccess.runtimePeerRemoval.status, 'not-performed');
  assert.equal(banned.productUserAccess.runtimePeerRemoval.domestic, 'not-performed');
  assert.equal(banned.productUserAccess.runtimePeerRemoval.internalDirect, 'not-performed');

  const storedUser = store.listUserCenterUsers().find((user) => user.userId === blockedUser.userId);
  assert.equal(storedUser?.status, 'active', 'product ban must not globally disable the user');
  assert.deepEqual(storedUser?.appAccess, appAccessBefore, 'network ban must not modify AppCenter access');
  assert.deepEqual(
    store.evaluateAppCenterAccess({ appId: 'mx-h2i', userId: blockedUser.userId }),
    mxH2iAppDecisionBefore,
    'network ban must not change the AppCenter decision for the same product ID'
  );
  assert.equal(store.introspectToken({ token: blockedToken, audience: 'mx-sdk' }).active, true);
  assert.equal(store.introspectToken({ token: feishuToken, audience: 'mx-sdk' }).active, true);
  assert.equal(store.getLauncherProductUserAccess('mx-h2i', blockedUser.userId)?.blocked, true);
  assert.equal(store.getLauncherNetworkLease(mxH2i.lease.leaseId)?.status, 'released');
  assert.equal(launcherNetworkLeaseIsActive(store.getLauncherNetworkLease(luopan.lease.leaseId)!), true);
  assert.equal(launcherNetworkLeaseIsActive(store.getLauncherNetworkLease(otherMxH2i.lease.leaseId)!), true);

  const listUserCenterUsers = store.listUserCenterUsers.bind(store);
  store.listUserCenterUsers = () => {
    throw new Error('product access reads must not load credential summaries');
  };
  try {
    const list = await controller.listProductUserAccess('mx-h2i', 'product-user-access-test');
    assert.equal(list.productUserAccess.blockedUserCount, 1);
    assert.equal(list.productUserAccess.blockedUsers[0]?.userId, blockedUser.userId);
    assert.equal(list.productUserAccess.blockedUsers[0]?.lastLease?.leaseId, mxH2i.lease.leaseId);
    assert.equal(list.productUserAccess.blockedUsers[0]?.lastLease?.status, 'released');
    assert.equal(list.productUserAccess.blockedUsers[0]?.controlPlane.admission, 'blocked');
    assert.equal(list.productUserAccess.blockedUsers[0]?.runtimePeerRemoval.status, 'not-performed');
    const blockedAccess = await controller.getProductUserAccess(
      'mx-h2i',
      blockedUser.userId,
      'product-user-access-test'
    );
    assert.equal(blockedAccess.productUserAccess.blocked, true);
    assert.equal(blockedAccess.productUserAccess.runtimePeerRemoval.status, 'not-performed');
  } finally {
    store.listUserCenterUsers = listUserCenterUsers;
  }

  await assert.rejects(
    enrollUser(controller, blockedToken, blockedUser.userId, 'mx-h2i', 'blocked-mx-h2i-new'),
    productAccessForbidden('mx-h2i', blockedUser.userId)
  );
  await assert.rejects(
    controller.createSnapshot(
      `Bearer ${blockedToken}`,
      {
        leaseId: mxH2i.lease.leaseId,
        userId: blockedUser.userId,
        appId: 'mx-h2i',
        leaseProfile: 'employee'
      },
      mxH2i.lease.capability,
      undefined
    ),
    productAccessForbidden('mx-h2i', blockedUser.userId)
  );
  await assert.rejects(
    controller.syncDomesticPeer(
      mxH2i.lease.leaseId,
      `Bearer ${blockedToken}`,
      mxH2i.lease.capability,
      undefined,
      undefined,
      {}
    ),
    productAccessForbidden('mx-h2i', blockedUser.userId)
  );
  await assert.rejects(
    controller.syncInternalDirectPeer(
      mxH2i.lease.leaseId,
      `Bearer ${blockedToken}`,
      mxH2i.lease.capability,
      undefined,
      undefined,
      {}
    ),
    productAccessForbidden('mx-h2i', blockedUser.userId)
  );

  const stillAllowed = await controller.enrollLease(
    `Bearer ${blockedToken}`,
    {
      appId: 'luopan',
      productId: 'luopan',
      mode: 'standalone',
      identityKind: 'user',
      leaseProfile: 'employee',
      installId: 'inst_blocked-luopan',
      deviceId: 'dev_blocked-luopan',
      userId: blockedUser.userId,
      publicKey: 'public-key-blocked-luopan'
    },
    luopan.lease.capability,
    undefined,
    '198.51.100.41'
  );
  assert.equal(stillAllowed.lease.productId, 'luopan');
  assert.equal(stillAllowed.lease.status, 'active');

  const unbanned = await controller.setProductUserAccess(
    'mx-h2i',
    blockedUser.userId,
    'product-user-access-test',
    { blocked: false, reason: 'drawer unban test' }
  );
  assert.equal(unbanned.productUserAccess.blocked, false);
  assert.equal(unbanned.productUserAccess.changed, true);
  assert.deepEqual(unbanned.productUserAccess.controlPlane.releasedLeaseIds, []);
  assert.equal(unbanned.productUserAccess.runtimePeerRemoval.status, 'not-requested');
  assert.equal(
    store.getLauncherProductUserAccess('mx-h2i', blockedUser.userId)?.blocked,
    false
  );
  assert.deepEqual(
    store.listUserCenterUsers().find((user) => user.userId === blockedUser.userId)?.appAccess,
    appAccessBefore
  );

  const reconnected = await enrollUser(
    controller,
    blockedToken,
    blockedUser.userId,
    'mx-h2i',
    'blocked-mx-h2i-new'
  );
  assert.equal(reconnected.lease.status, 'active');
});

test('product access endpoint validates boolean input and preserves an idempotent ban', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'product-user-access-validation-test';
  context.after(() => {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  });
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const user = store.createUserCenterUser({
    userId: 'usr_product_validation',
    account: 'product-validation',
    password: 'product-validation-password'
  });

  await assert.rejects(
    controller.setProductUserAccess(
      'mx-h2i',
      user.userId,
      'product-user-access-validation-test',
      { blocked: 'true' }
    ),
    (error) => httpStatus(error) === 400
  );
  await controller.setProductUserAccess(
    'mx-h2i',
    user.userId,
    'product-user-access-validation-test',
    { blocked: true }
  );
  const repeated = await controller.setProductUserAccess(
    'mx-h2i',
    user.userId,
    'product-user-access-validation-test',
    { blocked: true }
  );
  assert.equal(repeated.productUserAccess.changed, false);
  assert.equal(repeated.productUserAccess.blocked, true);
  assert.equal(store.listLauncherProductUserAccess('mx-h2i').length, 1);
  assert.equal(store.getLauncherProductUserAccess('mx-h2i', user.userId)?.revision, 1);

  const reasonUpdated = await controller.setProductUserAccess(
    'mx-h2i',
    user.userId,
    'product-user-access-validation-test',
    { blocked: true, reason: 'operator note' }
  );
  assert.equal(reasonUpdated.productUserAccess.changed, false, 'reason-only updates do not change admission');
  assert.equal(reasonUpdated.productUserAccess.reason, 'operator note');
  assert.equal(reasonUpdated.productUserAccess.accessRevision, 2);
  const readBack = await controller.getProductUserAccess(
    'mx-h2i',
    user.userId,
    'product-user-access-validation-test'
  );
  assert.equal(readBack.productUserAccess.reason, 'operator note');
  assert.equal(readBack.productUserAccess.accessRevision, 2);
});

test('legacy AppCenter deniedAppIds without trusted network audit remains app-only', async () => {
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const user = store.createUserCenterUser({
    userId: 'usr_legacy_app_deny',
    account: 'legacy-app-deny',
    password: 'legacy-app-deny-password',
    deniedAppIds: ['mx-h2i']
  });
  const token = issueUserToken(store, user.userId);

  assert.equal(
    store.evaluateAppCenterAccess({ appId: 'mx-h2i', userId: user.userId }).allowed,
    false,
    'legacy deniedAppIds keeps its AppCenter meaning'
  );
  assert.equal(store.getLauncherProductUserAccess('mx-h2i', user.userId), null);

  const enrolled = await enrollUser(controller, token, user.userId, 'mx-h2i', 'legacy-app-deny');
  assert.equal(enrolled.lease.status, 'active', 'AppCenter deny must not become a ProductNetwork ban');
  assert.equal(store.getLauncherProductUserAccess('mx-h2i', user.userId), null);
});

function issueUserToken(store: MemoryStore, userId: string): string {
  return store.issueUserCenterToken({
    subjectKind: 'user',
    subjectId: userId,
    audience: 'mx-sdk',
    scopes: ['auth.read'],
    authProvider: 'local-password',
    requestId: `token-${userId}`
  }).token;
}

async function enrollUser(
  controller: LauncherNetworkController,
  token: string,
  userId: string,
  productId: 'mx-h2i' | 'luopan',
  suffix: string
) {
  return controller.enrollLease(
    `Bearer ${token}`,
    {
      appId: productId,
      productId,
      mode: 'standalone',
      identityKind: 'user',
      leaseProfile: 'employee',
      installId: `inst_${suffix}`,
      deviceId: `dev_${suffix}`,
      userId,
      publicKey: `public-key-${suffix}`
    },
    undefined,
    undefined,
    '198.51.100.40'
  );
}

function productAccessForbidden(productId: string, userId: string) {
  return (error: unknown): boolean => {
    assert.equal(httpStatus(error), 403);
    const response = (error as { getResponse: () => unknown }).getResponse();
    assert.equal((response as { code?: string }).code, 'launcher_product_user_access_denied');
    assert.equal((response as { productId?: string }).productId, productId);
    assert.equal((response as { userId?: string }).userId, userId);
    return true;
  };
}

function httpStatus(error: unknown): number | null {
  const getStatus = (error as { getStatus?: () => number } | null)?.getStatus;
  return typeof getStatus === 'function' ? getStatus.call(error) : null;
}
