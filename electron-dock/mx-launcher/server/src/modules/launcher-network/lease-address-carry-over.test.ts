import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { mintLauncherLeaseCapability } from '../../lib/launcher-lease-auth.js';
import {
  launcherNetworkLeaseIsActive,
  launcherNetworkLeaseMatchesProfile
} from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import { LauncherNetworkController } from './launcher-network.controller.js';

const config = loadConfig();

// Luopan keeps one overlay address per install and WireGuard key, so a login,
// a logout restart or a user switch leaves the client's tunnel unchanged.
test('Luopan identity switches keep the device address and release the previous lease', async () => {
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const alice = createUser(store, 'usr_carry_alice', 'carry-alice');
  const bob = createUser(store, 'usr_carry_bob', 'carry-bob');
  const product = store.getLauncherProductNetwork('luopan')!;
  const device = devicePrefix('luopan', 'carry');
  const capabilities: string[] = [];
  const presented = () => capabilities.join(',');

  const anonymous = (await enroll(controller, undefined, device, 'anonymous', null, presented())).lease;
  capabilities.push(capabilityOf(anonymous));
  assert.equal(anonymous.leaseProfile, 'anonymous');
  const deviceAddress = anonymous.leaseIp;

  const aliceLogin = (await enroll(controller, token(store, alice), device, 'employee', alice, presented())).lease;
  capabilities.push(capabilityOf(aliceLogin));
  assert.equal(aliceLogin.leaseProfile, 'employee');
  assert.equal(aliceLogin.leaseIp, deviceAddress, 'login keeps the anonymous address');
  const storedAlice = store.getLauncherNetworkLease(aliceLogin.leaseId)!;
  assert.equal(storedAlice.addressProfile, 'anonymous');
  assert.equal(launcherNetworkLeaseMatchesProfile(product, 'employee', storedAlice), true,
    'the kept address still matches the range it was allocated from');
  assert.equal(launcherNetworkLeaseIsActive(store.getLauncherNetworkLease(anonymous.leaseId)!), false,
    'the anonymous lease is released, so one active lease holds the address');
  const snapshot = await controller.createSnapshot(
    `Bearer ${token(store, alice)}`,
    { leaseId: aliceLogin.leaseId, appId: 'luopan', productId: 'luopan', launcherMode: 'standalone', leaseProfile: 'employee' },
    presented()
  );
  assert.equal(JSON.stringify(snapshot).includes(deviceAddress), true, 'the route plan carries the kept address');
  // Peer sync stops at the missing Domestic plan before any SSH, after its lease checks.
  const peerSync = await controller.syncDomesticPeer(
    aliceLogin.leaseId, `Bearer ${token(store, alice)}`, presented(), undefined, undefined, {}
  );
  assert.equal(peerSync.domesticPeerSync.status, 'blocked');
  await assert.rejects(
    controller.syncDomesticPeer(anonymous.leaseId, undefined, presented(), undefined, undefined, {}),
    /released or expired/,
    'the released lease can no longer change the relay peer'
  );

  const restored = (await enroll(controller, token(store, alice), device, 'employee', alice, presented())).lease;
  capabilities.push(capabilityOf(restored));
  assert.equal(restored.leaseId, aliceLogin.leaseId, 'a remembered session renews the same lease');
  assert.equal(restored.leaseIp, deviceAddress);

  const loggedOut = (await enroll(controller, undefined, device, 'anonymous', null, presented())).lease;
  capabilities.push(capabilityOf(loggedOut));
  assert.equal(loggedOut.leaseIp, deviceAddress, 'a restart without a remembered user keeps the address');
  assert.equal(store.getLauncherNetworkLease(loggedOut.leaseId)!.addressProfile, undefined,
    'an address back in its own range carries no override');
  assert.equal(launcherNetworkLeaseIsActive(store.getLauncherNetworkLease(aliceLogin.leaseId)!), false);

  const bobLogin = (await enroll(controller, token(store, bob), device, 'employee', bob, presented())).lease;
  assert.equal(bobLogin.leaseIp, deviceAddress, 'another user on the same device keeps the address');
  assert.equal(launcherNetworkLeaseIsActive(store.getLauncherNetworkLease(loggedOut.leaseId)!), false);

  const otherDevice = (await enroll(
    controller, undefined, devicePrefix('luopan', 'carry-other'), 'anonymous', null, ''
  )).lease;
  assert.notEqual(otherDevice.leaseIp, deviceAddress, 'an active kept address is never allocated twice');

  const activeAtAddress = store.listLauncherNetworkLeases('luopan')
    .filter((lease) => launcherNetworkLeaseIsActive(lease) && lease.leaseIp === deviceAddress);
  assert.deepEqual(activeAtAddress.map((lease) => lease.leaseId), [bobLogin.leaseId]);
});

