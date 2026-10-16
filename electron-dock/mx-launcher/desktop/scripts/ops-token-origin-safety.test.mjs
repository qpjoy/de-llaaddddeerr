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

const gateHandlerStart = rendererSource.indexOf("document.getElementById('gate-token-form').addEventListener('submit',");
const gateHandlerEnd = rendererSource.indexOf('\n});\nvoid boot();', gateHandlerStart);
assert.ok(gateHandlerStart >= 0 && gateHandlerEnd > gateHandlerStart, 'the real gate Token handler must exist');
const gateHandlerSource = rendererSource.slice(gateHandlerStart, gateHandlerEnd + '\n});'.length);

const serverInput = { value: 'https://internal.example:443' };
const opsTokenInput = { value: 'session-secret' };
const opsTokenApply = { disabled: false, textContent: '应用' };
const opsTokenFeedback = { textContent: '', dataset: {}, hidden: true };
const requests = [];
let requestResponse = Promise.resolve({ roles: [] });
let refreshCount = 0;
let refreshResult = true;
let productRefreshCount = 0;
let opsMode = async () => 'raw';
let sessionAuthenticated = false;
const sessionLogins = [];
const adminSession = {
  opsLoginMode: () => opsMode(),
  signInWithOps: async token => {
    sessionLogins.push({ path: '/auth/admin/ops-login', token });
    sessionAuthenticated = true;
  },
  entry: () => sessionAuthenticated ? { authenticated: true, canManage: true } : null
};
let gateSubmit;
const gateButton = { disabled: false };
const gateToken = { value: '' };
const gateFeedback = { textContent: '' };
const gateServer = { value: serverInput.value };
const gateDocument = { getElementById: id => ({
  'gate-token-form': { addEventListener: (event, handler) => { assert.equal(event, 'submit'); gateSubmit = handler; } },
  'gate-token': gateToken,
  'gate-token-error': gateFeedback,
  'gate-server': gateServer
})[id] };
const submitGate = () => gateSubmit({ preventDefault() {}, currentTarget: { querySelector: () => gateButton } });
const security = Function(
  'serverInput',
  'opsTokenInput',
  'opsTokenApply',
  'opsTokenFeedback',
  'fetch',
  'refreshAdmin',
  'adminSession',
  'document',
  'refreshProducts',
  `
const LOCAL_SERVER_BASE_URL = 'http://127.0.0.1:18090';
${functionSource(rendererSource, 'isLocalStaticAdminBaseUrl')}
${functionSource(rendererSource, 'normalizeServerBaseValue')}
function defaultServerBaseUrl() { return LOCAL_SERVER_BASE_URL; }
let opsTokenBinding = null;
let verifiedOpsBinding = null;
function renderLoginGate() {}
function normalizedServerBase() { return serverInput.value; }
function synchronizeLauncherNetworkServerScope() {}
let drawerRenderCount = 0;
function renderUserEditorDrawer() { drawerRenderCount += 1; }
const state = { userCenter: {
  drawer: null,
  systemSubscriptionBusy: false,
  systemSubscriptionFeedback: null,
  systemSubscriptionSecrets: {},
  systemSubscriptionSecretGeneration: 0
} };
${functionSource(rendererSource, 'isOpsProtectedInternalRequest')}
${functionSource(rendererSource, 'normalizedInternalServerEndpoint')}
${functionSource(rendererSource, 'clearSystemSubscriptionSecrets')}
${functionSource(rendererSource, 'clearOpsToken')}
${functionSource(rendererSource, 'setOpsTokenFeedback')}
async ${functionSource(rendererSource, 'applyOpsToken')}
${functionSource(rendererSource, 'bindOpsTokenToCurrentServer')}
${functionSource(rendererSource, 'clearOpsTokenIfServerBaseChanged')}
${functionSource(rendererSource, 'opsTokenForRequest')}
${functionSource(rendererSource, 'setServerBaseInputValue')}
${functionSource(rendererSource, 'managementSignedIn')}
${gateHandlerSource}
return {
  applyOpsToken,
  clearOpsToken,
  bindOpsTokenToCurrentServer,
  clearOpsTokenIfServerBaseChanged,
  isOpsProtectedInternalRequest,
  opsTokenForRequest,
  binding: () => opsTokenBinding,
  secrets: () => state.userCenter.systemSubscriptionSecrets,
  generation: () => state.userCenter.systemSubscriptionSecretGeneration,
  drawerRenderCount: () => drawerRenderCount,
  setSecrets: (value) => { state.userCenter.systemSubscriptionSecrets = value; },
  setDrawer: (value) => { state.userCenter.drawer = value; }
};
`
)(serverInput, opsTokenInput, opsTokenApply, opsTokenFeedback, (url, options) => {
  requests.push({ path: new URL(url).pathname, token: options.headers['x-mx-ops-token'] });
  return requestResponse.then(() => ({ ok: true, json: async () => ({ roles: [] }) }));
}, async () => {
  refreshCount += 1;
  return refreshResult;
}, adminSession, gateDocument, async () => { productRefreshCount += 1; });

