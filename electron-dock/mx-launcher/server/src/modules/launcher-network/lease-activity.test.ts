import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import { AuditController } from '../audit/audit.controller.js';
import { LauncherNetworkController } from './launcher-network.controller.js';

const config = loadConfig();

test('lease activity is ops-only, exact-linked, and redacted', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'lease-activity-test';
  context.after(() => {
    if (previousOpsToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOpsToken;
  });

  const store = new MemoryStore(config);
  const auditController = new AuditController(store);
  const controller = new LauncherNetworkController(store, config);
  const lease = store.enrollLauncherNetworkLease({
    appId: 'mx-h2i',
    productId: 'mx-h2i',
    mode: 'standalone',
    identityKind: 'anonymous',
    leaseProfile: 'anonymous',
    installId: 'inst_lease_activity',
    deviceId: 'dev_lease_activity',
    publicKey: 'public-key-lease-activity',
    sourceIp: '198.51.100.45',
    requestedBy: 'lease-activity-test',
    requestId: 'req_lease_enroll'
  });

  store.recordAudit({
    eventType: 'launcher_network.domestic_peer.synced',
    siteId: 'domestic-main',
    requestId: 'req_peer_sync',
    metadata: {
      leaseId: lease.leaseId,
      status: 'passed',
      publicKey: 'public-key-must-not-leak',
      token: 'token-must-not-leak',
      capability: 'capability-must-not-leak',
      sourceIp: '203.0.113.77',
      stdout: 'stdout-must-not-leak',
      stderr: 'stderr-must-not-leak'
    }
  });
  store.recordAudit({
    eventType: 'launcher_network.unrelated.same_overlay',
    overlayIp: lease.leaseIp,
    installId: lease.installId,
    deviceId: lease.deviceId,
    metadata: { leaseId: `${lease.leaseId}-different` }
  });
  store.recordAudit({
    eventType: 'launcher_network.unrelated.no_lease_id',
    overlayIp: lease.leaseIp,
    installId: lease.installId,
    deviceId: lease.deviceId,
    metadata: { status: 'passed' }
  });
  const forged = await auditController.recordAudit({
    provenance: 'server',
    eventType: 'launcher_network.domestic_peer.synced',
    siteId: 'forged-domestic',
    requestId: 'req_forged_peer_sync',
    metadata: {
      leaseId: lease.leaseId,
      status: 'passed'
    }
  });
  assert.equal(forged.event.provenance, 'client', 'request-body provenance is ignored');

  await assert.rejects(
    controller.getLeaseActivity(lease.leaseId, 'wrong-token'),
    /valid Internal ops token/
  );
  await assert.rejects(
    controller.getLeaseActivity('lnlease_missing', 'lease-activity-test'),
    (error) => httpStatus(error) === 404
  );

  const response = await controller.getLeaseActivity(lease.leaseId, 'lease-activity-test');
  assert.equal(response.leaseId, lease.leaseId);
  assert.equal(response.source, 'audit-events');
  assert.equal(response.count, 2);
  assert.deepEqual(
    response.activity.map((event) => event.eventType).sort(),
    ['launcher_network.domestic_peer.synced', 'launcher_network.lease.enrolled']
  );
  assert.ok(
    response.activity.every((event) => event.requestId !== 'req_forged_peer_sync'),
    'client-ingested audit records are not server evidence'
  );
  const peerSync = response.activity.find((event) => (
    event.eventType === 'launcher_network.domestic_peer.synced'
  ));
  assert.deepEqual(peerSync, {
    eventId: peerSync?.eventId,
    eventType: 'launcher_network.domestic_peer.synced',
    createdAt: peerSync?.createdAt,
    siteId: 'domestic-main',
    requestId: 'req_peer_sync',
    summary: 'Domestic WireGuard peer synchronized',
    status: 'passed',
    plane: 'domestic'
  });
  assert.deepEqual(
    Object.keys(peerSync ?? {}).sort(),
    ['createdAt', 'eventId', 'eventType', 'plane', 'requestId', 'siteId', 'status', 'summary']
  );
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    'public-key-lease-activity',
    '198.51.100.45',
    'public-key-must-not-leak',
    'token-must-not-leak',
    'capability-must-not-leak',
    '203.0.113.77',
    'stdout-must-not-leak',
    'stderr-must-not-leak'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
  assert.doesNotMatch(serialized, /"(?:provenance|metadata|publicKey|token|capability|sourceIp|stdout|stderr)"/);
});

test('lease activity returns at most the latest 50 exact metadata.leaseId events', async (context) => {
  const previousOpsToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'lease-activity-limit-test';
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
    installId: 'inst_lease_activity_limit',
    deviceId: 'dev_lease_activity_limit',
    publicKey: 'public-key-lease-activity-limit',
    requestedBy: 'lease-activity-limit-test'
  });
  for (let index = 0; index < 55; index += 1) {
    store.recordAudit({
      eventType: 'launcher_network.test.exact',
      requestId: `req_exact_${index}`,
      metadata: { leaseId: lease.leaseId }
    });
  }
  store.recordAudit({
    eventType: 'launcher_network.test.near_match',
    metadata: { leaseId: `${lease.leaseId}-suffix` }
  });
  const legacy = store.recordAudit({
    eventType: 'launcher_network.test.legacy_without_provenance',
    requestId: 'req_legacy_without_provenance',
    metadata: { leaseId: lease.leaseId }
  });
  delete (legacy as Partial<typeof legacy>).provenance;

  const listed = store.listAuditEvents({ metadataLeaseId: lease.leaseId, limit: 500 });
  assert.equal(listed.length, 50, 'store enforces the hard upper bound');
  assert.ok(listed.every((event) => event.metadata?.leaseId === lease.leaseId));
  assert.equal(listed[0]?.requestId, 'req_exact_54');
  assert.equal(listed.at(-1)?.requestId, 'req_exact_5');
  assert.ok(
    listed.every((event) => event.requestId !== 'req_legacy_without_provenance'),
    'legacy audit rows without explicit provenance fail closed'
  );

  const response = await controller.getLeaseActivity(lease.leaseId, 'lease-activity-limit-test');
  assert.equal(response.count, 50);
  assert.equal(response.activity[0]?.requestId, 'req_exact_54');
  assert.equal(response.activity.at(-1)?.requestId, 'req_exact_5');
  assert.ok(response.activity.every((event) => event.eventType === 'launcher_network.test.exact'));
});

function httpStatus(error: unknown): number | null {
  const getStatus = (error as { getStatus?: () => number } | null)?.getStatus;
  return typeof getStatus === 'function' ? getStatus.call(error) : null;
}
