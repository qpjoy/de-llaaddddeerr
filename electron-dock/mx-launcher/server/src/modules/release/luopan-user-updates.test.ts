import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { LauncherNetworkLease } from '../../types.js';
import { ReleaseController } from './release.controller.js';
import { evaluateReleaseCheck } from './release-check.js';
import { isLuopanReleasePlan } from './luopan-user-updates.js';

function fixture() {
  const store = new MemoryStore({ ...loadConfig(), environment: `update-policy-${randomUUID()}`, storeDriver: 'memory' });
  const user = store.createUserCenterUser({ account: 'UpdateOnlyUser', password: 'Unchanged123!', roleIds: ['mx-user'] });
  const other = store.createUserCenterUser({ account: 'OtherUpdateUser', password: 'Unchanged456!', roleIds: ['mx-user'] });
  const controller = new ReleaseController(store);
  const installId = 'old-compass-install';
  const enroll = (productId: string, userId = user.userId, installation = installId) => store.enrollLauncherNetworkLease({
    productId, appId: productId, mode: 'standalone', identityKind: 'user', leaseProfile: 'employee', userId,
    installId: installation, deviceId: `device-${installation}-${userId}`, publicKey: `key-${installation}-${userId}`
  });
  const publish = (productId: string | undefined, componentId = productId ?? 'luopan', version = '2.0.9') => store.createReleaseManagementPlan({
    productId, appId: productId ?? 'luopan', releaseId: `${componentId}-${version}`, channel: 'stable',
    launcherComponentId: componentId, launcherUpdatePolicy: 'app-asar',
    launcherCurrentVersion: '2.0.1', launcherTargetVersion: version,
    artifactKind: 'app-asar', artifactVersion: version, artifactUrl: `https://example.test/${componentId}-${version}.asar`,
    artifactDigest: `sha256:${'a'.repeat(64)}`, artifactSizeBytes: 100,
    artifactPlatform: 'win32', artifactArch: 'x64', artifactFileName: `${componentId}-${version}.asar`,
    rolloutStrategy: 'all', rolloutPercentage: 100, e2eResult: 'passed', releaseNotes: 'New version details'
  });
  const input = { installId, userId: '42', productId: 'luopan', channel: 'stable', platform: 'win32', arch: 'x64', components: { luopan: '2.0.1' } };
  return { store, controller, user, other, enroll, publish, input };
}

test('old Luopan client receives the ordinary no-release response; restoring policy resumes updates', async () => {
  const f = fixture();
  f.enroll('luopan');
  f.publish('luopan', 'luopan', '2.0.8');
  f.publish('luopan');
  assert.equal((await f.controller.checkRelease(f.input)).status, 'update-available');
  const originalUser = structuredClone(f.store.getUserCenterUserIdentity(f.user.userId));
  await f.store.setLuopanUserControls({ userId: f.user.userId, updatesBlocked: true, expectedRevision: 0, reason: 'Internal only reason' });
  const response = await f.controller.checkRelease(f.input);
  const { signedAt, signature, ...visible } = response;
  assert.deepEqual(visible, evaluateReleaseCheck([], f.input));
  assert.ok(signedAt);
  assert.equal(signature.algorithm, 'hmac-sha256');
  assert.doesNotMatch(JSON.stringify(response), /Internal only reason|updatesBlocked|updatePolicy|access_denied|update_denied/);
  assert.deepEqual(f.store.getUserCenterUserIdentity(f.user.userId), originalUser);
  await f.store.setLuopanUserControls({ userId: f.user.userId, updatesBlocked: false, expectedRevision: 1 });
  assert.equal((await f.controller.checkRelease(f.input)).status, 'update-available');
});

test('identity comes from the Luopan installation lease, never the Java or self-reported userId', async () => {
  const f = fixture();
  f.publish('luopan');
  f.enroll('luopan');
  f.enroll('luopan', f.other.userId, 'other-install');
  await f.store.setLuopanUserControls({ userId: f.user.userId, updatesBlocked: true, expectedRevision: 0 });
  for (const userId of ['42', f.other.userId, null, undefined]) {
    assert.equal((await f.controller.checkRelease({ ...f.input, userId })).status, 'up-to-date');
  }
  assert.equal((await f.controller.checkRelease({ ...f.input, installId: 'other-install', userId: f.user.userId })).status, 'update-available');
});