security.bindOpsTokenToCurrentServer();
assert.deepEqual(security.binding(), {
  token: 'session-secret',
  serverBase: 'https://internal.example:443',
  origin: 'https://internal.example'
});
assert.equal(
  security.opsTokenForRequest(
    new URL('https://internal.example/internal/v1/user-center/users'),
    'GET'
  ),
  'session-secret',
  'a protected request on the bound normalized origin receives the token'
);
assert.equal(
  security.opsTokenForRequest(
    new URL('https://internal.example/internal/v1/admin/dashboard'),
    'GET'
  ),
  '',
  'an unprotected Internal request does not receive the token'
);
assert.equal(
  security.opsTokenForRequest(
    new URL('https://attacker.example/internal/v1/user-center/users'),
    'GET'
  ),
  '',
  'a protected-looking path on another origin never receives the token'
);

for (const [method, path] of [
  ['GET', '/internal/v1/user-center/roles'],
  ['GET', '/internal/v1/user-center/system-subscriptions'],
  ['POST', '/internal/v1/user-center/bootstrap'],
  ['POST', '/internal/v1/user-center/oversea-entitlements/rollout'],
  ['POST', '/internal/v1/user-center/system-subscriptions/ensure'],
  ['POST', '/internal/v1/user-center/system-subscriptions/subscription-link'],
  ['DELETE', '/internal/v1/user-center/system-subscriptions/subscription-link'],
  ['POST', '/internal/v1/user-center/system-subscriptions/sites/mx-oversea-hk01/reveal'],
  ['GET', '/internal/v1/site-slots/mx-oversea-hk01/access-accounts'],
  ['GET', '/internal/v1/site-slots/plans/slotplan_oversea'],
  ['GET', '/internal/v1/admin/oversea'],
  ['GET', '/internal/v1/admin/site-slots/pipelines/slotplan_oversea'],
  ['POST', '/internal/v1/site-slots/plans'],
  ['POST', '/internal/v1/site-slots/mx-oversea-hk01/access-accounts'],
  ['POST', '/internal/v1/config-center/site-slot-ssh-profiles'],
  ['POST', '/internal/v1/config-center/site-slot-ssh-profiles/bootstrap'],
  ['POST', '/internal/v1/config-center/site-slot-ssh-profiles/profile_oversea/readiness-probe'],
  ['POST', '/internal/v1/admin/actions/execute'],
  ['POST', '/internal/v1/admin/oversea/mx-oversea-hk01/shadow-setup'],
  ['POST', '/internal/v1/admin/oversea/mx-oversea-hk01/ensure'],
  ['POST', '/internal/v1/admin/oversea/mx-oversea-hk01/terminal'],
  ['DELETE', '/internal/v1/user-center/users/usr_test'],
  ['GET', '/internal/v1/sdk/service-accounts'],
  ['GET', '/internal/v1/launcher-network/leases'],
  ['POST', '/internal/v1/launcher-network/products/mx-h2i'],
  ['POST', '/internal/v1/launcher-network/leases/lease_1/release']
]) {
  assert.equal(
    security.isOpsProtectedInternalRequest(`https://internal.example${path}`, method),
    true,
    `${method} ${path} must be recognized as ops protected`
  );
}
for (const [method, path] of [
  ['GET', '/internal/v1/user-center/capabilities'],
  ['POST', '/internal/v1/user-center/token/introspect'],
  ['GET', '/internal/v1/sdk/oauth/feishu/config'],
  ['GET', '/internal/v1/launcher-network/products'],
  ['POST', '/internal/v1/launcher-network/enrollments'],
  ['GET', '/internal/v1/admin/dashboard']
]) {
  assert.equal(
    security.isOpsProtectedInternalRequest(`https://internal.example${path}`, method),
    false,
    `${method} ${path} must not receive the ops token`
  );
}

