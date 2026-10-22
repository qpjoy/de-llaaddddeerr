import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeployedAuth } from '../scripts/deploy-auth.mjs';

const settings = { clusterUid: '399f2349-3a34-48f4-8105-d7bae56ca136', node: 'mx-internal-server' };
const profile = { appId: 'mx-harbor', audience: 'mx-harbor', issuer: 'https://auth.minsight-ai.com/identity',
  origin: 'https://dataport.minsight-ai.com', clientId: 'private-client', clientSecret: 'private-secret', sessionKey: 'k'.repeat(43) };
const healthy = () => ({ ok: true, profile: { valid: true, category: 'valid', customCaConfigured: false },
  discovery: { status: 200, category: 'ok', jsonValid: true, issuerMatches: true },
  capabilities: { status: 200, category: 'ok', jsonValid: true, nativeForm: true, appIdMatches: true, originMatches: true, audienceMatches: true } });
const upstream = (name = 'capabilities', status = 502) => ({ ...healthy(), ok: false, [name]: { status, category: 'upstream_http_error' } });
function fixture({ diagnostics = [healthy()], recovery = { ok: true, action: 'recovered', applied: true }, ...options } = {}) {
  const calls = { diagnose: 0, recover: 0, pauses: [], reports: [] };
  return { calls, run: () => verifyDeployedAuth({ settings, profile: JSON.stringify(profile),
    diagnose: async () => {
      const value = diagnostics[Math.min(calls.diagnose++, diagnostics.length - 1)];
      if (value instanceof Error) throw value;
      return structuredClone(value);
    }, recover: async () => { calls.recover++; if (recovery instanceof Error) throw recovery; return structuredClone(recovery); },
    pause: async ms => { calls.pauses.push(ms); }, report: summary => calls.reports.push(summary), ...options }) };
}
function sanitized(error, reports) {
  assert.match(error.message, /DataPort 已更新，但 SSO 验证未通过/);
  const output = JSON.stringify({ message: error.message, ...error, reports });
  for (const secret of [profile.clientId, profile.clientSecret, profile.sessionKey, profile.issuer, profile.origin, 'raw-private-error'])
    assert.ok(!output.includes(secret));
}

test('absent enrollment explicitly skips; enrolled healthy deploy never calls recovery', async () => {
  for (const value of [undefined, null]) {
    const f = fixture({ profile: value });
    assert.deepEqual(await f.run(), { stage: 'auth', status: 'skipped_profile_missing' });
    assert.equal(f.calls.diagnose, 0); assert.equal(f.calls.recover, 0);
  }
  const f = fixture(); assert.deepEqual(await f.run(), { stage: 'auth', status: 'verified' });
  assert.equal(f.calls.diagnose, 1); assert.equal(f.calls.recover, 0); assert.deepEqual(f.calls.pauses, []);
});

test('invalid retained profiles are rejected before any network check or recovery', async () => {
  for (const value of ['', 'raw-private-error', 'null', {}, JSON.stringify({ ...profile, sessionKey: 'bad' }),
    JSON.stringify({ ...profile, issuer: 'http://invalid.example' })]) {
    const f = fixture({ profile: value });
    await assert.rejects(f.run(), error => { assert.equal(error.step, 'profile'); sanitized(error, f.calls.reports); return true; });
    assert.equal(f.calls.diagnose, 0); assert.equal(f.calls.recover, 0);
  }
});

test('every known upstream 502/503/504 combination allows exactly one guarded recovery and a fresh verification', async () => {
  for (const discovery of [200, 502, 503, 504]) for (const capabilities of [200, 502, 503, 504]) {
    if (discovery === 200 && capabilities === 200) continue;
    const initial = healthy(); initial.ok = false;
    for (const [name, status] of Object.entries({ discovery, capabilities }))
      if (status !== 200) initial[name] = { status, category: 'upstream_http_error' };
    const f = fixture({ diagnostics: [initial, healthy()] });
    assert.equal((await f.run()).status, 'recovered'); assert.equal(f.calls.recover, 1); assert.equal(f.calls.diagnose, 2);
  }
});

