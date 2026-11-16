import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');

function functionSource(name) {
  const asyncStart = renderer.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : renderer.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = renderer.indexOf('{', renderer.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < renderer.length; index += 1) {
    if (renderer[index] === '{') depth += 1;
    if (renderer[index] === '}') depth -= 1;
    if (depth === 0) return renderer.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

function harness(overrides = {}) {
  const requests = [];
  const confirmations = [];
  const site = {
    siteId: 'mx-oversea-us01', host: '192.0.2.10', status: 'installed',
    sshProfile: { profileId: 'ssh-us01', host: '198.51.100.20' }
  };
  const recovery = { siteId: site.siteId, host: site.sshProfile.host, status: 'healthy', changed: false, steps: [], blockedReasons: [] };
  const context = vm.createContext({
    state: {
      selectedSiteId: site.siteId, overseaOverview: { retained: true },
      overseaEnsureFeedback: { retained: true }, overseaTerminalResult: { retained: true }
    },
    selectedOverseaSite: () => site,
    renderDeploymentWorkbench() {},
    asArray: value => Array.isArray(value) ? value : [],
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    window: { confirm: message => { confirmations.push(message); return true; } },
    fetchJson: async (url, options) => { requests.push({ url, ...options }); return { recovery }; },
    ...overrides
  });
  vm.runInContext(['recoverSelectedOversea', 'renderOverseaRecovery'].map(functionSource).join('\n'), context);
  return { context, requests, confirmations, site, recovery };
}

test('default read-only check uses the saved SSH host and never starts an install', async () => {
  const { context, requests, confirmations } = harness();
  await context.recoverSelectedOversea();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/internal/v1/admin/oversea/mx-oversea-us01/recover');
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['confirmRecovery', 'executeRecovery', 'expectedHost', 'requestId', 'requestedBy']);
  assert.equal(requests[0].body.expectedHost, '198.51.100.20');
  assert.equal(requests[0].body.executeRecovery, false);
  assert.equal(requests[0].body.confirmRecovery, false);
  assert.equal(confirmations.length, 0);
  assert.equal(context.state.overseaRecovery.result.changed, false);
  assert.match(context.state.overseaRecovery.feedback.message, /健康.*未做变更/);
  assert.equal(context.state.overseaEnsureFeedback.retained, true);
  assert.equal(context.state.overseaTerminalResult.retained, true);
});

test('explicit recovery confirms the exact saved site and IP before one request', async () => {
  const { context, requests, confirmations, recovery } = harness();
  recovery.status = 'recovered';
  recovery.changed = true;
  await context.recoverSelectedOversea(true);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /mx-oversea-us01.*198\.51\.100\.20/);
  assert.match(confirmations[0], /健康节点不做变更/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.executeRecovery, true);
  assert.equal(requests[0].body.confirmRecovery, true);
  assert.equal(context.state.overseaRecovery.feedback.kind, 'success');
});

test('cancelled confirmation, archived, draft and missing-profile sites do not execute', async () => {
  const { context, requests } = harness({ window: { confirm: () => false } });
  await context.recoverSelectedOversea(true);
  assert.equal(requests.length, 0);
  for (const invalid of [{ archived: true }, { status: 'archived' }, { status: 'draft' }, { sshProfile: null }]) {
    const fixture = harness();
    Object.assign(fixture.site, invalid);
    await fixture.context.recoverSelectedOversea(true);
    assert.equal(fixture.requests.length, 0);
  }
});

test('recovery and existing ensure, terminal and archive actions exclude one another', async () => {
  for (const flag of ['overseaRecoveryBusy', 'overseaEnsureBusy', 'overseaTerminalBusy', 'overseaArchiveBusy']) {
    const { context, requests } = harness();
    context.state[flag] = true;
    await context.recoverSelectedOversea(true);
    assert.equal(requests.length, 0, flag);
  }
  const { context, requests } = harness();
  context.state.overseaRecoveryBusy = true;
  for (const name of ['ensureSelectedOversea', 'runSelectedOverseaTerminal', 'setSelectedOverseaArchived']) {
    vm.runInContext(functionSource(name), context);
    await context[name]();
  }
  assert.equal(requests.length, 0);
});

