import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import {
  LauncherAnonymousEnrollmentPolicyError,
  assertLauncherAnonymousEnrollmentPolicy,
  buildLauncherNetworkLease,
  buildLauncherProductNetwork
} from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import type { LauncherNetworkLeaseInput, LauncherProductNetwork } from '../../types.js';
import { EnrollmentsController } from '../enrollments/enrollments.controller.js';
import { LauncherNetworkController } from './launcher-network.controller.js';

const config = loadConfig();

test('built-in and legacy product networks keep compatible anonymous defaults', () => {
  const store = new MemoryStore(config);
  const mxH2i = requiredProduct(store, 'mx-h2i');
  const luopan = requiredProduct(store, 'luopan');

  assert.equal(mxH2i.anonymousEnrollmentPolicy, 'enabled');
  assert.equal(mxH2i.anonymousUiVisibility, 'advanced');
  assert.equal(luopan.anonymousEnrollmentPolicy, 'enabled');
  assert.equal(luopan.anonymousUiVisibility, 'primary');

  const legacy = { ...mxH2i } as Partial<LauncherProductNetwork>;
  delete legacy.anonymousEnrollmentPolicy;
  delete legacy.anonymousUiVisibility;
  const normalized = buildLauncherProductNetwork(
    config,
    { productId: mxH2i.productId, requestedBy: 'legacy-policy-test' },
    legacy as LauncherProductNetwork
  );

  assert.equal(normalized.anonymousEnrollmentPolicy, 'enabled');
  assert.equal(normalized.anonymousUiVisibility, 'advanced');
  assert.doesNotThrow(() => assertLauncherAnonymousEnrollmentPolicy(
    anonymousInput('legacy-anonymous'),
    legacy as LauncherProductNetwork,
    null
  ));
});

test('product policy writes reject unknown enum values without reopening enrollment', async () => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'anonymous-policy-write-test';
  try {
    const store = new MemoryStore(config);
    const controller = new LauncherNetworkController(store, config);
    await controller.upsertProductNetwork('mx-h2i', 'anonymous-policy-write-test', {
      anonymousEnrollmentPolicy: 'disabled',
      anonymousUiVisibility: 'hidden'
    });

    await assert.rejects(
      controller.upsertProductNetwork('mx-h2i', 'anonymous-policy-write-test', {
        anonymousEnrollmentPolicy: 'disable'
      }),
      (error) => httpStatus(error) === 400
    );
    await assert.rejects(
      controller.upsertProductNetwork('mx-h2i', 'anonymous-policy-write-test', {
        anonymousUiVisibility: 'hide'
      }),
      (error) => httpStatus(error) === 400
    );

    const product = requiredProduct(store, 'mx-h2i');
    assert.equal(product.anonymousEnrollmentPolicy, 'disabled');
    assert.equal(product.anonymousUiVisibility, 'hidden');
  } finally {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  }
});

test('disabled rejects anonymous leases without affecting employee or Feishu leases', () => {
  const store = new MemoryStore(config);
  const legacyAnonymous = store.enrollLauncherNetworkLease(anonymousInput('disabled-legacy-claim'));
  store.upsertLauncherProductNetwork({
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: 'disabled',
    requestedBy: 'anonymous-policy-test'
  });

  assert.throws(
    () => store.enrollLauncherNetworkLease(anonymousInput('disabled-anonymous')),
    policyError('launcher_anonymous_enrollment_disabled')
  );
  assert.throws(
    () => store.enrollLauncherNetworkLease({
      ...anonymousInput('disabled-legacy-claim'),
      legacyCapabilityClaimLeaseIds: [legacyAnonymous.leaseId],
      capabilityDigest: 'new-capability-digest',
      capabilityVersion: 1,
      capabilityExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      anonymousRenewalLeaseId: legacyAnonymous.leaseId
    }),
    policyError('launcher_anonymous_enrollment_disabled')
  );
  assert.equal(
    store.getLauncherNetworkLease(legacyAnonymous.leaseId)?.capabilityDigest,
    null,
    'a denied legacy capability claim must not mutate the in-memory lease'
  );

  const employee = store.enrollLauncherNetworkLease({
    ...userInput('disabled-employee', 'usr_employee'),
    leaseProfile: 'employee'
  });
  const feishu = store.enrollLauncherNetworkLease({
    ...userInput('disabled-feishu', 'usr_feishu'),
    leaseProfile: 'feishu'
  });

  assert.equal(employee.identityKind, 'user');
  assert.equal(employee.leaseProfile, 'employee');
  assert.equal(feishu.identityKind, 'user');
  assert.equal(feishu.leaseProfile, 'feishu');
});

