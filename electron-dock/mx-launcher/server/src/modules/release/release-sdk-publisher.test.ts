import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { HttpException } from '@nestjs/common';

import { evaluateSdkGatewayRoute } from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import type { PlatformStore, PublisherReleasePlanInput } from '../../store/platform-store.js';
import type {
  PlatformPrincipal,
  ReleaseManagementGateInput,
  ReleaseManagementPlan,
  ReleaseManagementPlanInput,
  RuntimeConfig,
  TokenIntrospectionResult,
  UserCenterServiceAccount
} from '../../types.js';
import { ReleaseController } from './release.controller.js';
import { evaluateReleaseCheck } from './release-check.js';

const publisherPrincipal = servicePrincipal('svc_release_luopan', ['sdk.release.read', 'sdk.release.publish']);
const approverPrincipal = servicePrincipal('svc_release_luopan_approver', ['sdk.release.read', 'sdk.release.approve']);
const otherPrincipal = servicePrincipal('svc_release_other', ['sdk.release.publish']);

test('SDK Gateway route manifest scope evaluation recognizes release publisher actions', () => {
  assert.equal(evaluateSdkGatewayRoute(publisherPrincipal, 'sdk.releases.create').allowed, true);
  assert.equal(evaluateSdkGatewayRoute(publisherPrincipal, 'sdk.releases.gate').allowed, false);
  assert.deepEqual(
    evaluateSdkGatewayRoute(publisherPrincipal, 'sdk.releases.gate').missingScopes,
    ['sdk.release.approve', 'release.manage']
  );
  assert.equal(evaluateSdkGatewayRoute(approverPrincipal, 'sdk.releases.gate').allowed, true);
});

test('release checks bind external callers to productId and ignore planned no-op components', () => {
  const luopanPlan = releasePlan('luopan', 'sha256:abc');
  const otherPlan = releasePlan('other', 'sha256:def');
  luopanPlan.rollout.percentage = 100;
  otherPlan.rollout.percentage = 100;
  otherPlan.releaseId = 'other-release-0.2.0';
  otherPlan.components.launcher.componentId = 'luopan';
  const decision = evaluateReleaseCheck([otherPlan, luopanPlan], {
    installId: 'install_luopan',
    productId: 'luopan',
    channel: 'shadow',
    components: { luopan: '0.1.0' }
  });
  assert.equal(decision.releaseId, luopanPlan.releaseId);
  assert.equal(decision.decision?.componentId, 'luopan');

  const noOp = evaluateReleaseCheck([luopanPlan], {
    installId: 'install_luopan',
    productId: 'luopan',
    channel: 'shadow',
    components: { 'luopan-config': '0.0.1' }
  });
  assert.equal(noOp.status, 'up-to-date');
});

test('release checks let new clients select ASAR without changing legacy installer matching', () => {
  const installerPlan = releasePlan('mx-h2i', 'sha256:installer');
  installerPlan.releaseId = 'mx-h2i-installer-2.1.2';
  installerPlan.createdAt = '2026-07-28T01:00:00.000Z';
  installerPlan.rollout.percentage = 100;
  const asarPlan = releasePlan('mx-h2i', 'sha256:asar', {
    releaseId: 'mx-h2i-asar-2.1.3',
    launcherUpdatePolicy: 'app-asar',
    launcherCurrentVersion: '2.1.2',
    launcherTargetVersion: '2.1.3',
    artifactKind: 'app-asar',
    artifactPlatform: 'darwin',
    artifactArch: 'arm64',
    artifactFileName: 'MX-H2I-2.1.3-darwin-arm64-app.asar'
  });
  asarPlan.createdAt = '2026-07-28T02:00:00.000Z';
  asarPlan.rollout.percentage = 100;
  asarPlan.deliveryMode = 'silent-download-next-start';

  const selectedAsar = evaluateReleaseCheck([installerPlan, asarPlan], {
    installId: 'install_h2i',
    productId: 'mx-h2i',
    channel: 'shadow',
    platform: 'darwin',
    arch: 'arm64',
    artifactKinds: ['app-asar'],
    components: { 'mx-h2i': '2.1.2' }
  });
  assert.equal(selectedAsar.releaseId, 'mx-h2i-asar-2.1.3');
  assert.equal(selectedAsar.artifacts[0]?.kind, 'app-asar');
  assert.equal(selectedAsar.deliveryMode, 'silent-download-next-start');

  const legacySelection = evaluateReleaseCheck([installerPlan, asarPlan], {
    installId: 'install_h2i',
    productId: 'mx-h2i',
    channel: 'shadow',
    platform: 'darwin',
    arch: 'arm64',
    components: { 'mx-h2i': '2.1.2' }
  });
  assert.equal(legacySelection.releaseId, 'mx-h2i-asar-2.1.3');
});

