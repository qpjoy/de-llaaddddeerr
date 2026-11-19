import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../config.js';
import type { PlatformRecordRow } from '../db/entities.js';
import type { ReleaseManagementPlan } from '../types.js';
import { MemoryStore } from './memory.js';
import { PostgresStore } from './postgres.js';

type Row = Pick<PlatformRecordRow, 'kind' | 'id' | 'environment' | 'siteId' | 'data'>;
type Lookup = { where: { kind: string; id: string; environment: string } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Exercise the real PostgresStore methods with independently staged writes and
// transaction-scoped keyed locks. Pausing the first plan read forces the stale
// read/write interleaving that used to lose metadata when a gate completed.
function harness(t: TestContext, options: { pause?: boolean; failAudit?: boolean } = {}) {
  const config = { ...loadConfig(), environment: 'release-concurrency-test', siteId: 'test-site' };
  const memory = new MemoryStore(config);
  const plan = memory.createReleaseManagementPlan({
    releaseId: 'mx-h2i-installer-3.0.1', productId: 'mx-h2i', appId: 'mx-h2i', channel: 'stable',
    launcherComponentId: 'mx-h2i', launcherUpdatePolicy: 'app-installer',
    launcherCurrentVersion: '3.0.0', launcherTargetVersion: '3.0.1',
    artifactKind: 'app-installer', artifactVersion: '3.0.1', artifactUrl: '/installer.dmg',
    artifactDigest: `sha256:${'a'.repeat(64)}`, artifactPlatform: 'darwin', artifactArch: 'universal',
    rolloutPercentage: 100, e2eResult: 'running'
  });
  const rows = new Map<string, Row>();
  const key = (row: { kind: string; id: string }) => `${row.kind}:${row.id}`;
  for (const [kind, id, data] of [
    ['release-management-plan', plan.planId, plan], ['test-run', plan.test.run.testRunId, plan.test.run]
  ] as const) rows.set(`${kind}:${id}`, { kind, id, environment: config.environment, siteId: config.siteId, data: structuredClone(data) as unknown as Record<string, unknown> });
  const firstRead = deferred();
  const releaseRead = deferred();
  const secondLockAttempt = deferred();
  t.after(() => releaseRead.resolve());
  const lockTails = new Map<string, Promise<void>>();
  const lockKeys: string[] = [];
  let transactionCount = 0;
  const read = (where: Lookup['where'], pending = new Map<string, Row>()) => {
    assert.equal(where.environment, config.environment);
    return structuredClone(pending.get(key(where)) ?? rows.get(key(where)) ?? null);
  };
  const rootRepository = {
    findOne: async ({ where }: Lookup) => read(where),
    save: async () => { throw new Error('release writes must participate in the transaction'); }
  };
  const dataSource = {
    async transaction<T>(action: (manager: object) => Promise<T>): Promise<T> {
      const transactionId = ++transactionCount;
      const pending = new Map<string, Row>();
      const unlock: Array<() => void> = [];
      const repository = {
        async findOne({ where }: Lookup) {
          const value = read(where, pending);
          if (options.pause && transactionId === 1 && where.kind === 'release-management-plan') {
            firstRead.resolve(); await releaseRead.promise;
          }
          return value;
        },
        async save(row: Row) {
          if (options.failAudit && row.kind === 'audit-event') throw new Error('audit storage unavailable');
          pending.set(key(row), structuredClone(row));
          return row;
        }
      };
      try {
        const result = await action({
          getRepository: () => repository,
          async query(sql: string, [lockKey]: string[]) {
            assert.match(sql, /pg_advisory_xact_lock/);
            lockKeys.push(lockKey);
            if (transactionId === 2) secondLockAttempt.resolve();
            const previous = lockTails.get(lockKey) ?? Promise.resolve();
            const held = deferred();
            lockTails.set(lockKey, previous.then(() => held.promise));
            await previous;
            unlock.push(held.resolve);
            return [];
          }
        });
        for (const [id, row] of pending) rows.set(id, row);
        return result;
      } finally {
        unlock.forEach(done => done());
      }
    }
  };
  const store = Reflect.construct(PostgresStore, [config, dataSource, rootRepository]) as PostgresStore;
  t.after(() => store.onModuleDestroy());
  return { store, plan, rows, firstRead, releaseRead, secondLockAttempt, lockKeys,
    saved: () => rows.get(`release-management-plan:${plan.planId}`)!.data as unknown as ReleaseManagementPlan };
}

for (const first of ['gate', 'withdrawal', 'metadata'] as const) {
  test(`concurrent ${first} and withdrawal/gate edits preserve the committed lifecycle and gate`, { timeout: 5000 }, async t => {
    const h = harness(t, { pause: true });
    const withdraw = () => h.store.updateReleaseManagementPlan(h.plan.planId, { withdrawn: true, updatedBy: 'verified-admin' });
    const gate = () => h.store.completeReleaseManagementGate(h.plan.planId, { status: 'passed' });
    const metadata = () => h.store.updateReleaseManagementPlan(h.plan.planId, { releaseNotes: 'Corrected notes', updatedBy: 'other-admin' });
    const firstWrite = first === 'gate' ? gate() : first === 'withdrawal' ? withdraw() : metadata();
    await h.firstRead.promise;
    const secondWrite = first === 'withdrawal' ? gate() : withdraw();
    await h.secondLockAttempt.promise;
    h.releaseRead.resolve();
    await Promise.all([firstWrite, secondWrite]);
    const saved = h.saved();
    assert.ok(saved.withdrawnAt, 'a concurrent edit must not reactivate the release');
    assert.equal(saved.withdrawnBy, 'verified-admin');
    assert.equal(saved.test.gate.verdict, first === 'metadata' ? h.plan.test.gate.verdict : 'passed');
    if (first === 'metadata') assert.equal(saved.releaseNotes, 'Corrected notes');
    assert.deepEqual(saved.artifacts, h.plan.artifacts);
    assert.deepEqual(saved.rollout, { ...h.plan.rollout, allowAutoPromote: saved.rollout.allowAutoPromote }, 'audience, percentage and strategy survive; the existing metadata update may recompute gate eligibility');
    assert.ok(h.lockKeys.filter(key => key.endsWith(`release-gate:${h.plan.planId}`)).length >= 2, 'metadata and gate writers coordinate on the same lock');
    const audit = [...h.rows.values()].find(row => row.kind === 'audit-event' && row.data.eventType === 'release.management_plan.withdrawn');
    assert.equal((audit?.data.metadata as Record<string, unknown>)?.withdrawnAt, saved.withdrawnAt);
  });
}

test('Postgres withdrawal and its audit commit or roll back together', async t => {
  const h = harness(t, { failAudit: true });
  await assert.rejects(h.store.updateReleaseManagementPlan(h.plan.planId, { withdrawn: true, updatedBy: 'verified-admin' }), /audit storage unavailable/);
  assert.equal(h.saved().withdrawnAt, undefined);
  assert.deepEqual(h.saved(), h.plan);
});