test('disabling MX-H2I anonymous admission does not affect Luopan anonymous leases', () => {
  const store = new MemoryStore(config);
  store.upsertLauncherProductNetwork({
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: 'disabled',
    requestedBy: 'anonymous-policy-isolation-test'
  });

  const luopanInput: LauncherNetworkLeaseInput = {
    ...anonymousInput('luopan-isolation'),
    appId: 'luopan',
    productId: 'luopan'
  };
  const enrolled = store.enrollLauncherNetworkLease(luopanInput);
  const renewed = store.enrollLauncherNetworkLease(luopanInput);

  assert.equal(requiredProduct(store, 'mx-h2i').anonymousEnrollmentPolicy, 'disabled');
  assert.equal(requiredProduct(store, 'luopan').anonymousEnrollmentPolicy, 'enabled');
  assert.equal(enrolled.productId, 'luopan');
  assert.match(enrolled.leaseIp, /^10\.91\./);
  assert.equal(renewed.leaseId, enrolled.leaseId);
});

test('drain admits only a matching active anonymous renewal', () => {
  const store = new MemoryStore(config);
  const originalInput = anonymousInput('drain-existing');
  const original = store.enrollLauncherNetworkLease(originalInput);
  store.upsertLauncherProductNetwork({
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: 'drain',
    requestedBy: 'anonymous-policy-test'
  });

  assert.throws(
    () => store.enrollLauncherNetworkLease(anonymousInput('drain-new')),
    policyError('launcher_anonymous_enrollment_draining')
  );
  assert.throws(
    () => store.enrollLauncherNetworkLease(originalInput),
    policyError('launcher_anonymous_enrollment_draining')
  );
  assert.throws(
    () => store.enrollLauncherNetworkLease({
      ...originalInput,
      anonymousRenewalLeaseId: 'lnlease_wrong'
    }),
    policyError('launcher_anonymous_enrollment_draining')
  );

  const renewed = store.enrollLauncherNetworkLease({
    ...originalInput,
    anonymousRenewalLeaseId: original.leaseId
  });
  assert.equal(renewed.leaseId, original.leaseId);

  store.releaseLauncherNetworkLease(renewed.leaseId, { requestedBy: 'anonymous-policy-test' });
  assert.throws(
    () => store.enrollLauncherNetworkLease({
      ...originalInput,
      anonymousRenewalLeaseId: renewed.leaseId
    }),
    policyError('launcher_anonymous_enrollment_draining')
  );
});

test('drain rejects capability bootstrap against a legacy anonymous lease', async () => {
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const legacy = store.enrollLauncherNetworkLease(anonymousInput('drain-legacy-claim'));
  store.upsertLauncherProductNetwork({
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: 'drain',
    requestedBy: 'anonymous-policy-test'
  });

  await assert.rejects(
    controller.enrollLease(
      undefined,
      {
        appId: 'mx-h2i',
        productId: 'mx-h2i',
        mode: 'standalone',
        identityKind: 'anonymous',
        leaseProfile: 'anonymous',
        installId: legacy.installId,
        deviceId: legacy.deviceId,
        publicKey: legacy.publicKey
      },
      undefined,
      `mxlc1.${'A'.repeat(43)}`,
      '198.51.100.20'
    ),
    forbiddenPolicyError('launcher_anonymous_enrollment_draining')
  );
  assert.equal(
    store.getLauncherNetworkLease(legacy.leaseId)?.capabilityDigest,
    null,
    'drain must not let an unauthenticated caller claim a legacy lease capability'
  );
});

