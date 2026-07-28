import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { LauncherNetworkController } from '../src/modules/launcher-network/launcher-network.controller.js';
import {
  advanceLauncherNetworkHandover,
  buildLauncherNetworkHandover
} from '../src/lib/launcher-network-handover.js';
import {
  buildLauncherNetworkLease,
  buildLauncherNetworkTopology,
  buildLauncherProductNetwork,
  buildSiteSlotDomesticRuntimeConfig,
  launcherLeaseIpForProduct,
  launcherNetworkLeaseIsActive
} from '../src/store/domain.js';
import { MemoryStore } from '../src/store/memory.js';

const config = loadConfig();
const store = new MemoryStore(config);
store.bootstrapUserCenter();
const domesticTlsRuntime = buildSiteSlotDomesticRuntimeConfig(config, {
  siteId: 'domestic-main'
}, null);
assert.equal(domesticTlsRuntime.edge.publicBaseUrl, 'https://h2i.minsight-ai.com');
assert.equal(domesticTlsRuntime.edge.bind, '127.0.0.1');
assert.equal(
  domesticTlsRuntime.env.MX_DOMESTIC_PUBLIC_GATEWAY_NETWORK,
  'compass-gateway_default'
);
assert.equal(domesticTlsRuntime.env.MX_DOMESTIC_HTTPS_BIND, '0.0.0.0');
assert.equal(domesticTlsRuntime.env.MX_DOMESTIC_HTTPS_PORT, '443');
const migratedLegacyDomesticTlsRuntime = buildSiteSlotDomesticRuntimeConfig(config, {
  siteId: 'domestic-main',
  bootstrapHost: 'h2i.mxinfo-inc.cn'
}, null);
assert.equal(migratedLegacyDomesticTlsRuntime.edge.publicBaseUrl, 'https://h2i.minsight-ai.com');
assert.ok(
  migratedLegacyDomesticTlsRuntime.warnings.some((warning) => (
    warning === 'legacy-public-bootstrap-host: migrated h2i.mxinfo-inc.cn to h2i.minsight-ai.com'
  ))
);
const preservedMxinfoInternalName = buildSiteSlotDomesticRuntimeConfig(config, {
  siteId: 'domestic-main',
  bootstrapHost: 'api.mxinfo-inc.cn',
  publicGatewayNetwork: 'official_shared'
}, null);
assert.equal(preservedMxinfoInternalName.edge.publicBaseUrl, 'https://api.mxinfo-inc.cn');
assert.equal(
  preservedMxinfoInternalName.env.MX_DOMESTIC_PUBLIC_GATEWAY_NETWORK,
  'official_shared'
);
const rejectedDomesticTlsInjection = buildSiteSlotDomesticRuntimeConfig(config, {
  siteId: 'domestic-main',
  bootstrapHost: 'h2i.mxinfo-inc.cn}\n:80 { respond injected }',
  publicGatewayNetwork: 'compass\nINJECTED=1',
  edgeBind: '0.0.0.0\nINJECTED=1'
}, null);
assert.equal(rejectedDomesticTlsInjection.edge.publicBaseUrl, 'https://h2i.minsight-ai.com');
assert.equal(rejectedDomesticTlsInjection.edge.bind, '127.0.0.1');
assert.ok(
  rejectedDomesticTlsInjection.warnings.some((warning) => warning.startsWith('blocked: bootstrapHost'))
);
assert.ok(
  rejectedDomesticTlsInjection.warnings.some((warning) => warning.startsWith('blocked: edgeBind'))
);
assert.ok(
  rejectedDomesticTlsInjection.warnings.some((warning) => (
    warning.startsWith('blocked: publicGatewayNetwork')
  ))
);
const directOnlyHandover = buildLauncherNetworkHandover(config.environment, {
  transitionId: 'direct-only-optional-peer-smoke',
  productId: 'mx-h2i',
  installId: 'inst_direct_only',
  deviceId: 'dev_direct_only',
  publicKey: `${'H'.repeat(43)}=`,
  oldLeaseId: 'lease_direct_old',
  newLeaseId: 'lease_direct_new',
  oldLeaseIp: '10.89.100.10',
  newLeaseIp: '10.89.50.10',
  domesticRequired: false,
  internalRequired: true,
  deadlineAt: new Date(Date.now() + 60_000).toISOString()
});
const directOnlyPrepared = advanceLauncherNetworkHandover(directOnlyHandover, {
  transitionId: directOnlyHandover.transitionId,
  peer: 'internal',
  phase: 'prepare',
  success: true
});
assert.equal(directOnlyPrepared.status, 'prepared');
const directOnlyAfterOptionalFailure = advanceLauncherNetworkHandover(directOnlyPrepared, {
  transitionId: directOnlyHandover.transitionId,
  peer: 'domestic',
  phase: 'prepare',
  success: false,
  error: 'optional relay unavailable'
});
assert.equal(directOnlyAfterOptionalFailure.status, 'prepared');
assert.equal(directOnlyAfterOptionalFailure.lastError, null);
const directOnlyCommitted = advanceLauncherNetworkHandover(directOnlyAfterOptionalFailure, {
  transitionId: directOnlyHandover.transitionId,
  peer: 'internal',
  phase: 'commit',
  success: true
});
assert.equal(directOnlyCommitted.status, 'committed');
assert.equal(
  advanceLauncherNetworkHandover(directOnlyCommitted, {
    transitionId: directOnlyHandover.transitionId,
    peer: 'domestic',
    phase: 'commit',
    success: false,
    error: 'late optional relay failure'
  }).status,
  'committed'
);
const product = store.getLauncherProductNetwork('mx-h2i');

