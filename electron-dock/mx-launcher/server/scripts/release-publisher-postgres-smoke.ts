import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { loadConfig } from '../src/config.js';
import type { PublisherReleasePlanInput } from '../src/store/platform-store.js';
import { PostgresStore } from '../src/store/postgres.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (process.env.MX_RELEASE_PUBLISHER_SMOKE_CONFIRM !== 'ephemeral') {
  throw new Error('Set MX_RELEASE_PUBLISHER_SMOKE_CONFIRM=ephemeral for this destructive ephemeral-DB smoke');
}
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('Release Publisher Postgres smoke only accepts a localhost DATABASE_URL');
}
if (!parsedDatabaseUrl.pathname.includes('release_smoke')) {
  throw new Error('Release Publisher Postgres smoke database name must contain release_smoke');
}

const runId = randomUUID();
const productId = `release-smoke-${runId}`;
const requestId = `request-${runId}`;
const config = {
  ...loadConfig(),
  environment: `release-publisher-smoke-${runId}`,
  storeDriver: 'postgres' as const,
  databaseUrl
};

const store = await PostgresStore.create(config);
const dataSource = (store as unknown as { dataSource: DataSource }).dataSource;

try {
  const input = publisherInput(productId, requestId, 'a');
  const sameRequest = await Promise.all([
    store.createPublisherReleaseManagementPlan(input),
    store.createPublisherReleaseManagementPlan(input)
  ]);
  assert.deepEqual(
    sameRequest.map((result) => result.outcome).sort(),
    ['created', 'replayed']
  );

  const conflict = await store.createPublisherReleaseManagementPlan(
    publisherInput(productId, requestId, 'b')
  );
  assert.equal(conflict.outcome, 'conflict');

  const created = sameRequest.find((result) => result.outcome === 'created');
  assert(created && created.outcome === 'created');
  const genericStep = store.recordTestStep(created.plan.test.run.testRunId, {
    caseId: 'publisher-bypass',
    status: 'failed'
  });
  const gate = store.completeReleaseManagementGate(created.plan.planId, {
    status: 'passed',
    requestId: `gate-${runId}`
  });
  const [genericResult, gateResult] = await Promise.allSettled([genericStep, gate]);
  assert.equal(genericResult.status, 'rejected');
  if (genericResult.status === 'rejected') {
    assert.match(String(genericResult.reason), /release gate endpoint/);
  }
  assert.equal(gateResult.status, 'fulfilled');
  if (gateResult.status === 'fulfilled') {
    assert.equal(gateResult.value.test.gate.verdict, 'passed');
    assert.equal(gateResult.value.test.run.state, 'passed');
  }

  const indexRows = await dataSource.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'uq_mx_release_publisher_request'`
  ) as Array<{ indexname: string }>;
  assert.equal(indexRows.length, 1);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    outcomes: sameRequest.map((result) => result.outcome).sort(),
    conflict: conflict.outcome,
    gate: gateResult.status === 'fulfilled' ? gateResult.value.test.gate.verdict : 'failed',
    index: indexRows[0]?.indexname
  }, null, 2)}\n`);
} finally {
  await dataSource.destroy();
}

function publisherInput(
  productId: string,
  requestId: string,
  fingerprintSeed: string
): PublisherReleasePlanInput {
  return {
    releaseId: `${productId}-0.2.0`,
    productId,
    appId: productId,
    channel: 'shadow',
    launcherComponentId: productId,
    launcherUpdatePolicy: 'app-installer',
    launcherCurrentVersion: '0.1.0',
    launcherTargetVersion: '0.2.0',
    appComponentId: `${productId}-config`,
    appUpdatePolicy: 'config-snapshot',
    appCurrentVersion: '0.1.0',
    appTargetVersion: '0.1.0',
    artifactKind: 'app-installer',
    artifactVersion: '0.2.0',
    artifactUrl: `/artifacts/${productId}`,
    artifactDigest: `sha256:${fingerprintSeed.repeat(64)}`,
    artifactSizeBytes: 1,
    artifactPlatform: 'darwin',
    artifactArch: 'arm64',
    artifactFileName: `${productId}.dmg`,
    activationMode: 'installer-manual',
    rolloutStrategy: 'all',
    rolloutPercentage: 100,
    e2eResult: 'running',
    requestId,
    publisherRequestFingerprint: `sha256:${fingerprintSeed.repeat(64)}`
  };
}