test('release plan metadata can be edited without changing artifact identity', () => {
  const store = new MemoryStore(testRuntimeConfig());
  const plan = store.createReleaseManagementPlan({
    releaseId: 'luopan-asar-0.1.2',
    productId: 'luopan',
    appId: 'luopan',
    channel: 'shadow',
    launcherComponentId: 'luopan',
    launcherUpdatePolicy: 'app-asar',
    launcherCurrentVersion: '0.1.1',
    launcherTargetVersion: '0.1.2',
    artifactKind: 'app-asar',
    artifactVersion: '0.1.2',
    artifactUrl: '/artifact/luopan.asar',
    artifactDigest: 'sha256:immutable',
    artifactPlatform: 'darwin',
    artifactArch: 'arm64',
    artifactFileName: 'Luopan-0.1.2-darwin-arm64-app.asar',
    activationMode: 'restart-auto',
    e2eResult: 'passed'
  });
  const artifactBefore = structuredClone(plan.artifacts);
  const updated = store.updateReleaseManagementPlan(plan.planId, {
    releaseNotes: 'Updated notes',
    deliveryMode: 'silent-download-next-start',
    rolloutStrategy: 'all',
    rolloutPercentage: 100,
    targetUserIds: ['usr_canary'],
    updatedBy: 'desktop-admin'
  });
  assert.equal(updated.releaseNotes, 'Updated notes');
  assert.equal(updated.deliveryMode, 'silent-download-next-start');
  assert.equal(updated.rollout.percentage, 100);
  assert.deepEqual(updated.rollout.audience.userIds, ['usr_canary']);
  assert.deepEqual(updated.artifacts, artifactBefore);
  assert.equal(updated.updatedBy, 'desktop-admin');
});

test('release product identity resolves by package name without changing network identity', async () => {
  const store = new MemoryStore(testRuntimeConfig());
  store.upsertAppCenterApp({
    appId: 'other-desktop',
    packageName: '@example/other-desktop',
    launcherMode: 'embed',
    productNetworkId: 'shared-network',
    channels: ['beta', 'stable']
  });
  const controller = new ReleaseController(store);

  const resolved = await controller.resolveReleaseProduct('@example/other-desktop', 'beta');
  assert.deepEqual(resolved.identity, {
    appId: 'other-desktop',
    productId: 'other-desktop',
    packageName: '@example/other-desktop',
    launcherMode: 'embed',
    networkProductId: 'shared-network',
    componentId: 'other-desktop',
    rendererComponentId: 'other-desktop-renderer',
    channel: 'beta',
    channels: ['beta', 'stable']
  });
});

test('release product identity supports the historical Luopan row and fails closed on ambiguity', async () => {
  const store = new MemoryStore(testRuntimeConfig());
  store.upsertAppCenterApp({
    appId: 'luopan',
    packageName: null,
    launcherMode: 'standalone',
    channels: ['shadow', 'stable']
  });
  const controller = new ReleaseController(store);

  assert.equal(
    (await controller.resolveReleaseProduct('@qpjoy/luopan-demo', 'shadow')).identity.productId,
    'luopan'
  );

  store.upsertAppCenterApp({
    appId: 'luopan-copy',
    packageName: '@qpjoy/luopan-demo',
    channels: ['shadow']
  });
  await assert.rejects(
    controller.resolveReleaseProduct('@qpjoy/luopan-demo', 'shadow'),
    (error) => statusOf(error) === 409
  );
});

test('Publisher-owned test runs reject generic steps but remain completable through the release gate', () => {
  const store = new MemoryStore(testRuntimeConfig());
  const created = store.createPublisherReleaseManagementPlan({
    releaseId: 'luopan-installer-0.2.0',
    productId: 'luopan',
    appId: 'luopan',
    channel: 'shadow',
    launcherComponentId: 'luopan',
    launcherUpdatePolicy: 'app-installer',
    launcherCurrentVersion: '0.1.0',
    launcherTargetVersion: '0.2.0',
    appComponentId: 'luopan-config',
    appUpdatePolicy: 'config-snapshot',
    appCurrentVersion: '0.1.0',
    appTargetVersion: '0.1.0',
    artifactKind: 'app-installer',
    artifactVersion: '0.2.0',
    artifactUrl: '/artifact',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    e2eResult: 'running',
    requestId: 'luopan-memory-plan-001',
    publisherRequestFingerprint: `sha256:${'b'.repeat(64)}`
  } as PublisherReleasePlanInput);
  assert.equal(created.outcome, 'created');
  if (created.outcome !== 'created') throw new Error('expected Publisher plan creation');
  assert.throws(
    () => store.recordTestStep(created.plan.test.run.testRunId, {
      caseId: 'bypass',
      status: 'passed'
    }),
    /release gate endpoint/
  );
  const completed = store.completeReleaseManagementGate(created.plan.planId, {
    status: 'passed',
    requestId: 'luopan-memory-gate-001'
  });
  assert.equal(completed.test.gate.verdict, 'passed');
});