assert.ok(product);
assert.equal(product.userLeaseStart, '10.89.0.1');
assert.equal(product.userLeaseEnd, '10.89.49.254');
assert.equal(product.feishuLeaseStart, '10.89.50.1');
assert.equal(product.feishuLeaseEnd, '10.89.99.254');
assert.equal(product.anonymousLeaseStart, '10.89.100.1');
assert.equal(product.anonymousLeaseEnd, '10.89.254.254');
assert.throws(
  () => buildLauncherProductNetwork(loadConfig(), {
    productId: 'mx-h2i',
    userLeaseEnd: '10.89.60.1'
  }, product),
  /must not overlap/
);
assert.throws(
  () => buildLauncherProductNetwork(loadConfig(), {
    productId: 'mx-h2i',
    feishuCidr: '10.90.0.0/16'
  }, product),
  /must be contained/
);
assert.throws(
  () => buildLauncherProductNetwork(loadConfig(), {
    productId: 'mx-h2i',
    anonymousCidr: 'not-a-cidr'
  }, product),
  /must be contained/
);

assert.equal(launcherLeaseIpForProduct(product, 'employee', 1), '10.89.0.1');
assert.equal(launcherLeaseIpForProduct(product, 'employee', 12_700), '10.89.49.254');
assert.throws(() => launcherLeaseIpForProduct(product, 'employee', 12_701), /range exhausted/);
assert.equal(launcherLeaseIpForProduct(product, 'feishu', 1), '10.89.50.1');
assert.equal(launcherLeaseIpForProduct(product, 'feishu', 12_700), '10.89.99.254');
assert.throws(() => launcherLeaseIpForProduct(product, 'feishu', 12_701), /range exhausted/);
assert.equal(launcherLeaseIpForProduct(product, 'anonymous', 1), '10.89.100.1');
assert.equal(launcherLeaseIpForProduct(product, 'anonymous', 39_370), '10.89.254.254');
assert.throws(() => launcherLeaseIpForProduct(product, 'anonymous', 39_371), /range exhausted/);

const distinctCidrProduct = buildLauncherProductNetwork(config, {
  productId: 'distinct-cidr-smoke',
  mode: 'standalone',
  userCidr: '10.89.0.0/18',
  userLeaseStart: '10.89.0.1',
  userLeaseEnd: '10.89.49.254',
  feishuCidr: '10.89.64.0/18',
  feishuLeaseStart: '10.89.64.1',
  feishuLeaseEnd: '10.89.99.254',
  anonymousCidr: '10.89.128.0/17',
  anonymousLeaseStart: '10.89.128.1',
  anonymousLeaseEnd: '10.89.254.254'
}, null);
const distinctFeishuTopology = buildLauncherNetworkTopology(config, {
  mode: 'user',
  leaseIp: '10.89.64.1',
  leaseProfile: 'feishu',
  product: distinctCidrProduct
});
assert.equal(distinctFeishuTopology.homeLease.cidr, distinctCidrProduct.feishuCidr);
assert.equal(distinctFeishuTopology.relayPlan.homePeer.cidr, distinctCidrProduct.feishuCidr);

