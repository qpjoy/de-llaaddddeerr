import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../renderer.js', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const syncStart = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = syncStart >= 0 ? syncStart : asyncStart;
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const setupActionBlockedMessage = Function(
  `
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
${functionSource(rendererSource, 'setupActionBlockedMessage')}
return setupActionBlockedMessage;
`
)();

assert.equal(
  setupActionBlockedMessage({
    internalServicePeerRuntimeStatus: {
      status: 'passed',
      blockedReasons: []
    }
  }),
  '',
  'a passed verification may advance the setup chain'
);

assert.match(
  setupActionBlockedMessage({
    internalServicePeerRuntimeStatus: {
      status: 'ready',
      blockedReasons: []
    }
  }),
  /no install or restart was performed/,
  'a non-passed read-only verification must stop instead of looping or applying'
);

assert.match(
  setupActionBlockedMessage({
    internalServicePeerRuntimeStatus: {
      status: 'blocked',
      blockedReasons: ['host runner is unreachable']
    }
  }),
  /host runner is unreachable/,
  'the operator sees the concrete verification blocker'
);

assert.match(
  setupActionBlockedMessage({
    internalServicePeerRuntimeStatus: {
      status: 'passed',
      blockedReasons: []
    },
    internalServicePeerApply: {
      status: 'failed',
      blockedReasons: ['wg apply exited 1']
    }
  }),
  /Action failed: wg apply exited 1/,
  'a failed mutation must stop even when the pre-existing tunnel still probes healthy'
);

const shouldReplaceSelectedHistoryPipeline = Function(
  `
${functionSource(rendererSource, 'isRollbackPipeline')}
${functionSource(rendererSource, 'isFailedOrRollbackPipeline')}
${functionSource(rendererSource, 'shouldReplaceSelectedHistoryPipeline')}
return shouldReplaceSelectedHistoryPipeline;
`
)();

assert.equal(
  shouldReplaceSelectedHistoryPipeline(
    { planId: 'failed-plan', siteId: 'domestic-main', health: 'failed', currentStage: 'worker-report' },
    { planId: 'healthy-plan', siteId: 'domestic-main', health: 'passed', currentStage: 'worker-report' }
  ),
  true,
  'refresh must replace the selected failed history with the same-site operational plan'
);

assert.equal(
  shouldReplaceSelectedHistoryPipeline(
    { planId: 'healthy-plan', siteId: 'domestic-main', health: 'passed', currentStage: 'worker-report' },
    { planId: 'other-plan', siteId: 'domestic-main', health: 'blocked', currentStage: 'worker-report' }
  ),
  false,
  'refresh must preserve an explicitly selected healthy history'
);

assert.equal(
  shouldReplaceSelectedHistoryPipeline(
    { planId: 'failed-plan', siteId: 'domestic-main', health: 'failed', currentStage: 'worker-report' },
    null
  ),
  false,
  'a failed history remains inspectable when no operational replacement exists'
);

const chooseOperationalPipeline = Function(
  `
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
${functionSource(rendererSource, 'latestPipeline')}
${functionSource(rendererSource, 'isRollbackPipeline')}
${functionSource(rendererSource, 'isFailedOrRollbackPipeline')}
${functionSource(rendererSource, 'pipelineObjectCount')}
${functionSource(rendererSource, 'pipelineOperationalScore')}
${functionSource(rendererSource, 'chooseOperationalPipeline')}
return chooseOperationalPipeline;
`
)();

const olderBlocked = {
  planId: 'older-blocked',
  siteId: 'domestic-main',
  health: 'blocked',
  currentStage: 'worker-report',
  latestUpdatedAt: '2026-06-23T05:32:00.000Z',
  actionHints: [{ allowed: true }]
};
const newerPassed = {
  planId: 'newer-passed',
  siteId: 'domestic-main',
  health: 'passed',
  currentStage: 'worker-report',
  latestUpdatedAt: '2026-07-29T15:36:00.000Z',
  actionHints: []
};
assert.equal(
  chooseOperationalPipeline([olderBlocked, newerPassed])?.planId,
  'newer-passed',
  'an older remediation record must not keep a site blocked after a newer deployment passed'
);

const newestBlocked = {
  ...olderBlocked,
  planId: 'newest-blocked',
  latestUpdatedAt: '2026-07-29T16:00:00.000Z'
};
assert.equal(
  chooseOperationalPipeline([newerPassed, newestBlocked])?.planId,
  'newest-blocked',
  'a blocked deployment created after the last passing run remains the operational item'
);

