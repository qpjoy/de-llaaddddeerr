import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import { LauncherNetworkController } from './launcher-network.controller.js';

const config = loadConfig();

test('ops lease inventory resolves User Center names without changing client lease responses', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'lease-user-identity-test';
  context.after(() => {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  });

  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const feishuUser = store.createUserCenterUser({
    userId: 'usr_feishu_identity_test',
    account: 'feishu_identity_test',
    displayName: '王小明',
    externalIds: { feishuSubject: 'tenant_allowed:ou_identity_test' },
    allowedAppIds: ['mx-h2i'],
    requestedBy: 'lease-user-identity-test'
  });
  const token = store.issueUserCenterToken({
    subjectKind: 'user',
    subjectId: feishuUser.userId,
    audience: 'mx-sdk',
    scopes: ['auth.read'],
    authProvider: 'feishu',
    requestId: 'token-lease-user-identity-test'
  }).token;
  const enrolled = await controller.enrollLease(
    `Bearer ${token}`,
    {
      appId: 'mx-h2i',
      productId: 'mx-h2i',
      mode: 'standalone',
      identityKind: 'user',
      leaseProfile: 'feishu',
      installId: 'inst_feishu_identity_test',
      deviceId: 'dev_feishu_identity_test',
      userId: feishuUser.userId,
      publicKey: 'public-key-feishu-identity-test'
    },
    undefined,
    undefined,
    '198.51.100.55'
  );

  assert.equal('userDisplayName' in enrolled.lease, false);
  assert.equal('userAccount' in enrolled.lease, false);
  assert.equal('sourceIp' in enrolled.lease, false);
  assert.equal('userDisplayName' in store.getLauncherNetworkLease(enrolled.lease.leaseId)!, false);
  assert.equal('userAccount' in store.getLauncherNetworkLease(enrolled.lease.leaseId)!, false);

  const orphan = store.enrollLauncherNetworkLease({
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    leaseProfile: 'feishu',
    installId: 'inst_feishu_orphan_test',
    deviceId: 'dev_feishu_orphan_test',
    userId: 'usr_feishu_legacy_missing',
    publicKey: 'public-key-feishu-orphan-test',
    requestedBy: 'lease-user-identity-test'
  });
  const anonymous = store.enrollLauncherNetworkLease({
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: 'inst_anonymous_identity_test',
    deviceId: 'dev_anonymous_identity_test',
    publicKey: 'public-key-anonymous-identity-test',
    requestedBy: 'lease-user-identity-test'
  });

  const projectedIdentity = store.listUserCenterUserIdentities()
    .find((identity) => identity.userId === feishuUser.userId);
  assert.equal(projectedIdentity?.account, 'feishu_identity_test');
  assert.equal(projectedIdentity?.displayName, '王小明');
  assert.equal(projectedIdentity?.status, 'active');
  assert.deepEqual(projectedIdentity?.appAccess, feishuUser.appAccess);
  assert.equal(projectedIdentity?.updatedAt, feishuUser.updatedAt);
  assert.deepEqual(
    Object.keys(projectedIdentity ?? {}).sort(),
    ['account', 'appAccess', 'displayName', 'status', 'updatedAt', 'userId']
  );
  store.listUserCenterUsers = () => {
    throw new Error('ops lease identity join must not load credential summaries');
  };

  await assert.rejects(
    controller.listLeases('wrong-token'),
    /valid Internal ops token/
  );
  await assert.rejects(
    controller.getLease(enrolled.lease.leaseId, 'wrong-token'),
    /valid Internal ops token/
  );

  const listed = await controller.listLeases('lease-user-identity-test');
  const resolved = listed.leases.find((lease) => lease.leaseId === enrolled.lease.leaseId);
  assert.equal(resolved?.userDisplayName, '王小明');
  assert.equal(resolved?.userAccount, 'feishu_identity_test');
  assert.equal(resolved?.userId, feishuUser.userId);
  assert.equal(resolved?.sourceIp, '198.51.100.55');

  const missing = listed.leases.find((lease) => lease.leaseId === orphan.leaseId);
  assert.equal(missing?.userId, 'usr_feishu_legacy_missing');
  assert.equal(missing?.userDisplayName, null);
  assert.equal(missing?.userAccount, null);

  const guest = listed.leases.find((lease) => lease.leaseId === anonymous.leaseId);
  assert.equal(guest?.userId, null);
  assert.equal(guest?.userDisplayName, null);
  assert.equal(guest?.userAccount, null);

  const detail = await controller.getLease(enrolled.lease.leaseId, 'lease-user-identity-test');
  assert.equal(detail.lease.userDisplayName, '王小明');
  assert.equal(detail.lease.userAccount, 'feishu_identity_test');
});