test('SDK release upload requires publish scope and product binding', async () => {
  const harness = controllerHarness();
  await assert.rejects(
    harness.controller.uploadSdkArtifact(undefined, artifactRequest('payload'), artifactQuery()),
    (error) => statusOf(error) === 401
  );
  await assert.rejects(
    harness.controller.uploadSdkArtifact('Bearer read-token', artifactRequest('payload'), artifactQuery()),
    (error) => statusOf(error) === 403
  );
  await assert.rejects(
    harness.controller.uploadSdkArtifact('Bearer other-token', artifactRequest('payload'), artifactQuery()),
    (error) => statusOf(error) === 403
  );
  await assert.rejects(
    harness.controller.uploadSdkArtifact('Bearer stale-publisher-token', artifactRequest('payload'), artifactQuery()),
    (error) => statusOf(error) === 403
  );
  await assert.rejects(
    harness.controller.uploadSdkArtifact(
      'Bearer publisher-token',
      artifactRequest('payload'),
      { ...artifactQuery(), digest: 'not-a-sha256-digest' }
    ),
    (error) => statusOf(error) === 400
  );
  await assert.rejects(
    harness.controller.uploadSdkArtifact(
      'Bearer publisher-token',
      artifactRequest('payload'),
      { ...artifactQuery(), componentId: 'luopan-enterprise' }
    ),
    (error) => statusOf(error) === 403
  );
  const collisionHarness = controllerHarness([], ['luopan', 'luopan-renderer']);
  await assert.rejects(
    collisionHarness.controller.uploadSdkArtifact(
      'Bearer publisher-token',
      artifactRequest('payload'),
      {
        ...artifactQuery(),
        kind: 'renderer-ui',
        componentId: 'luopan-renderer',
        fileName: 'luopan-renderer.zip'
      }
    ),
    (error) => statusOf(error) === 400
  );
  const configCollisionHarness = controllerHarness([], ['luopan', 'luopan-config']);
  await assert.rejects(
    configCollisionHarness.controller.uploadSdkArtifact(
      'Bearer publisher-token',
      artifactRequest('payload'),
      artifactQuery()
    ),
    (error) => statusOf(error) === 400
  );
  await assert.rejects(
    harness.controller.uploadSdkArtifact(
      'Bearer publisher-token',
      artifactRequest('payload'),
      { ...artifactQuery(), releaseId: 'luopan release 0.2.0' }
    ),
    (error) => statusOf(error) === 400
  );
  await assert.rejects(
    harness.controller.uploadSdkArtifact(
      'Bearer publisher-token',
      artifactRequest('payload'),
      { ...artifactQuery(), channel: 'shadow/canary' }
    ),
    (error) => statusOf(error) === 400
  );
});

test('SDK publisher accepts a product-scoped app-asar and derives restart-auto policy', async (t) => {
  const storeDir = await mkdtemp(join(tmpdir(), 'mx-release-sdk-asar-test-'));
  const previousStoreDir = process.env.MX_RELEASE_ARTIFACT_STORE_DIR;
  const previousStorage = process.env.MX_RELEASE_ARTIFACT_STORAGE;
  process.env.MX_RELEASE_ARTIFACT_STORE_DIR = storeDir;
  process.env.MX_RELEASE_ARTIFACT_STORAGE = 'server';
  t.after(async () => {
    if (previousStoreDir === undefined) delete process.env.MX_RELEASE_ARTIFACT_STORE_DIR;
    else process.env.MX_RELEASE_ARTIFACT_STORE_DIR = previousStoreDir;
    if (previousStorage === undefined) delete process.env.MX_RELEASE_ARTIFACT_STORAGE;
    else process.env.MX_RELEASE_ARTIFACT_STORAGE = previousStorage;
    await rm(storeDir, { recursive: true, force: true });
  });

  const payload = 'signed luopan app asar';
  const harness = controllerHarness();
  const uploaded = await harness.controller.uploadSdkArtifact(
    'Bearer publisher-token',
    artifactRequest(payload),
    {
      ...artifactQuery(payload),
      releaseId: 'luopan-asar-0.2.0',
      kind: 'app-asar',
      fileName: 'Luopan-0.2.0-darwin-arm64-app.asar'
    }
  );
  const created = await harness.controller.createSdkManagementPlan('Bearer publisher-token', {
    artifactId: uploaded.artifact.artifactId,
    currentVersion: '0.1.0',
    requestId: 'luopan-asar-release-001'
  });
  assert.equal(uploaded.artifact.kind, 'app-asar');
  assert.equal(harness.createInputs[0]?.launcherUpdatePolicy, 'app-asar');
  assert.equal(harness.createInputs[0]?.activationMode, 'restart-auto');
  assert.equal(created.plan.artifacts[0]?.kind, 'app-asar');
});