const continueSetupRunSource = functionSource(rendererSource, 'continueSetupRun');
assert.doesNotMatch(
  continueSetupRunSource,
  /pushSetupRunStep\(action,\s*'(?:passed|failed|blocked)'/,
  'terminal setup results must replace the running row instead of creating contradictory duplicates'
);
assert.match(
  continueSetupRunSource,
  /replaceLatestSetupRunStep\(action\.actionId,\s*'passed'/,
  'a successful status check must settle its running row as passed'
);

const internalPeerWorkbenchSource = functionSource(rendererSource, 'renderInternalPeerWorkbench');
assert.match(
  internalPeerWorkbenchSource,
  /if \(state\.deploymentKind !== 'internal'\) \{\s*renderDeploymentWorkbench\(pipelines\);\s*return;\s*\}/,
  'a delayed Internal peer refresh must render the current deployment lane instead of overwriting Oversea'
);
const delayedInternalRefresh = Function(
  `
const state = { deploymentKind: 'oversea' };
let routed = null;
function renderDeploymentWorkbench(pipelines) { routed = pipelines; }
${internalPeerWorkbenchSource}
return { run: renderInternalPeerWorkbench, routed: () => routed };
`
)();
const overseaPipelines = [{ kind: 'oversea', siteId: 'mx-oversea-hk01' }];
delayedInternalRefresh.run(overseaPipelines);
assert.strictEqual(
  delayedInternalRefresh.routed(),
  overseaPipelines,
  'a late Internal status response must redispatch the current Oversea lane'
);
assert.match(
  internalPeerWorkbenchSource,
  /const runtimeHealthy = runtimeStatus\?\.status === 'passed';\s*const panelStatus = runtimeHealthy\s*\? 'passed'/,
  'a healthy live Domestic/Internal WG must remain passed when only its control-plane artifact is stale'
);
assert.doesNotMatch(
  internalPeerWorkbenchSource,
  /const panelStatus = materializeAction\s*\? 'blocked'/,
  'artifact maintenance must not relabel the running WG data plane as blocked'
);
assert.match(
  internalPeerWorkbenchSource,
  /Oversea operations do not modify this runtime\. Refresh Artifact reuses the current keys and does not sync, apply, or restart WG\./,
  'the maintenance warning must state the hard runtime isolation boundary'
);
assert.match(
  internalPeerWorkbenchSource,
  /Refresh Domestic Artifact/,
  'the control-plane action must not be presented as a runtime WG install or restart'
);

const renderOverseaSiteDetail = Function(
  `
const state = { overseaEnsureBusy: false };
function asArray(value) { return Array.isArray(value) ? value : []; }
function escapeHtml(value) { return String(value ?? ''); }
function normalizeStageStatus(value) { return value || 'ready'; }
function sameHostPeerProfile() { return null; }
function workerInternalBaseUrlForSite() { return 'http://127.0.0.1:18090'; }
function renderSameHostNote() { return ''; }
function renderOverseaTerminal() { return ''; }
${functionSource(rendererSource, 'renderOverseaSiteDetail')}
return renderOverseaSiteDetail;
`
)();

function overseaSite(status, archived = false) {
  return {
    siteId: 'mx-oversea-hk01',
    host: '18.166.135.196',
    status,
    archived,
    sshProfile: { profileId: 'sshprof_hk01' },
    services: [],
    subscriptions: []
  };
}

function overseaEnsureTag(html) {
  return html.match(/<button[^>]*data-oversea-ensure[^>]*>/)?.[0] || '';
}

const waitingOverseaHtml = renderOverseaSiteDetail(overseaSite('waiting'));
assert.match(waitingOverseaHtml, /Install \/ Sync/, 'a waiting site keeps the explicit Install / Sync action');
assert.doesNotMatch(overseaEnsureTag(waitingOverseaHtml), /\bdisabled\b/, 'a waiting site with an SSH profile remains syncable');
assert.doesNotMatch(
  waitingOverseaHtml,
  /data-internal-peer|Generate Handoff|Sync Domestic WG Key|Install \/ Restart|Open Domestic/,
  'the Oversea detail never renders Domestic or Internal runtime controls'
);

const installedOverseaHtml = renderOverseaSiteDetail(overseaSite('installed'));
assert.match(installedOverseaHtml, /Sync Remote/, 'an installed site exposes Sync Remote independently of pipeline action hints');
assert.doesNotMatch(overseaEnsureTag(installedOverseaHtml), /\bdisabled\b/, 'an installed active site remains syncable');

const archivedOverseaHtml = renderOverseaSiteDetail(overseaSite('archived', true));
assert.match(archivedOverseaHtml, /Unarchive First/, 'an archived site requires explicit restoration before sync');
assert.match(overseaEnsureTag(archivedOverseaHtml), /\bdisabled\b/, 'an archived site cannot sync');

console.log('internal service peer setup safety contract: ok');
