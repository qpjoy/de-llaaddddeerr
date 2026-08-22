import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import {
  LauncherNetworkController,
  launcherNetworkDomesticRuntimeObservation
} from './launcher-network.controller.js';

const config = loadConfig();

test('runtime observation endpoint is ops-only, active-only, and returns a strict whitelist', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'runtime-observation-test';
  context.after(() => {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  });

  const store = new MemoryStore(config);
  const controller = new LauncherNetworkController(store, config);
  const lease = store.enrollLauncherNetworkLease({
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: 'inst_runtime_observation',
    deviceId: 'dev_runtime_observation',
    publicKey: 'deliberately-invalid-public-key',
    requestedBy: 'runtime-observation-test'
  });

  await assert.rejects(
    controller.observeLeaseRuntime(lease.leaseId, 'wrong-token', {}),
    /valid Internal ops token/
  );

  const response = await controller.observeLeaseRuntime(
    lease.leaseId,
    'runtime-observation-test',
    { requestedBy: 'desktop-admin', requestId: 'runtime-observation-request' }
  );
  assert.deepEqual(Object.keys(response), ['runtimeObservation']);
  assert.deepEqual(
    Object.keys(response.runtimeObservation),
    [
      'leaseId',
      'productId',
      'observedAt',
      'source',
      'plane',
      'status',
      'stale',
      'peerConfigured',
      'latestHandshakeEpoch',
      'rxBytes',
      'txBytes'
    ]
  );
  assert.equal(response.runtimeObservation.leaseId, lease.leaseId);
  assert.equal(response.runtimeObservation.productId, 'mx-h2i');
  assert.equal(response.runtimeObservation.source, 'domestic-relay-manual');
  assert.equal(response.runtimeObservation.plane, 'domestic');
  assert.equal(response.runtimeObservation.status, 'unavailable');
  assert.equal(response.runtimeObservation.stale, true);
  assert.equal(response.runtimeObservation.peerConfigured, 'unknown');
  assert.equal(response.runtimeObservation.rxBytes, null);
  assert.equal(response.runtimeObservation.txBytes, null);
  assert.doesNotMatch(
    JSON.stringify(response),
    /stdout|stderr|result|summary|publicKey|endpoint|deliberately-invalid-public-key/
  );

  store.releaseLauncherNetworkLease(lease.leaseId, { requestedBy: 'runtime-observation-test' });
  await assert.rejects(
    controller.observeLeaseRuntime(lease.leaseId, 'runtime-observation-test', {}),
    /released or expired/
  );
});

test('runtime observation exposes only strictly parsed selected-peer counters', () => {
  const lease = { leaseId: 'lnlease_observed', productId: 'mx-h2i' };
  const observedAt = '2026-08-22T00:00:00.000Z';
  const observation = launcherNetworkDomesticRuntimeObservation(lease, {
    status: 'blocked',
    execution: 'executed',
    checkedAt: '2026-08-21T23:59:55.000Z',
    sampledAt: observedAt,
    summary: {
      clientPeerConfigured: 'yes',
      clientLatestHandshake: '1784505600',
      clientTransfer: '123456/654321',
      internalTransfer: 'must-not-be-returned'
    },
    result: {
      stdout: 'must-not-be-returned',
      stderr: 'must-not-be-returned'
    }
  });

  assert.deepEqual(observation, {
    leaseId: 'lnlease_observed',
    productId: 'mx-h2i',
    observedAt,
    source: 'domestic-relay-manual',
    plane: 'domestic',
    status: 'observed',
    stale: false,
    peerConfigured: 'yes',
    latestHandshakeEpoch: 1784505600,
    rxBytes: 123456,
    txBytes: 654321
  });
});

test('runtime observation fails closed for malformed or unsafe transfer counters', () => {
  for (const clientTransfer of [
    null,
    '123/not-a-number',
    '-1/2',
    '01/2',
    '9007199254740992/2'
  ]) {
    const observation = launcherNetworkDomesticRuntimeObservation(
      { leaseId: 'lnlease_invalid', productId: 'luopan' },
      {
        execution: 'executed',
        checkedAt: '2026-08-22T00:00:00.000Z',
        sampledAt: '2026-08-22T00:00:05.000Z',
        summary: {
          clientPeerConfigured: 'yes',
          clientLatestHandshake: '0',
          clientTransfer
        }
      }
    );
    assert.equal(observation.status, 'unavailable');
    assert.equal(observation.stale, false, 'the command ran, but its fields were rejected');
    assert.equal(observation.latestHandshakeEpoch, null);
    assert.equal(observation.rxBytes, null);
    assert.equal(observation.txBytes, null);
  }

  for (const clientLatestHandshake of [
    '9007199254740991',
    '1787393101'
  ]) {
    const observation = launcherNetworkDomesticRuntimeObservation(
      { leaseId: 'lnlease_invalid_handshake', productId: 'luopan' },
      {
        execution: 'executed',
        checkedAt: '2026-08-22T10:00:00.000Z',
        sampledAt: '2026-08-22T10:00:00.000Z',
        summary: {
          clientPeerConfigured: 'yes',
          clientLatestHandshake,
          clientTransfer: '1/2'
        }
      }
    );
    assert.equal(observation.status, 'unavailable');
    assert.equal(observation.latestHandshakeEpoch, null);
    assert.equal(observation.rxBytes, null);
    assert.equal(observation.txBytes, null);
  }
});

test('runtime observation distinguishes freshly observed peer absence from execution failure', () => {
  const absent = launcherNetworkDomesticRuntimeObservation(
    { leaseId: 'lnlease_absent', productId: 'mx-h2i' },
    {
      execution: 'executed',
      checkedAt: '2026-08-22T00:00:00.000Z',
      sampledAt: '2026-08-22T00:00:05.000Z',
      summary: {
        clientPeerConfigured: 'no',
        clientLatestHandshake: '',
        clientTransfer: null
      }
    }
  );
  assert.equal(absent.status, 'observed');
  assert.equal(absent.stale, false);
  assert.equal(absent.peerConfigured, 'no');
  assert.equal(absent.latestHandshakeEpoch, null);
  assert.equal(absent.rxBytes, null);
  assert.equal(absent.txBytes, null);

  const missingCompletionTimestamp = launcherNetworkDomesticRuntimeObservation(
    { leaseId: 'lnlease_missing_sample_time', productId: 'mx-h2i' },
    {
      execution: 'executed',
      checkedAt: '2026-08-22T00:00:00.000Z',
      summary: {
        clientPeerConfigured: 'yes',
        clientLatestHandshake: '1784505600',
        clientTransfer: '1/2'
      }
    }
  );
  assert.equal(missingCompletionTimestamp.status, 'unavailable');
  assert.equal(missingCompletionTimestamp.stale, true);
  assert.equal(missingCompletionTimestamp.observedAt, '2026-08-22T00:00:00.000Z');

  const failed = launcherNetworkDomesticRuntimeObservation(
    { leaseId: 'lnlease_failed', productId: 'mx-h2i' },
    {
      execution: 'failed',
      checkedAt: '2026-08-22T00:00:00.000Z',
      summary: {
        clientPeerConfigured: 'yes',
        clientLatestHandshake: '1784505600',
        clientTransfer: '1/2'
      }
    }
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stale, true);
  assert.equal(failed.peerConfigured, 'yes');
  assert.equal(failed.latestHandshakeEpoch, null);
  assert.equal(failed.rxBytes, null);
  assert.equal(failed.txBytes, null);
});