test('late recovery responses cannot overwrite a different selected site', async () => {
  let finish;
  const { context, recovery } = harness({ fetchJson: () => new Promise(resolve => { finish = resolve; }) });
  const running = context.recoverSelectedOversea(true);
  context.state.selectedSiteId = 'mx-oversea-jp01';
  context.state.overseaRecovery = null;
  finish({ recovery, oversea: { stale: true } });
  await running;
  assert.equal(context.state.overseaRecovery, null);
  assert.equal(context.state.overseaOverview.retained, true);
  assert.equal(context.state.overseaRecoveryBusy, false);
});

test('changed saved targets and mismatched responses are rejected before applying overview', async () => {
  let finish;
  const { context, recovery, site } = harness({ fetchJson: () => new Promise(resolve => { finish = resolve; }) });
  const running = context.recoverSelectedOversea(true);
  site.sshProfile.host = '203.0.113.40';
  finish({ recovery, oversea: { stale: true } });
  await running;
  assert.match(context.state.overseaRecovery.feedback.message, /目标 IP 已改变/);
  assert.equal(context.state.overseaRecovery.result, null);
  assert.equal(context.state.overseaOverview.retained, true);
  const mismatch = harness();
  mismatch.recovery.host = 'wrong-target';
  await mismatch.context.recoverSelectedOversea(true);
  assert.match(mismatch.context.state.overseaRecovery.feedback.message, /不匹配/);
});

test('timeouts never retry and direct the operator to site history before another execution', async () => {
  let requests = 0;
  const { context } = harness({ fetchJson: async () => { requests += 1; throw new Error('HTTP 504'); } });
  await context.recoverSelectedOversea(true);
  assert.equal(requests, 1);
  assert.equal(context.state.overseaRecoveryBusy, false);
  assert.match(context.state.overseaRecovery.feedback.message, /未自动重试.*历史报告/);
});

test('safe early refusals preserve the server reason without accepting untargeted success', async () => {
  const { context, recovery, site } = harness();
  recovery.host = null;
  recovery.status = 'blocked';
  recovery.changed = false;
  recovery.blockedReasons = ['An Oversea operation is already running for this site.'];
  await context.recoverSelectedOversea(true);
  assert.equal(context.state.overseaRecovery.result.status, 'blocked');
  assert.match(context.renderOverseaRecovery(site), /operation is already running/);
  assert.doesNotMatch(context.state.overseaRecovery.feedback.message, /不匹配/);
  for (const override of [{ status: 'healthy' }, { status: 'recovered' }, { status: 'ready' }, { changed: true }, { siteId: 'another-site' }]) {
    const fixture = harness();
    Object.assign(fixture.recovery, { host: null, status: 'blocked', changed: false }, override);
    await fixture.context.recoverSelectedOversea(true);
    assert.equal(fixture.context.state.overseaRecovery.result, null);
    assert.match(fixture.context.state.overseaRecovery.feedback.message, /不匹配/);
  }
});

test('recovery renders summaries with escaped output and existing SSH guidance only', () => {
  const { context, site, recovery } = harness();
  recovery.status = 'blocked';
  recovery.steps = [{ stepId: 'ssh', status: 'failed', message: '<img src=x onerror=bad()>' }];
  recovery.blockedReasons = ['Permission denied <script>bad()</script>'];
  recovery.warnings = ['Published metadata restoration failed <script>bad()</script>'];
  recovery.nextActions = ['review-worker-evidence <img src=x>'];
  recovery.password = 'must-not-render';
  recovery.stdout = 'ssh-private-key-must-not-render';
  context.state.overseaRecovery = { siteId: site.siteId, host: site.sshProfile.host, result: recovery };
  const html = context.renderOverseaRecovery(site);
  assert.match(html, /198\.51\.100\.20/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Refresh Host Key/);
  assert.match(html, /Bootstrap Key/);
  assert.match(html, /warning: Published metadata restoration failed &lt;script&gt;/);
  assert.match(html, /next: review-worker-evidence &lt;img/);
  assert.doesNotMatch(html, /<img|<script>|must-not-render|<input/);
  const blockedSiteHtml = context.renderOverseaRecovery({ ...site, status: 'blocked' });
  assert.doesNotMatch(blockedSiteHtml.match(/<button[^>]+data-oversea-recover[^>]*>/)[0], /disabled/);
  context.state.overseaRecoveryBusy = true;
  const busyHtml = context.renderOverseaRecovery(site);
  assert.match(busyHtml.match(/<button[^>]+data-oversea-recover[^>]*>/)[0], /disabled/);
  assert.match(busyHtml.match(/<button[^>]+data-oversea-recovery-check[^>]*>/)[0], /disabled/);
});