const common = {
  appId: 'mx-h2i',
  productId: 'mx-h2i',
  mode: 'standalone' as const,
  installId: 'inst_feishu_network_smoke',
  deviceId: 'dev_feishu_network_smoke',
  siteId: 'domestic-main',
  userId: 'usr_demo_user',
  publicKey: 'smoke-public-key',
  requestedBy: 'feishu-network-smoke'
};
const employee = store.enrollLauncherNetworkLease({
  ...common,
  identityKind: 'user',
  leaseProfile: 'employee'
});
const feishu = store.enrollLauncherNetworkLease({
  ...common,
  identityKind: 'user',
  leaseProfile: 'feishu'
});
const guest = store.enrollLauncherNetworkLease({
  ...common,
  identityKind: 'anonymous',
  leaseProfile: 'anonymous',
  userId: null
});

assert.equal(employee.leaseIp, '10.89.0.1');
assert.equal(feishu.leaseIp, '10.89.50.1');
assert.equal(guest.leaseIp, '10.89.100.1');
assert.notEqual(employee.leaseId, feishu.leaseId);
assert.equal(launcherNetworkLeaseIsActive(feishu), true);

const crossProductPublicKey = `${'G'.repeat(43)}=`;
const foreignProductLease = {
  ...guest,
  leaseId: 'lease_luopan_public_key_smoke',
  leaseKey: 'luopan-public-key-smoke',
  productId: 'luopan',
  installId: 'inst_luopan_public_key_smoke',
  deviceId: 'dev_luopan_public_key_smoke',
  publicKey: crossProductPublicKey
};
(store as unknown as {
  launcherNetworkLeases: Map<string, typeof foreignProductLease>;
}).launcherNetworkLeases.set(foreignProductLease.leaseId, foreignProductLease);
assert.throws(
  () => store.enrollLauncherNetworkLease({
    ...common,
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: 'inst_mx_h2i_cross_product_key_smoke',
    deviceId: 'dev_mx_h2i_cross_product_key_smoke',
    userId: null,
    publicKey: crossProductPublicKey
  }),
  /WireGuard publicKey is already owned/
);

const snapshot = store.createLauncherNetworkSnapshot({
  leaseId: feishu.leaseId,
  appId: 'mx-h2i',
  launcherMode: 'standalone',
  userId: feishu.userId,
  leaseProfile: 'feishu'
});
assert.equal(snapshot.overlayPolicy.leaseProfile, 'feishu');
assert.equal(snapshot.overlayPolicy.leaseIp, feishu.leaseIp);
assert.equal(snapshot.overlayPolicy.cidr, product.feishuCidr);

