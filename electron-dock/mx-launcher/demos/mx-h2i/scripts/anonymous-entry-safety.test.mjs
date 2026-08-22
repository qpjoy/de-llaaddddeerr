import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../src/renderer.js', import.meta.url)),
  'utf8'
);
const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main-runtime.cjs', import.meta.url)),
  'utf8'
);
const stylesSource = readFileSync(
  fileURLToPath(new URL('../src/styles.css', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const candidates = [`async function ${name}(`, `function ${name}(`];
  const start = candidates
    .map((prefix) => source.indexOf(prefix))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.ok(Number.isInteger(start), `${name} must exist`);
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

assert.match(rendererSource, /let modeDraft = 'employee';/);
assert.match(
  functionSource(rendererSource, 'boot'),
  /modeDraft = preferredLauncherMode\(\)/,
  'startup must choose employee unless a real guest connection is retained'
);
assert.match(
  functionSource(rendererSource, 'boot'),
  /state\.connection\?\.state === 'idle'[\s\S]*modeDraft = 'employee'/,
  'a later runtime transition to idle must also restore the employee default'
);

const launcherModeForConnection = Function(
  'connection',
  `let state = { connection };
${functionSource(rendererSource, 'isGuestConnectionActive')}
${functionSource(rendererSource, 'preferredLauncherMode')}
return preferredLauncherMode();`
);

assert.equal(launcherModeForConnection({ state: 'idle', mode: 'guest' }), 'employee');
assert.equal(launcherModeForConnection({ state: 'connected', mode: 'employee' }), 'employee');
for (const connectionState of [
  'connecting',
  'connected',
  'lease-only',
  'tunnel-only',
  'server-unavailable',
  'network-unavailable',
  'forbidden'
]) {
  assert.equal(
    launcherModeForConnection({ state: connectionState, mode: 'guest' }),
    'guest',
    `a retained guest ${connectionState} state must stay visible`
  );
}

const anonymousEntryForState = Function(
  'anonymousUiVisibilityValue',
  'anonymousEnrollmentPolicyValue',
  'connection',
  `let state = {
  config: { productId: 'mx-h2i' },
  launcherProductPresentation: {
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: anonymousEnrollmentPolicyValue,
    anonymousUiVisibility: anonymousUiVisibilityValue
  },
  connection
};
${functionSource(rendererSource, 'isGuestConnectionActive')}
${functionSource(rendererSource, 'anonymousUiVisibility')}
${functionSource(rendererSource, 'anonymousEnrollmentPolicy')}
${functionSource(rendererSource, 'shouldRenderPrimaryAnonymousEntry')}
${functionSource(rendererSource, 'shouldRenderAnonymousAccessPanel')}
${functionSource(rendererSource, 'canStartAnonymousEnrollment')}
${functionSource(rendererSource, 'canRenewAnonymousEnrollment')}
return {
  visibility: anonymousUiVisibility(),
  policy: anonymousEnrollmentPolicy(),
  primary: shouldRenderPrimaryAnonymousEntry(),
  advanced: shouldRenderAnonymousAccessPanel(),
  canStart: canStartAnonymousEnrollment(),
  canRenew: canRenewAnonymousEnrollment()
};`
);

assert.deepEqual(
  anonymousEntryForState(undefined, undefined, { state: 'idle', mode: 'guest' }),
  { visibility: 'advanced', policy: 'enabled', primary: false, advanced: true, canStart: true, canRenew: true },
  'missing or invalid presentation state must preserve the MX-H2I advanced default'
);
assert.deepEqual(
  anonymousEntryForState('primary', 'enabled', { state: 'idle', mode: 'guest' }),
  { visibility: 'primary', policy: 'enabled', primary: true, advanced: false, canStart: true, canRenew: true }
);
assert.deepEqual(
  anonymousEntryForState('advanced', 'disabled', { state: 'idle', mode: 'guest' }),
  { visibility: 'advanced', policy: 'disabled', primary: false, advanced: true, canStart: false, canRenew: false },
  'disabled policy may show an explanatory surface but must not offer enrollment'
);
assert.deepEqual(
  anonymousEntryForState('primary', 'drain', { state: 'idle', mode: 'guest' }),
  { visibility: 'primary', policy: 'drain', primary: true, advanced: false, canStart: false, canRenew: false },
  'drain may explain the policy on primary but must not create a new anonymous lease'
);
assert.deepEqual(
  anonymousEntryForState('advanced', 'drain', {
    state: 'tunnel-only',
    mode: 'guest',
    hasLeaseCapability: true
  }),
  { visibility: 'advanced', policy: 'drain', primary: false, advanced: true, canStart: false, canRenew: true },
  'drain may renew only a retained guest for which the main process confirms capability possession'
);
assert.deepEqual(
  anonymousEntryForState('advanced', 'drain', {
    state: 'tunnel-only',
    mode: 'guest',
    hasLeaseCapability: false
  }),
  { visibility: 'advanced', policy: 'drain', primary: false, advanced: true, canStart: false, canRenew: false },
  'legacy retained guests without capability proof must stay visible but cannot renew during drain'
);
assert.deepEqual(
  anonymousEntryForState('hidden', 'disabled', { state: 'idle', mode: 'guest' }),
  { visibility: 'hidden', policy: 'disabled', primary: false, advanced: false, canStart: false, canRenew: false }
);
assert.deepEqual(
  anonymousEntryForState('hidden', 'disabled', { state: 'connected', mode: 'guest' }),
  { visibility: 'hidden', policy: 'disabled', primary: false, advanced: true, canStart: false, canRenew: false },
  'a current guest must keep the advanced status, recovery, and disconnect surface even when new entry is hidden'
);

const employeeUiSource = functionSource(rendererSource, 'renderEmployeeLogin');
assert.match(employeeUiSource, /renderPrimaryAnonymousEntry\(connecting, feishuPending\)/);
assert.match(employeeUiSource, /data-action="show-advanced"/);
assert.match(employeeUiSource, /data-action="disconnect"/);
assert.match(employeeUiSource, /仅断开访客模式/);

const primaryAnonymousUiSource = functionSource(rendererSource, 'renderPrimaryAnonymousEntry');
assert.match(primaryAnonymousUiSource, /if \(!canStartAnonymousEnrollment\(\)\)/);
assert.match(primaryAnonymousUiSource, /anonymousPolicyMessage\(\)/);
assert.match(primaryAnonymousUiSource, /data-action="connectGuest"/);

const advancedUiSource = functionSource(rendererSource, 'renderAdvancedPhone');
assert.match(advancedUiSource, /renderAnonymousAccessPanel\(\)/);

const anonymousUiSource = functionSource(rendererSource, 'renderAnonymousAccessPanel');
assert.match(anonymousUiSource, /if \(!shouldRenderAnonymousAccessPanel\(\)\) return '';/);
assert.match(anonymousUiSource, /const action = connected \? 'disconnect' : 'connectGuest'/);
assert.match(anonymousUiSource, /\(!connected && !enrollmentAllowed\)/);
assert.match(anonymousUiSource, /renderConnectionRecoverySteps\(retainedGuest\)/);
assert.match(anonymousUiSource, /data-action="resetLocalNetworkIdentity"/);
assert.match(anonymousUiSource, /employeeActive/);

const guestUiSource = functionSource(rendererSource, 'renderGuestConnect');
assert.match(guestUiSource, /retainedGuest && !canRenewAnonymousEnrollment\(\)/);
assert.match(guestUiSource, /connecting \|\| disconnecting \|\| renewalBlocked/);

const backSource = functionSource(rendererSource, 'handlePhoneBack');
assert.match(
  backSource,
  /if \(screen === 'advanced'\) \{[\s\S]*modeDraft = preferredLauncherMode\(\)/,
  'leaving advanced options must reveal a retained guest and otherwise return to employee login'
);

const runActionSource = functionSource(rendererSource, 'runAction');
assert.match(
  runActionSource,
  /\['connectGuest', 'disconnect', 'resetLocalNetworkIdentity'\]\.includes\(action\)[\s\S]*!isGuestConnectionActive\(\)[\s\S]*modeDraft = 'employee'/,
  'completed guest actions must return an idle launcher to the employee default'
);

assert.match(stylesSource, /\.anonymous-access-panel\s*\{/);
assert.match(stylesSource, /\.anonymous-access-actions\s*\{/);

assert.match(
  mainSource,
  /void refreshLauncherProductPresentation\('app-startup'\)/,
  'the client must refresh ProductNetwork presentation without blocking startup'
);
assert.match(
  functionSource(mainSource, 'refreshLauncherProductPresentation'),
  /launcher\.getProduct\(productId\)/,
  'visibility must come from the public per-product ProductNetwork read'
);
assert.match(
  functionSource(mainSource, 'launcherContext'),
  /applyLauncherProductPresentation\(productNetwork\)/,
  'every enrollment path must consume the latest product response as well'
);
assert.match(
  functionSource(mainSource, 'normalizeLauncherAnonymousUiVisibility'),
  /\['primary', 'advanced', 'hidden'\][\s\S]*'advanced'/,
  'unknown and legacy values must fail safe to the current advanced location'
);
assert.match(
  functionSource(mainSource, 'normalizeLauncherAnonymousEnrollmentPolicy'),
  /\['enabled', 'drain', 'disabled'\][\s\S]*'enabled'/,
  'unknown and legacy admission policy must preserve the pre-existing enabled behavior'
);
assert.match(
  functionSource(mainSource, 'applyLauncherProductPresentation'),
  /anonymousEnrollmentPolicy:[\s\S]*anonymousUiVisibility:/,
  'the presentation snapshot must update policy and visibility atomically from one ProductNetwork response'
);
const visibleConnectionSource = functionSource(mainSource, 'visibleConnection');
assert.match(visibleConnectionSource, /hasLeaseCapability: Boolean\(nullableString\(input\.leaseCapability\)\)/);
assert.doesNotMatch(
  visibleConnectionSource,
  /leaseCapability:\s*input\.leaseCapability/,
  'renderer state may receive capability possession but never the capability secret'
);

console.log('OK anonymous entry follows per-product policy and visibility while retained guests stay recoverable');