test('credential, configuration, network, protocol and unknown diagnostic failures never trigger recovery', async () => {
  const failures = [];
  for (const status of [401, 403, 404, 429, 500]) failures.push({ status, category: status >= 500 ? 'upstream_http_error' : 'http_error' });
  for (const category of ['dns_error', 'tls_error', 'timeout', 'connection_error', 'network_error', 'raw-private-error']) failures.push({ status: null, category });
  failures.push({ status: 302, category: 'redirect_refused' }, { status: 200, category: 'invalid_json', jsonValid: false },
    { ...healthy().capabilities, category: 'configuration_mismatch', originMatches: false },
    { status: 502, category: 'upstream_http_error', jsonValid: false });
  const reports = failures.map(value => ({ ...upstream('discovery'), capabilities: value }));
  reports.push(null, {}, { ok: true }, { ...healthy(), profile: { valid: false, category: 'invalid' } },
    { ...upstream(), category: 'diagnostic_failed' }, { ...healthy(), ok: false },
    { ...healthy(), capabilities: { ...healthy().capabilities, nativeForm: 1 } },
    { ...healthy(), discovery: { ...healthy().discovery, issuerMatches: false } },
    { ...healthy(), capabilities: { ...healthy().capabilities, audienceMatches: false } });
  for (const report of reports) {
    const f = fixture({ diagnostics: [report] });
    await assert.rejects(f.run(), error => { sanitized(error, f.calls.reports); return true; });
    assert.equal(f.calls.recover, 0); assert.equal(f.calls.diagnose, 1);
  }
});

test('automatic recovery is confined to the fixed production cluster, node and current DataPort issuer', async () => {
  for (const override of [
    { settings: { ...settings, clusterUid: 'other' } }, { settings: { ...settings, node: 'other' } },
    { profile: JSON.stringify({ ...profile, origin: 'https://other.example' }) },
    { profile: JSON.stringify({ ...profile, issuer: 'https://other.example/identity' }) },
    { profile: JSON.stringify({ ...profile, audience: 'other' }) },
    { profile: JSON.stringify({ ...profile, appId: 'mx-h2i' }) },
  ]) {
    const f = fixture({ diagnostics: [upstream()], ...override });
    await assert.rejects(f.run()); assert.equal(f.calls.recover, 0);
  }
});

test('a concurrent successful repair can return already_healthy but still requires readonly verification', async () => {
  const f = fixture({ diagnostics: [upstream(), healthy()], recovery: { ok: true, action: 'already_healthy', applied: false } });
  assert.equal((await f.run()).status, 'recovered'); assert.equal(f.calls.recover, 1); assert.equal(f.calls.diagnose, 2);
});

test('unconfirmed recovery stops once and only reports allowlisted state', async () => {
  for (const recovery of [null, {}, { ok: true }, { ok: true, action: 'recovered', applied: false },
    { ok: true, action: 'already_healthy', applied: true }, { ok: true, action: 'restart_required', applied: false },
    { ok: false, stage: 'restart', mutationAttempted: true, restartSubmitted: 'unknown', message: 'raw-private-error' },
    { ok: false, stage: 'raw-private-error', mutationAttempted: 'raw-private-error', restartSubmitted: 'raw-private-error' },
    Error('raw-private-error')]) {
    const f = fixture({ diagnostics: [upstream()], recovery });
    await assert.rejects(f.run(), error => { assert.equal(error.step, 'recover'); sanitized(error, f.calls.reports); return true; });
    assert.equal(f.calls.recover, 1); assert.equal(f.calls.diagnose, 1); assert.deepEqual(f.calls.pauses, []);
  }
});

test('settling retries are bounded readonly checks; recovery is never repeated', async () => {
  const f = fixture({ diagnostics: [upstream(), upstream('discovery', 503), upstream('capabilities', 504), healthy()] });
  assert.equal((await f.run()).status, 'recovered'); assert.equal(f.calls.recover, 1); assert.equal(f.calls.diagnose, 4);
  assert.deepEqual(f.calls.pauses, [2000, 2000]);
  const failed = fixture({ diagnostics: [upstream()] });
  await assert.rejects(failed.run(), error => { assert.equal(error.step, 'verify'); sanitized(error, failed.calls.reports); return true; });
  assert.equal(failed.calls.recover, 1); assert.equal(failed.calls.diagnose, 4); assert.deepEqual(failed.calls.pauses, [2000, 2000]);
});

test('non-upstream failures after recovery stop immediately; thrown diagnostic messages remain private', async () => {
  for (const next of [Error('raw-private-error'), { ...healthy(), ok: false, capabilities: { status: 401, category: 'http_error' } }]) {
    const f = fixture({ diagnostics: [upstream(), next] });
    await assert.rejects(f.run(), error => { assert.equal(error.step, 'verify'); sanitized(error, f.calls.reports); return true; });
    assert.equal(f.calls.recover, 1); assert.equal(f.calls.diagnose, 2); assert.deepEqual(f.calls.pauses, []);
  }
  const initial = fixture({ diagnostics: [Error('raw-private-error')] });
  await assert.rejects(initial.run(), error => { sanitized(error, initial.calls.reports); return true; });
  assert.equal(initial.calls.recover, 0);
});