const feishuToken = store.issueUserCenterToken({
  subjectKind: 'user',
  subjectId: 'usr_demo_user',
  audience: 'mx-sdk',
  authProvider: 'feishu'
});
const controller = new LauncherNetworkController(store, config);
const guestCapabilityV1 = `mxlc1.${'A'.repeat(43)}`;
const guestCapabilityV2 = `mxlc1.${'B'.repeat(43)}`;
const controllerGuestInput = {
  appId: 'mx-h2i',
  productId: 'mx-h2i',
  mode: 'standalone',
  identityKind: 'anonymous',
  installId: 'inst_guest_capability_smoke',
  deviceId: 'dev_guest_capability_smoke',
  publicKey: `${'C'.repeat(43)}=`
};
const controllerGuest = await controller.enrollLease(
  undefined,
  controllerGuestInput,
  undefined,
  guestCapabilityV1
);
assert.equal(controllerGuest.lease.capability, guestCapabilityV1);
assert.equal('capabilityDigest' in controllerGuest.lease, false);
await assert.rejects(
  controller.enrollLease(undefined, controllerGuestInput, undefined, guestCapabilityV2),
  /valid launcher lease capability/
);
const rotatedControllerGuest = await controller.enrollLease(
  undefined,
  controllerGuestInput,
  guestCapabilityV1,
  guestCapabilityV2
);
assert.equal(rotatedControllerGuest.lease.capability, guestCapabilityV2);
await assert.rejects(
  controller.enrollLease(
    undefined,
    {
      ...controllerGuestInput,
      publicKey: `${'J'.repeat(43)}=`
    },
    guestCapabilityV2,
    `mxlc1.${'K'.repeat(43)}`
  ),
  /requires the existing device and public key/
);
await assert.rejects(
  controller.createSnapshot(undefined, {
    leaseId: rotatedControllerGuest.lease.leaseId,
    appId: 'mx-h2i',
    launcherMode: 'standalone'
  }),
  /valid launcher lease capability/
);
const controllerGuestSnapshot = await controller.createSnapshot(
  undefined,
  {
    leaseId: rotatedControllerGuest.lease.leaseId,
    appId: 'mx-h2i',
    launcherMode: 'standalone'
  },
  guestCapabilityV2
);
assert.equal(controllerGuestSnapshot.snapshot.overlayPolicy.leaseProfile, 'anonymous');
const passwordToken = store.issueUserCenterToken({
  subjectKind: 'user',
  subjectId: 'usr_demo_user',
  audience: 'mx-sdk',
  authProvider: 'local-password'
});
const providerlessToken = store.issueUserCenterToken({
  subjectKind: 'user',
  subjectId: 'usr_demo_user',
  audience: 'mx-sdk'
});
await assert.rejects(
  controller.enrollLease(`Bearer ${providerlessToken.token}`, {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: 'inst_providerless_token_smoke',
    deviceId: 'dev_providerless_token_smoke',
    userId: 'usr_demo_user'
  }),
  /require a local-password or Feishu login token/
);
await assert.rejects(
  controller.enrollLease('Bearer mx-shadow-user:usr_demo_user', {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: 'inst_shadow_token_smoke',
    deviceId: 'dev_shadow_token_smoke',
    userId: 'usr_demo_user'
  }),
  /inactive or has no user principal/
);
const authorizedEmployee = await controller.enrollLease(`Bearer ${passwordToken.token}`, {
  appId: 'mx-h2i',
  productId: 'mx-h2i',
  mode: 'standalone',
  identityKind: 'user',
  installId: 'inst_employee_controller_smoke',
  deviceId: 'dev_employee_controller_smoke',
  userId: 'usr_demo_user'
});
assert.equal(authorizedEmployee.lease.leaseProfile, 'employee');
assert.match(authorizedEmployee.lease.leaseIp, /^10\.89\.(?:[0-9]|[1-4]\d)\./);
await assert.rejects(
  controller.enrollLease(
    `Bearer ${passwordToken.token}`,
    {
      appId: 'mx-h2i',
      productId: 'mx-h2i',
      mode: 'standalone',
      identityKind: 'user',
      installId: authorizedEmployee.lease.installId,
      deviceId: authorizedEmployee.lease.deviceId,
      userId: authorizedEmployee.lease.userId,
      publicKey: `${'L'.repeat(43)}=`
    },
    authorizedEmployee.lease.capability
  ),
  /requires the existing device and public key/
);
await assert.rejects(
  controller.enrollLease(`Bearer ${passwordToken.token}`, {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    leaseProfile: 'feishu',
    installId: 'inst_password_spoof_smoke',
    deviceId: 'dev_password_spoof_smoke',
    userId: 'usr_demo_user'
  }),
  /Only a Feishu-authenticated/
);
const authorized = await controller.enrollLease(`Bearer ${feishuToken.token}`, {
  appId: 'mx-h2i',
  productId: 'mx-h2i',
  mode: 'standalone',
  identityKind: 'user',
  leaseProfile: 'employee',
  installId: 'inst_feishu_controller_smoke',
  deviceId: 'dev_feishu_controller_smoke',
  userId: 'usr_demo_user'
});
assert.equal(authorized.lease.leaseProfile, 'feishu');
assert.match(authorized.lease.leaseIp, /^10\.89\.(?:5\d|[6-9]\d)\./);
const authorizedSnapshot = await controller.createSnapshot(`Bearer ${feishuToken.token}`, {
  leaseId: authorized.lease.leaseId,
  appId: 'mx-h2i',
  launcherMode: 'standalone',
  userId: 'usr_demo_user',
  leaseProfile: 'feishu'
});
assert.equal(authorizedSnapshot.snapshot.overlayPolicy.leaseProfile, 'feishu');
assert.equal(authorizedSnapshot.snapshot.overlayPolicy.leaseIp, authorized.lease.leaseIp);
assert.equal(authorizedSnapshot.snapshot.topology.homeLease.cidr, authorized.lease.cidr);
assert.equal(authorizedSnapshot.snapshot.topology.relayPlan.homePeer.cidr, authorized.lease.cidr);
await assert.rejects(
  controller.createSnapshot(undefined, {
    leaseId: authorized.lease.leaseId,
    appId: 'mx-h2i',
    launcherMode: 'standalone',
    userId: 'usr_demo_user',
    leaseProfile: 'employee'
  }),
  /leaseProfile does not match/
);
await assert.rejects(
  controller.createSnapshot(undefined, {
    leaseId: authorized.lease.leaseId,
    appId: 'mx-h2i',
    launcherMode: 'standalone',
    userId: 'usr_demo_user',
    leaseProfile: 'feishu'
  }),
  /require a Feishu-authenticated/
);
await assert.rejects(
  controller.enrollLease(undefined, {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: 'inst_unauthenticated_employee_smoke',
    deviceId: 'dev_unauthenticated_employee_smoke',
    userId: 'usr_demo_user'
  }),
  /require an active MX user token/
);
await assert.rejects(
  controller.enrollLease(undefined, {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: 'inst_nonexistent_employee_smoke',
    deviceId: 'dev_nonexistent_employee_smoke',
    userId: 'usr_missing_user'
  }),
  /require an active MX user token/
);
await assert.rejects(
  controller.enrollLease(undefined, {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    leaseProfile: 'feishu',
    installId: 'inst_spoofed_feishu_smoke',
    deviceId: 'dev_spoofed_feishu_smoke',
    userId: 'usr_demo_user'
  }),
  /Feishu launcher leases require/
);
store.createUserCenterUser({
  userId: 'usr_feishu_only_smoke',
  account: 'feishu-only-smoke',
  externalIds: {
    feishuSubject: 'tenant_smoke:ou_feishu_only'
  },
  roleIds: ['mx-user'],
  allowedAppIds: ['mx-h2i']
});
await assert.rejects(
  controller.enrollLease(undefined, {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    leaseProfile: 'employee',
    installId: 'inst_feishu_downgrade_smoke',
    deviceId: 'dev_feishu_downgrade_smoke',
    userId: 'usr_feishu_only_smoke'
  }),
  /require an active MX user token/
);
const legacyController = new LauncherNetworkController(store, {
  ...config,
  launcherNetworkLegacyUnauthenticatedUserLeasesEnabled: true
});
const legacyEmployee = await legacyController.enrollLease(undefined, {
  appId: 'mx-h2i',
  productId: 'mx-h2i',
  mode: 'standalone',
  identityKind: 'user',
  installId: 'inst_legacy_employee_smoke',
  deviceId: 'dev_legacy_employee_smoke',
  userId: 'usr_demo_user'
});
assert.equal(legacyEmployee.lease.leaseProfile, 'employee');
await assert.rejects(
  legacyController.enrollLease(undefined, {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: 'inst_legacy_missing_user_smoke',
    deviceId: 'dev_legacy_missing_user_smoke',
    userId: 'usr_missing_user'
  }),
  /require an active password user/
);

