import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../renderer.js', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
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

console.log('internal service peer setup safety contract: ok');
