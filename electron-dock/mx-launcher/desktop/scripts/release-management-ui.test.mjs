import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const renderer = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
function source(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(renderer);
  assert.ok(match, `${name} must exist`);
  const tail = renderer.slice(match.index);
  const next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}

function plan(overrides = {}) {
  return {
    planId: 'plan-mx-h2i', releaseId: 'mx-h2i-installer-3.0.0', productId: 'mx-h2i', channel: 'stable',
    components: { launcher: { componentId: 'mx-h2i', currentVersion: '0.1.0', targetVersion: '3.0.0', updateAvailable: true } },
    artifacts: [{ artifactId: 'dmg', version: '3.0.0', digest: 'sha256:original', kind: 'app-installer', url: '/artifact.dmg' }],
    rollout: { strategy: 'all', percentage: 100, audience: { userIds: [], installIds: [] }, rings: ['stable'], featureKeys: [] },
    activation: { majorUpdateRequiresInstaller: true },
    test: { gate: { verdict: 'passed' } }, decisions: { readyToPromote: true }, releaseNotes: 'Original notes',
    ...overrides
  };
}

const functions = [
  'releaseCenterFilters', 'releaseCenterPlans', 'releasePlanById', 'releaseDecisionList',
  'releasePlanArtifacts', 'releasePlanStatus', 'releasePlanIsWithdrawn', 'releaseStatusLabel',
  'releaseArtifactKinds', 'releaseComponentSummary', 'filteredReleaseCenterPlans',
  'releaseWithdrawalConfirmation', 'setReleaseWithdrawalFromAdmin', 'updateReleasePlanFromAdmin',
  'commaList', 'openReleaseCenterDrawer', 'openReleaseMetadataEditor', 'renderReleaseDistributionButton',
  'bindReleaseDistributionButtons', 'fetchJson', 'requestHeadersWithoutOpsToken'
];

function fixture({ plans = [plan()], personal = false, accept = true, respond } = {}) {
  const state = { dashboard: { latestReleasePlans: plans }, releaseCenter: { busy: false, drawer: { planId: plans[0].planId }, feedback: null } };
  const f = { state, requests: [], confirmations: [], rejections: [], frames: [], renderCount: 0, base: 'https://launcher.example', loginChecks: 0, denied: false, scrolled: 0, focused: 0 };
  const editForm = { scrollIntoView() { f.scrolled++; }, elements: { releaseNotes: { focus() { f.focused++; } } } };
  const dependencies = {
    state,
    fetch: async (url, options) => {
      const request = { url, options, body: options.body ? JSON.parse(options.body) : null };
      f.requests.push(request);
      const result = respond ? await respond(request) : { plan: { ...plans[0], withdrawnAt: request.body.withdrawn ? '2026-11-19T12:00:00Z' : null } };
      return result instanceof Response ? result : Response.json(result);
    },
    window: { confirm(message) { f.confirmations.push(message); return accept; } },
    normalizedServerBase: () => f.base,
    requireManagementLogin: () => { f.loginChecks++; if (f.denied) throw new Error('management login required'); },
    opsTokenForRequest: () => personal ? '' : 'fixture-ops-token',
    hasAdminOpsToken: () => !personal,
    adminSession: {
      async prepare(url, headers) {
        if (personal) { url.pathname = `/admin-api${url.pathname}`; headers['x-mx-admin-csrf'] = 'fixture-csrf'; }
        return personal;
      },
      async rejected(payload) { f.rejections.push(payload); }
    },
    renderLoginGate() {}, renderInspector() {}, renderReleaseCenterDrawer() {},
    renderFoundationGrid() { f.renderCount++; },
    requestAnimationFrame(callback) { f.frames.push(callback); },
    userEditorDrawer: { querySelector: () => editForm },
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  };
  f.api = Function(...Object.keys(dependencies), `
    let verifiedOpsBinding = null;
    const asArray = value => Array.isArray(value) ? value : [];
    ${functions.map(source).join('\n')}
    return { ${functions.join(', ')} };
  `)(...Object.values(dependencies));
  return f;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function editForm(planId = 'plan-mx-h2i') {
  return {
    dataset: { releasePlanId: planId },
    elements: Object.fromEntries(Object.entries({ channel: 'stable', rolloutStrategy: 'all', rolloutPercentage: '100', rolloutRings: 'stable', featureKeys: '', targetUserIds: '', targetInstallIds: '', releaseNotes: 'Corrected notes' }).map(([key, value]) => [key, { value }]))
  };
}

test('withdrawal has its own persistent status; zero-percent drafts and legacy records remain distinct', () => {
  const active = plan();
  const zero = plan({ planId: 'zero', rollout: { strategy: 'manual-ring', percentage: 0, audience: {} }, decisions: { readyToPromote: false } });
  const withdrawn = plan({ planId: 'withdrawn', withdrawnAt: '2026-11-19T12:00:00Z' });
  const f = fixture({ plans: [active, zero, withdrawn] });
  assert.equal(f.api.releasePlanStatus(active), 'ready');
  assert.equal(f.api.releasePlanStatus(zero), 'planned');
  assert.equal(f.api.releasePlanStatus(withdrawn), 'withdrawn');
  assert.equal(f.api.releaseStatusLabel('withdrawn'), '已撤销');
  f.api.releaseCenterFilters().status = 'withdrawn';
  assert.deepEqual(f.api.filteredReleaseCenterPlans().map(item => item.planId), ['withdrawn']);
});

test('withdrawal confirms exact release/version/audience and sends only lifecycle fields with ops protection', async () => {
  const original = plan({ rollout: { strategy: 'gray', percentage: 10, audience: { userIds: ['user-a'], installIds: ['install-a'] } } });
  const f = fixture({ plans: [original] });
  await f.api.setReleaseWithdrawalFromAdmin(original.planId, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.loginChecks, 1);
  const { url, options, body } = f.requests[0];
  assert.equal(new URL(url).pathname, '/internal/v1/release-management/plans/plan-mx-h2i');
  assert.equal(options.method, 'PATCH');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['x-mx-ops-token'], 'fixture-ops-token');
  assert.deepEqual(Object.keys(body).sort(), ['requestId', 'updatedBy', 'withdrawn']);
  assert.equal(body.withdrawn, true);
  assert.match(f.confirmations[0], /mx-h2i-installer-3\.0\.0/);
  assert.match(f.confirmations[0], /版本：3\.0\.0/);
  assert.match(f.confirmations[0], /gray 10%/);
  assert.match(f.confirmations[0], /user-a/);
  assert.match(f.confirmations[0], /install-a/);
  assert.equal(f.state.releaseCenter.feedback.kind, 'success');
  assert.equal(f.api.releasePlanStatus(f.state.dashboard.latestReleasePlans[0]), 'withdrawn');
  assert.equal(original.withdrawnAt, undefined, 'the old plan is not mutated optimistically');
  assert.deepEqual(f.state.dashboard.latestReleasePlans[0].artifacts, original.artifacts);
  assert.deepEqual(f.state.dashboard.latestReleasePlans[0].rollout, original.rollout);
});

