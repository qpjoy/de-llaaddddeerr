import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { loadConfig } from '../../config.js';
import { internalAdminContext } from '../../lib/internal-admin-context.js';
import { updateReleaseManagementPlanMetadata } from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import type { AuditEventInput, ReleaseManagementPlan } from '../../types.js';
import { evaluateReleaseCheck } from './release-check.js';
import { ReleaseController } from './release.controller.js';

function fixture() {
  const store = new MemoryStore({ ...loadConfig(), environment: 'release-withdrawal-test' });
  const plan = store.createReleaseManagementPlan({
    releaseId: 'mx-h2i-installer-3.0.1', productId: 'mx-h2i', appId: 'mx-h2i', channel: 'stable',
    launcherComponentId: 'mx-h2i', launcherUpdatePolicy: 'app-installer',
    launcherCurrentVersion: '3.0.0', launcherTargetVersion: '3.0.1',
    artifactKind: 'app-installer', artifactVersion: '3.0.1',
    artifactUrl: 'https://example.invalid/MinCave-3.0.1.dmg', artifactDigest: `sha256:${'a'.repeat(64)}`,
    artifactPlatform: 'darwin', artifactArch: 'universal', artifactFileName: 'MinCave-3.0.1.dmg',
    rolloutStrategy: 'all', rolloutPercentage: 100, e2eResult: 'passed'
  });
  const controller = new ReleaseController(store);
  const check = (candidate: ReleaseManagementPlan, version = '3.0.0') => evaluateReleaseCheck([candidate], {
    installId: 'test-install', userId: 'test-user', productId: 'mx-h2i', channel: 'stable',
    platform: 'darwin', arch: 'arm64', components: { 'mx-h2i': version }
  });
  const history = () => controller.releaseHistory({ componentId: 'mx-h2i', channel: 'stable', platform: 'darwin', arch: 'arm64' });
  return { store, plan, controller, check, history };
}

test('withdrawal hides published installers from checks/history and restoration preserves their metadata', async t => {
  const f = fixture();
  const audits: AuditEventInput[] = [];
  const recordAudit = f.store.recordAudit.bind(f.store);
  t.mock.method(f.store, 'recordAudit', (input: AuditEventInput) => { audits.push(input); return recordAudit(input); });
  assert.equal(f.plan.withdrawnAt, undefined, 'legacy records remain active');
  assert.equal(f.check(f.plan).status, 'update-available');
  assert.equal(f.check(f.plan, '3.0.1').status, 'up-to-date', 'no same-version automatic update');
  assert.equal((await f.history()).releases.length, 1);

  const withdrawn = f.store.updateReleaseManagementPlan(f.plan.planId, { withdrawn: true, updatedBy: 'admin-1', requestId: 'withdraw-1' });
  assert.ok(withdrawn.withdrawnAt);
  assert.equal(withdrawn.withdrawnBy, 'admin-1');
  assert.equal(f.check(withdrawn).status, 'up-to-date');
  assert.equal(f.check({ ...withdrawn, rollout: { ...withdrawn.rollout, audience: { ...withdrawn.rollout.audience, installIds: ['test-install'], userIds: ['test-user'] } } }).status, 'up-to-date', 'explicit targets cannot bypass withdrawal');
  assert.equal((await f.history()).releases.length, 0);
  assert.equal(f.store.listReleaseManagementPlans()[0].planId, f.plan.planId, 'admin registry retains the record');
  assert.deepEqual(withdrawn.artifacts, f.plan.artifacts);
  assert.deepEqual(withdrawn.rollout, f.plan.rollout);
  assert.deepEqual(withdrawn.test, f.plan.test);

  const edited = f.store.updateReleaseManagementPlan(f.plan.planId, { releaseNotes: 'Corrected release notes', updatedBy: 'admin-2' });
  assert.equal(edited.withdrawnAt, withdrawn.withdrawnAt);
  assert.equal(edited.withdrawnBy, 'admin-1');
  assert.equal(f.check(edited).status, 'up-to-date');
  const repeated = updateReleaseManagementPlanMetadata(edited, { withdrawn: true, updatedBy: 'admin-3' }, '2099-01-01T00:00:00.000Z');
  assert.equal(repeated.withdrawnAt, withdrawn.withdrawnAt, 'retries do not replace the original withdrawal');
  assert.equal(repeated.withdrawnBy, 'admin-1');

  const restored = f.store.updateReleaseManagementPlan(f.plan.planId, { withdrawn: false, updatedBy: 'admin-2', requestId: 'restore-1' });
  assert.equal(restored.withdrawnAt, null);
  assert.equal(restored.withdrawnBy, null);
  assert.equal(restored.releaseNotes, 'Corrected release notes');
  assert.deepEqual(restored.artifacts, f.plan.artifacts);
  assert.deepEqual(restored.rollout, f.plan.rollout);
  assert.equal(f.check(restored).status, 'update-available');
  assert.equal((await f.history()).releases.length, 1);
  assert.deepEqual(audits.map(row => row.eventType), ['release.management_plan.withdrawn', 'release.management_plan.updated', 'release.management_plan.restored']);
  assert.equal(audits[2].metadata?.previousWithdrawnAt, withdrawn.withdrawnAt);
  assert.equal(audits[2].metadata?.previousWithdrawnBy, 'admin-1');
  assert.equal(audits[2].metadata?.updatedBy, 'admin-2');
});