serverInput.value = 'https://other-internal.example';
security.setSecrets({ 'mx-oversea-jp01': { url: 'secret' } });
security.setDrawer({ mode: 'system-subscriptions' });
const previousGeneration = security.generation();
const previousDrawerRenderCount = security.drawerRenderCount();
assert.equal(
  security.clearOpsTokenIfServerBaseChanged(),
  true,
  'changing the normalized server base clears the token immediately'
);
assert.equal(opsTokenInput.value, '');
assert.equal(security.binding(), null);
assert.deepEqual(security.secrets(), {}, 'changing the bound Internal origin clears revealed system URLs');
assert.equal(security.generation(), previousGeneration + 1, 'origin changes invalidate in-flight reveal responses');
assert.equal(
  security.drawerRenderCount(),
  previousDrawerRenderCount + 1,
  'an open system drawer is rerendered so stale plaintext leaves the DOM'
);

let resolveReveal;
const revealResponse = new Promise((resolve) => { resolveReveal = resolve; });
const revealRace = Function(
  'revealResponse',
  `
let drawerRenderCount = 0;
function renderUserEditorDrawer() { drawerRenderCount += 1; }
async function fetchJson() { return revealResponse; }
const state = { userCenter: {
  drawer: { mode: 'system-subscriptions' },
  systemSubscriptionBusy: false,
  systemSubscriptionFeedback: null,
  systemSubscriptionSecrets: {},
  systemSubscriptionSecretGeneration: 0
} };
${functionSource(rendererSource, 'clearSystemSubscriptionSecrets')}
async ${functionSource(rendererSource, 'revealSystemSubscription')}
return {
  run: revealSystemSubscription,
  invalidate: clearSystemSubscriptionSecrets,
  state: () => state.userCenter,
  drawerRenderCount: () => drawerRenderCount
};
`
)(revealResponse);
const pendingReveal = revealRace.run('mx-oversea-jp01');
assert.equal(revealRace.drawerRenderCount(), 1, 'reveal renders its busy state');
revealRace.invalidate();
assert.equal(revealRace.drawerRenderCount(), 2, 'credential invalidation immediately removes plaintext from the drawer');
resolveReveal({ subscription: { url: 'http://old-origin.example/secret' } });
await pendingReveal;
assert.deepEqual(revealRace.state().systemSubscriptionSecrets, {}, 'an old-origin response cannot repopulate cleared plaintext');
assert.equal(revealRace.state().systemSubscriptionFeedback, null, 'an old-origin response cannot overwrite the new session feedback');
assert.equal(revealRace.drawerRenderCount(), 2, 'a discarded old-origin response does not rerender the current drawer');

serverInput.value = 'https://internal.example';
opsTokenInput.value = 'next-secret';
security.bindOpsTokenToCurrentServer();
serverInput.value = 'https://internal.example/control-plane';
assert.equal(
  security.opsTokenForRequest(
    new URL('https://internal.example/internal/v1/user-center/users'),
    'GET'
  ),
  '',
  'a programmatic base URL change is caught before sending a request'
);
assert.equal(opsTokenInput.value, '');

const sanitizeHeaders = Function(
  `${functionSource(rendererSource, 'requestHeadersWithoutOpsToken')}; return requestHeadersWithoutOpsToken;`
)();
assert.deepEqual(
  sanitizeHeaders({
    accept: 'application/json',
    'X-MX-OPS-TOKEN': 'attacker-supplied',
    'x-mx-ops-token': 'second-value'
  }),
  { accept: 'application/json' },
  'callers cannot bypass origin binding by supplying the ops header themselves'
);