test('restore requires explicit confirmation and preserves BFF/CSRF authentication', async () => {
  const f = fixture({ personal: true, plans: [plan({ withdrawnAt: '2026-11-19T12:00:00Z' })] });
  await f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', false);
  assert.match(f.confirmations[0], /恢复分发/);
  assert.match(f.confirmations[0], /重新提供/);
  assert.equal(f.requests[0].body.withdrawn, false);
  assert.equal(new URL(f.requests[0].url).pathname, '/admin-api/internal/v1/release-management/plans/plan-mx-h2i');
  assert.equal(f.requests[0].options.headers['x-mx-admin-csrf'], 'fixture-csrf');
  assert.equal(f.requests[0].options.headers['x-mx-ops-token'], undefined);
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.state.dashboard.latestReleasePlans[0].withdrawnAt, null);
});

test('cancel, missing records, identical state and management denial never report a successful mutation', async () => {
  const cancelled = fixture({ accept: false });
  await cancelled.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', true);
  assert.equal(cancelled.requests.length, 0);
  const f = fixture();
  await f.api.setReleaseWithdrawalFromAdmin('missing', true);
  await f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', false);
  assert.equal(f.confirmations.length, 0);
  f.denied = true;
  await f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.releaseCenter.feedback.kind, 'error');
  assert.equal(f.state.dashboard.latestReleasePlans[0].withdrawnAt, undefined);
});

test('old servers, wrong records and failed requests cannot produce a false success', async () => {
  for (const respond of [
    () => ({ plan: plan() }),
    () => ({ plan: plan({ planId: 'other', withdrawnAt: '2026-11-19T12:00:00Z' }) }),
    () => Response.json({ message: 'forbidden', code: 'management_forbidden' }, { status: 403 })
  ]) {
    const f = fixture({ respond, personal: true });
    const before = structuredClone(f.state.dashboard.latestReleasePlans);
    await f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', true);
    assert.deepEqual(f.state.dashboard.latestReleasePlans, before);
    assert.equal(f.state.releaseCenter.feedback.kind, 'error');
    assert.equal(f.state.releaseCenter.busy, false);
  }
  const f = fixture({ plans: [plan({ withdrawnAt: '2026-11-19T12:00:00Z' })], respond: () => ({ plan: plan() }) });
  await f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', false);
  assert.equal(f.state.releaseCenter.feedback.kind, 'error', 'missing withdrawnAt is not a confirmed restore');
});

test('pending and duplicate mutations cannot switch selection or overwrite another plan', async () => {
  const pending = deferred();
  const other = plan({ planId: 'other', releaseId: 'other-release' });
  const f = fixture({ plans: [plan(), other], respond: () => pending.promise });
  const first = f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', true);
  assert.equal(f.state.releaseCenter.busy, true);
  await f.api.setReleaseWithdrawalFromAdmin('other', true);
  f.api.openReleaseCenterDrawer('other');
  assert.equal(f.state.releaseCenter.drawer.planId, 'plan-mx-h2i');
  f.state.releaseCenter.drawer = { planId: 'other' };
  pending.resolve({ plan: plan({ withdrawnAt: '2026-11-19T12:00:00Z' }) });
  await first;
  assert.equal(f.state.releaseCenter.drawer.planId, 'other');
  assert.strictEqual(f.state.dashboard.latestReleasePlans[1], other);
  await f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', true);
  assert.equal(f.requests.length, 1);
});

