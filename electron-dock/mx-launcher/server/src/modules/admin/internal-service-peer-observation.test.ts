import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type {
  SiteSlotDomesticWireGuardSecret,
  SiteSlotInternalServicePeerObservation,
  SiteSlotPlan,
  SiteSlotWorkerReport
} from '../../types.js';
import {
  internalServicePeerObservationClearsWarning,
  internalServicePeerObservationInput
} from './internal-service-peer-observation.js';
import { AdminController } from './admin.controller.js';

const plan = {
  planId: 'slotplan_current',
  siteId: 'domestic-main',
  kind: 'domestic'
} as SiteSlotPlan;

const secret = {
  siteId: 'domestic-main',
  domesticRelayPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
  internalServicePublicKey: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
  fingerprints: {
    materialDigest: 'wg-material-current'
  }
} as SiteSlotDomesticWireGuardSecret;

const report = {
  reportId: 'slotreport_warning',
  createdAt: '2026-07-29T05:36:00.000Z'
} as SiteSlotWorkerReport;

function observation(
  input: Partial<SiteSlotInternalServicePeerObservation> = {}
): SiteSlotInternalServicePeerObservation {
  return {
    observationId: 'internalpeerobs_slotplan_current',
    siteId: 'domestic-main',
    planId: 'slotplan_current',
    materialDigest: 'wg-material-current',
    workerReportId: 'slotreport_warning',
    status: 'passed',
    sourceAction: 'site-slot.internal-service-peer.status',
    blockedReasons: [],
    checkedAt: '2026-07-29T05:37:00.000Z',
    recordedBy: 'user:usr_demo_admin',
    recordedAt: '2026-07-29T05:37:00.000Z',
    ...input
  };
}

test('builds a bounded observation input from runtime status without secret material', () => {
  const input = internalServicePeerObservationInput(
    'site-slot.internal-service-peer.status',
    'domestic-main',
    plan,
    secret,
    {
      status: 'passed',
      siteId: 'domestic-main',
      planId: 'slotplan_current',
      checkedAt: '2026-07-29T05:37:00.000Z',
      blockedReasons: [],
      interface: {
        livePublicKey: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
        livePeerPublicKeys: ['BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=']
      }
    },
    report,
    'user:usr_demo_admin'
  );
  assert.deepEqual(input, {
    siteId: 'domestic-main',
    planId: 'slotplan_current',
    materialDigest: 'wg-material-current',
    workerReportId: 'slotreport_warning',
    status: 'passed',
    sourceAction: 'site-slot.internal-service-peer.status',
    blockedReasons: [],
    checkedAt: '2026-07-29T05:37:00.000Z',
    requestedBy: 'user:usr_demo_admin'
  });
});

test('fresh matching passed observation clears the historical worker warning', () => {
  assert.equal(internalServicePeerObservationClearsWarning(plan, report, secret, observation()), true);
});

test('wrong report, non-passed, wrong-plan, and wrong-key observations do not clear the warning', () => {
  assert.equal(internalServicePeerObservationClearsWarning(
    plan,
    report,
    secret,
    observation({ workerReportId: 'slotreport_old' })
  ), false);
  assert.equal(internalServicePeerObservationClearsWarning(
    plan,
    report,
    secret,
    observation({ status: 'ready' })
  ), false);
  assert.equal(internalServicePeerObservationClearsWarning(
    plan,
    report,
    secret,
    observation({ planId: 'slotplan_old' })
  ), false);
  assert.equal(internalServicePeerObservationClearsWarning(
    plan,
    report,
    secret,
    observation({ materialDigest: 'wg-material-old' })
  ), false);
});

test('ensure top-level success is not accepted when afterStatus is absent or invalid', () => {
  assert.equal(internalServicePeerObservationInput(
    'site-slot.internal-service-peer.host-runner.ensure',
    'domestic-main',
    plan,
    secret,
    { execution: 'completed' },
    report,
    'user:usr_demo_admin'
  ), null);
});

test('a healthy old interface key cannot become passed evidence for the current secret', () => {
  const input = internalServicePeerObservationInput(
    'site-slot.internal-service-peer.status',
    'domestic-main',
    plan,
    secret,
    {
      status: 'passed',
      siteId: 'domestic-main',
      planId: 'slotplan_current',
      checkedAt: '2026-07-29T05:37:00.000Z',
      blockedReasons: [],
      interface: {
        wgShow: {
          stdout: [
            'interface: mx-internal-svc',
            '  public key: EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=',
            'peer: BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
          ].join('\n')
        }
      }
    },
    report,
    'user:usr_demo_admin'
  );
  assert.equal(input?.status, 'blocked');
  assert.match(input?.blockedReasons?.[0] ?? '', /does not match/);
});