test('a returning user lease moves to the address the device is running', async () => {
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const alice = createUser(store, 'usr_carry_return', 'carry-return');
  const device = devicePrefix('luopan', 'return');
  // Before this change a login allocated from the employee range and left the
  // anonymous lease active, so a device can hold both.
  const legacy = (leaseProfile: 'employee' | 'anonymous') => {
    const capability = mintLauncherLeaseCapability();
    const lease = store.enrollLauncherNetworkLease({
      appId: 'luopan', productId: 'luopan', mode: 'standalone',
      identityKind: leaseProfile === 'employee' ? 'user' : 'anonymous', leaseProfile,
      installId: device.installId, deviceId: device.deviceId, publicKey: device.publicKey,
      ...(leaseProfile === 'employee' ? { userId: alice.userId } : {}),
      capabilityDigest: capability.digest, capabilityVersion: capability.version,
      capabilityExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      requestedBy: 'carry-over-test'
    });
    return { lease, capability: capability.token };
  };
  const legacyUser = legacy('employee');
  const runningAnonymous = legacy('anonymous');
  assert.notEqual(runningAnonymous.lease.leaseIp, legacyUser.lease.leaseIp);

  const login = (await enroll(
    controller, token(store, alice), device, 'employee', alice,
    [legacyUser.capability, runningAnonymous.capability].join(',')
  )).lease;
  assert.equal(login.leaseId, legacyUser.lease.leaseId, 'the existing user lease is renewed');
  assert.equal(login.leaseIp, runningAnonymous.lease.leaseIp, 'and takes the address of the newer running lease');
  assert.equal(launcherNetworkLeaseIsActive(store.getLauncherNetworkLease(runningAnonymous.lease.leaseId)!), false);
});

test('MX-H2I keeps separate guest and employee leases', async () => {
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const alice = createUser(store, 'usr_carry_h2i', 'carry-h2i');
  const device = devicePrefix('mx-h2i', 'h2i');
  const guest = (await enroll(controller, undefined, device, 'anonymous', null, '')).lease;
  const employee = (await enroll(controller, token(store, alice), device, 'employee', alice, capabilityOf(guest))).lease;
  assert.notEqual(employee.leaseIp, guest.leaseIp);
  assert.equal(store.getLauncherNetworkLease(employee.leaseId)!.addressProfile, undefined);
  assert.equal(launcherNetworkLeaseIsActive(store.getLauncherNetworkLease(guest.leaseId)!), true,
    'the guest lease stays active for the make-before-break handover');
});

// The client keeps every capability it was issued and presents them together.
function capabilityOf(lease: { capability?: string }): string {
  assert.equal(typeof lease.capability, 'string');
  return lease.capability as string;
}

function createUser(store: MemoryStore, userId: string, account: string) {
  return store.createUserCenterUser({
    userId,
    account,
    password: `${account}-password`,
    allowedAppIds: ['mx-h2i', 'luopan'],
    requestedBy: 'carry-over-test'
  });
}

function token(store: MemoryStore, user: { userId: string }): string {
  return store.issueUserCenterToken({
    subjectKind: 'user',
    subjectId: user.userId,
    audience: 'mx-sdk',
    scopes: ['auth.read'],
    authProvider: 'local-password',
    requestId: `token-${user.userId}`
  }).token;
}

function devicePrefix(productId: 'luopan' | 'mx-h2i', suffix: string) {
  return {
    productId,
    installId: `inst_${suffix}`,
    deviceId: `dev_${suffix}`,
    publicKey: `public-key-${suffix}`
  };
}

async function enroll(
  controller: LauncherNetworkController,
  bearer: string | undefined,
  device: ReturnType<typeof devicePrefix>,
  leaseProfile: 'anonymous' | 'employee',
  user: { userId: string } | null,
  capabilities: string
) {
  return controller.enrollLease(
    bearer ? `Bearer ${bearer}` : undefined,
    {
      appId: device.productId,
      productId: device.productId,
      mode: 'standalone',
      identityKind: user ? 'user' : 'anonymous',
      leaseProfile,
      installId: device.installId,
      deviceId: device.deviceId,
      ...(user ? { userId: user.userId } : {}),
      publicKey: device.publicKey
    },
    capabilities || undefined,
    undefined,
    '198.51.100.70'
  );
}
