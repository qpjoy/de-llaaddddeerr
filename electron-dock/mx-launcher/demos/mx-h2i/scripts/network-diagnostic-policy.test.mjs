import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { networkDiagnosticsProblem, windowsNrptOwnershipConflictMessage } = require('../src/network-diagnostic-policy.cjs');
const publicResolution = { severity: 'ok', ok: true, message: 'disconnected 状态已回到系统/外部解析路径。' };
const internalResolution = { severity: 'ok', ok: true, message: '已由 V2 split DNS 指向 Internal。' };
const cleanDisconnected = {
  ready: false, state: 'rules-missing', totalOwnedRuleCount: 0, globalRestorePending: false,
  namespaces: [], missingNamespaces: ['mxinfo-inc.cn'], profileMissingSplitDns: true
};
const conflict = {
  ready: false, state: 'name-server-mismatch', totalOwnedRuleCount: 2,
  namespaces: ['mxinfo-inc.cn', '.mxinfo-inc.cn'].map(namespace => ({
    namespace, ready: false, ownedRuleCount: 1, legacyAmbiguousRuleCount: 0,
    expectedNameServers: ['10.88.0.1'], installedNameServers: ['10.88.0.1'],
    foreignOwners: ['MX HDO / QPJoy HDO hdo-client'],
    conflictingRules: [{ owner: 'MX HDO / QPJoy HDO hdo-client', nameServers: ['100.88.0.1'] }]
  }))
};

test('normal disconnected/bootstrap DNS does not warn about absent not-yet-needed MX rules', () => {
  for (const phase of ['disconnected', 'bootstrap']) {
    assert.equal(networkDiagnosticsProblem({ phase, resolution: publicResolution, windowsNrpt: cleanDisconnected }), null);
  }
  assert.equal(networkDiagnosticsProblem({ phase: 'disconnected', resolution: publicResolution,
    windowsNrpt: { ...cleanDisconnected, namespaces: conflict.namespaces.map(row => ({ ...row, ownedRuleCount: 0, installedNameServers: [] })) } }), null);
});

test('real DNS errors and MX-owned disconnect residue remain visible', () => {
  for (const phase of ['disconnected', 'bootstrap', 'connected']) {
    for (const severity of ['error', 'warning']) {
      const dnsError = networkDiagnosticsProblem({ phase, resolution: { severity, ok: false, state: 'unresolved', message: 'DNS timeout' }, windowsNrpt: cleanDisconnected });
      assert.deepEqual(dnsError, { level: severity, message: 'DNS timeout' });
    }
  }
  for (const residue of [{ totalOwnedRuleCount: 1 }, { globalRestorePending: true }, { legacyAmbiguousRuleCount: 1 }]) {
    assert.match(networkDiagnosticsProblem({ phase: 'disconnected', resolution: publicResolution,
      windowsNrpt: { ...cleanDisconnected, ...residue } }).message, /清理尚未确认/);
  }
  for (const phase of ['disconnected', 'bootstrap', 'connected']) {
    const problem = networkDiagnosticsProblem({ phase, resolution: publicResolution,
      windowsNrpt: { ...cleanDisconnected, state: 'probe-failed', error: 'PowerShell timeout' } });
    assert.equal(problem.level, 'warning');
    assert.match(problem.message, /尚无法确认.*PowerShell timeout/);
  }
});

test('successful DNS cannot hide the owner conflict or change readiness', () => {
  const before = structuredClone(conflict);
  const problem = networkDiagnosticsProblem({ phase: 'connected', resolution: internalResolution, windowsNrpt: conflict });
  assert.equal(problem.level, 'warning');
  for (const value of ['mxinfo-inc.cn', '.mxinfo-inc.cn', '10.88.0.1', '100.88.0.1', 'MX HDO', '不会自动删除']) {
    assert.ok(problem.message.includes(value), value);
  }
  assert.ok(!problem.message.includes(internalResolution.message));
  assert.deepEqual(conflict, before);
  assert.equal(networkDiagnosticsProblem({ phase: 'connected', resolution: internalResolution, windowsNrpt: cleanDisconnected }).level, 'warning');
});

test('older core metadata still identifies owners without inventing their DNS', () => {
  const old = { ...conflict, namespaces: conflict.namespaces.map(({ conflictingRules, ...row }) => row) };
  const message = windowsNrptOwnershipConflictMessage(old);
  assert.match(message, /MX HDO/);
  assert.ok(!message.includes('100.88.0.1'));
  assert.equal(windowsNrptOwnershipConflictMessage({ namespaces: old.namespaces.map(row => ({ ...row, installedNameServers: ['10.88.0.2'] })) }), null);
  assert.equal(windowsNrptOwnershipConflictMessage({ namespaces: old.namespaces.map(row => ({ ...row, ready: true })) }), null);
});