test('a healthy interface with an old Domestic peer key cannot clear the current plan', () => {
  const input = internalServicePeerObservationInput(
    'site-slot.internal-service-peer.status',
    'domestic-main',
    plan,
    secret,
    {
      status: 'passed',
      siteId: 'domestic-main',
      planId: 'slotplan_current',
      checkedAt: '2026-07-29T05:37:00.000Z',
      blockedReasons: [],
      interface: {
        livePublicKey: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
        livePeerPublicKeys: ['EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=']
      }
    },
    report,
    'user:usr_demo_admin'
  );
  assert.equal(input?.status, 'blocked');
  assert.match(input?.blockedReasons?.[0] ?? '', /Domestic relay key/);
});

test('an older concurrent status result cannot overwrite a newer observation', async () => {
  const store = new MemoryStore(loadConfig());
  const newer = await store.upsertSiteSlotInternalServicePeerObservation({
    siteId: 'domestic-main',
    planId: 'slotplan_current',
    materialDigest: 'wg-material-current',
    workerReportId: 'slotreport_warning',
    status: 'passed',
    sourceAction: 'site-slot.internal-service-peer.status',
    checkedAt: '2026-07-29T05:38:00.000Z',
    requestedBy: 'test'
  });
  const persisted = await store.upsertSiteSlotInternalServicePeerObservation({
    siteId: 'domestic-main',
    planId: 'slotplan_current',
    materialDigest: 'wg-material-current',
    workerReportId: 'slotreport_warning',
    status: 'ready',
    sourceAction: 'site-slot.internal-service-peer.status',
    checkedAt: '2026-07-29T05:37:00.000Z',
    requestedBy: 'test'
  });
  assert.equal(persisted.recordedAt, newer.recordedAt);
  assert.equal(persisted.status, 'passed');
});

test('a persisted fresh passed observation removes the repeated Status gate', async () => {
  const store = new MemoryStore(loadConfig());
  const controller = new AdminController(store);
  const createdPlan = await store.createSiteSlotPlan({
    siteId: 'domestic-observation-test',
    kind: 'domestic',
    host: '116.62.51.154',
    sshUser: 'root',
    rootAccess: true,
    hasDocker: true,
    hasOutboundInternet: true,
    createdBy: 'test'
  });
  const createdSecret = await store.upsertSiteSlotDomesticWireGuardSecret({
    siteId: createdPlan.siteId,
    publicEndpoint: '116.62.51.154:51280',
    domesticRelayPrivateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    domesticRelayPublicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    internalServicePrivateKey: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
    internalServicePublicKey: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
    requestedBy: 'test'
  });
  const preflight = await store.createSiteSlotExecution({
    planId: createdPlan.planId,
    action: 'preflight',
    mode: 'dry-run',
    requestedBy: 'test'
  });
  assert.equal(preflight.status, 'ready');
  const apply = await store.createSiteSlotExecution({
    planId: createdPlan.planId,
    action: 'apply',
    mode: 'manual',
    confirmApply: true,
    requestedBy: 'test'
  });
  const session = await store.startSiteSlotRunnerSession({
    runId: apply.runId,
    mode: 'simulate',
    requestedBy: 'test'
  });
  const job = await store.createSiteSlotWorkerJob({
    sessionId: session.sessionId,
    requestedBy: 'test'
  });
  const warningStep = job.steps.find((step) => step.sourceId === 'sync-internal-config.2');
  assert.ok(warningStep, 'Domestic worker job must include sync-internal-config.2');
  const warningReport = await store.recordSiteSlotWorkerReport({
    jobId: job.jobId,
    status: 'passed',
    stepReports: [{
      stepId: warningStep.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: 'Internal is not reachable: No route to host',
      stderr: ''
    }],
    requestId: 'worker-warning'
  });

  const before = await controller.siteSlotPipelines(undefined, '20', undefined, undefined);
  const blocked = before.pipelines.find((pipeline) => pipeline.summary.planId === createdPlan.planId);
  assert.equal(blocked?.summary.health, 'blocked');
  assert.ok(blocked?.summary.actionHints.some(
    (action) => action.actionId === 'site-slot.internal-service-peer.status'
  ));

  await store.upsertSiteSlotInternalServicePeerObservation({
    siteId: createdPlan.siteId,
    planId: createdPlan.planId,
    materialDigest: createdSecret.fingerprints.materialDigest,
    workerReportId: warningReport.reportId,
    status: 'passed',
    sourceAction: 'site-slot.internal-service-peer.status',
    checkedAt: new Date().toISOString(),
    requestedBy: 'test'
  });

  const after = await controller.siteSlotPipelines(undefined, '20', undefined, undefined);
  const passed = after.pipelines.find((pipeline) => pipeline.summary.planId === createdPlan.planId);
  assert.equal(passed?.summary.health, 'passed');
  assert.equal(passed?.summary.actionHints.some(
    (action) => action.actionId === 'site-slot.internal-service-peer.status'
  ), false);
});
