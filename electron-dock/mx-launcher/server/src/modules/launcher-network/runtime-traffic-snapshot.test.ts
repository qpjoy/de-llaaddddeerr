import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type {
  LauncherNetworkLease,
  LauncherNetworkRuntimeCollectionCompleteInput,
  RuntimeConfig
} from '../../types.js';
import {
  LauncherNetworkController,
  domesticRuntimeSnapshotScript,
  launcherRuntimeSnapshotCapacityBlocked,
  parseLauncherNetworkDomesticDump
} from './launcher-network.controller.js';

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');
const meta = 'meta\t3f45c451-0fa1-46df-9a3a-f10edff95ce0\t17';

test('sanitized Domestic dump uses one wg read and rejects malformed peer truth', () => {
  const script = domesticRuntimeSnapshotScript();
  assert.equal(script.match(/wg show mx-domestic dump/g)?.length, 1);
  assert.match(script, /dump="\$\(wg show mx-domestic dump\)"/);
  assert.match(script, /printf "%s\\n" "\$dump" \| awk/);
  assert.doesNotMatch(script, /wg show mx-domestic dump \|/);
  assert.match(script, /NR > 1/);
  assert.match(script, /\$1, \$4, \$5, \$6, \$7/);
  assert.doesNotMatch(script, /\$2|\$3/);

  const sampledAt = '2026-08-23T00:05:00.000Z';
  const parsed = parseLauncherNetworkDomesticDump([
    meta,
    `peer\t${keyA}\t10.89.50.2/32,fd00::2/128\t1787443200\t100\t200`,
    `peer\t${keyB}\t10.91.0.5/32\t0\t300\t400`
  ].join('\n'), 'domestic-main', sampledAt);
  assert.equal(parsed.peers.size, 2);
  assert.deepEqual(parsed.peers.get(keyA)?.allowedIps, ['10.89.50.2/32', 'fd00::2/128']);
  assert.match(parsed.peers.get(keyA)?.seriesId ?? '', /^[a-f0-9]{24}$/);

  for (const output of [
    `${meta}\npeer\t${keyA}\t10.89.50.2/32\t1787443200\t100`,
    `${meta}\npeer\t${keyA}\t::::/64\t1787443200\t100\t200`,
    `${meta}\npeer\t${keyA}\t10.89.50.2/32\t1787443200\t100\t200\npeer\t${keyA}\t10.89.50.3/32\t1787443200\t300\t400`,
    `${meta}\npeer\tnot-a-key\t10.89.50.2/32\t1787443200\t100\t200`,
    `${meta}\npeer\t${keyA}\t10.89.50.2/32\tnot-an-epoch\t100\t200`,
    `${meta}\npeer\t${keyA}\t10.89.50.2/32\t1787443200\t01\t200`
  ]) {
    assert.throws(
      () => parseLauncherNetworkDomesticDump(output, 'domestic-main', sampledAt),
      /Domestic WireGuard/
    );
  }
  assert.throws(
    () => parseLauncherNetworkDomesticDump(
      `${meta}\n${'x'.repeat(1024 * 1024)}`,
      'domestic-main',
      sampledAt
    ),
    /output limit/
  );
});

