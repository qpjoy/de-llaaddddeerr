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
  'a current guest must keep the advanced status and disconnect surface even when new entry is hidden'
);

const anonymousRecoveryState = Function(
  'anonymousEnrollmentPolicyValue',
  'connection',
  `let state = {
  launcherProductPresentation: { anonymousEnrollmentPolicy: anonymousEnrollmentPolicyValue },
  connection
};
${functionSource(rendererSource, 'anonymousEnrollmentPolicy')}
${functionSource(rendererSource, 'isGuestConnectionReady')}
${functionSource(rendererSource, 'isGuestTunnelActive')}
${functionSource(rendererSource, 'anonymousRecoveryBlockedByPolicy')}
return {
  ready: isGuestConnectionReady(),
  liveTunnel: isGuestTunnelActive(),
  blocked: anonymousRecoveryBlockedByPolicy()
};`
);

assert.deepEqual(
  anonymousRecoveryState('disabled', { state: 'forbidden', mode: 'guest' }),
  { ready: false, liveTunnel: false, blocked: true },
  'an anonymous 403 must settle into a policy-blocked state instead of retained recovery'
);
assert.deepEqual(
  anonymousRecoveryState('disabled', { state: 'idle', mode: 'guest' }),
  { ready: false, liveTunnel: false, blocked: false },
  'an idle client must remain on the employee-first launcher instead of becoming a retained guest'
);
assert.deepEqual(
  anonymousRecoveryState('disabled', {
    state: 'tunnel-only',
    mode: 'guest',
    wireGuard: { active: true }
  }),
  { ready: false, liveTunnel: true, blocked: true },
  'a non-ready guest tunnel must not be repaired after anonymous login is disabled'
);
assert.deepEqual(
  anonymousRecoveryState('disabled', {
    state: 'connected',
    mode: 'guest',
    health: { wireGuard: 'ready', internalApi: 'ready', splitDns: 'ready' },
    wireGuard: { active: true },
    diagnostics: { route: { ok: true }, internalApi: { ok: true } }
  }),
  { ready: true, liveTunnel: true, blocked: false },
  'a genuinely ready existing guest remains live and disconnectable'
);
assert.deepEqual(
  anonymousRecoveryState('drain', {
    state: 'tunnel-only',
    mode: 'guest',
    wireGuard: { active: true }
  }),
  { ready: false, liveTunnel: true, blocked: false },
  'drain keeps the existing retained-capability recovery behavior'
);

const retainedTunnelRuntime = {
  connection: {
    state: 'tunnel-only',
    mode: 'guest',
    leaseId: 'lnlease_retained_guest',
    wireGuard: { active: true, interfaceName: 'utun9' },
    diagnostics: { route: { ok: false } }
  },
  feedback: null
};
const disabledStateEffects = { canceledRecoveries: 0, touched: [] };
const applyAnonymousLoginDisabledState = Function(
  'runtime',
  'readyAnonymousConnection',
  'guestConnectionHasRecoveryState',
  'cancelScheduledWireGuardRecovery',
  'nowIso',
  'touchRuntime',
  'ANONYMOUS_LOGIN_DISABLED_MESSAGE',
  `${functionSource(mainSource, 'applyAnonymousLoginDisabledState')}
return applyAnonymousLoginDisabledState;`
)(
  retainedTunnelRuntime,
  () => false,
  () => true,
  () => { disabledStateEffects.canceledRecoveries += 1; },
  () => '2026-08-22T00:00:00.000Z',
  (reason) => { disabledStateEffects.touched.push(reason); },
  'MX-H2I 已禁止匿名登录，请使用员工登录或由管理员重新启用'
);
applyAnonymousLoginDisabledState('test disabled policy');
assert.equal(retainedTunnelRuntime.connection.state, 'forbidden');
assert.equal(retainedTunnelRuntime.connection.leaseId, 'lnlease_retained_guest');
assert.deepEqual(
  retainedTunnelRuntime.connection.wireGuard,
  { active: true, interfaceName: 'utun9' },
  'policy settlement must preserve a live WireGuard tunnel so the user can explicitly disconnect it'
);
assert.equal(disabledStateEffects.canceledRecoveries, 1);
assert.equal(
  retainedTunnelRuntime.feedback.message,
  'MX-H2I 已禁止匿名登录，请使用员工登录或由管理员重新启用'
);