test('controller derives drain renewal proof, captures source IP, and keeps it ops-only', async () => {
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const body = {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: 'inst_controller_drain',
    deviceId: 'dev_controller_drain',
    publicKey: 'controller-drain-public-key',
    sourceIp: '203.0.113.250'
  };
  const initial = await controller.enrollLease(
    undefined,
    body,
    undefined,
    undefined,
    '198.51.100.10'
  );
  assert.equal(typeof initial.lease.capability, 'string');

  store.upsertLauncherProductNetwork({
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: 'drain',
    requestedBy: 'anonymous-policy-test'
  });

  await assert.rejects(
    controller.enrollLease(
      undefined,
      { ...body, anonymousRenewalLeaseId: initial.lease.leaseId },
      undefined,
      undefined,
      '198.51.100.11'
    ),
    (error) => httpStatus(error) === 401
  );

  const renewed = await controller.enrollLease(
    undefined,
    { ...body, anonymousRenewalLeaseId: 'client-controlled-wrong-id' },
    initial.lease.capability,
    undefined,
    '198.51.100.12'
  );
  assert.equal(renewed.lease.leaseId, initial.lease.leaseId);
  assert.equal(renewed.lease.appId, 'mx-h2i');
  assert.equal('sourceIp' in renewed.lease, false, 'ordinary enrollment responses must not expose sourceIp');
  assert.equal(store.getLauncherNetworkLease(renewed.lease.leaseId)?.sourceIp, '198.51.100.12');

  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'anonymous-policy-read-test';
  try {
    const opsLeases = await controller.listLeases('anonymous-policy-read-test');
    assert.equal(
      opsLeases.leases.find((lease) => lease.leaseId === renewed.lease.leaseId)?.sourceIp,
      '198.51.100.12',
      'ops-authorized lease inventory retains the server-observed sourceIp'
    );
  } finally {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  }

  await assert.rejects(
    controller.enrollLease(
      undefined,
      {
        ...body,
        installId: 'inst_controller_spoof',
        deviceId: 'dev_controller_spoof',
        publicKey: 'controller-spoof-public-key',
        anonymousRenewalLeaseId: renewed.lease.leaseId
      },
      undefined,
      undefined,
      '198.51.100.13'
    ),
    forbiddenPolicyError('launcher_anonymous_enrollment_draining')
  );
});

test('legacy anonymous enrollment endpoint uses the same product policy gate', async () => {
  const store = new MemoryStore(config);
  const controller = new EnrollmentsController(store);
  store.upsertLauncherProductNetwork({
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: 'disabled',
    requestedBy: 'anonymous-policy-test'
  });

  await assert.rejects(
    controller.enrollAnonymous({
      productId: 'mx-h2i',
      sourceIp: '203.0.113.250'
    }, '198.51.100.21'),
    forbiddenPolicyError('launcher_anonymous_enrollment_disabled')
  );
});

test('lease builder persists app attribution and server-provided source IP', () => {
  const product = requiredProduct(new MemoryStore(config), 'mx-h2i');
  const lease = buildLauncherNetworkLease(
    config,
    {
      ...anonymousInput('builder-metadata'),
      appId: 'mx-h2i',
      sourceIp: '192.0.2.45'
    },
    product,
    1,
    null
  );

  assert.equal(lease.appId, 'mx-h2i');
  assert.equal(lease.sourceIp, '192.0.2.45');
});

function anonymousInput(suffix: string): LauncherNetworkLeaseInput {
  return {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: `inst_${suffix}`,
    deviceId: `dev_${suffix}`,
    publicKey: `public-key-${suffix}`,
    requestedBy: 'anonymous-policy-test'
  };
}

function userInput(suffix: string, userId: string): LauncherNetworkLeaseInput {
  return {
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'user',
    installId: `inst_${suffix}`,
    deviceId: `dev_${suffix}`,
    userId,
    publicKey: `public-key-${suffix}`,
    requestedBy: 'anonymous-policy-test'
  };
}

function requiredProduct(store: MemoryStore, productId: string): LauncherProductNetwork {
  const product = store.getLauncherProductNetwork(productId);
  assert.ok(product, `missing product ${productId}`);
  return product;
}

function policyError(code: LauncherAnonymousEnrollmentPolicyError['code']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LauncherAnonymousEnrollmentPolicyError);
    assert.equal(error.code, code);
    return true;
  };
}

function forbiddenPolicyError(code: LauncherAnonymousEnrollmentPolicyError['code']) {
  return (error: unknown): boolean => {
    assert.equal(httpStatus(error), 403);
    const response = (error as { getResponse: () => unknown }).getResponse();
    assert.equal((response as { code?: string }).code, code);
    return true;
  };
}

function httpStatus(error: unknown): number | null {
  const getStatus = (error as { getStatus?: () => number } | null)?.getStatus;
  return typeof getStatus === 'function' ? getStatus.call(error) : null;
}
