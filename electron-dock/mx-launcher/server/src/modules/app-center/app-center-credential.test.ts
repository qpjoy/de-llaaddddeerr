import assert from 'node:assert/strict';
import test from 'node:test';

import type { HttpException } from '@nestjs/common';

import { loadConfig } from '../../config.js';
import {
  appReleasePublisherServiceAccountId,
  createSdkGatewayManifest,
  createUserCenterServiceAccount
} from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import type { UserCenterServiceAccountCredential } from '../../types.js';
import { AppCenterController } from './app-center.controller.js';

test('App creation issues one product-scoped Publisher credential and idempotent updates do not reveal it', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  const controller = new AppCenterController(store);
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  const opsToken = 'app-center-credential-test-ops-token';
  process.env.MX_INTERNAL_OPS_TOKEN = opsToken;

  try {
    await assert.rejects(
      controller.upsertApp('luopan', undefined, { displayName: 'Luopan' }),
      (error) => statusOf(error) === 401
    );

    const created = await controller.upsertApp('luopan', opsToken, {
      displayName: 'Luopan',
      enabled: true,
      requestedBy: 'test'
    });
    assert.ok(created.publisher);
    assert.equal(created.publisher.serviceAccount.serviceAccountId, 'svc_luopan_release_publisher');
    assert.deepEqual(created.publisher.serviceAccount.roleIds, ['mx-release-publisher']);
    assert.deepEqual(created.publisher.serviceAccount.allowedProductIds, ['luopan']);
    assert.deepEqual(created.publisher.serviceAccount.scopes, ['sdk.release.read', 'sdk.release.publish']);
    const oneTimeSecret = created.publisher.credential?.clientSecret ?? '';
    assert.match(oneTimeSecret, /^mxsa1\.[A-Za-z0-9_-]{43}$/);
    const persistedCredential = (
      store as unknown as {
        serviceAccountCredentials: Map<string, UserCenterServiceAccountCredential>;
      }
    ).serviceAccountCredentials.get(created.publisher.serviceAccount.serviceAccountId);
    assert.ok(persistedCredential);
    assert.equal(JSON.stringify(persistedCredential).includes(oneTimeSecret), false);
    const issuedToken = await store.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: created.publisher.serviceAccount.serviceAccountId
    });
    const introspection = await store.introspectToken({ token: issuedToken.token });
    assert.deepEqual(introspection.scopes.sort(), ['sdk.release.publish', 'sdk.release.read']);

    const updated = await controller.upsertApp('luopan', opsToken, {
      displayName: 'Luopan v2',
      enabled: true,
      requestedBy: 'test'
    });
    assert.ok(updated.publisher);
    assert.equal(updated.publisher.credential, null);

    const statuses = await store.listUserCenterServiceAccountCredentialStatuses();
    const serialized = JSON.stringify(statuses);
    assert.equal(serialized.includes('clientSecret'), false);
    assert.equal(serialized.includes('Hash'), false);
    assert.equal(
      JSON.stringify((store as unknown as { auditEvents: unknown[] }).auditEvents).includes(oneTimeSecret),
      false
    );
  } finally {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  }
});

test('AppCenter rejects duplicate package identities before issuing a Publisher', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  const controller = new AppCenterController(store);
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  const opsToken = 'app-center-package-identity-test-ops-token';
  process.env.MX_INTERNAL_OPS_TOKEN = opsToken;

  try {
    await controller.upsertApp('package-owner', opsToken, {
      displayName: 'Package Owner',
      packageName: '@example/shared-package'
    });
    await assert.rejects(
      controller.upsertApp('package-collision', opsToken, {
        displayName: 'Package Collision',
        packageName: '@example/shared-package'
      }),
      (error) => statusOf(error) === 409
    );
    assert.equal(await store.getAppCenterApp('package-collision'), null);
    assert.equal(
      (await store.listUserCenterServiceAccounts())
        .some((item) => item.serviceAccountId === 'svc_package-collision_release_publisher'),
      false
    );
  } finally {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  }
});

test('Service-account credential rotation invalidates the old secret', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  await store.createUserCenterServiceAccount({
    serviceAccountId: 'svc_rotation_test',
    scopes: ['sdk.release.read'],
    allowedProductIds: ['rotation-test']
  });
  const first = await store.issueUserCenterServiceAccountCredential({
    serviceAccountId: 'svc_rotation_test',
    requestedBy: 'test'
  });
  const oldToken = await store.issueUserCenterToken({
    subjectKind: 'service-account',
    subjectId: 'svc_rotation_test',
    serviceAccountClientSecret: first.clientSecret,
    serviceAccountCredentialVersion: first.credential.version
  });
  const rotated = await store.issueUserCenterServiceAccountCredential({
    serviceAccountId: 'svc_rotation_test',
    requestedBy: 'test',
    rotate: true
  });

  assert.equal((await store.verifyUserCenterServiceAccountCredential({
    serviceAccountId: 'svc_rotation_test',
    clientSecret: first.clientSecret
  })).ok, false);
  assert.equal((await store.verifyUserCenterServiceAccountCredential({
    serviceAccountId: 'svc_rotation_test',
    clientSecret: rotated.clientSecret
  })).ok, true);
  assert.equal(rotated.credential.version, 2);
  assert.equal((await store.introspectToken({ token: oldToken.token })).active, false);
  assert.throws(
    () => store.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: 'svc_rotation_test',
      serviceAccountClientSecret: first.clientSecret,
      serviceAccountCredentialVersion: first.credential.version
    }),
    /credential changed during authentication/
  );
  assert.match((await store.issueUserCenterToken({
    subjectKind: 'service-account',
    subjectId: 'svc_rotation_test',
    serviceAccountClientSecret: rotated.clientSecret,
    serviceAccountCredentialVersion: rotated.credential.version
  })).token, /^mx-v1-/);
});

