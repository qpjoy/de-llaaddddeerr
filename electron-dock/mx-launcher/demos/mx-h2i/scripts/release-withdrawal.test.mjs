import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main-runtime.cjs', import.meta.url), 'utf8');
const functionSource = source.slice(
  source.indexOf('function availableReleaseFromPlan('),
  source.indexOf('\nfunction mergeAvailableRelease(')
);
const availableReleaseFromPlan = vm.runInNewContext(`(${functionSource})`, {
  launcherProductId: () => 'mx-h2i',
  nullableString: value => typeof value === 'string' && value.trim() || null,
  normalizeReleaseDeliveryMode: value => value || 'prompt-download-restart',
  runtime: { config: { releaseChannel: 'stable' } }
});
const decision = { componentId: 'mx-h2i', componentKind: 'app-installer', targetVersion: '3.0.1' };
const artifact = { artifactId: 'installer', kind: 'app-installer', version: '3.0.1', url: 'https://download.example.test/app.dmg' };

test('withdrawn plans cannot reappear through the MX-H2I history fallback or explicit update result', () => {
  const withdrawn = { planId: 'withdrawn', releaseId: 'withdrawn', withdrawnAt: '2026-11-19T12:00:00.000Z' };
  assert.equal(availableReleaseFromPlan(withdrawn), null);
  assert.equal(availableReleaseFromPlan(withdrawn, decision, artifact, 'update-available'), null);
});

test('active and legacy plans keep their existing installer history metadata', () => {
  for (const withdrawnAt of [null, undefined]) {
    const active = { planId: 'active', releaseId: 'active', withdrawnAt, test: { gate: { verdict: 'passed' } } };
    const result = availableReleaseFromPlan(active, decision, artifact);
    assert.equal(result.planId, 'active');
    assert.equal(result.status, 'ready');
    assert.equal(result.version, '3.0.1');
    assert.equal(result.artifactUrl, artifact.url);
  }
});