test('failure reports retain allowlisted profile, HTTP, network and mismatch details', async () => {
  const cases = [
    { ...healthy(), ok: false, profile: { valid: false, category: 'missing' } },
    { ...healthy(), ok: false, discovery: { status: null, category: 'dns_error' } },
    { ...healthy(), ok: false, capabilities: { status: 401, category: 'http_error' } },
    { ...healthy(), ok: false, capabilities: { ...healthy().capabilities, category: 'configuration_mismatch', originMatches: false } },
  ];
  for (const diagnostic of cases) {
    const f = fixture({ diagnostics: [diagnostic] });
    await assert.rejects(f.run(), error => {
      assert.equal(error.diagnostic.profile.category, diagnostic.profile.category);
      for (const name of ['discovery', 'capabilities']) {
        assert.equal(error.diagnostic[name].status, diagnostic[name].status);
        assert.equal(error.diagnostic[name].category, diagnostic[name].category);
      }
      if (diagnostic.capabilities.originMatches === false) assert.equal(error.diagnostic.capabilities.originMatches, false);
      assert.deepEqual(f.calls.reports.at(-1).diagnostic, error.diagnostic);
      sanitized(error, f.calls.reports); return true;
    });
    assert.equal(f.calls.recover, 0);
  }
});

test('recovery failures retain known codes and command categories without raw receipt data', async () => {
  for (const [code, commandCategory, expectedCode, expectedCategory] of [
    ['operation_locked', undefined, 'operation_locked', undefined],
    ['identity_config_changed', undefined, 'identity_config_changed', undefined],
    ['command_failed', 'conflict', 'command_failed', 'conflict'],
    ['raw-private-error', 'raw-private-error', 'unknown', 'unknown'],
  ]) {
    const recovery = { ok: false, code, commandCategory, stage: 'preflight', mutationAttempted: false,
      restartSubmitted: false, stdout: profile.clientSecret, stderr: profile.clientId };
    const f = fixture({ diagnostics: [upstream()], recovery });
    await assert.rejects(f.run(), error => {
      assert.equal(error.recoveryCode, expectedCode); assert.equal(error.commandCategory, expectedCategory);
      assert.equal(error.diagnostic.capabilities.status, 502);
      assert.equal(error.diagnostic.capabilities.category, 'upstream_http_error');
      sanitized(error, f.calls.reports); return true;
    });
    assert.equal(f.calls.recover, 1);
  }
});

test('post-recovery failures report the latest diagnosis; unavailable reads do not reuse stale details', async () => {
  for (const next of [{ ...healthy(), ok: false, capabilities: { status: 403, category: 'http_error' } }, Error('raw-private-error')]) {
    const f = fixture({ diagnostics: [upstream(), next] });
    await assert.rejects(f.run(), error => {
      assert.equal(error.step, 'verify');
      if (next instanceof Error) assert.equal(error.diagnostic, undefined);
      else {
        assert.equal(error.diagnostic.capabilities.status, 403);
        assert.equal(error.diagnostic.capabilities.category, 'http_error');
      }
      sanitized(error, f.calls.reports); return true;
    });
    assert.equal(f.calls.recover, 1);
  }
});

test('diagnostic summaries reject arbitrary strings, out-of-range statuses and nonboolean checks', async () => {
  for (const [status, expected] of [[100, 100], [599, 599], [99, null], [600, null], [502.5, null], ['502', null], [null, null]]) {
    const f = fixture({ diagnostics: [{ ok: false, profile: { category: 'raw-private-error', secret: profile.clientSecret },
      discovery: { status, category: 'raw-private-error', issuerMatches: profile.clientSecret, body: profile.issuer },
      capabilities: { status: profile.clientId, category: profile.origin, nativeForm: profile.sessionKey } }] });
    await assert.rejects(f.run(), error => {
      assert.deepEqual(error.diagnostic, { profile: { category: 'unknown' },
        discovery: { status: expected, category: 'unknown' }, capabilities: { status: null, category: 'unknown' } });
      sanitized(error, f.calls.reports); return true;
    });
  }
});