const legacyProduct = buildLauncherProductNetwork(config, {
  productId: 'mx-h2i',
  mode: 'standalone',
  userCidr: '10.89.0.0/16',
  userLeaseStart: '10.89.0.1',
  userLeaseEnd: '10.89.99.254',
  feishuCidr: '10.89.0.0/16',
  feishuLeaseStart: '10.89.100.1',
  feishuLeaseEnd: '10.89.149.254',
  anonymousCidr: '10.89.0.0/16',
  anonymousLeaseStart: '10.89.150.1',
  anonymousLeaseEnd: '10.89.254.254'
}, null);
const legacyOutOfRangeLease = buildLauncherNetworkLease(config, {
  ...common,
  identityKind: 'user',
  leaseProfile: 'employee',
  installId: 'inst_legacy_out_of_range',
  deviceId: 'dev_legacy_out_of_range',
  publicKey: `${'H'.repeat(43)}=`
}, legacyProduct, 12_701, null);
delete (legacyOutOfRangeLease as Partial<typeof legacyOutOfRangeLease>).leaseProfile;
(store as unknown as {
  launcherNetworkLeases: Map<string, typeof legacyOutOfRangeLease>;
}).launcherNetworkLeases.set(legacyOutOfRangeLease.leaseId, legacyOutOfRangeLease);
await assert.rejects(
  controller.createSnapshot(`Bearer ${passwordToken.token}`, {
    leaseId: legacyOutOfRangeLease.leaseId,
    appId: 'mx-h2i',
    launcherMode: 'standalone',
    userId: 'usr_demo_user',
    leaseProfile: 'employee'
  }),
  /no longer belongs to its configured profile range/
);
const legacyUpgradeCapability = `mxlc1.${'I'.repeat(43)}`;
const upgradedLegacyEmployee = await controller.enrollLease(
  `Bearer ${passwordToken.token}`,
  {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: legacyOutOfRangeLease.installId,
    deviceId: legacyOutOfRangeLease.deviceId,
    userId: legacyOutOfRangeLease.userId,
    publicKey: legacyOutOfRangeLease.publicKey
  },
  undefined,
  legacyUpgradeCapability
);
assert.notEqual(upgradedLegacyEmployee.lease.leaseId, legacyOutOfRangeLease.leaseId);
assert.equal(upgradedLegacyEmployee.lease.leaseProfile, 'employee');
assert.match(upgradedLegacyEmployee.lease.leaseIp, /^10\.89\.(?:[0-9]|[1-4]\d)\./);
assert.equal(upgradedLegacyEmployee.lease.replacementForLeaseId, legacyOutOfRangeLease.leaseId);
assert.equal(upgradedLegacyEmployee.lease.handoverLeases?.length, 1);
assert.equal(upgradedLegacyEmployee.lease.handoverLeases?.[0]?.leaseId, legacyOutOfRangeLease.leaseId);
assert.equal(upgradedLegacyEmployee.lease.handoverLeases?.[0]?.capability, legacyUpgradeCapability);
assert.equal(
  Boolean(store.getLauncherNetworkLease(legacyOutOfRangeLease.leaseId)?.capabilityDigest),
  true
);
const retriedLegacyEmployeeUpgrade = await controller.enrollLease(
  `Bearer ${passwordToken.token}`,
  {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: legacyOutOfRangeLease.installId,
    deviceId: legacyOutOfRangeLease.deviceId,
    userId: legacyOutOfRangeLease.userId,
    publicKey: legacyOutOfRangeLease.publicKey
  },
  legacyUpgradeCapability,
  legacyUpgradeCapability
);
assert.equal(retriedLegacyEmployeeUpgrade.lease.leaseId, upgradedLegacyEmployee.lease.leaseId);
assert.equal(retriedLegacyEmployeeUpgrade.lease.leaseIp, upgradedLegacyEmployee.lease.leaseIp);
await assert.rejects(
  controller.syncDomesticPeer(
    legacyOutOfRangeLease.leaseId,
    `Bearer ${passwordToken.token}`,
    legacyUpgradeCapability,
    legacyUpgradeCapability,
    undefined,
    {
      transitionId: 'legacy-upgrade-wrong-direction',
      peerLeaseId: upgradedLegacyEmployee.lease.leaseId,
      handoverPhase: 'commit'
    }
  ),
  /direction does not match/
);
await assert.rejects(
  controller.syncDomesticPeer(
    upgradedLegacyEmployee.lease.leaseId,
    `Bearer ${passwordToken.token}`,
    legacyUpgradeCapability,
    legacyUpgradeCapability,
    undefined,
    {
      peerLeaseId: legacyOutOfRangeLease.leaseId,
      handoverPhase: 'prepare'
    }
  ),
  /valid transitionId/
);
const relayOnlyRequirements = await (controller as unknown as {
  launcherHandoverPeerRequirements(
    lease: typeof upgradedLegacyEmployee.lease
  ): Promise<{ domesticRequired: boolean; internalRequired: boolean }>;
}).launcherHandoverPeerRequirements(upgradedLegacyEmployee.lease);
assert.deepEqual(relayOnlyRequirements, {
  domesticRequired: true,
  internalRequired: false
});
const legacyUpgradeTransition = store.createLauncherNetworkHandover({
  transitionId: 'legacy-upgrade-stateful-handover',
  productId: upgradedLegacyEmployee.lease.productId,
  installId: upgradedLegacyEmployee.lease.installId,
  deviceId: upgradedLegacyEmployee.lease.deviceId,
  publicKey: upgradedLegacyEmployee.lease.publicKey as string,
  oldLeaseId: legacyOutOfRangeLease.leaseId,
  newLeaseId: upgradedLegacyEmployee.lease.leaseId,
  oldLeaseIp: legacyOutOfRangeLease.leaseIp,
  newLeaseIp: upgradedLegacyEmployee.lease.leaseIp,
  ...relayOnlyRequirements,
  deadlineAt: new Date(Date.now() + 60_000).toISOString()
});
assert.throws(
  () => store.createLauncherNetworkHandover({
    ...legacyUpgradeTransition,
    transitionId: 'legacy-upgrade-parallel-handover'
  }),
  /already active/
);
const preparedLegacyUpgrade = store.advanceLauncherNetworkHandover({
  transitionId: legacyUpgradeTransition.transitionId,
  peer: 'domestic',
  phase: 'prepare',
  success: true
});
assert.equal(preparedLegacyUpgrade.status, 'prepared');
const controllerInternals = controller as unknown as {
  recordPeerHandoverResult(
    handover: {
      phase: 'single' | 'prepare' | 'commit' | 'abort';
      transition: typeof preparedLegacyUpgrade | null;
    },
    peer: 'domestic' | 'internal',
    success: boolean,
    error: string | null
  ): Promise<void>;
};
await controllerInternals.recordPeerHandoverResult(
  { phase: 'commit', transition: preparedLegacyUpgrade },
  'domestic',
  true,
  null
);
assert.equal(
  store.getLauncherNetworkHandover(legacyUpgradeTransition.transitionId)?.status,
  'committed'
);
assert.equal(
  store.getLauncherNetworkLease(legacyOutOfRangeLease.leaseId)?.status,
  'released'
);
const replayedLegacyRetirement = await controller.releaseLease(
  legacyOutOfRangeLease.leaseId,
  undefined,
  legacyUpgradeCapability,
  undefined,
  { requestId: 'legacy-upgrade-retirement-replay' }
);
assert.equal(replayedLegacyRetirement.lease.status, 'released');

