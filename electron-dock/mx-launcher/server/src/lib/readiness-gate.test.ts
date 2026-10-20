import assert from 'node:assert/strict';
import test from 'node:test';

import { ReadinessGate } from './readiness-gate.js';

// Each database check takes the outcome configured when it starts.
function scriptedCheck() {
  let outcome: 'ok' | 'fail' | 'hang' = 'ok';
  let calls = 0;
  const hanging: Array<() => void> = [];
  const check = () => {
    calls += 1;
    if (outcome === 'ok') return Promise.resolve();
    if (outcome === 'fail') return Promise.reject(new Error('db'));
    return new Promise<void>((resolve) => { hanging.push(resolve); });
  };
  return {
    check,
    calls: () => calls,
    next: (value: typeof outcome) => { outcome = value; },
    releaseHanging: () => { for (const resolve of hanging.splice(0)) resolve(); }
  };
}

test('nothing is ready before the first successful database check', async () => {
  const db = scriptedCheck();
  const gate = new ReadinessGate(db.check, { waitMs: 20, graceMs: 60_000 });
  db.next('hang');
  assert.deepEqual(await gate.state(), { ready: false, degraded: true });
  db.releaseHanging();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fresh = new ReadinessGate(db.check, { waitMs: 20, graceMs: 60_000 });
  db.next('fail');
  assert.deepEqual(await fresh.state(), { ready: false, degraded: true });
});

test('after a success, a slow database keeps readiness without stacking checks', async () => {
  const db = scriptedCheck();
  let now = 1_000;
  const gate = new ReadinessGate(db.check, { waitMs: 20, graceMs: 60_000 }, () => now);
  assert.deepEqual(await gate.state(), { ready: true, degraded: false });

  db.next('hang');
  now += 30_000;
  const probes = await Promise.all([gate.state(), gate.state(), gate.state()]);
  assert.ok(probes.every((probe) => probe.ready && probe.degraded));
  assert.equal(db.calls(), 2, 'one in-flight check is shared by every probe');

  now += 31_000;
  assert.deepEqual(await gate.state(), { ready: false, degraded: true });
  assert.equal(db.calls(), 2, 'still the same hung check');

  db.next('ok');
  db.releaseHanging();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await gate.state(), { ready: true, degraded: false });
});

test('failures within the grace keep a previously ready service in rotation', async () => {
  const db = scriptedCheck();
  let now = 5_000;
  const gate = new ReadinessGate(db.check, { waitMs: 20, graceMs: 60_000 }, () => now);
  await gate.state();
  db.next('fail');
  now += 59_000;
  assert.deepEqual(await gate.state(), { ready: true, degraded: true });
  now += 2_000;
  assert.deepEqual(await gate.state(), { ready: false, degraded: true });
});