const fetchJsonSource = functionSource(rendererSource, 'fetchJson');
assert.match(fetchJsonSource, /new URL\(String\(path \|\| ''\), `\$\{normalizedServerBase\(\)\}\/`\)/);
assert.match(fetchJsonSource, /requestHeadersWithoutOpsToken\(options\.headers\)/);
assert.match(fetchJsonSource, /opsTokenForRequest\(requestUrl, method\)/);
assert.match(
  fetchJsonSource,
  /redirect: opsToken \|\| usesPersonalSession \? 'error' : 'follow'/,
  'a token-bearing request must not follow a redirect to another origin'
);
assert.match(
  rendererSource,
  /serverInput\.addEventListener\('input', \(\) => \{\s*clearOpsTokenIfServerBaseChanged\(\);/,
  'base URL edits must clear a stale binding on input, not only on blur'
);
assert.match(
  rendererSource,
  /opsTokenInput\.addEventListener\('input', \(\) => \{\s*bindOpsTokenToCurrentServer\(\);/,
  'token entry must bind to the current normalized Internal origin'
);
assert.match(htmlSource, /id="ops-token-input"[^>]*type="password"[^>]*autocomplete="off"/);
assert.match(htmlSource, /Bound to the current MX Server origin; changing MX Server clears it\./);

// Programmatic autofill deliberately dispatches no input event.
serverInput.value = 'https://internal.example';
opsTokenInput.value = 'autofilled-secret';
await security.applyOpsToken();
assert.deepEqual(requests.at(-1), {
  path: '/internal/v1/user-center/roles',
  token: 'autofilled-secret'
});
assert.equal(refreshCount, 1, 'explicit apply refreshes protected Admin data');
assert.equal(opsTokenFeedback.dataset.kind, 'success');
assert.equal(opsTokenApply.disabled, false);

requestResponse = Promise.reject(new Error('unauthorized'));
await security.applyOpsToken();
assert.equal(opsTokenFeedback.dataset.kind, 'error', 'invalid credentials must not report success');
assert.equal(refreshCount, 1, 'failed verification does not refresh the dashboard');
assert.equal(opsTokenApply.disabled, false, 'failed requests can be retried');
assert.ok(!opsTokenFeedback.textContent.includes('autofilled-secret'));

requestResponse = Promise.resolve({ roles: [] });
refreshResult = false;
await security.applyOpsToken();
assert.equal(opsTokenFeedback.dataset.kind, 'error', 'dashboard failure must not report a successful refresh');
refreshResult = true;

let resolveVerification;
requestResponse = new Promise((resolve) => { resolveVerification = resolve; });
const pendingApply = security.applyOpsToken();
await Promise.resolve(); // Login-mode discovery completes before raw verification starts.
const requestCount = requests.length;
assert.equal(opsTokenApply.disabled, true);
await security.applyOpsToken();
assert.equal(requests.length, requestCount, 'repeated submits cannot start concurrent verification');
serverInput.value = 'https://other-internal.example';
security.clearOpsTokenIfServerBaseChanged();
const refreshesBeforeServerChange = refreshCount;
resolveVerification({ roles: [] });
await pendingApply;
assert.equal(refreshCount, refreshesBeforeServerChange, 'an old-server verification cannot trigger a new-server refresh');
assert.equal(opsTokenFeedback.hidden, true, 'stale completion cannot restore cleared feedback');
assert.equal(opsTokenInput.value, '');
assert.equal(opsTokenApply.disabled, false);

await security.applyOpsToken();
assert.equal(requests.length, requestCount, 'empty tokens do not send a request');
assert.equal(opsTokenFeedback.dataset.kind, 'error');
serverInput.value = 'not a URL';
opsTokenInput.value = 'invalid-endpoint-secret';
await security.applyOpsToken();
assert.equal(requests.length, requestCount, 'invalid server addresses do not send a token');

function resetLoginFixture() {
  security.clearOpsToken();
  serverInput.value = 'https://launcher.example';
  gateServer.value = serverInput.value;
  gateToken.value = '';
  gateFeedback.textContent = '';
  sessionAuthenticated = false;
  sessionLogins.length = 0;
  requests.length = 0;
  refreshCount = 0;
  productRefreshCount = 0;
  requestResponse = Promise.resolve({ roles: [] });
  refreshResult = true;
  opsMode = async () => 'raw';
}

resetLoginFixture();
opsMode = async () => { throw Object.assign(new Error('账号服务暂不可用，请重试连接。'), { code: 'sso_unavailable' }); };
gateToken.value = 'gate-secret-not-to-send';
await submitGate();
assert.deepEqual(requests, [], 'failed session discovery must not send the gate Token to raw roles');
assert.deepEqual(sessionLogins, [], 'failed session discovery must not submit a session login either');
assert.equal(security.binding(), null);
assert.equal(gateToken.value, '', 'failed gate submissions clear the password field');
assert.equal(gateButton.disabled, false, 'discovery failure can be retried');
assert.match(gateFeedback.textContent, /重试连接/);
assert.ok(!gateFeedback.textContent.includes('gate-secret-not-to-send'));
assert.equal(productRefreshCount, 0);

// The operator retries once discovery has recovered as public management.
opsMode = async () => 'session';
gateToken.value = 'recovered-public-secret';
await submitGate();
assert.deepEqual(requests, [], 'recovered public gate must never call raw roles');
assert.deepEqual(sessionLogins, [{ path: '/auth/admin/ops-login', token: 'recovered-public-secret' }]);
assert.equal(security.binding(), null, 'public gate must not create a raw Ops binding');
assert.equal(gateToken.value, '');
assert.equal(gateButton.disabled, false);
assert.equal(productRefreshCount, 1);

resetLoginFixture();
opsMode = async () => { throw Object.assign(new Error('账号服务暂不可用，请重试连接。'), { code: 'sso_unavailable' }); };
opsTokenInput.value = 'direct-secret-not-to-send';
await security.applyOpsToken();
assert.deepEqual(requests, [], 'direct apply must also stop before raw roles when discovery fails');
assert.deepEqual(sessionLogins, []);
assert.equal(opsTokenApply.disabled, false);
assert.match(opsTokenFeedback.textContent, /重试连接/);
assert.ok(!opsTokenFeedback.textContent.includes('direct-secret-not-to-send'));
opsMode = async () => 'session';
await security.applyOpsToken();
assert.deepEqual(requests, [], 'direct public apply uses the session endpoint exclusively');
assert.deepEqual(sessionLogins, [{ path: '/auth/admin/ops-login', token: 'direct-secret-not-to-send' }]);
assert.equal(security.binding(), null, 'session login clears raw credentials');
assert.equal(opsTokenInput.value, '');
assert.equal(refreshCount, 1);

resetLoginFixture();
serverInput.value = 'http://private.example:18090';
gateServer.value = 'http://selected-private.example:18090';
opsMode = async () => {
  // Session refresh rerenders the gate using the current server field. The
  // submitted private target must survive this rerender.
  gateServer.value = serverInput.value;
  return 'raw';
};
gateToken.value = 'private-gate-secret';
await submitGate();
assert.deepEqual(requests, [{ path: '/internal/v1/user-center/roles', token: 'private-gate-secret' }]);
assert.deepEqual(sessionLogins, [], 'known private emergency mode retains raw roles verification');
assert.equal(security.binding().serverBase, 'http://selected-private.example:18090');
assert.equal(refreshCount, 1);
assert.equal(productRefreshCount, 1);
assert.equal(gateFeedback.textContent, '');
assert.equal(gateToken.value, '');

resetLoginFixture();
let resolveMode;
opsMode = () => new Promise(resolve => { resolveMode = resolve; });
opsTokenInput.value = 'old-origin-discovery-secret';
const pendingModeApply = security.applyOpsToken();
assert.equal(opsTokenApply.disabled, true);
serverInput.value = 'https://new-origin.example';
// Programmatic input changes need not dispatch an event; apply must notice the
// changed endpoint itself after awaiting discovery.
resolveMode('session');
await pendingModeApply;
assert.deepEqual(requests, []);
assert.deepEqual(sessionLogins, [], 'old-origin mode discovery must not submit a Token to the new origin');
assert.equal(refreshCount, 0);
assert.equal(opsTokenInput.value, '');
assert.equal(opsTokenApply.disabled, false);

resetLoginFixture();
let rejectGateMode;
let gateModeCalls = 0;
const pendingGateMode = new Promise((_resolve, reject) => { rejectGateMode = reject; });
opsMode = () => { gateModeCalls += 1; return pendingGateMode; };
gateToken.value = 'stale-gate-secret';
const pendingGate = submitGate();
assert.equal(gateButton.disabled, true);
const duplicateGate = submitGate();
assert.equal(gateModeCalls, 1, 'repeated gate submissions share the in-flight operation');
serverInput.value = 'https://new-origin.example';
rejectGateMode(new Error('连接地址已变化，请重新操作。'));
await Promise.all([pendingGate, duplicateGate]);
assert.deepEqual(requests, []);
assert.deepEqual(sessionLogins, []);
assert.equal(serverInput.value, 'https://new-origin.example', 'a rejected discovery must not restore the old gate address');
assert.equal(gateToken.value, '');
assert.equal(gateButton.disabled, false);
assert.match(gateFeedback.textContent, /连接地址已变化/);

console.log('OK Internal ops token stays bound to one protected Internal origin');