test('responses from a previously selected server are discarded', async () => {
  const pending = deferred();
  const f = fixture({ respond: () => pending.promise });
  const before = structuredClone(f.state.dashboard.latestReleasePlans);
  const operation = f.api.setReleaseWithdrawalFromAdmin('plan-mx-h2i', true);
  await Promise.resolve();
  f.base = 'https://another.example';
  pending.resolve({ plan: plan({ withdrawnAt: '2026-11-19T12:00:00Z' }) });
  await operation;
  assert.deepEqual(f.state.dashboard.latestReleasePlans, before);
  assert.notEqual(f.state.releaseCenter.feedback.kind, 'success');
});

test('editing a withdrawn release does not request restoration or alter artifact identity', async () => {
  const original = plan({ withdrawnAt: '2026-11-19T12:00:00Z', withdrawnBy: 'operator' });
  const f = fixture({ plans: [original], respond: request => ({ plan: { ...original, releaseNotes: request.body.releaseNotes } }) });
  await f.api.updateReleasePlanFromAdmin(editForm());
  assert.equal(f.requests[0].body.releaseNotes, 'Corrected notes');
  assert.equal(Object.hasOwn(f.requests[0].body, 'withdrawn'), false);
  assert.equal(Object.hasOwn(f.requests[0].body, 'artifacts'), false);
  assert.equal(Object.hasOwn(f.requests[0].body, 'version'), false);
  assert.equal(f.state.dashboard.latestReleasePlans[0].withdrawnAt, original.withdrawnAt);
  assert.deepEqual(f.state.dashboard.latestReleasePlans[0].artifacts, original.artifacts);
  assert.match(f.state.releaseCenter.feedback.message, /仍为已撤销/);
});

test('metadata responses cannot silently restore a withdrawn record or redirect selection', async () => {
  const original = plan({ withdrawnAt: '2026-11-19T12:00:00Z' });
  const f = fixture({ plans: [original], respond: () => ({ plan: plan({ withdrawnAt: null }) }) });
  await f.api.updateReleasePlanFromAdmin(editForm());
  assert.equal(f.state.releaseCenter.feedback.kind, 'error');
  assert.equal(f.state.dashboard.latestReleasePlans[0].withdrawnAt, original.withdrawnAt);
  const pending = deferred();
  const next = fixture({ plans: [plan(), plan({ planId: 'other' })], respond: () => pending.promise });
  const operation = next.api.updateReleasePlanFromAdmin(editForm());
  next.state.releaseCenter.drawer = { planId: 'other' };
  pending.resolve({ plan: plan({ releaseNotes: 'Corrected notes' }) });
  await operation;
  assert.equal(next.state.releaseCenter.drawer.planId, 'other');
});

test('editing installer notes preserves manual-download and permits an explicit delivery-mode change', async () => {
  const original = plan({ deliveryMode: 'manual-download' });
  const f = fixture({ plans: [original], respond: request => ({ plan: { ...original, releaseNotes: request.body.releaseNotes, deliveryMode: request.body.deliveryMode } }) });
  const form = editForm();
  form.elements.deliveryMode = { value: 'manual-download' };
  await f.api.updateReleasePlanFromAdmin(form);
  assert.equal(f.requests[0].body.deliveryMode, 'manual-download');
  assert.equal(f.state.dashboard.latestReleasePlans[0].deliveryMode, 'manual-download');
  form.elements.deliveryMode.value = 'prompt-download-restart';
  await f.api.updateReleasePlanFromAdmin(form);
  assert.equal(f.requests[1].body.deliveryMode, 'prompt-download-restart');
});

test('Edit opens the selected record and focuses its existing metadata form only if it is still selected', () => {
  const f = fixture({ plans: [plan(), plan({ planId: 'other' })] });
  f.api.openReleaseMetadataEditor('plan-mx-h2i');
  f.frames.shift()();
  assert.equal(f.scrolled, 1);
  assert.equal(f.focused, 1);
  f.api.openReleaseMetadataEditor('plan-mx-h2i');
  f.state.releaseCenter.drawer = { planId: 'other' };
  f.frames.shift()();
  assert.equal(f.focused, 1);
});

test('bound distribution buttons carry a specific desired state instead of toggling a stale record', async () => {
  const f = fixture();
  const listeners = {};
  const button = { dataset: { releaseDistribution: 'plan-mx-h2i', releaseWithdrawn: 'true' }, addEventListener(event, callback) { listeners[event] = callback; } };
  f.api.bindReleaseDistributionButtons({ querySelectorAll: () => [button] });
  listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests[0].body.withdrawn, true);
  listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
});