const generationGuestCapability = `mxlc1.${'D'.repeat(43)}`;
const generationFeishuCapability = `mxlc1.${'E'.repeat(43)}`;
const generationDevice = {
  appId: 'mx-h2i',
  productId: 'mx-h2i',
  mode: 'standalone',
  installId: 'inst_generation_smoke',
  deviceId: 'dev_generation_smoke',
  publicKey: `${'F'.repeat(43)}=`
};
const generationGuest = await controller.enrollLease(
  undefined,
  {
    ...generationDevice,
    identityKind: 'anonymous'
  },
  undefined,
  generationGuestCapability
);
const generationFeishu = await controller.enrollLease(
  `Bearer ${feishuToken.token}`,
  {
    ...generationDevice,
    identityKind: 'user',
    leaseProfile: 'feishu',
    userId: 'usr_demo_user'
  },
  generationGuestCapability,
  generationFeishuCapability
);
assert.ok(
  Number(generationFeishu.lease.generation) > Number(generationGuest.lease.generation)
);
await assert.rejects(
  controller.syncDomesticPeer(
    generationGuest.lease.leaseId,
    undefined,
    generationGuestCapability,
    undefined,
    undefined,
    {}
  ),
  /superseded by a newer lease/
);
const expiredGenerationHandover = store.createLauncherNetworkHandover({
  transitionId: 'generation-expired-handover',
  productId: generationFeishu.lease.productId,
  installId: generationFeishu.lease.installId,
  deviceId: generationFeishu.lease.deviceId,
  publicKey: generationFeishu.lease.publicKey as string,
  oldLeaseId: generationGuest.lease.leaseId,
  newLeaseId: generationFeishu.lease.leaseId,
  oldLeaseIp: generationGuest.lease.leaseIp,
  newLeaseIp: generationFeishu.lease.leaseIp,
  domesticRequired: true,
  internalRequired: true,
  deadlineAt: new Date(Date.now() - 1_000).toISOString()
});
store.advanceLauncherNetworkHandover({
  transitionId: expiredGenerationHandover.transitionId,
  peer: 'domestic',
  phase: 'prepare',
  success: true
});
store.advanceLauncherNetworkHandover({
  transitionId: expiredGenerationHandover.transitionId,
  peer: 'internal',
  phase: 'prepare',
  success: true
});
await controller.reconcileExpiredHandovers(
  new Date(),
  async () => ({
    domesticPeerSync: { status: 'passed', execution: 'executed' },
    internalPeerSync: { status: 'passed', execution: 'executed' }
  })
);
assert.equal(
  store.getLauncherNetworkHandover(expiredGenerationHandover.transitionId)?.status,
  'aborted'
);
assert.equal(
  store.getLauncherNetworkLease(generationFeishu.lease.leaseId)?.status,
  'released'
);
assert.equal(
  store.getLauncherNetworkLease(generationGuest.lease.leaseId)?.status,
  'active'
);