const authoritativeDisabledError = Function(
  `${functionSource(mainSource, 'authoritativeAnonymousEnrollmentDisabledError')}
return authoritativeAnonymousEnrollmentDisabledError;`
)();
assert.equal(authoritativeDisabledError({
  status: 403,
  payload: {
    statusCode: 403,
    code: 'launcher_anonymous_enrollment_disabled',
    message: 'Launcher product mx-h2i has disabled anonymous enrollment'
  }
}), true);
assert.equal(
  authoritativeDisabledError({ status: 403, payload: { message: 'forbidden' } }),
  false,
  'a generic 403 must never be reclassified as the product anonymous policy'
);
assert.equal(
  authoritativeDisabledError({
    status: 403,
    payload: { code: 'launcher_anonymous_enrollment_draining' }
  }),
  false,
  'drain must preserve its separate retained-capability semantics'
);

const authoritativeRuntime = {
  config: { productId: 'mx-h2i' },
  launcherProductPresentation: {
    productId: 'mx-h2i',
    anonymousEnrollmentPolicy: 'enabled',
    anonymousUiVisibility: 'advanced',
    syncedAt: '2026-08-21T00:00:00.000Z'
  },
  connection: {
    state: 'connecting',
    mode: 'guest',
    leaseId: 'lnlease_authoritative_disabled',
    diagnostics: {}
  },
  feedback: null
};
const applyAuthoritativeDisabled = Function(
  'runtime',
  'normalizeLauncherProductPresentation',
  'launcherProductId',
  'nowIso',
  'readyAnonymousConnection',
  'guestConnectionHasRecoveryState',
  'cancelScheduledWireGuardRecovery',
  'touchRuntime',
  'ANONYMOUS_LOGIN_DISABLED_MESSAGE',
  `${functionSource(mainSource, 'applyAnonymousLoginDisabledState')}
${functionSource(mainSource, 'applyAuthoritativeAnonymousEnrollmentDisabledState')}
return applyAuthoritativeAnonymousEnrollmentDisabledState;`
)(
  authoritativeRuntime,
  (presentation) => ({ ...presentation }),
  () => 'mx-h2i',
  () => '2026-08-22T00:00:00.000Z',
  () => false,
  () => true,
  () => undefined,
  () => undefined,
  'MX-H2I 已禁止匿名登录，请使用员工登录或由管理员重新启用'
);
applyAuthoritativeDisabled('authoritative 403 test');
assert.equal(authoritativeRuntime.launcherProductPresentation.anonymousEnrollmentPolicy, 'disabled');
assert.equal(authoritativeRuntime.connection.state, 'forbidden');
assert.equal(
  authoritativeRuntime.feedback.message,
  'MX-H2I 已禁止匿名登录，请使用员工登录或由管理员重新启用'
);

const startupSettlementEffects = { applied: 0, saved: 0 };
const settleDisabledAfterStartup = Function(
  'runtime',
  'anonymousRecoveryBlockedByPolicy',
  'applyAnonymousLoginDisabledState',
  'saveRuntime',
  `${functionSource(mainSource, 'settleAnonymousLoginDisabledAfterStartup')}
return settleAnonymousLoginDisabledAfterStartup;`
)(
  authoritativeRuntime,
  () => true,
  () => { startupSettlementEffects.applied += 1; },
  async () => { startupSettlementEffects.saved += 1; }
);
assert.equal(await settleDisabledAfterStartup(), true);
assert.deepEqual(
  startupSettlementEffects,
  { applied: 1, saved: 1 },
  'startup must re-settle and persist disabled state without relying on a changed product timestamp'
);