test('runtime collection is fenced, throttled, bounded, and derives only valid adjacent rates', () => {
  const config = loadConfig();
  const store = new MemoryStore(config);
  const firstClaim = store.claimLauncherNetworkRuntimeCollection({
    siteId: 'domestic-main',
    claimId: 'claim-1',
    requestedAt: '2026-08-23T00:00:00.000Z',
    minIntervalMs: 300_000,
    claimTtlMs: 90_000
  });
  assert.equal(firstClaim.outcome, 'claimed');
  assert.equal(store.claimLauncherNetworkRuntimeCollection({
    siteId: 'domestic-main',
    claimId: 'claim-in-flight',
    requestedAt: '2026-08-23T00:00:30.000Z',
    minIntervalMs: 300_000,
    claimTtlMs: 90_000
  }).outcome, 'in-flight');
  store.completeLauncherNetworkRuntimeCollection(completeInput({
    claimId: 'claim-1',
    snapshotId: 'snapshot-1',
    sampledAt: '2026-08-23T00:00:05.000Z',
    rxBytes: 100,
    txBytes: 200,
    retentionSamples: 2
  }));
  assert.equal(store.claimLauncherNetworkRuntimeCollection({
    siteId: 'domestic-main',
    claimId: 'claim-throttled',
    requestedAt: '2026-08-23T00:04:59.000Z',
    minIntervalMs: 300_000,
    claimTtlMs: 90_000
  }).outcome, 'throttled');

  assert.equal(store.claimLauncherNetworkRuntimeCollection({
    siteId: 'domestic-main',
    claimId: 'claim-2',
    requestedAt: '2026-08-23T00:05:00.000Z',
    minIntervalMs: 300_000,
    claimTtlMs: 90_000
  }).outcome, 'claimed');
  store.completeLauncherNetworkRuntimeCollection(completeInput({
    claimId: 'claim-2',
    snapshotId: 'snapshot-2',
    sampledAt: '2026-08-23T00:05:05.000Z',
    rxBytes: 700,
    txBytes: 1_400,
    retentionSamples: 2
  }));
  let history = store.getLauncherNetworkTrafficHistory('lease-1');
  assert.equal(history?.samples.length, 2);
  assert.equal(history?.samples[1]?.relayRxBytesPerSecond, 2);
  assert.equal(history?.samples[1]?.relayTxBytesPerSecond, 4);
  assert.equal(history?.samples[1]?.rateWindowSeconds, 300);

  assert.equal(store.claimLauncherNetworkRuntimeCollection({
    siteId: 'domestic-main',
    claimId: 'claim-3',
    requestedAt: '2026-08-23T00:10:00.000Z',
    minIntervalMs: 300_000,
    claimTtlMs: 90_000
  }).outcome, 'claimed');
  store.completeLauncherNetworkRuntimeCollection(completeInput({
    claimId: 'claim-3',
    snapshotId: 'snapshot-3',
    sampledAt: '2026-08-23T00:10:05.000Z',
    rxBytes: 10,
    txBytes: 20,
    retentionSamples: 2
  }));
  history = store.getLauncherNetworkTrafficHistory('lease-1');
  assert.deepEqual(history?.samples.map((sample) => sample.snapshotId), ['snapshot-2', 'snapshot-3']);
  assert.equal(history?.samples[1]?.relayRxBytesPerSecond, null, 'counter reset breaks the rate series');
  assert.equal(history?.samples[1]?.rateWindowSeconds, null);
  assert.equal(store.pruneLauncherNetworkTrafficHistories('2026-08-24T00:00:00.000Z'), 1);
  assert.equal(store.getLauncherNetworkTrafficHistory('lease-1'), null);

  const fencingStore = new MemoryStore(config);
  fencingStore.claimLauncherNetworkRuntimeCollection({
    siteId: 'domestic-main',
    claimId: 'slow-claim',
    requestedAt: '2026-08-23T01:00:00.000Z',
    minIntervalMs: 60_000,
    claimTtlMs: 30_000
  });
  fencingStore.claimLauncherNetworkRuntimeCollection({
    siteId: 'domestic-main',
    claimId: 'new-claim',
    requestedAt: '2026-08-23T01:01:00.000Z',
    minIntervalMs: 60_000,
    claimTtlMs: 30_000
  });
  assert.throws(
    () => fencingStore.completeLauncherNetworkRuntimeCollection(completeInput({
      claimId: 'slow-claim',
      snapshotId: 'stale-snapshot',
      sampledAt: '2026-08-23T01:01:05.000Z',
      rxBytes: 1,
      txBytes: 2,
      retentionSamples: 2
    })),
    /claim is stale/
  );
});