test('unconfirmed, expired, anonymous or conflicting install identities do not guess whom to restrict', async () => {
  const f = fixture();
  f.publish('luopan');
  const lease = f.enroll('luopan');
  await f.store.setLuopanUserControls({ userId: f.user.userId, updatesBlocked: true, expectedRevision: 0 });
  const variants: LauncherNetworkLease[][] = [
    [],
    [{ ...lease, expiresAt: new Date(0).toISOString() }],
    [{ ...lease, expiresAt: 'invalid' }],
    [{ ...lease, status: 'released' }],
    [{ ...lease, productId: 'mx-h2i' }],
    [lease, { ...lease, userId: f.other.userId, leaseId: 'another-user-lease' }],
    [lease, { ...lease, identityKind: 'anonymous', userId: null, leaseId: 'anonymous-lease' }]
  ];
  for (const leases of variants) {
    f.store.listLauncherNetworkLeasesForInstall = () => leases;
    assert.equal((await f.controller.checkRelease(f.input)).status, 'update-available');
  }
});

test('omitted productId and renderer/pre-V2 plans still filter every Luopan candidate', async () => {
  const f = fixture();
  f.enroll('luopan');
  const plan = f.publish('luopan', 'luopan-renderer');
  delete plan.productId;
  f.store.listReleaseManagementPlans = () => [plan];
  await f.store.setLuopanUserControls({ userId: f.user.userId, updatesBlocked: true, expectedRevision: 0 });
  const response = await f.controller.checkRelease({ ...f.input, productId: undefined, components: { 'luopan-renderer': '2.0.1' } });
  assert.equal(response.status, 'up-to-date');
  assert.deepEqual(response.artifacts, []);
  assert.equal(response.releaseNotes, null);
  assert.equal(isLuopanReleasePlan({ ...plan, productId: 'mx-h2i' }), false, 'explicit server product remains authoritative');
});

test('update-only restrictions preserve user tokens, Luopan networking and MX-H2I update/login/network paths', async () => {
  const f = fixture();
  const luopan = f.enroll('luopan');
  const h2i = f.enroll('mx-h2i', f.user.userId, 'h2i-install');
  const tokens = ['luopan', 'mx-h2i', undefined].map((appId) => f.store.issueUserCenterToken({
    subjectKind: 'user', subjectId: f.user.userId, appId, audience: 'mx-sdk', scopes: ['auth.read']
  }));
  f.publish('mx-h2i');
  await f.store.setLuopanUserControls({ userId: f.user.userId, updatesBlocked: true, expectedRevision: 0 });
  for (const token of tokens) assert.equal(f.store.introspectToken({ token: token.token }).active, true);
  assert.equal(f.store.verifyUserCenterPassword({ userId: f.user.userId, password: 'Unchanged123!' }).ok, true);
  assert.equal(f.enroll('luopan').leaseId, luopan.leaseId);
  assert.deepEqual(f.store.getLauncherNetworkLease(h2i.leaseId), h2i);
  f.store.listLauncherNetworkLeasesForInstall = () => { throw new Error('H2I must not depend on Luopan update identity'); };
  f.store.getUserAppUpdatePolicy = () => { throw new Error('H2I must not depend on Luopan update policy'); };
  assert.equal((await f.controller.checkRelease({ ...f.input, installId: 'h2i-install', productId: 'mx-h2i', components: { 'mx-h2i': '2.0.1' } })).status, 'update-available');
});

test('real legacy renderer plans defaulted productId to luopan-renderer and remain covered', async () => {
  const f = fixture();
  f.enroll('luopan');
  const plan = f.publish(undefined, 'luopan-renderer');
  assert.equal(plan.productId, 'luopan-renderer');
  const input = { ...f.input, productId: undefined, components: { 'luopan-renderer': '2.0.1' } };
  assert.equal((await f.controller.checkRelease(input)).status, 'update-available');
  await f.store.setLuopanUserControls({ userId: f.user.userId, updatesBlocked: true, expectedRevision: 0 });
  const result = await f.controller.checkRelease(input);
  assert.equal(result.status, 'up-to-date');
  assert.deepEqual(result.artifacts, []);
  assert.equal(isLuopanReleasePlan({ ...plan, productId: 'mx-h2i' }), false);
});