test('Legacy credential import is idempotent and never replaces a database credential', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  await store.createUserCenterServiceAccount({
    serviceAccountId: 'svc_legacy_test',
    scopes: ['sdk.release.read'],
    allowedProductIds: ['legacy-test']
  });
  const legacySecret = 'legacy-service-account-secret-with-32-characters';
  const imported = await store.importLegacyUserCenterServiceAccountCredential({
    serviceAccountId: 'svc_legacy_test',
    clientSecret: legacySecret,
    requestedBy: 'test'
  });
  const preserved = await store.importLegacyUserCenterServiceAccountCredential({
    serviceAccountId: 'svc_legacy_test',
    clientSecret: 'different-legacy-secret-with-32-characters',
    requestedBy: 'test'
  });

  assert.equal(imported.outcome, 'imported');
  assert.equal(preserved.outcome, 'preserved');
  assert.equal((await store.verifyUserCenterServiceAccountCredential({
    serviceAccountId: 'svc_legacy_test',
    clientSecret: legacySecret
  })).ok, true);
});

test('Legacy import rejects stale account IDs instead of pre-seeding future credentials', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  assert.throws(
    () => store.importLegacyUserCenterServiceAccountCredential({
      serviceAccountId: 'svc_stale_legacy_entry',
      clientSecret: 'stale-legacy-secret-with-at-least-32-characters',
      requestedBy: 'test'
    }),
    /Service account not found/
  );
  await store.createUserCenterServiceAccount({
    serviceAccountId: 'svc_stale_legacy_entry',
    scopes: ['sdk.release.read'],
    allowedProductIds: ['stale-test']
  });
  assert.equal(
    await store.getUserCenterServiceAccountCredential('svc_stale_legacy_entry'),
    null
  );
});

test('Legacy K8s JSON is imported automatically on startup without exposing it in account metadata', async () => {
  const previous = process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON;
  const legacySecret = 'legacy-sdk-gateway-secret-with-32-characters';
  process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON = JSON.stringify({
    svc_sdk_gateway: legacySecret
  });
  try {
    const store = new MemoryStore(loadConfig());
    await store.bootstrapUserCenter();
    assert.equal((await store.verifyUserCenterServiceAccountCredential({
      serviceAccountId: 'svc_sdk_gateway',
      clientSecret: legacySecret
    })).ok, true);
    assert.equal(JSON.stringify(await store.listUserCenterServiceAccounts()).includes(legacySecret), false);
  } finally {
    if (previous === undefined) delete process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON;
    else process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON = previous;
  }
});

test('An unbound historical account cannot be adopted as an application Publisher', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  const appId = 'publisher-collision-test';
  const serviceAccountId = appReleasePublisherServiceAccountId(appId);
  await store.createUserCenterServiceAccount({
    serviceAccountId,
    roleIds: ['mx-service-account'],
    scopes: ['sdk.user.write'],
    allowedProductIds: []
  });
  const oldCredential = await store.issueUserCenterServiceAccountCredential({
    serviceAccountId,
    requestedBy: 'historical-test'
  });
  const controller = new AppCenterController(store);
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  const opsToken = 'publisher-collision-test-ops-token';
  process.env.MX_INTERNAL_OPS_TOKEN = opsToken;
  try {
    await assert.rejects(
      controller.upsertApp(appId, opsToken, {
        displayName: 'Collision Test',
        enabled: true
      }),
      (error) => statusOf(error) === 409
    );
    assert.equal(await store.getAppCenterApp(appId), null);
    const account = (await store.listUserCenterServiceAccounts())
      .find((item) => item.serviceAccountId === serviceAccountId);
    assert.deepEqual(account?.roleIds, ['mx-service-account']);
    assert.deepEqual(account?.scopes, ['sdk.user.write']);
    assert.deepEqual(account?.allowedProductIds, []);
    assert.equal((await store.verifyUserCenterServiceAccountCredential({
      serviceAccountId,
      clientSecret: oldCredential.clientSecret
    })).ok, true);
  } finally {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  }
});

