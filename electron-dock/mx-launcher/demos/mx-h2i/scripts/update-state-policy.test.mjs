#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  reconcileRuntimeUpdateWithInstalledVersion
} = require('../src/update-state-policy.cjs');

const history = [{ kind: 'major-download', version: '2.0.9' }];
const rollbackSlots = [{ slot: 'app', version: '2.0.6' }];
const reconciled = reconcileRuntimeUpdateWithInstalledVersion({
  currentVersion: '2.0.6',
  latestVersion: '2.0.9',
  status: 'installer-opened',
  updateAvailable: true,
  restartPrompt: true,
  restartRequired: true,
  majorUpdateRequiresInstaller: true,
  stagedPath: '/tmp/MX-H2I-2.0.9.dmg',
  artifactKind: 'app-installer',
  artifactUrl: 'https://internal.invalid/MX-H2I-2.0.9.dmg',
  downloadProgress: { state: 'downloaded', percent: 100 },
  history,
  rollbackSlots
}, '2.0.9');

assert.equal(reconciled.currentVersion, '2.0.9');
assert.equal(reconciled.latestVersion, '2.0.9');
assert.equal(reconciled.status, 'up-to-date');
assert.equal(reconciled.updateAvailable, false);
assert.equal(reconciled.restartPrompt, false);
assert.equal(reconciled.stagedPath, null);
assert.equal(reconciled.artifactUrl, null);
assert.equal(reconciled.downloadProgress, null);
assert.equal(reconciled.history, history, 'release history must survive installer reconciliation');
assert.equal(reconciled.rollbackSlots, rollbackSlots, 'rollback slots must survive installer reconciliation');
assert.deepEqual(
  reconcileRuntimeUpdateWithInstalledVersion(reconciled, '2.0.9'),
  reconciled,
  'the corrected persisted state must remain stable on the next startup'
);

const pendingNewer = reconcileRuntimeUpdateWithInstalledVersion({
  currentVersion: '2.0.9',
  latestVersion: '2.1.0',
  status: 'update-available',
  updateAvailable: true
}, '2.0.9');
assert.equal(pendingNewer.currentVersion, '2.0.9');
assert.equal(pendingNewer.latestVersion, '2.1.0');
assert.equal(pendingNewer.updateAvailable, true, 'a genuinely newer release must remain available');

const rolledBack = reconcileRuntimeUpdateWithInstalledVersion({
  currentVersion: '2.0.9',
  latestVersion: '2.0.9',
  status: 'up-to-date',
  updateAvailable: false,
  artifactKind: 'app-installer',
  artifactUrl: 'https://internal.invalid/MX-H2I-2.0.9.dmg'
}, '2.0.6');
assert.equal(rolledBack.currentVersion, '2.0.6');
assert.equal(rolledBack.latestVersion, '2.0.6');
assert.equal(rolledBack.status, 'needs-check');
assert.equal(rolledBack.updateAvailable, false);
assert.equal(rolledBack.artifactUrl, null, 'rollback startup must not retain a newer installer action');

const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main-runtime.cjs', import.meta.url)),
  'utf8'
);
assert.match(
  mainSource,
  /async function normalizeRuntime\(input\)[\s\S]*?reconcileRuntimeUpdateWithInstalledVersion\([\s\S]*?currentReleaseVersion\(\)[\s\S]*?update: normalizeUpdate\(reconciledUpdate, config\)/,
  'persisted runtime loading must reconcile against the active ASAR or base version before rendering'
);
assert.match(
  mainSource,
  /function normalizeUpdate\(input, config\)[\s\S]*?currentVersion: currentReleaseVersion\(\)/,
  'the visible update model must never prefer a stale persisted current version'
);

console.log('update state policy tests passed');