let diagnosticsSettlementCount = 0;
const refreshDisabledDiagnostics = Function(
  'runtime',
  'anonymousRecoveryBlockedByPolicy',
  'applyAnonymousLoginDisabledState',
  `${functionSource(mainSource, 'refreshWireGuardDiagnostics')}
return refreshWireGuardDiagnostics;`
)(
  authoritativeRuntime,
  () => true,
  () => { diagnosticsSettlementCount += 1; }
);
assert.deepEqual(
  await refreshDisabledDiagnostics(),
  { skipped: true, reason: 'anonymous-enrollment-disabled' }
);
assert.equal(diagnosticsSettlementCount, 1);

const enrollmentGateEffects = { context: 0, settled: 0 };
const connectWithRefreshedDisabledPolicy = Function(
  'ensureCredentialStorageRecoveryReady',
  'launcherContext',
  'launcherAnonymousEnrollmentDisabled',
  'applyAnonymousLoginDisabledState',
  'launcherAnonymousEnrollmentDisabledError',
  `${functionSource(mainSource, 'connectLauncherNetwork')}
return connectLauncherNetwork;`
)(
  async () => undefined,
  async () => {
    enrollmentGateEffects.context += 1;
    return { launcher: { connectNetwork: () => { throw new Error('enrollment POST must not run'); } } };
  },
  () => true,
  () => { enrollmentGateEffects.settled += 1; },
  () => Object.assign(new Error('disabled'), {
    status: 403,
    payload: { code: 'launcher_anonymous_enrollment_disabled' }
  })
);
await assert.rejects(
  connectWithRefreshedDisabledPolicy({ identityKind: 'anonymous' }),
  (err) => err?.payload?.code === 'launcher_anonymous_enrollment_disabled'
);
assert.deepEqual(enrollmentGateEffects, { context: 1, settled: 1 });