test('collector fails closed before SSH and writes no partial history above 512 active leases', async () => {
  const config = loadConfig();
  const store = new MemoryStore(config);
  const seed = store.enrollLauncherNetworkLease({
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: 'inst_capacity_seed',
    deviceId: 'dev_capacity_seed',
    publicKey: keyA,
    requestedBy: 'runtime-capacity-test'
  });
  const leaseMap = (store as unknown as {
    launcherNetworkLeases: Map<string, LauncherNetworkLease>;
  }).launcherNetworkLeases;
  for (let index = 1; index < 513; index += 1) {
    const leaseId = `lnlease_capacity_${index}`;
    leaseMap.set(leaseId, {
      ...seed,
      leaseId,
      leaseKey: `capacity:${index}`,
      installId: `inst_capacity_${index}`,
      deviceId: `dev_capacity_${index}`,
      sequence: index + 1
    });
  }
  assert.equal(launcherRuntimeSnapshotCapacityBlocked(512), false);
  assert.equal(launcherRuntimeSnapshotCapacityBlocked(513), true);
  const controller = new LauncherNetworkController(store, config);
  const result = await (controller as unknown as {
    collectDomesticRuntimeSnapshotForSite(siteId: string): Promise<{ outcome: string }>;
  }).collectDomesticRuntimeSnapshotForSite(seed.domesticSiteId);
  assert.equal(result.outcome, 'unavailable');
  const state = store.getLauncherNetworkRuntimeCollection(seed.domesticSiteId);
  assert.equal(state?.latestFailureCode, 'capacity-blocked');
  assert.equal(state?.activeLeaseCount, 513);
  assert.equal(state?.collectedLeaseCount, 0);
  assert.equal(store.getLauncherNetworkTrafficHistory(seed.leaseId), null);
  assert.equal(
    [...leaseMap.keys()].some((leaseId) => store.getLauncherNetworkTrafficHistory(leaseId) !== null),
    false
  );
});

test('manual site snapshot trigger is ops-only and shares the collection throttle', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'runtime-snapshot-test';
  context.after(() => {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  });
  const config = loadConfig();
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  await assert.rejects(
    controller.collectDomesticRuntimeSnapshot('wrong-token', { siteId: 'domestic-main' }),
    /valid Internal ops token/
  );
  const first = await controller.collectDomesticRuntimeSnapshot(
    'runtime-snapshot-test',
    { siteId: 'domestic-main' }
  );
  assert.equal(first.collection.outcome, 'unavailable');
  const second = await controller.collectDomesticRuntimeSnapshot(
    'runtime-snapshot-test',
    { siteId: 'domestic-main' }
  );
  assert.equal(second.collection.outcome, 'throttled');
});