test('SDK release plan derives artifact identity, actor, and a pending blocked gate from uploaded metadata', async (t) => {
  const storeDir = await mkdtemp(join(tmpdir(), 'mx-release-sdk-test-'));
  const previousStoreDir = process.env.MX_RELEASE_ARTIFACT_STORE_DIR;
  const previousStorage = process.env.MX_RELEASE_ARTIFACT_STORAGE;
  process.env.MX_RELEASE_ARTIFACT_STORE_DIR = storeDir;
  process.env.MX_RELEASE_ARTIFACT_STORAGE = 'server';
  t.after(async () => {
    if (previousStoreDir === undefined) delete process.env.MX_RELEASE_ARTIFACT_STORE_DIR;
    else process.env.MX_RELEASE_ARTIFACT_STORE_DIR = previousStoreDir;
    if (previousStorage === undefined) delete process.env.MX_RELEASE_ARTIFACT_STORAGE;
    else process.env.MX_RELEASE_ARTIFACT_STORAGE = previousStorage;
    await rm(storeDir, { recursive: true, force: true });
  });

  const harness = controllerHarness();
  const rendererPayload = 'signed luopan renderer bundle';
  const rendererQuery = {
    ...artifactQuery(rendererPayload),
    releaseId: 'luopan-renderer-0.2.0',
    kind: 'renderer-ui',
    fileName: 'luopan-renderer-0.2.0.zip'
  };
  await assert.rejects(
    harness.controller.uploadSdkArtifact(
      'Bearer publisher-token',
      artifactRequest(rendererPayload),
      rendererQuery
    ),
    (error) => statusOf(error) === 403
  );
  const uploadedRenderer = await harness.controller.uploadSdkArtifact(
    'Bearer publisher-token',
    artifactRequest(rendererPayload),
    { ...rendererQuery, componentId: 'luopan-renderer' }
  );
  assert.equal(uploadedRenderer.artifact.componentId, 'luopan-renderer');
  assert.equal(uploadedRenderer.artifact.kind, 'renderer-ui');

  const legacyMismatched = await harness.controller.uploadArtifact(
    artifactRequest('legacy cross-product artifact'),
    {
      ...artifactQuery('legacy cross-product artifact'),
      releaseId: 'legacy-luopan-mismatch',
      componentId: 'mx-h2i'
    },
    true
  );
  await assert.rejects(
    harness.controller.createSdkManagementPlan('Bearer publisher-token', {
      artifactId: legacyMismatched.artifact.artifactId,
      currentVersion: '0.1.0',
      requestId: 'legacy-mismatch-plan'
    }),
    (error) => statusOf(error) === 403
  );

  const payload = 'signed luopan installer';
  const uploaded = await harness.controller.uploadSdkArtifact(
    'Bearer publisher-token',
    artifactRequest(payload),
    artifactQuery(payload)
  );

  await assert.rejects(
    harness.controller.createSdkManagementPlan('Bearer publisher-token', {
      artifactId: uploaded.artifact.artifactId,
      currentVersion: '0.1.0',
      artifactUrl: 'https://attacker.invalid/luopan.dmg'
    }),
    (error) => statusOf(error) === 400
  );

  const created = await harness.controller.createSdkManagementPlan('Bearer publisher-token', {
    artifactId: uploaded.artifact.artifactId,
    currentVersion: '0.1.0',
    productId: 'luopan',
    channel: 'shadow',
    rolloutPercentage: 10,
    targetInstallIds: ['install_canary'],
    createdBy: undefined,
    requestId: 'luopan-release-001'
  });

  assert.equal(created.idempotent, false);
  assert.equal(created.plan.test.gate.verdict, 'blocked');
  assert.equal(harness.createInputs.length, 1);
  assert.match(harness.createInputs[0].publisherRequestFingerprint ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual({ ...harness.createInputs[0], publisherRequestFingerprint: undefined }, {
    releaseId: 'luopan-installer-0.2.0',
    channel: 'shadow',
    installId: null,
    userId: null,
    productId: 'luopan',
    appId: 'luopan',
    launcherComponentId: 'luopan',
    appComponentId: 'luopan-config',
    launcherUpdatePolicy: 'app-installer',
    appUpdatePolicy: 'config-snapshot',
    launcherCurrentVersion: '0.1.0',
    launcherTargetVersion: '0.2.0',
    appCurrentVersion: '0.1.0',
    appTargetVersion: '0.1.0',
    artifactKind: 'app-installer',
    artifactVersion: '0.2.0',
    artifactUrl: uploaded.artifact.url,
    artifactDigest: uploaded.artifact.digest,
    artifactSignature: null,
    artifactSizeBytes: Buffer.byteLength(payload),
    artifactPlatform: 'darwin',
    artifactArch: 'arm64',
    artifactFileName: 'luopan-0.2.0.dmg',
    activationMode: 'installer-manual',
    rolloutStrategy: null,
    rolloutPercentage: 10,
    rolloutSegment: null,
    rolloutRings: [],
    featureKeys: [],
    targetUserIds: [],
    targetInstallIds: ['install_canary'],
    releaseNotes: null,
    deliveryMode: null,
    suiteId: null,
    topology: null,
    sites: [],
    e2eResult: 'running',
    createdBy: publisherPrincipal.principalId,
    requestId: 'luopan-release-001',
    publisherRequestFingerprint: undefined
  });

  const retried = await harness.controller.createSdkManagementPlan('Bearer publisher-token', {
    artifactId: uploaded.artifact.artifactId,
    currentVersion: '0.1.0',
    productId: 'luopan',
    channel: 'shadow',
    rolloutPercentage: 10,
    targetInstallIds: ['install_canary'],
    requestId: 'luopan-release-001'
  });
  assert.equal(retried.idempotent, true);
  assert.equal(retried.plan.planId, created.plan.planId);
  assert.equal(harness.createInputs.length, 1);

  await assert.rejects(
    harness.controller.createSdkManagementPlan('Bearer publisher-token', {
      artifactId: uploaded.artifact.artifactId,
      currentVersion: '0.1.0',
      productId: 'luopan',
      channel: 'shadow',
      rolloutPercentage: 10,
      installId: 'install_other',
      targetInstallIds: ['install_canary'],
      requestId: 'luopan-release-001'
    }),
    (error) => statusOf(error) === 400
  );

  const concurrentBody = {
    artifactId: uploaded.artifact.artifactId,
    currentVersion: '0.1.0',
    productId: 'luopan',
    channel: 'shadow',
    rolloutPercentage: 10,
    targetInstallIds: ['install_canary'],
    requestId: 'luopan-release-002'
  };
  const concurrent = await Promise.all([
    harness.controller.createSdkManagementPlan('Bearer publisher-token', concurrentBody),
    harness.controller.createSdkManagementPlan('Bearer publisher-token', concurrentBody)
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.idempotent).sort(),
    [false, true]
  );
  assert.equal(harness.createInputs.length, 2);
});

test('SDK release gate requires separate approval scope and records the authenticated actor', async () => {
  const harness = controllerHarness([releasePlan('luopan', 'sha256:abc')]);
  await assert.rejects(
    harness.controller.completeSdkManagementGate('Bearer publisher-token', 'relplan_test', { status: 'passed' }),
    (error) => statusOf(error) === 403
  );
  await assert.rejects(
    harness.controller.completeSdkManagementGate('Bearer approver-token', 'relplan_test', { status: 'passed' }),
    (error) => statusOf(error) === 400
  );
  await assert.rejects(
    harness.controller.completeSdkManagementGate(
      'Bearer approver-token',
      'relplan_test',
      {
        status: 'passed',
        requestId: 'approve-sensitive-001',
        evidence: { accessToken: 'must-not-be-persisted' }
      }
    ),
    (error) => statusOf(error) === 400
  );
  const result = await harness.controller.completeSdkManagementGate(
    'Bearer approver-token',
    'relplan_test',
    {
      status: 'passed',
      requestedBy: 'spoofed',
      requestId: 'approve-001',
      evidence: { smoke: 'passed' }
    }
  );
  assert.equal(result.plan.test.gate.verdict, 'passed');
  assert.deepEqual(harness.gateInputs, [{
    status: 'passed',
    message: null,
    evidence: { smoke: 'passed' },
    requestedBy: approverPrincipal.principalId,
    requestId: 'approve-001'
  }]);
  const replayed = await harness.controller.completeSdkManagementGate(
    'Bearer approver-token',
    'relplan_test',
    {
      status: 'passed',
      requestId: 'approve-001'
    }
  );
  assert.equal(replayed.plan.test.gate.verdict, 'passed');
  assert.equal(harness.gateInputs.length, 1);
  await assert.rejects(
    harness.controller.completeSdkManagementGate(
      'Bearer approver-token',
      'relplan_test',
      {
        status: 'failed',
        requestId: 'approve-002'
      }
    ),
    (error) => statusOf(error) === 400
  );
});

test('legacy Release Center management writes require the Internal ops token when configured', async (t) => {
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.MX_INTERNAL_OPS_TOKEN = 'release-admin-test-token-000000000000';
  t.after(() => {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  const harness = controllerHarness();
  await assert.rejects(
    harness.controller.createManagementPlan(requestWithHeaders({}), {
      releaseId: 'legacy-without-auth'
    }),
    (error) => statusOf(error) === 401
  );
  const result = await harness.controller.createManagementPlan(requestWithHeaders({
    'x-mx-ops-token': process.env.MX_INTERNAL_OPS_TOKEN
  }), {
    releaseId: 'legacy-with-auth',
    productId: 'luopan'
  });
  assert.equal(result.plan.releaseId, 'legacy-with-auth');

  delete process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.NODE_ENV = 'production';
  await assert.rejects(
    harness.controller.createManagementPlan(requestWithHeaders({}), {
      releaseId: 'legacy-production-without-auth'
    }),
    (error) => statusOf(error) === 503
  );
});

function controllerHarness(
  initialPlans: ReleaseManagementPlan[] = [],
  registeredProductIds: string[] = ['luopan']
): {
  controller: ReleaseController;
  createInputs: ReleaseManagementPlanInput[];
  gateInputs: ReleaseManagementGateInput[];
} {
  const plans = [...initialPlans];
  const createInputs: ReleaseManagementPlanInput[] = [];
  const gateInputs: ReleaseManagementGateInput[] = [];
  const store = {
    introspectToken: async ({ token }: { token?: string | null }) => tokenAuth(token ?? ''),
    listUserCenterServiceAccounts: async () => serviceAccounts(),
    getAppCenterApp: async (appId: string) => registeredProductIds.includes(appId)
      ? { appId, enabled: true }
      : null,
    listReleaseManagementPlans: async () => [...plans],
    getReleaseManagementPlan: async (planId: string) => plans.find((plan) => plan.planId === planId) ?? null,
    createPublisherReleaseManagementPlan: async (input: ReleaseManagementPlanInput) => {
      const existing = plans.find((plan) => (
        plan.productId === input.productId && plan.requestId === input.requestId
      ));
      if (existing) {
        return existing.publisherRequestFingerprint === input.publisherRequestFingerprint
          ? { outcome: 'replayed', plan: existing }
          : { outcome: 'conflict', planId: existing.planId };
      }
      createInputs.push(input);
      const plan = releasePlan(input.productId ?? 'unknown', input.artifactDigest ?? '', input);
      plans.push(plan);
      return { outcome: 'created', plan };
    },
    createReleaseManagementPlan: async (input: ReleaseManagementPlanInput) => {
      createInputs.push(input);
      const plan = releasePlan(input.productId ?? 'unknown', input.artifactDigest ?? '', input);
      plans.push(plan);
      return plan;
    },
    completeReleaseManagementGate: async (planId: string, input: ReleaseManagementGateInput) => {
      gateInputs.push(input);
      const index = plans.findIndex((plan) => plan.planId === planId);
      const plan = plans[index];
      const updated = {
        ...plan,
        test: {
          ...plan.test,
          gate: { ...plan.test.gate, verdict: input.status }
        }
      } as ReleaseManagementPlan;
      plans[index] = updated;
      return updated;
    }
  } as unknown as PlatformStore;
  return {
    controller: new ReleaseController(store),
    createInputs,
    gateInputs
  };
}

function artifactRequest(payload: string): IncomingMessage {
  const request = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
  request.headers = {
    'content-type': 'application/octet-stream',
    'content-length': String(Buffer.byteLength(payload))
  };
  return request;
}

function requestWithHeaders(headers: IncomingMessage['headers']): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage;
  request.headers = headers;
  return request;
}

function artifactQuery(payload = 'payload'): Record<string, string> {
  return {
    productId: 'luopan',
    releaseId: 'luopan-installer-0.2.0',
    componentId: 'luopan',
    kind: 'app-installer',
    version: '0.2.0',
    channel: 'shadow',
    platform: 'darwin',
    arch: 'arm64',
    fileName: 'luopan-0.2.0.dmg',
    digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`
  };
}

function tokenAuth(token: string): TokenIntrospectionResult {
  if (token === 'publisher-token') return activeAuth(publisherPrincipal);
  if (token === 'approver-token') return activeAuth(approverPrincipal);
  if (token === 'other-token') return activeAuth(otherPrincipal);
  if (token === 'read-token') return activeAuth(servicePrincipal('svc_release_luopan', ['sdk.release.read']));
  if (token === 'stale-publisher-token') {
    return {
      ...activeAuth(servicePrincipal('svc_release_luopan', ['sdk.release.read'])),
      scopes: ['sdk.release.publish']
    };
  }
  return {
    active: false,
    tokenKind: 'unknown',
    issuer: 'test',
    audience: 'mx-sdk',
    subject: null,
    principal: null,
    scopes: [],
    expiresAt: null,
    reason: 'inactive'
  };
}

function activeAuth(principal: PlatformPrincipal): TokenIntrospectionResult {
  return {
    active: true,
    tokenKind: 'service-token',
    issuer: 'test',
    audience: 'mx-sdk',
    subject: principal.principalId,
    principal,
    scopes: principal.scopes,
    expiresAt: '2099-01-01T00:00:00.000Z',
    reason: 'active'
  };
}

function servicePrincipal(serviceAccountId: string, scopes: string[]): PlatformPrincipal {
  return {
    principalId: `service-account:${serviceAccountId}`,
    kind: 'service-account',
    tenantId: 'tenant_default',
    orgIds: ['org_default'],
    displayName: serviceAccountId,
    userId: null,
    anonymousPrincipalId: null,
    serviceAccountId,
    roles: ['mx-service-account'],
    scopes
  };
}

function serviceAccounts(): UserCenterServiceAccount[] {
  return [
    {
      serviceAccountId: 'svc_release_luopan',
      tenantId: 'tenant_default',
      displayName: 'Luopan Publisher',
      roleIds: ['mx-service-account'],
      scopes: ['sdk.release.read', 'sdk.release.publish'],
      allowedProductIds: ['luopan'],
      status: 'active',
      createdAt: '2026-07-28T00:00:00.000Z'
    },
    {
      serviceAccountId: 'svc_release_luopan_approver',
      tenantId: 'tenant_default',
      displayName: 'Luopan Approver',
      roleIds: ['mx-service-account'],
      scopes: ['sdk.release.read', 'sdk.release.approve'],
      allowedProductIds: ['luopan'],
      status: 'active',
      createdAt: '2026-07-28T00:00:00.000Z'
    },
    {
      serviceAccountId: 'svc_release_other',
      tenantId: 'tenant_default',
      displayName: 'Other Publisher',
      roleIds: ['mx-service-account'],
      scopes: ['sdk.release.publish'],
      allowedProductIds: ['other'],
      status: 'active',
      createdAt: '2026-07-28T00:00:00.000Z'
    }
  ];
}

function releasePlan(
  productId: string,
  digest: string,
  input: ReleaseManagementPlanInput = {}
): ReleaseManagementPlan {
  const requestedResult = input.e2eResult ?? 'running';
  const verdict = requestedResult === 'running' ? 'blocked' : requestedResult;
  return {
    planId: 'relplan_test',
    releaseId: input.releaseId ?? 'luopan-installer-0.2.0',
    productId,
    environment: 'shadow',
    channel: input.channel ?? 'shadow',
    installId: input.installId ?? null,
    userId: input.userId ?? null,
    createdBy: input.createdBy ?? 'test',
    requestId: input.requestId ?? null,
    publisherRequestFingerprint: input.publisherRequestFingerprint ?? null,
    components: {
      launcher: {
        componentKind: input.launcherUpdatePolicy === 'renderer-ui'
          ? 'renderer-ui'
          : input.launcherUpdatePolicy === 'app-asar'
            ? 'app-asar'
            : 'app-installer',
        componentId: input.launcherComponentId ?? productId,
        currentVersion: input.launcherCurrentVersion ?? '0.1.0',
        targetVersion: input.launcherTargetVersion ?? '0.2.0',
        updateAvailable: true,
        updateMode: 'mandatory',
        canSkip: false,
        canDefer: true,
        requiresGate: true,
        rollbackRequired: true,
        reason: 'test'
      },
      app: {
        componentKind: 'config-snapshot',
        componentId: `${productId}-config`,
        currentVersion: '0.1.0',
        targetVersion: '0.1.0',
        updateAvailable: false,
        updateMode: 'none',
        canSkip: true,
        canDefer: true,
        requiresGate: false,
        rollbackRequired: false,
        reason: 'test'
      }
    },
    artifacts: [{
      artifactId: 'artifact_test',
      kind: input.artifactKind === 'app-asar' ? 'app-asar' : 'app-installer',
      componentId: productId,
      version: '0.2.0',
      source: 'manual-upload',
      url: input.artifactUrl ?? '/artifact',
      digest,
      signature: null,
      sizeBytes: input.artifactSizeBytes ?? 1,
      platform: 'darwin',
      arch: 'arm64',
      fileName: input.artifactFileName ?? 'luopan-0.2.0.dmg',
      activation: input.activationMode === 'restart-auto' ? 'restart-auto' : 'installer-manual',
      autoApply: input.artifactKind === 'app-asar',
      restartRequired: true,
      requiredAppRestart: true,
      notes: []
    }],
    rollout: {
      strategy: 'gray',
      percentage: input.rolloutPercentage ?? 10,
      segmentId: 'test',
      rings: [],
      featureKeys: [],
      channels: [input.channel ?? 'shadow'],
      audience: { installIds: [], userIds: [], siteIds: [] },
      allowAutoPromote: false,
      canaryMetricGate: 'test'
    },
    activation: {
      checkSource: 'internal-postgres',
      hotUpdateAuto: true,
      hotUpdateToast: true,
      majorUpdateRequiresInstaller: true,
      restartAfterApply: true,
      manualConfirmRequired: true,
      connectionSafeMode: true
    },
    releaseNotes: input.releaseNotes ?? null,
    deliveryMode: input.deliveryMode === 'silent-download-next-start'
      ? 'silent-download-next-start'
      : 'prompt-download-restart',
    test: {
      suiteId: 'test',
      topology: 'test',
      sites: ['internal-main'],
      run: {} as ReleaseManagementPlan['test']['run'],
      gate: { verdict } as ReleaseManagementPlan['test']['gate']
    },
    decisions: {
      readyToPromote: verdict === 'passed',
      requiresApproval: verdict !== 'passed',
      canaryAllowed: verdict === 'passed',
      rollbackRequired: true,
      nextActions: []
    },
    createdAt: '2026-07-28T00:00:00.000Z'
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as HttpException | undefined)?.getStatus?.();
}

function testRuntimeConfig(): RuntimeConfig {
  return {
    environment: 'test',
    siteId: 'internal-main',
    siteRole: 'internal',
    enabledModules: ['release-center', 'test-center'],
    host: '127.0.0.1',
    port: 18090,
    publicBaseUrl: 'http://127.0.0.1:18090',
    internalBaseUrl: 'http://127.0.0.1:18090',
    storeDriver: 'memory',
    databaseUrl: null,
    observabilitySinks: [],
    runnerDryRunDefault: true,
    siteSlotRunnerRemoteExecutionEnabled: false,
    coreDnsK8sApplyEnabled: false,
    coreDnsK8sAllowedNamespace: 'mx-dns',
    coreDnsK8sAllowedConfigMapName: 'coredns',
    gatewayK8sApplyEnabled: false,
    gatewayK8sAllowedNamespace: 'mx-internal-shadow',
    gatewayK8sAllowedConfigMapName: 'mx-internal-gateway-caddy',
    gatewayApplyBackend: 'k8s',
    gatewayHostNginxApplyEnabled: false,
    gatewayHostNginxConfigPath: '/tmp/mx-gateway.conf',
    gatewayHostNginxInternalApiUpstream: null,
    launcherNetworkSdkTestModeEnabled: false,
    launcherNetworkLegacyUnauthenticatedUserLeasesEnabled: false,
    launcherNetworkHandoverTtlMs: 300_000,
    launcherNetworkHandoverReconcileMs: 30_000,
    feishuAppId: null,
    feishuAppSecret: null,
    feishuAllowedTenantKeys: [],
    feishuRedirectUris: [],
    feishuAutoProvisionEnabled: false,
    feishuAuthorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    feishuTokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    feishuUserInfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    gatewayAppPort: 80,
    siteSlotSshKeyRoot: '/tmp/mx-site-slot-ssh'
  };
}