test('Deleting an application revokes its Publisher and recreation issues a new secret', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  const controller = new AppCenterController(store);
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  const opsToken = 'publisher-delete-test-ops-token';
  process.env.MX_INTERNAL_OPS_TOKEN = opsToken;
  try {
    const created = await controller.upsertApp('publisher-delete-test', opsToken, {
      displayName: 'Publisher Delete Test',
      enabled: true
    });
    const serviceAccountId = created.publisher?.serviceAccount.serviceAccountId ?? '';
    const oldSecret = created.publisher?.credential?.clientSecret ?? '';
    const oldToken = await store.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: serviceAccountId
    });

    assert.deepEqual(await controller.deleteApp('publisher-delete-test', opsToken), { deleted: true });
    assert.equal((await store.verifyUserCenterServiceAccountCredential({
      serviceAccountId,
      clientSecret: oldSecret
    })).reason, 'service-account-disabled');
    assert.equal((await store.introspectToken({ token: oldToken.token })).active, false);

    const recreated = await controller.upsertApp('publisher-delete-test', opsToken, {
      displayName: 'Publisher Delete Test',
      enabled: true
    });
    const newSecret = recreated.publisher?.credential?.clientSecret ?? '';
    assert.match(newSecret, /^mxsa1\./);
    assert.notEqual(newSecret, oldSecret);
    assert.equal((await store.verifyUserCenterServiceAccountCredential({
      serviceAccountId,
      clientSecret: oldSecret
    })).ok, false);
    assert.equal((await store.verifyUserCenterServiceAccountCredential({
      serviceAccountId,
      clientSecret: newSecret
    })).ok, true);
    assert.equal((await store.introspectToken({ token: oldToken.token })).active, false);
  } finally {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  }
});

test('Disabling an application pauses its Publisher without reviving old tokens', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  const controller = new AppCenterController(store);
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  const opsToken = 'publisher-disable-test-ops-token';
  process.env.MX_INTERNAL_OPS_TOKEN = opsToken;
  try {
    const created = await controller.upsertApp('publisher-disable-test', opsToken, {
      displayName: 'Publisher Disable Test',
      enabled: true
    });
    const serviceAccountId = created.publisher?.serviceAccount.serviceAccountId ?? '';
    const clientSecret = created.publisher?.credential?.clientSecret ?? '';
    const oldToken = await store.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: serviceAccountId,
      serviceAccountClientSecret: clientSecret
    });

    const disabled = await controller.upsertApp('publisher-disable-test', opsToken, {
      displayName: 'Publisher Disable Test',
      enabled: false
    });
    assert.equal(disabled.publisher, null);
    assert.equal((await store.introspectToken({ token: oldToken.token })).active, false);
    assert.equal((await store.verifyUserCenterServiceAccountCredential({
      serviceAccountId,
      clientSecret
    })).reason, 'service-account-disabled');

    const reenabled = await controller.upsertApp('publisher-disable-test', opsToken, {
      displayName: 'Publisher Disable Test',
      enabled: true
    });
    assert.equal(reenabled.publisher?.credential, null);
    assert.equal((await store.verifyUserCenterServiceAccountCredential({
      serviceAccountId,
      clientSecret
    })).ok, true);
    assert.equal((await store.introspectToken({ token: oldToken.token })).active, false);
  } finally {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  }
});

test('Publisher IDs are collision-resistant and ops-only credential routes stay outside SDK discovery', () => {
  assert.equal(
    appReleasePublisherServiceAccountId('mx-h2i'),
    'svc_mx-h2i_release_publisher'
  );
  assert.notEqual(
    appReleasePublisherServiceAccountId('foo-bar'),
    appReleasePublisherServiceAccountId('foo_bar')
  );
  const longAppId = 'long-app-' + 'x'.repeat(300);
  const first = appReleasePublisherServiceAccountId(longAppId);
  assert.equal(first, appReleasePublisherServiceAccountId(longAppId));
  assert.ok(first.length <= 160);

  const manifest = createSdkGatewayManifest(loadConfig());
  assert.equal(
    manifest.routes.some((route) => route.routeId.startsWith('sdk.service_accounts.')),
    false
  );
});

test('Service-account IDs are explicit and follow the deploy contract', () => {
  assert.throws(
    () => createUserCenterServiceAccount({}),
    /serviceAccountId is required/
  );
  assert.throws(
    () => createUserCenterServiceAccount({ serviceAccountId: 'invalid account id' }),
    /serviceAccountId must be 1-160 characters/
  );
  assert.throws(
    () => createUserCenterServiceAccount({ serviceAccountId: 's'.repeat(161) }),
    /serviceAccountId must be 1-160 characters/
  );
  assert.equal(
    createUserCenterServiceAccount({ serviceAccountId: 'svc.valid-name:1' }).serviceAccountId,
    'svc.valid-name:1'
  );
});

function statusOf(error: unknown): number | null {
  return typeof (error as HttpException)?.getStatus === 'function'
    ? (error as HttpException).getStatus()
    : null;
}