test('traffic history is ops-only, dynamically stale, queryable after release, and strictly redacted', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'traffic-history-test';
  context.after(() => {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  });
  const config: RuntimeConfig = {
    ...loadConfig(),
    launcherNetworkRuntimeSnapshotIntervalMs: 60_000,
    launcherNetworkRuntimeSnapshotRetentionSamples: 288
  };
  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const lease = store.enrollLauncherNetworkLease({
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: 'inst_runtime_history',
    deviceId: 'dev_runtime_history',
    publicKey: keyA,
    requestedBy: 'runtime-history-test'
  });
  const now = Date.now();
  const firstRequestedAt = new Date(now - 61_000).toISOString();
  const firstSampledAt = new Date(now - 60_000).toISOString();
  store.claimLauncherNetworkRuntimeCollection({
    siteId: lease.domesticSiteId,
    claimId: 'history-claim-1',
    requestedAt: firstRequestedAt,
    minIntervalMs: 60_000,
    claimTtlMs: 30_000
  });
  store.completeLauncherNetworkRuntimeCollection(completeInput({
    claimId: 'history-claim-1',
    snapshotId: 'history-snapshot-1',
    sampledAt: firstSampledAt,
    rxBytes: 1_000,
    txBytes: 2_000,
    retentionSamples: 288,
    leaseId: lease.leaseId,
    productId: lease.productId,
    siteId: lease.domesticSiteId
  }));

  await assert.rejects(
    controller.getLeaseTrafficHistory(lease.leaseId, '12', 'wrong-token'),
    /valid Internal ops token/
  );
  await assert.rejects(
    controller.getLeaseTrafficHistory(lease.leaseId, '0', 'traffic-history-test'),
    /between 1 and 288/
  );
  let response = await controller.getLeaseTrafficHistory(
    lease.leaseId,
    '12',
    'traffic-history-test'
  );
  assert.equal(response.trafficHistory.stale, false);
  assert.deepEqual(Object.keys(response.trafficHistory.samples[0] ?? {}).sort(), [
    'attribution',
    'latestHandshakeEpoch',
    'observedAt',
    'peerConfigured',
    'rateWindowSeconds',
    'relayRxBytesPerSecond',
    'relayTxBytesPerSecond',
    'rxBytes',
    'sharedLeaseCount',
    'snapshotId',
    'status',
    'txBytes'
  ]);
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    'seriesId', 'historyId', 'environment', 'createdAt', 'publicKey', 'endpoint', 'stdout', 'stderr'
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));

  store.claimLauncherNetworkRuntimeCollection({
    siteId: lease.domesticSiteId,
    claimId: 'history-claim-2',
    requestedAt: new Date(now).toISOString(),
    minIntervalMs: 60_000,
    claimTtlMs: 30_000
  });
  store.completeLauncherNetworkRuntimeCollection({
    ...completeInput({
      claimId: 'history-claim-2',
      snapshotId: 'capacity-snapshot',
      sampledAt: new Date(now + 1_000).toISOString(),
      rxBytes: 0,
      txBytes: 0,
      retentionSamples: 288,
      leaseId: lease.leaseId,
      productId: lease.productId,
      siteId: lease.domesticSiteId
    }),
    result: 'unavailable',
    failureCode: 'profile-unavailable',
    collectedLeaseCount: 0,
    samples: []
  });
  response = await controller.getLeaseTrafficHistory(lease.leaseId, '12', 'traffic-history-test');
  assert.equal(response.trafficHistory.stale, true, 'a newer failed site collection invalidates old freshness');

  store.releaseLauncherNetworkLease(lease.leaseId, { requestedBy: 'runtime-history-test' });
  response = await controller.getLeaseTrafficHistory(lease.leaseId, '12', 'traffic-history-test');
  assert.equal(response.trafficHistory.samples.length, 1);
});

function completeInput(input: {
  claimId: string;
  snapshotId: string;
  sampledAt: string;
  rxBytes: number;
  txBytes: number;
  retentionSamples: number;
  leaseId?: string;
  productId?: string;
  siteId?: string;
}): LauncherNetworkRuntimeCollectionCompleteInput {
  return {
    siteId: input.siteId ?? 'domestic-main',
    claimId: input.claimId,
    snapshotId: input.snapshotId,
    sampledAt: input.sampledAt,
    result: 'observed',
    intervalMs: 300_000,
    retentionSamples: input.retentionSamples,
    activeLeaseCount: 1,
    peerCount: 1,
    unmatchedPeerCount: 0,
    sharedPeerLeaseCount: 0,
    collectedLeaseCount: 1,
    collectionDurationMs: 25,
    failureCode: null,
    samples: [{
      leaseId: input.leaseId ?? 'lease-1',
      productId: input.productId ?? 'mx-h2i',
      status: 'observed',
      peerConfigured: 'yes',
      latestHandshakeEpoch: null,
      rxBytes: input.rxBytes,
      txBytes: input.txBytes,
      attribution: 'exact',
      sharedLeaseCount: 1,
      seriesId: 'a'.repeat(24)
    }]
  };
}