const recoveryRuntime = {
  installation: {
    installId: 'inst_guest',
    keyPair: { publicKey: 'guest-public-key' }
  },
  identity: {
    kind: 'anonymous',
    provider: null,
    account: null
  },
  networkEvent: { transitionId: 'transition-guest' },
  connection: {
    state: 'connected',
    mode: 'guest',
    subject: 'anonymous:inst_guest',
    leaseId: 'lease-guest',
    snapshotId: 'snapshot-guest',
    localIp: '10.89.100.12',
    connectedAt: '2026-08-22T00:00:00.000Z',
    productId: 'mx-h2i',
    publicKey: 'guest-public-key'
  }
};
const recoveryIdentityApi = Function(
  'runtime',
  'nullableString',
  'networkMutationEpoch',
  `${functionSource(mainSource, 'wireGuardRecoveryIdentity')}
${functionSource(mainSource, 'wireGuardRecoveryIdentityIsCurrent')}
return { wireGuardRecoveryIdentity, wireGuardRecoveryIdentityIsCurrent };`
)(
  recoveryRuntime,
  (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
  7
);
const capturedRecoveryIdentity = recoveryIdentityApi.wireGuardRecoveryIdentity(recoveryRuntime.connection);
assert.equal(recoveryIdentityApi.wireGuardRecoveryIdentityIsCurrent(capturedRecoveryIdentity), true);
recoveryRuntime.connection = {
  ...recoveryRuntime.connection,
  state: 'connecting',
  mode: 'employee'
};
assert.equal(
  recoveryIdentityApi.wireGuardRecoveryIdentityIsCurrent(capturedRecoveryIdentity),
  false,
  'an in-flight guest probe must become stale before an employee/Feishu transition can be overwritten'
);
recoveryRuntime.connection = {
  ...recoveryRuntime.connection,
  state: 'forbidden',
  mode: 'guest'
};
assert.equal(
  recoveryIdentityApi.wireGuardRecoveryIdentityIsCurrent(capturedRecoveryIdentity),
  true,
  'the same guest lease may settle from connected to policy-forbidden without being mistaken for another transition'
);
recoveryRuntime.identity = {
  kind: 'user',
  provider: 'feishu',
  account: 'employee@example.com'
};
assert.equal(
  recoveryIdentityApi.wireGuardRecoveryIdentityIsCurrent(capturedRecoveryIdentity),
  false,
  'a changed principal must supersede a guest recovery even before a lease write-back'
);
recoveryRuntime.identity = {
  kind: 'anonymous',
  provider: null,
  account: null
};
recoveryRuntime.networkEvent = { transitionId: 'transition-employee' };
assert.equal(recoveryIdentityApi.wireGuardRecoveryIdentityIsCurrent(capturedRecoveryIdentity), false);

let resolveRecoveryImport;
let staleRecoveryMutationCalls = 0;
const recoveryImportReady = new Promise((resolve) => {
  resolveRecoveryImport = resolve;
});
const recoverWithAsyncIdentityGuard = Function(
  'runtime',
  'shouldRecoverWireGuardConnection',
  'wireGuardRecoveryGate',
  'wireGuardRecoveryTurn',
  'wireGuardRecoveryIdentity',
  'wireGuardRecoveryIdentityIsCurrent',
  'normalizeRoutePlan',
  'importInstalledPackage',
  'broadcastState',
  `let wireGuardRecoveryInFlight = null;
let lastWireGuardRecoveryFailureAt = 0;
const wireGuardConnectOperations = new Set();
let wireGuardDisconnectInFlight = false;
let networkRecoveryPaused = false;
${functionSource(mainSource, 'recoverWireGuardForRuntime')}
return recoverWireGuardForRuntime;`
)(
  recoveryRuntime,
  () => true,
  () => null,
  async () => ({ action: 'reuse', recovery: null }),
  recoveryIdentityApi.wireGuardRecoveryIdentity,
  recoveryIdentityApi.wireGuardRecoveryIdentityIsCurrent,
  (routePlan) => routePlan || { leaseIp: '10.89.100.12' },
  async () => recoveryImportReady,
  () => undefined
);
recoveryRuntime.connection = {
  ...recoveryRuntime.connection,
  state: 'lease-only',
  mode: 'guest',
  routePlan: { leaseIp: '10.89.100.12' }
};
recoveryRuntime.networkEvent = { transitionId: 'transition-async-guest' };
const staleRecoveryPromise = recoverWithAsyncIdentityGuard('interval', { allowPrivileged: true });
recoveryRuntime.connection = {
  ...recoveryRuntime.connection,
  state: 'connecting',
  mode: 'employee',
  subject: 'user:employee'
};
recoveryRuntime.identity = {
  kind: 'user',
  provider: 'feishu',
  account: 'employee@example.com'
};
recoveryRuntime.networkEvent = { transitionId: 'transition-async-employee' };
resolveRecoveryImport({
  recoverLauncherWireGuardPeer: async () => {
    staleRecoveryMutationCalls += 1;
    return { ok: true };
  }
});
assert.deepEqual(
  await staleRecoveryPromise,
  { ok: true, skipped: true, reason: 'connection-transition-superseded' }
);
assert.equal(staleRecoveryMutationCalls, 0, 'a stale async guest recovery must not mutate the employee tunnel');
assert.match(
  functionSource(mainSource, 'recoverWireGuardForRuntime'),
  /wireGuardRecoveryInFlight = pendingRecovery[\s\S]*settlePendingRecovery[\s\S]*broadcastState\(\)[\s\S]*pendingRecovery\.then\(settlePendingRecovery, settlePendingRecovery\)/,
  'a completed background probe must clear its in-flight marker and publish the settled UI state'
);
assert.equal(recoveryRuntime.connection.mode, 'employee');

const staleEmployeeRuntime = {
  connection: {
    state: 'connecting',
    mode: 'employee',
    leaseId: 'lease-employee'
  }
};
const settleStaleRecovery = Function(
  'runtime',
  'wireGuardRecoveryIdentityIsCurrent',
  'anonymousRecoveryBlockedByPolicy',
  'applyAnonymousLoginDisabledState',
  'saveAndBroadcast',
  `${functionSource(mainSource, 'settleAnonymousRecoveryBlockedByPolicy')}
return settleAnonymousRecoveryBlockedByPolicy;`
)(
  staleEmployeeRuntime,
  () => false,
  () => true,
  () => { throw new Error('stale recovery must not settle'); },
  () => { throw new Error('stale recovery must not save'); }
);
assert.equal(await settleStaleRecovery(
  { state: 'connected', mode: 'guest', leaseId: 'lease-guest' },
  { state: 'tunnel-only', health: {}, wireGuard: {}, diagnostics: {} },
  'test-race',
  capturedRecoveryIdentity
), false);
assert.equal(staleEmployeeRuntime.connection.mode, 'employee');

const resetNeedsDisconnect = Function(
  `${functionSource(mainSource, 'guestConnectionRequiresDisconnectBeforeIdentityReset')}
return guestConnectionRequiresDisconnectBeforeIdentityReset;`
)();
assert.equal(resetNeedsDisconnect({ state: 'forbidden', mode: 'guest', wireGuard: { active: true } }), true);
assert.equal(resetNeedsDisconnect({ state: 'tunnel-only', mode: 'guest', wireGuard: { active: false } }), true);
assert.equal(
  resetNeedsDisconnect({ state: 'connecting', mode: 'employee', retainedMode: 'guest', wireGuard: { active: true } }),
  true,
  'an employee transition must not make the still-retained guest tunnel eligible for identity reset'
);
assert.equal(resetNeedsDisconnect({ state: 'lease-only', mode: 'guest', wireGuard: { active: false } }), false);
assert.equal(resetNeedsDisconnect({ state: 'connected', mode: 'employee', wireGuard: { active: true } }), false);

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
assert.match(anonymousUiSource, /const disconnectable = connected \|\| isGuestTunnelActive\(connection\)/);
assert.match(anonymousUiSource, /const action = disconnectable \? 'disconnect' : 'connectGuest'/);
assert.match(anonymousUiSource, /\(!disconnectable && !enrollmentAllowed\)/);
assert.match(anonymousUiSource, /renderConnectionRecoverySteps\(retainedGuest\)/);
assert.match(anonymousUiSource, /data-action="resetLocalNetworkIdentity"/);
assert.match(anonymousUiSource, /cleaning \|\| disconnectable \? 'disabled' : ''/);
assert.match(anonymousUiSource, /请先断开匿名连接/);
assert.match(anonymousUiSource, /employeeActive/);

const guestUiSource = functionSource(rendererSource, 'renderGuestConnect');
assert.match(guestUiSource, /retainedGuest && !canRenewAnonymousEnrollment\(\)/);
assert.match(guestUiSource, /const disconnectable = connected \|\| isGuestTunnelActive\(\)/);
assert.match(guestUiSource, /!disconnectable && renewalBlocked/);
assert.match(guestUiSource, /data-action="resetLocalNetworkIdentity"[\s\S]*disconnectable \? 'disabled' : ''/);

assert.match(
  functionSource(rendererSource, 'renderConnectionRecoverySteps'),
  /!show \|\| networkOperationPaused\(\) \|\| anonymousRecoveryBlockedByPolicy\(\)/,
  'paused or disabled non-ready anonymous state must never render misleading in-place recovery progress'
);
assert.match(
  functionSource(rendererSource, 'renderConnectionRecoverySteps'),
  /currentNetworkOperation\(\) \? ''[\s\S]*data-action="cancelNetworkOperation"[\s\S]*暂停自动恢复[\s\S]*系统权限框/,
  'retained automatic recovery without a foreground id must still expose a safe pause action'
);
assert.match(
  functionSource(rendererSource, 'renderWireGuardDiagnostics'),
  /anonymousRecoveryBlockedByPolicy\(\)[\s\S]*修复网络[\s\S]*重新诊断/,
  'disabled non-ready anonymous state must expose neither repair nor mutating peer diagnostics'
);
assert.match(
  functionSource(rendererSource, 'connectionCaption'),
  /anonymousRecoveryBlockedByPolicy\(\)[\s\S]*ANONYMOUS_LOGIN_DISABLED_MESSAGE/,
  'the launcher must show a stable disabled-anonymous explanation'
);

const backSource = functionSource(rendererSource, 'handlePhoneBack');
assert.match(
  backSource,
  /if \(screen === 'advanced'\) \{[\s\S]*modeDraft = preferredLauncherMode\(\)/,
  'leaving advanced options must reveal a retained guest and otherwise return to employee login'
);

const runActionSource = functionSource(rendererSource, 'runAction');
assert.match(
  runActionSource,
  /networkOperationBlocksMutation\(\) && isNetworkMutatingAction\(action\)/,
  'a cancel-requested operation must block reconnect, repair, disconnect, and identity cleanup races'
);
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
  functionSource(mainSource, 'connectLauncherNetwork'),
  /launcherContext\(\)[\s\S]*identityKind === 'anonymous'[\s\S]*launcherAnonymousEnrollmentDisabled\(\)[\s\S]*throw launcherAnonymousEnrollmentDisabledError\(\)[\s\S]*launcher\.connectNetwork/,
  'anonymous enrollment must re-check the authoritative product response before the enrollment POST'
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
  /anonymousEnrollmentPolicy:[\s\S]*anonymousUiVisibility:[\s\S]*anonymousRecoveryBlockedByPolicy/,
  'the presentation snapshot must update policy and visibility atomically from one ProductNetwork response'
);
assert.match(mainSource, /MX-H2I 已禁止匿名登录，请使用员工登录或由管理员重新启用/);
assert.match(
  functionSource(mainSource, 'shouldRecoverWireGuardConnection'),
  /anonymousRecoveryBlockedByPolicy\(connection\)/,
  'automatic WireGuard recovery must stop for a disabled non-ready guest'
);
assert.match(
  functionSource(mainSource, 'scheduleWireGuardRecovery'),
  /anonymousRecoveryBlockedByPolicy\(runtime\?\.connection\)/,
  'disabled anonymous recovery must not schedule new timers'
);
assert.match(
  functionSource(mainSource, 'applyAnonymousLoginDisabledState'),
  /cancelScheduledWireGuardRecovery\(\)/,
  'a newly disabled non-ready guest must cancel queued recovery turns'
);
assert.ok(
  functionSource(mainSource, 'recoverWireGuardForRuntime')
    .split('anonymousRecoveryBlockedByPolicy(runtime?.connection)').length >= 3,
  'an in-flight recovery must re-check disabled anonymous policy after asynchronous work'
);
assert.match(
  functionSource(mainSource, 'recoverWireGuardForRuntime'),
  /settleAnonymousRecoveryBlockedByPolicy\([\s\S]*connection,[\s\S]*wireGuardResult,[\s\S]*reason,[\s\S]*recoveryIdentity/,
  'a recovery probe that observes degradation under disabled policy must settle directly into the stable blocked state'
);
assert.match(
  functionSource(mainSource, 'handleNetworkChange'),
  /anonymousRecoveryBlockedByPolicy\(runtime\?\.connection\)/,
  'network-change repair must stop for a disabled non-ready guest'
);
assert.match(
  functionSource(mainSource, 'refreshSystemDomainProxyForRuntime'),
  /anonymousRecoveryBlockedByPolicy\(runtime\?\.connection\)/,
  'PAC and split-DNS background repair must stop for a disabled non-ready guest'
);
assert.match(
  functionSource(mainSource, 'repairSystemNetworkForRuntime'),
  /anonymousRecoveryBlockedByPolicy\(runtime\?\.connection\)[\s\S]*ANONYMOUS_LOGIN_DISABLED_MESSAGE/,
  'manual repair must remain blocked once anonymous login is disabled'
);
assert.match(
  functionSource(mainSource, 'applyConnectionError'),
  /authoritativeAnonymousEnrollmentDisabledError\(err\)[\s\S]*applyAuthoritativeAnonymousEnrollmentDisabledState[\s\S]*anonymousRecoveryBlockedByPolicy\(runtime\.connection\)[\s\S]*applyAnonymousLoginDisabledState/,
  'an authoritative disabled code and a refreshed disabled policy must both settle into the stable state'
);
assert.match(
  mainSource,
  /ipcMain\.handle\('mx-h2i:connect-guest'[\s\S]*anonymousGuestConnectBlockedByPolicy\(runtime\.connection\)[\s\S]*repairDarwinEndpointRouteBeforeBootstrap\('guest-pre-bootstrap'\)/,
  'guest connect must enforce the effective product policy before retained repair'
);
assert.match(
  mainSource,
  /reconcileExistingWireGuardAfterStartup\(\)[\s\S]*reconcilePendingNetworkHandoverAfterStartup\(\)[\s\S]*settleAnonymousLoginDisabledAfterStartup\(\)[\s\S]*refreshSystemDomainProxyForRuntime\('app-startup'\)/,
  'persisted disabled policy must be re-settled after startup reconciliation even when the product snapshot is unchanged'
);
assert.match(
  functionSource(mainSource, 'probeWireGuardForConnection'),
  /shouldRepairDarwinRetainedOwnership\([\s\S]*!anonymousRecoveryBlockedByPolicy\(connection\)/,
  'a disabled non-ready guest probe must not mutate standalone ownership'
);
assert.match(
  functionSource(mainSource, 'refreshWireGuardDiagnostics'),
  /anonymousRecoveryBlockedByPolicy\(runtime\?\.connection\)[\s\S]*return \{ skipped: true, reason: 'anonymous-enrollment-disabled' \};[\s\S]*syncDomesticPeerForLease/,
  'disabled guest diagnostics must return before any remote peer synchronization'
);
assert.match(
  mainSource,
  /ipcMain\.handle\('mx-h2i:refresh-diagnostics'[\s\S]*anonymousRecoveryBlockedByPolicy\(runtime\?\.connection\)[\s\S]*return visibleRuntime\(\);[\s\S]*recoverWireGuardForRuntime\('manual-diagnostics'/,
  'the IPC path must also fail closed before recovery or peer diagnostics'
);
assert.match(
  functionSource(mainSource, 'promoteEmployeeConnection'),
  /drainWireGuardRecoveryOperation\(\)[\s\S]*setConnecting\('employee'/,
  'employee and Feishu transitions must drain an older guest recovery before changing the data plane'
);
assert.ok(
  functionSource(mainSource, 'recoverWireGuardForRuntime')
    .split('wireGuardRecoveryIdentityIsCurrent(recoveryIdentity)').length >= 6,
  'all in-flight recovery phases must discard stale guest observations before writing runtime state'
);
assert.match(
  mainSource,
  /ipcMain\.handle\('mx-h2i:reset-local-network-identity'[\s\S]*guestConnectionRequiresDisconnectBeforeIdentityReset\(runtime\?\.connection\)[\s\S]*请先明确断开连接[\s\S]*rotateLocalLauncherIdentity/,
  'main process must refuse identity rotation while an anonymous tunnel may still be active'
);
const visibleConnectionSource = functionSource(mainSource, 'visibleConnection');
assert.match(visibleConnectionSource, /hasLeaseCapability: Boolean\(nullableString\(input\.leaseCapability\)\)/);
assert.doesNotMatch(
  visibleConnectionSource,
  /leaseCapability:\s*input\.leaseCapability/,
  'renderer state may receive capability possession but never the capability secret'
);

console.log('OK anonymous entry and retained recovery follow the effective per-product policy');