const activeDemoUser = store.listUserCenterUsers()
  .find((user) => user.userId === 'usr_demo_user');
assert.ok(activeDemoUser);
store.createUserCenterUser({
  userId: activeDemoUser.userId,
  account: activeDemoUser.account,
  email: activeDemoUser.email,
  displayName: activeDemoUser.displayName,
  roleIds: activeDemoUser.roleIds,
  orgIds: activeDemoUser.orgIds,
  status: 'disabled',
  profile: activeDemoUser.profile,
  appAccess: activeDemoUser.appAccess
});
await assert.rejects(
  controller.diagnoseDomesticRelay(
    authorized.lease.leaseId,
    undefined,
    authorized.lease.capability,
    undefined,
    {}
  ),
  /user is disabled or no longer exists/
);
const retiredFeishuLease = await controller.releaseLease(
  authorized.lease.leaseId,
  undefined,
  authorized.lease.capability,
  undefined,
  {}
);
assert.equal(retiredFeishuLease.lease.status, 'released');
const replayedRetirement = await controller.releaseLease(
  authorized.lease.leaseId,
  undefined,
  authorized.lease.capability,
  undefined,
  {}
);
assert.equal(replayedRetirement.lease.status, 'released');
assert.equal(replayedRetirement.lease.releasedAt, retiredFeishuLease.lease.releasedAt);
await assert.rejects(
  controller.syncDomesticPeer(
    authorized.lease.leaseId,
    undefined,
    authorized.lease.capability,
    undefined,
    undefined,
    {}
  ),
  /lease is released or expired/
);

console.log(JSON.stringify({
  ok: true,
  ranges: {
    employee: [product.userLeaseStart, product.userLeaseEnd],
    feishu: [product.feishuLeaseStart, product.feishuLeaseEnd],
    guest: [product.anonymousLeaseStart, product.anonymousLeaseEnd]
  },
  leases: {
    employee: employee.leaseIp,
    feishu: feishu.leaseIp,
    guest: guest.leaseIp
  },
  snapshotLeaseIp: snapshot.overlayPolicy.leaseIp,
  authorizedEmployeeLeaseIp: authorizedEmployee.lease.leaseIp,
  authorizedFeishuLeaseIp: authorized.lease.leaseIp,
  authorizedFeishuSnapshotIp: authorizedSnapshot.snapshot.overlayPolicy.leaseIp,
  legacyEmployeeLeaseIp: legacyEmployee.lease.leaseIp
}, null, 2));
