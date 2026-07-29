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

console.log('internal service peer setup safety contract: ok');
