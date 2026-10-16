import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { SiteSlotDomesticWireGuardSecret } from '../../types.js';
import { generateWireGuardKeyPair } from '../config-center/wireguard-keys.js';
import { AdminController } from './admin.controller.js';

type MaterializeResult = {
  secret: SiteSlotDomesticWireGuardSecret | null;
  result: { status: string; blockedReasons?: string[] };
};

type ControllerInternals = {
  materializeDomesticWireGuard: (
    siteId: string,
    plan: unknown,
    secret: SiteSlotDomesticWireGuardSecret,
    body: Record<string, unknown>
  ) => Promise<MaterializeResult>;
  materializeDomesticBootstrapSubscription: () => Promise<never>;
  adminDomesticRuntimeConfigApplyResult: () => Promise<never>;
  adminInternalServicePeerDomesticKeySyncResult: () => Promise<never>;
};

const keyFields = [
  'domesticRelayPrivateKey', 'domesticRelayPublicKey',
  'internalServicePrivateKey', 'internalServicePublicKey'
] as const;

function fixture(missingKey?: typeof keyFields[number]) {
  const store = new MemoryStore(loadConfig());
  const relay = generateWireGuardKeyPair();
  const internal = generateWireGuardKeyPair();
  const keys = {
    domesticRelayPrivateKey: relay.privateKey,
    domesticRelayPublicKey: relay.publicKey,
    internalServicePrivateKey: internal.privateKey,
    internalServicePublicKey: internal.publicKey,
    ...(missingKey ? { [missingKey]: null } : {})
  };
  const before = store.upsertSiteSlotDomesticWireGuardSecret({
    siteId: 'domestic-main',
    publicEndpoint: '198.51.100.40:51280',
    productRelayCidrs: ['10.89.0.0/16', '10.90.0.0/16', '10.99.0.0/16'],
    ...keys,
    requestedBy: 'test'
  });
  store.createSiteSlotPlan({
    siteId: 'domestic-main', kind: 'domestic', host: '198.51.100.40',
    sshUser: 'root', rootAccess: true, hasDocker: true, hasOutboundInternet: true,
    createdBy: 'test'
  });
  store.upsertLauncherProductNetwork({
    productId: 'mx-rig', productIndex: 4, displayName: 'MX Rig',
    mode: 'standalone', networkScope: 'owner', enabled: true, requestedBy: 'test'
  });
  const controller = new AdminController(store);
  const internals = controller as unknown as ControllerInternals;
  const runtimeCalls: string[] = [];
  const forbidRuntime = (name: string) => async (): Promise<never> => {
    runtimeCalls.push(name);
    throw new Error(`Unexpected external operation: ${name}`);
  };
  // A regression must fail before it can run the external artifact materializer,
  // SSH, or the Internal host runner. Every request below leaves Domestic apply
  // enabled unless all runtime steps are explicitly disabled.
  internals.materializeDomesticBootstrapSubscription = forbidRuntime('bootstrap-materialize');
  internals.adminDomesticRuntimeConfigApplyResult = forbidRuntime('domestic-runtime');
  internals.adminInternalServicePeerDomesticKeySyncResult = forbidRuntime('domestic-peer-key-sync');
  const audits: Parameters<MemoryStore['recordAudit']>[0][] = [];
  const recordAudit = store.recordAudit.bind(store);
  store.recordAudit = (input) => { audits.push(input); return recordAudit(input); };
  return { store, controller, internals, before, runtimeCalls, audits };
}

function assertSharedStatePreserved(f: ReturnType<typeof fixture>) {
  const after = f.store.getSiteSlotDomesticWireGuardSecret('domestic-main');
  assert.ok(after);
  for (const key of keyFields) assert.equal(after[key], f.before[key], `${key} must not change`);
  assert.equal(after.publicEndpoint, f.before.publicEndpoint);
  for (const cidr of f.before.productRelayCidrs ?? []) {
    assert.ok(after.productRelayCidrs?.includes(cidr), `existing relay CIDR ${cidr} must remain`);
  }
  assert.ok(after.productRelayCidrs?.includes('10.94.0.0/16'), 'Rig CIDR is appended to Config Center');
  assert.deepEqual(f.runtimeCalls, []);
}

test('reconcile blocks incomplete shared key material without generating replacement keys or applying runtime', async () => {
  for (const missingKey of keyFields) {
    const f = fixture(missingKey);
    const result = await f.controller.reconcileLauncherServiceVip({ siteId: 'domestic-main', appId: 'mx-rig' });
    assert.equal(result.reconcile.status, 'blocked');
    assert.match(result.reconcile.blockedReasons.join('\n'), /key pair is incomplete/);
    assert.equal(result.domesticWgMaterialize?.status, 'blocked');
    assert.deepEqual(result.domesticWgMaterialize?.generated, {
      domesticRelayKeyPair: false, internalServiceKeyPair: false
    });
    assert.equal(result.domesticRuntimeApply, null);
    assert.equal(result.internalServicePeerApply, null);
    assert.equal(result.domesticPeerKeySync, null);
    assertSharedStatePreserved(f);
    assert.equal(f.audits.find(audit => audit.eventType === 'launcher.service_vip.reconciled')?.metadata?.status, 'blocked');
  }
});

test('non-passed materialization stops every runtime step and records the reconcile outcome', async () => {
  for (const status of ['failed', 'blocked', 'ready']) {
    const f = fixture();
    f.internals.materializeDomesticWireGuard = async (_siteId, _plan, secret) => ({
      secret,
      result: { status, blockedReasons: status === 'blocked' ? ['artifact prerequisite missing'] : [] }
    });
    const result = await f.controller.reconcileLauncherServiceVip({ siteId: 'domestic-main', appId: 'mx-rig' });
    assert.equal(result.reconcile.status, status);
    assert.equal(result.domesticWgMaterialize?.status, status);
    assert.equal(result.domesticRuntimeApply, null);
    assert.equal(result.internalServicePeerApply, null);
    assert.equal(result.domesticPeerKeySync, null);
    assertSharedStatePreserved(f);
    assert.equal(f.audits.find(audit => audit.eventType === 'launcher.service_vip.reconciled')?.metadata?.status, status);
  }
});

test('reconcile requires preserved keys and keeps existing CIDRs when successful runtime steps are disabled', async () => {
  const f = fixture();
  let materializeBody: Record<string, unknown> | undefined;
  f.internals.materializeDomesticWireGuard = async (_siteId, _plan, secret, body) => {
    materializeBody = body;
    return { secret, result: { status: 'passed' } };
  };
  const result = await f.controller.reconcileLauncherServiceVip({
    siteId: 'domestic-main', appId: 'mx-rig',
    applyDomesticRuntime: false, applyInternalServicePeer: false, syncDomesticPeerKey: false,
    // Product onboarding must not forward a caller's rotation request.
    rotateAll: true, confirmRotate: true, preserveExistingKeys: false
  });
  assert.equal(materializeBody?.preserveExistingKeys, true);
  assert.equal(materializeBody?.rotateAll, undefined);
  assert.equal(materializeBody?.confirmRotate, undefined);
  assert.equal(result.reconcile.status, 'passed');
  assert.equal(result.domesticRuntimeApply, null);
  assert.equal(result.internalServicePeerApply, null);
  assert.equal(result.domesticPeerKeySync, null);
  assertSharedStatePreserved(f);
  assert.equal(f.audits.find(audit => audit.eventType === 'launcher.service_vip.reconciled')?.metadata?.status, 'passed');
});
