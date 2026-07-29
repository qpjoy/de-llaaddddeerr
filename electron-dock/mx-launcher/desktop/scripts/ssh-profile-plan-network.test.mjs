import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../renderer.js', import.meta.url)),
  'utf8'
);
const htmlSource = readFileSync(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const parametersStart = source.indexOf('(', start);
  let parametersDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parametersDepth += 1;
    if (source[index] === ')') parametersDepth -= 1;
    if (parametersDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf('{', parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

for (const id of [
  'ssh-profile-domestic-network-mode-field',
  'ssh-profile-domestic-network-mode',
  'ssh-profile-domestic-oversea-site-field',
  'ssh-profile-domestic-oversea-site'
]) {
  assert.match(htmlSource, new RegExp(`id="${id}"`), `${id} must exist`);
}
assert.match(htmlSource, /option value="direct">Domestic direct<\/option>/);
assert.match(htmlSource, /option value="oversea-assisted">Oversea-assisted<\/option>/);

const networkHelpers = Function(
  `
${functionSource(rendererSource, 'buildSshProfilePlanNetworkInput')}
${functionSource(rendererSource, 'sshProfilePlanNetworkValidationFailure')}
return {
  buildSshProfilePlanNetworkInput,
  sshProfilePlanNetworkValidationFailure
};
`
)();

const overseaSites = [
  {
    siteId: 'oversea-main',
    host: '203.0.113.10',
    status: 'installed'
  },
  {
    siteId: 'oversea-sg-1',
    host: '198.51.100.25',
    status: 'ready'
  }
];

assert.deepEqual(
  networkHelpers.buildSshProfilePlanNetworkInput(
    'domestic',
    'direct',
    'oversea-main',
    overseaSites
  ),
  {
    hasOutboundInternet: true,
    overseaSiteId: null,
    overseaHost: null
  },
  'Domestic direct must not retain a stale Oversea selection'
);

const assisted = networkHelpers.buildSshProfilePlanNetworkInput(
  'domestic',
  'oversea-assisted',
  'oversea-sg-1',
  overseaSites
);
assert.deepEqual(
  assisted,
  {
    hasOutboundInternet: false,
    overseaSiteId: 'oversea-sg-1',
    overseaHost: '198.51.100.25'
  },
  'Assisted mode must use the explicitly selected site, not the first candidate'
);
assert.equal(
  networkHelpers.sshProfilePlanNetworkValidationFailure(
    'domestic',
    assisted,
    'oversea-assisted'
  ),
  null
);

const missingAssisted = networkHelpers.buildSshProfilePlanNetworkInput(
  'domestic',
  'oversea-assisted',
  '',
  overseaSites
);
assert.deepEqual(missingAssisted, {
  hasOutboundInternet: false,
  overseaSiteId: null,
  overseaHost: null
});
assert.match(
  networkHelpers.sshProfilePlanNetworkValidationFailure(
    'domestic',
    missingAssisted,
    'oversea-assisted'
  ),
  /Select an available Oversea bootstrap site/
);

assert.deepEqual(
  networkHelpers.buildSshProfilePlanNetworkInput(
    'oversea',
    'oversea-assisted',
    'oversea-sg-1',
    overseaSites
  ),
  {
    hasOutboundInternet: true,
    overseaSiteId: null,
    overseaHost: null
  },
  'Oversea plans remain direct and ignore Domestic-only controls'
);

const planPayloadSource = functionSource(rendererSource, 'sshProfilePlanPayload');
assert.doesNotMatch(planPayloadSource, /hasOutboundInternet:\s*kind === 'oversea'/);
assert.match(planPayloadSource, /const networkInput = sshProfilePlanNetworkInput\(kind\)/);
assert.match(planPayloadSource, /\.\.\.networkInput/);

const profilePayloadSource = functionSource(rendererSource, 'sshProfileFormPayload');
assert.doesNotMatch(
  profilePayloadSource,
  /hasOutboundInternet|overseaSiteId|overseaHost/,
  'Plan network choices must not be persisted as SSH Profile fields'
);

assert.match(
  functionSource(rendererSource, 'createPlanFromSshProfile'),
  /sshProfilePlanNetworkValidationFailure\(planBody\.kind, planBody\)/,
  'all Create Plan entry points must share the assisted-site validation'
);
assert.match(
  functionSource(rendererSource, 'fillNewSshProfileForm'),
  /syncSshProfilePlanNetworkFields\(\{ reset: true \}\)/,
  'new Domestic forms default to direct'
);
assert.match(
  functionSource(rendererSource, 'fillSshProfileForm'),
  /syncSshProfilePlanNetworkFields\(\{ reset: previousFormKey !== nextFormKey \}\)/,
  'profile changes reset plan-only network state without erasing same-profile edits'
);
assert.match(
  functionSource(rendererSource, 'syncSshProfileFormToSelectedSite'),
  /syncSshProfilePlanNetworkFields\(\{ reset: true \}\)/,
  'manual site switches reset plan-only network state'
);
assert.match(
  rendererSource,
  /sshProfileKind\.addEventListener\('change', \(\) => \{\s*syncSshProfilePlanNetworkFields\(\{ reset: true \}\);/,
  'Kind changes must reset Domestic plan-only network state'
);
assert.match(
  rendererSource,
  /sshProfileDomesticNetworkMode\.addEventListener\('change', \(\) => \{\s*syncSshProfilePlanNetworkFields\(\);/,
  'Mode changes must update assisted-site visibility'
);

console.log('ssh profile plan network UI contract: ok');
