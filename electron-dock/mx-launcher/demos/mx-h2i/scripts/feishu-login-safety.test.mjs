import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main.cjs', import.meta.url)),
  'utf8'
);
const preloadSource = readFileSync(
  fileURLToPath(new URL('../src/preload.cjs', import.meta.url)),
  'utf8'
);
const rendererSource = readFileSync(
  fileURLToPath(new URL('../src/renderer.js', import.meta.url)),
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

assert.match(mainSource, /const DEFAULT_FEISHU_CALLBACK_PORT = 17891;/);
assert.match(mainSource, /const FEISHU_CALLBACK_PATH = '\/oauth\/feishu\/callback';/);
assert.match(
  functionSource(mainSource, 'feishuCallbackPort'),
  /process\.env\.MX_H2I_FEISHU_CALLBACK_PORT/,
  'the fixed callback port must support the documented environment override'
);
assert.match(
  functionSource(mainSource, 'listenForFeishuCallback'),
  /server\.listen\(Number\(callbackUrl\.port\), '127\.0\.0\.1'\)/,
  'the OAuth callback listener must bind only to IPv4 loopback'
);

const startSource = functionSource(mainSource, 'startFeishuLogin');
assert.match(startSource, /randomBytes\(32\)\.toString\('base64url'\)/);
assert.match(startSource, /randomBytes\(48\)\.toString\('base64url'\)/);
assert.match(startSource, /createHash\('sha256'\)\.update\(flow\.codeVerifier\)\.digest\('base64url'\)/);
assert.match(startSource, /\/internal\/v1\/sdk\/oauth\/feishu\/authorize/);
assert.match(startSource, /redirectUri,[\s\S]*state: flow\.state,[\s\S]*codeChallenge:/);
assert.match(startSource, /assertSecureFeishuTransport\(bootstrap, '授权初始化'\)/);
assert.match(startSource, /shell\.openExternal\(authorizationUrl\)/);
assert.doesNotMatch(
  startSource,
  /setConnecting\(|connectLauncherNetwork\(|runtime\.connection\s*=/,
  'waiting for browser authorization must not mutate or reconnect the guest data plane'
);

const callbackSource = functionSource(mainSource, 'handleFeishuCallbackRequest');
assert.match(callbackSource, /request\.method !== 'GET'/);
assert.match(callbackSource, /callback\.origin !== expectedCallback\.origin/);
assert.match(callbackSource, /callback\.pathname !== FEISHU_CALLBACK_PATH/);
assert.match(callbackSource, /secureStringEqual\(returnedState, flow\.state\)/);
assert.match(callbackSource, /pendingFeishuLogin !== flow/);
assert.match(callbackSource, /if \(flow\.callbackAccepted\)/);
assert.match(callbackSource, /flow\.callbackAccepted = true/);
assert.match(callbackSource, /flow\.stage = 'exchanging-token'/);
assert.match(callbackSource, /feishuAuthorizationCodeFromRawUrl\(request\.url\)/);
assert.doesNotMatch(
  callbackSource,
  /queueDiagnostic(?:Log|Error)\([^)]*(?:request\.url|callback\.href|callback\.toString)/,
  'diagnostics must not record a complete OAuth callback URL'
);

const authorizationCodeFromRawUrl = Function(
  `${functionSource(mainSource, 'feishuAuthorizationCodeFromRawUrl')}; return feishuAuthorizationCodeFromRawUrl;`
)();
assert.equal(authorizationCodeFromRawUrl('/oauth/feishu/callback?code=a+b&state=ok'), 'a+b');
assert.equal(authorizationCodeFromRawUrl('/oauth/feishu/callback?code=a%2Bb&state=ok'), 'a+b');
assert.equal(authorizationCodeFromRawUrl('/oauth/feishu/callback?code=a&code=b'), null);
assert.equal(authorizationCodeFromRawUrl('/oauth/feishu/callback?code=%E0%A4%A'), null);

const isSafeAuthorizationUrl = Function(
  `${functionSource(mainSource, 'isSafeFeishuAuthorizationUrl')}; return isSafeFeishuAuthorizationUrl;`
)();
assert.equal(
  isSafeAuthorizationUrl('https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id=test'),
  true
);
for (const unsafeAuthorizationUrl of [
  'http://accounts.feishu.cn/open-apis/authen/v1/authorize',
  'https://evil.example/open-apis/authen/v1/authorize',
  'https://accounts.feishu.cn.evil.example/open-apis/authen/v1/authorize',
  'https://accounts.feishu.cn:444/open-apis/authen/v1/authorize',
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize/extra',
  'https://accounts.feishu.cn/other'
]) {
  assert.equal(isSafeAuthorizationUrl(unsafeAuthorizationUrl), false, unsafeAuthorizationUrl);
}

const tokenSource = functionSource(mainSource, 'authenticateFeishuViaGateway');
assert.match(tokenSource, /\/internal\/v1\/sdk\/oauth\/feishu\/token/);
assert.match(tokenSource, /code,[\s\S]*redirectUri,[\s\S]*codeVerifier,[\s\S]*exchangeHandle,[\s\S]*audience: 'mx-sdk',[\s\S]*scope: FEISHU_OAUTH_SCOPE/);
assert.match(tokenSource, /auth\.provider !== 'feishu'/);
assert.doesNotMatch(
  tokenSource,
  /fallbackProvider:\s*'feishu'/,
  'the desktop must verify auth_provider from the token instead of inventing it'
);
assert.match(
  functionSource(mainSource, 'completeFeishuLogin'),
  /await assertLiveSecureFeishuTransport\([\s\S]*'授权码交换'\)[\s\S]*authenticateFeishuViaGateway/,
  'the authorization code and PKCE verifier must pass a live transport check before exchange'
);
assert.match(
  functionSource(mainSource, 'assertLiveSecureFeishuTransport'),
  /probeWireGuardForConnection\([\s\S]*probe\?\.wireGuard\?\.active === true[\s\S]*probe\?\.diagnostics\?\.route\?\.ok === true[\s\S]*probe\?\.diagnostics\?\.internalApi\?\.ok === true/,
  'cached overlay readiness must be re-probed before sending the Feishu authorization code'
);

const secureTransportSource = functionSource(mainSource, 'feishuTransportIsSecure');
assert.match(secureTransportSource, /target\.protocol === 'https:'/);
assert.match(secureTransportSource, /hostname === '::1'/);
assert.match(secureTransportSource, /hostname\.startsWith\('127\.'\)/);
assert.match(secureTransportSource, /connectionHasReadyOverlayTransportProof\(connection\)/);
assert.match(secureTransportSource, /target\.origin === overlay\.origin/);
assert.match(
  functionSource(mainSource, 'defaultBootstrapApiBaseUrl'),
  /MX_H2I_BOOTSTRAP_PROTOCOL, 'https'/,
  'fresh installations must default to the Domestic HTTPS bootstrap facade'
);
assert.doesNotMatch(
  functionSource(mainSource, 'bootstrapPortCandidates'),
  /protocol === 'https' \? \['18090'/,
  'HTTPS discovery must not silently probe the legacy plaintext edge ports'
);
assert.match(
  functionSource(mainSource, 'directPublicBootstrapOverride'),
  /useTlsIdentity[\s\S]*hostHeader: useTlsIdentity \? original\.host : parsed\.host[\s\S]*servername: useTlsIdentity \? original\.hostname : undefined/,
  'direct-IP HTTPS fallback must retain the bootstrap hostname for both Host and TLS SNI'
);

const promotionSource = functionSource(mainSource, 'promoteEmployeeConnection');
assert.match(promotionSource, /identityKind: 'user'/);
assert.match(promotionSource, /leaseProfile: provider === 'feishu' \? 'feishu' : undefined/);
assert.match(
  promotionSource,
  /accessToken: auth\.accessToken/,
  'both password and Feishu employee promotion must bind the lease request to the issued MX token'
);
assert.match(promotionSource, /provider,[\s\S]*displayName:/);
assert.match(
  promotionSource,
  /\.\.\.EMPLOYEE_IDENTITY_BASE_SCOPES,[\s\S]*\.\.\.\(Array\.isArray\(auth\.scopes\) \? auth\.scopes : \[\]\)/,
  'password and Feishu identity scopes must retain the existing employee capabilities'
);
assert.match(
  promotionSource,
  /networkFallback && !dataPlaneApplyStarted[\s\S]*runtime\.connection = networkFallback[\s\S]*原有网络保持连接/,
  'control-plane failures must restore the retained guest or employee snapshot'
);
const applyNetworkSessionSource = functionSource(mainSource, 'applyNetworkSession');
assert.match(
  applyNetworkSessionSource,
  /Promise\.allSettled\([\s\S]*preflightFailure[\s\S]*syncPeerHandover\([\s\S]*'abort'/,
  'all remote prepare operations must settle before an abort can restore the guest peer'
);
assert.match(
  applyNetworkSessionSource,
  /handoverPhase: 'prepare'[\s\S]*wireGuardResult\.authorizationCanceled === true[\s\S]*syncPeerHandover\([\s\S]*'abort'[\s\S]*probeWireGuardForConnection\([\s\S]*applyWireGuardAuthorizationCanceled\(options, wireGuardResult, handoverRollback, fallbackProbe\)/,
  'guest-to-employee switching must prepare dual peer IPs and verify rollback before restoring guest state'
);
assert.match(
  applyNetworkSessionSource,
  /postConnectReady[\s\S]*syncPeerHandover\([\s\S]*'commit'/,
  'a handover may remove the old guest peer IP only after the new tunnel is ready'
);
const syncHandoverSource = functionSource(mainSource, 'syncPeerHandover');
assert.match(
  syncHandoverSource,
  /handoverPhase !== 'prepare'[\s\S]*releaseRetiredHandoverLease\(peerLease, options\)[\s\S]*retirement\?\.ok === true/,
  'commit and abort must revoke the retired lease capability before completing'
);
assert.match(
  functionSource(mainSource, 'releaseRetiredHandoverLease'),
  /\/release`[\s\S]*released\?\.status !== 'released'[\s\S]*forgetLeaseCapability\(leaseId\)/,
  'a retired handover lease must be released server-side and forgotten locally'
);
assert.match(
  functionSource(mainSource, 'retireSupersededLocalLeases'),
  /record\.leaseId !== leaseId[\s\S]*record\.publicKey === publicKey[\s\S]*releaseRetiredHandoverLease\(candidate, options\)/,
  'a successful reconnect must retire older local profiles sharing the same device key'
);
assert.match(
  functionSource(mainSource, 'connectLauncherNetwork'),
  /assertLiveSecureLauncherCapabilityTransport\(context\.bootstrap, 'lease capability 传输'\)/,
  'every lease capability and MX bearer must stay on HTTPS, loopback, or a live verified WireGuard overlay'
);
assert.match(
  functionSource(mainSource, 'rememberLeaseCapability'),
  /record\?\.leaseId && record\.leaseId !== leaseId[\s\S]*record\?\.capability !== capability/,
  'a temporary shared migration capability must remain addressable by both real lease IDs'
);
assert.match(
  functionSource(mainSource, 'reconcilePendingNetworkHandoverAfterStartup'),
  /actualInterfaceIps\.includes\(oldLeaseIp\)[\s\S]*actualInterfaceIps\.includes\(newLeaseIp\)[\s\S]*actualUsesOldLease === actualUsesNewLease[\s\S]*wireguard-interface-address-ambiguous/,
  'crash recovery must decide commit or abort from the real WireGuard interface address'
);

const visibleFlowSource = functionSource(mainSource, 'visibleFeishuAuthFlow');
assert.doesNotMatch(visibleFlowSource, /\bstate\b|codeVerifier|exchangeHandle|authorizationUrl|accessToken/);
assert.match(
  functionSource(mainSource, 'clearPendingFeishuLogin'),
  /flow\.codeVerifier = null[\s\S]*flow\.exchangeHandle = null/,
  'PKCE verifier and exchange handle must be discarded when the flow ends'
);
assert.match(
  functionSource(mainSource, 'sanitizeDiagnosticText'),
  /authorization_code\|ticket\|code_verifier\|exchange_handle\|state/,
  'callback secrets must be redacted from diagnostic text'
);
assert.match(
  functionSource(mainSource, 'protectPersistedRuntime'),
  /safeStorage\.encryptString\(accessToken\)[\s\S]*encryptedWireGuardPrivateKey:[\s\S]*encryptString\(wireGuardPrivateKey\)[\s\S]*encryptString\(JSON\.stringify\(leaseCapabilities\)\)/,
  'persisted MX login tokens, lease capabilities, and WireGuard private keys must use Electron safeStorage'
);
assert.match(
  functionSource(mainSource, 'unprotectPersistedRuntime'),
  /protectedCredentialStorageUnavailable === true[\s\S]*state: 'forbidden'[\s\S]*credentialStorageFailure:[\s\S]*installId: null,[\s\S]*deviceId: null,[\s\S]*keyPair: null/,
  'unavailable or failed credential storage must block recovery and rotate the persisted device identity'
);
assert.match(
  functionSource(mainSource, 'secureCredentialStorageAvailable'),
  /process\.platform !== 'linux'[\s\S]*getSelectedStorageBackend[\s\S]*backend !== 'basic_text'/,
  'Linux basic_text storage must not be treated as encrypted credential storage'
);
assert.match(
  functionSource(mainSource, 'visibleRuntime'),
  /leaseCapabilities: _leaseCapabilities[\s\S]*\.\.\.safeSource/,
  'lease capabilities must never be exposed to the renderer'
);
assert.match(
  functionSource(mainSource, 'writePrivateJsonFile'),
  /mode: 0o600[\s\S]*fs\.rename\(temporaryPath, filePath\)[\s\S]*fs\.chmod\(filePath, 0o600\)/,
  'runtime state files must be atomically replaced with private permissions'
);

const secureEqual = Function(
  'timingSafeEqual',
  `${functionSource(mainSource, 'secureStringEqual')}; return secureStringEqual;`
)(timingSafeEqual);
assert.equal(secureEqual('expected-state', 'expected-state'), true);
assert.equal(secureEqual('expected-state', 'wrong-state'), false);
assert.equal(secureEqual('', ''), true);

assert.match(preloadSource, /startFeishuLogin: \(\) => ipcRenderer\.invoke\('mx-h2i:start-feishu-login'\)/);
assert.match(preloadSource, /cancelFeishuLogin: \(\) => ipcRenderer\.invoke\('mx-h2i:cancel-feishu-login'\)/);
assert.match(rendererSource, /'login-feishu': \(\) => api\.startFeishuLogin\?\.\(\)/);
assert.match(rendererSource, /'cancel-feishu-login': \(\) => api\.cancelFeishuLogin\?\.\(\)/);

const employeeUiSource = functionSource(rendererSource, 'renderEmployeeLogin');
assert.match(employeeUiSource, /data-action="\$\{feishuAction\}"/);
assert.match(employeeUiSource, /使用飞书登录/);
assert.match(employeeUiSource, /data-action="\$\{guestActive \? 'disconnect' : 'connectGuest'\}"/);
assert.match(employeeUiSource, /使用访客连接/);
assert.match(employeeUiSource, /仅断开访客模式/);
assert.match(employeeUiSource, /当前访客 IP/);

console.log('Feishu loopback OAuth and guest-preserving UI safety tests passed');