test('withdrawal PATCH retains Ops/SSO authorization and rejects malformed lifecycle values', async t => {
  const previousToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'withdrawal-test-ops-token';
  t.after(() => { if (previousToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN; else process.env.MX_INTERNAL_OPS_TOKEN = previousToken; });
  const f = fixture();
  const request = (token?: string) => ({ headers: token ? { 'x-mx-ops-token': token } : {} }) as IncomingMessage;
  const status = (expected: number) => (error: unknown) => (error as { getStatus(): number }).getStatus() === expected;
  await assert.rejects(f.controller.updateManagementPlan(request(), f.plan.planId, { withdrawn: true, updatedBy: 'mx-admin' }), status(401));
  await assert.rejects(f.controller.updateManagementPlan(request('wrong'), f.plan.planId, { withdrawn: true }), status(401));
  assert.equal(f.store.getReleaseManagementPlan(f.plan.planId)?.withdrawnAt, undefined);
  const ops = request(process.env.MX_INTERNAL_OPS_TOKEN);
  for (const value of ['true', 'false', 0, 1, null, [], {}]) {
    await assert.rejects(f.controller.updateManagementPlan(ops, f.plan.planId, { withdrawn: value }), status(400));
  }
  await assert.rejects(f.controller.updateManagementPlan(ops, 'missing-plan', { withdrawn: true }), status(404));
  const { plan: withdrawn } = await f.controller.updateManagementPlan(ops, f.plan.planId, { withdrawn: true, updatedBy: 'forged-user' });
  assert.equal(withdrawn.withdrawnBy, 'internal-ops');
  const edited = await f.controller.updateManagementPlan(ops, f.plan.planId, { releaseNotes: 'Correction', withdrawnAt: null, artifactUrl: 'https://evil.invalid', launcherTargetVersion: '9.9.9' });
  assert.equal(edited.plan.withdrawnAt, withdrawn.withdrawnAt);
  assert.deepEqual(edited.plan.artifacts, f.plan.artifacts);
  assert.deepEqual(edited.plan.components, f.plan.components);
  const { plan: restored } = await internalAdminContext.run({ userId: 'verified-admin', requestId: 'trusted-request' }, () =>
    f.controller.updateManagementPlan(request(), f.plan.planId, { withdrawn: false, updatedBy: 'forged-user', requestId: 'forged-request' }));
  assert.equal(restored.withdrawnAt, null);
  assert.equal(restored.updatedBy, 'verified-admin');
  const { plan: ssoWithdrawn } = await internalAdminContext.run({ userId: 'verified-admin', requestId: 'trusted-request-2' }, () =>
    f.controller.updateManagementPlan(request(), f.plan.planId, { withdrawn: true, updatedBy: 'forged-user' }));
  assert.equal(ssoWithdrawn.withdrawnBy, 'verified-admin');
});
