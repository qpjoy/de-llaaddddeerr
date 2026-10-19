import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditEvent } from '../types.js';
import { ObservationalAuditQueue } from './observational-audit.js';

function event(id: number): AuditEvent {
  return {
    provenance: 'server', eventId: `aud_${id}`, eventType: 'auth.token.introspected',
    actorKind: 'user', userId: 'user_test', anonymousPrincipalId: null,
    installId: null, deviceId: null, productId: null, siteId: 'test',
    requestId: `request_${id}`, traceId: null, overlayIp: null, configSnapshotId: null,
    environment: 'test', metadata: { active: true }, createdAt: '2026-10-19T01:00:00.000Z'
  };
}

test('observations wait for the batch interval and retain enqueue-time metadata', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const batches: AuditEvent[][] = [];
  const queue = new ObservationalAuditQueue(async (rows) => { batches.push(rows); }, () => {});
  t.after(() => queue.close());
  const first = event(0);
  queue.enqueue(first);
  first.metadata!.active = false;
  for (let i = 1; i < 150; i++) queue.enqueue(event(i));
  t.mock.timers.tick(249);
  await Promise.resolve();
  assert.equal(batches.length, 0);
  t.mock.timers.tick(1);
  await queue.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 100);
  assert.deepEqual(batches[0][0], event(0));
  t.mock.timers.tick(250);
  await queue.flush();
  assert.equal(batches[1].length, 50);
});

test('a hung database write keeps exactly one writer and bounds in-flight plus pending events', async (t) => {
  const saved: AuditEvent[] = [];
  const warnings: unknown[] = [];
  let release!: () => void;
  let writers = 0;
  let maxWriters = 0;
  let calls = 0;
  const queue = new ObservationalAuditQueue(async (rows) => {
    calls++;
    maxWriters = Math.max(maxWriters, ++writers);
    assert.ok(rows.length <= 100);
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    saved.push(...rows);
    writers--;
  }, (warning) => { warnings.push(warning); });
  t.after(() => queue.close());
  queue.enqueue(event(0));
  const blocked = queue.flush();
  await Promise.resolve();
  for (let i = 1; i <= 2000; i++) queue.enqueue(event(i));
  assert.equal(queue.flush(), blocked);
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1, 'overflow warnings are throttled');
  release();
  await blocked;
  for (let i = 0; i < 10; i++) await queue.flush();
  assert.equal(maxWriters, 1);
  assert.equal(saved.length, 1000, 'the in-flight event consumes capacity too');
  assert.deepEqual(saved.map((row) => row.eventId), Array.from({ length: 1000 }, (_, i) => `aud_${i}`));
  queue.enqueue(event(3000));
  await queue.flush();
  assert.equal(saved.at(-1)!.eventId, 'aud_3000', 'capacity is released after completion');
});

test('payload bytes are bounded independently of event count, and oversized observations are dropped', async (t) => {
  const saved: AuditEvent[] = [];
  const queue = new ObservationalAuditQueue(async (rows) => { saved.push(...rows); }, () => {});
  t.after(() => queue.close());
  queue.enqueue({ ...event(-1), requestId: 'x'.repeat(17 * 1024) });
  for (let i = 0; i < 500; i++) queue.enqueue({ ...event(i), requestId: 'x'.repeat(15 * 1024) });
  for (let i = 0; i < 5; i++) await queue.flush();
  assert.ok(saved.length > 100 && saved.length < 150);
  assert.ok(saved.every((row) => row.eventId !== 'aud_-1'));
  const bytes = saved.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.ok(bytes <= 2 * 1024 * 1024);
  assert.ok(bytes + Buffer.byteLength(JSON.stringify(saved[0])) > 2 * 1024 * 1024);
});

test('failed batches are handled without retrying ambiguous writes, and the next batch backs off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const attempts: AuditEvent[][] = [];
  const warnings: unknown[] = [];
  const queue = new ObservationalAuditQueue(async (rows) => {
    attempts.push(rows);
    if (attempts.length === 1) throw new Error('secret SQL parameter and connection string');
  }, (warning) => { warnings.push(warning); });
  t.after(() => queue.close());
  queue.enqueue({ ...event(1), requestId: 'private request input' });
  await queue.flush();
  queue.enqueue(event(2));
  await queue.flush();
  assert.equal(attempts.length, 1);
  t.mock.timers.tick(4999);
  await queue.flush();
  assert.equal(attempts.length, 1);
  t.mock.timers.tick(1);
  await queue.flush();
  assert.deepEqual(attempts.map((rows) => rows.map((row) => row.eventId)), [['aud_1'], ['aud_2']]);
  assert.deepEqual(warnings, [{ event: 'audit.observation.degraded', reason: 'write-failed',
    droppedEvents: 0, failedEvents: 1, bufferedEvents: 1 }]);
  assert.doesNotMatch(JSON.stringify(warnings), /secret|SQL|private request/);
});

test('closing discards pending work and handles a later in-flight rejection without spawning more writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let reject!: (reason: Error) => void;
  let writes = 0;
  const queue = new ObservationalAuditQueue(() => {
    writes++;
    return new Promise<void>((_resolve, fail) => { reject = fail; });
  }, () => {});
  queue.enqueue(event(1));
  const pending = queue.flush();
  await Promise.resolve();
  queue.enqueue(event(2));
  queue.close();
  reject(new Error('database unavailable'));
  await pending;
  queue.enqueue(event(3));
  t.mock.timers.tick(60_000);
  await queue.flush();
  assert.equal(writes, 1);
});

test('serialization and warning-sink failures never escape to authentication', async (t) => {
  let writes = 0;
  const queue = new ObservationalAuditQueue(async () => { writes++; }, () => { throw new Error('logger failed'); });
  t.after(() => queue.close());
  const circular = event(1);
  circular.metadata!.self = circular;
  assert.doesNotThrow(() => queue.enqueue(circular));
  queue.enqueue(event(2));
  await queue.flush();
  assert.equal(writes, 1);
});
