import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main-runtime.cjs', import.meta.url)),
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
const launcherWireGuardSource = readFileSync(
  fileURLToPath(new URL('../../../packages/electron-launcher/src/wireguard.ts', import.meta.url)),
  'utf8'
);
const coreWireGuardSource = readFileSync(
  fileURLToPath(new URL('../../../../../electron-plugin/packages/electron-core-wireguard/src/index.ts', import.meta.url)),
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
assert.match(
  startSource,
  /exchangeHandleVersion: 'mxfx2'/,
  'new MX-H2I clients must explicitly request the signed exchangeHandle format while old clients stay on mxfx1'
);
assert.match(
  startSource,
  /resolveBootstrapEndpoint\(runtime\.config,\s*\{\s*requireSecureTransport:\s*true\s*\}\)/,
  'Feishu authorization must not select a reachable plaintext fallback'
);
assert.match(startSource, /assertSecureFeishuTransport\(bootstrap, '授权初始化'\)/);
assert.match(
  startSource,
  /await assertLiveSecureFeishuTransport\(bootstrap, '授权初始化'\)[\s\S]*requestJson\([\s\S]*\/internal\/v1\/sdk\/oauth\/feishu\/authorize/,
  'an HTTP overlay must pass a live WireGuard and route probe before authorization state is sent'
);
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

const isSafeExchangeHandle = Function(
  `${functionSource(mainSource, 'isSafeFeishuExchangeHandle')}; return isSafeFeishuExchangeHandle;`
)();
assert.equal(isSafeExchangeHandle(`mxfx1.${'a'.repeat(43)}`), true);
assert.equal(isSafeExchangeHandle(`mxfx2.${'b'.repeat(80)}.${'c'.repeat(43)}`), true);
assert.equal(isSafeExchangeHandle(`mxfx2.${'b'.repeat(80)}.${'c'.repeat(42)}`), false);
assert.equal(isSafeExchangeHandle(`mxfx2.${'b'.repeat(1801)}.${'c'.repeat(43)}`), false);
assert.equal(isSafeExchangeHandle('https://evil.example/handle'), false);

const tokenSource = functionSource(mainSource, 'authenticateFeishuViaGateway');
assert.match(tokenSource, /\/internal\/v1\/sdk\/oauth\/feishu\/token/);
assert.match(tokenSource, /code,[\s\S]*redirectUri,[\s\S]*codeVerifier,[\s\S]*exchangeHandle,[\s\S]*audience: 'mx-sdk',[\s\S]*scope: FEISHU_OAUTH_SCOPE/);
assert.match(tokenSource, /auth\.provider !== 'feishu'/);
assert.doesNotMatch(
  tokenSource,
  /fallbackProvider:\s*'feishu'/,
  'the desktop must verify auth_provider from the token instead of inventing it'
);
const completeFeishuLoginSource = functionSource(mainSource, 'completeFeishuLogin');
assert.match(
  completeFeishuLoginSource,
  /await assertLiveSecureFeishuTransport\([\s\S]*'授权码交换'\)[\s\S]*authenticateFeishuViaGateway/,
  'the authorization code and PKCE verifier must pass a live transport check before exchange'
);
assert.match(
  completeFeishuLoginSource,
  /isFeishuAuthorizationTransactionMissingError\(err\)[\s\S]*clearPendingFeishuLogin\('token-transaction-missing', flow\)[\s\S]*请重新点击“使用飞书登录”发起新的授权/,
  'an expired or consumed exchangeHandle should end the current authorization flow instead of leaving MX-H2I waiting'
);
assert.doesNotMatch(
  completeFeishuLoginSource,
  /startFeishuLogin\(\{ retryOnTransactionMissing:/,
  'a stale callback must not silently create a second browser authorization flow'
);
assert.match(
  functionSource(mainSource, 'feishuTokenExchangeFailureMessage'),
  /127\.0\.0\.1 回调地址是正确的/,
  'the user-facing error must not imply that the loopback redirect URI is misconfigured'
);
assert.match(
  functionSource(mainSource, 'promoteEmployeeConnection'),
  /resolveBootstrapEndpoint\(runtime\.config,\s*\{\s*requireSecureTransport:\s*provider === 'feishu'\s*\}\)/,
  'the employee transition must apply the same secure-candidate rule to Feishu'
);
assert.match(
  functionSource(mainSource, 'resolveBootstrapEndpoint'),
  /options\.requireSecureTransport === true && !feishuTransportIsSecure\(candidate\)[\s\S]*continue/,
  'secure flows must skip plaintext candidates before probing them'
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
  /\/release`[\s\S]*released\?\.status !== 'released'[\s\S]*status: 'released'/,
  'a retired handover lease must be confirmed released server-side'
);
assert.doesNotMatch(
  functionSource(mainSource, 'releaseRetiredHandoverLease'),
  /forgetLeaseCapability\(/,
  'a released lease capability must remain in the encrypted keyring for later allowReleased proof'
);
const retainedReleasedCapability = 'mxlc1.released-guest-proof';
const retiredLeaseRuntime = {
  config: {
    bootstrapApiBaseUrl: 'https://h2i.minsight-ai.com',
    bootstrapResolveMode: 'env-first'
  },
  leaseCapabilities: {
    'lease-retired-guest': {
      leaseId: 'lease-retired-guest',
      capability: retainedReleasedCapability
    }
  }
};
let forgottenReleasedLeaseCount = 0;
const releaseRetiredHandoverLease = Function(
  'nullableString',
  'normalizeBaseUrl',
  'runtime',
  'requestJson',
  'joinApiUrl',
  'launcherLeaseAccessHeaders',
  'REQUESTED_BY',
  'makeRequestId',
  'nowIso',
  'errorMessage',
  'forgetLeaseCapability',
  `${functionSource(mainSource, 'releaseRetiredHandoverLease')}; return releaseRetiredHandoverLease;`
)(
  (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
  (value) => value,
  retiredLeaseRuntime,
  async () => ({
    lease: {
      status: 'released',
      releasedAt: '2026-07-30T01:02:03.000Z'
    }
  }),
  (baseUrl, pathname) => `${baseUrl}${pathname}`,
  () => ({ 'x-mx-lease-capability': retainedReleasedCapability }),
  'mx-h2i',
  () => 'request-id',
  () => '2026-07-30T01:02:04.000Z',
  (err) => err.message,
  (leaseId) => {
    forgottenReleasedLeaseCount += 1;
    delete retiredLeaseRuntime.leaseCapabilities[leaseId];
  }
);
const retiredLeaseResult = await releaseRetiredHandoverLease({
  leaseId: 'lease-retired-guest',
  capability: retainedReleasedCapability
});
assert.equal(retiredLeaseResult.ok, true);
assert.equal(forgottenReleasedLeaseCount, 0);
assert.equal(
  retiredLeaseRuntime.leaseCapabilities['lease-retired-guest'].capability,
  retainedReleasedCapability,
  'released guest proof must survive employee handover for a later guest enrollment'
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
  functionSource(mainSource, 'connectLauncherNetwork'),
  /deviceModel: context\.installation\.deviceModel,[\s\S]*osVersion: context\.installation\.osVersion,[\s\S]*appVersion: currentReleaseVersion\(\)/,
  'each lease renewal must report best-effort device, OS, and app audit metadata'
);
assert.match(
  functionSource(mainSource, 'ensureInstallation'),
  /current\.deviceModel \|\| await detectDeviceModel\(\)[\s\S]*osVersion: os\.release\(\)[\s\S]*appVersion: currentReleaseVersion\(\)/,
  'device inventory must be cached per installation while OS and app versions refresh'
);
const capabilitySelectionRuntime = {
  installation: {
    installId: 'inst-current',
    keyPair: { publicKey: 'shared-public-key' }
  },
  connection: {
    leaseCapability: 'mxlc1.unscoped-connection'
  },
  leaseCapabilities: {
    current: {
      capability: 'mxlc1.current',
      productId: 'mx-h2i',
      installId: 'inst-current',
      publicKey: 'shared-public-key',
      leaseProfile: 'anonymous',
      updatedAt: '2026-07-29T02:00:00.000Z'
    },
    historicalProfile: {
      capability: 'mxlc1.historical-profile',
      productId: 'mx-h2i',
      installId: 'inst-current',
      publicKey: 'shared-public-key',
      leaseProfile: 'employee',
      updatedAt: '2026-07-29T01:30:00.000Z'
    },
    crossTuple: {
      capability: 'mxlc1.cross-tuple',
      productId: 'legacy-product',
      installId: 'inst-old',
      publicKey: 'shared-public-key',
      leaseProfile: 'employee',
      updatedAt: '2026-07-29T01:00:00.000Z'
    },
    otherInstall: {
      capability: 'mxlc1.other-install',
      productId: 'mx-h2i',
      installId: 'inst-other',
      publicKey: 'shared-public-key',
      leaseProfile: 'anonymous',
      updatedAt: '2026-07-29T03:00:00.000Z'
    },
    otherPublicKey: {
      capability: 'mxlc1.other-public-key',
      productId: 'mx-h2i',
      installId: 'inst-current',
      publicKey: 'other-public-key',
      leaseProfile: 'anonymous',
      updatedAt: '2026-07-29T04:00:00.000Z'
    },
    legacyWithoutPublicKey: {
      capability: 'mxlc1.legacy-without-public-key',
      productId: 'mx-h2i',
      installId: 'inst-current',
      leaseProfile: 'anonymous',
      updatedAt: '2026-07-29T05:00:00.000Z'
    }
  }
};
const leaseCapabilitiesForEnrollment = Function(
  'runtime',
  'launcherProductId',
  'nullableString',
  `${functionSource(mainSource, 'leaseCapabilitiesForEnrollment')}; return leaseCapabilitiesForEnrollment;`
)(
  capabilitySelectionRuntime,
  () => 'mx-h2i',
  (value) => typeof value === 'string' && value.trim() ? value.trim() : null
);
const selectedCapabilities = leaseCapabilitiesForEnrollment({ identityKind: 'anonymous' }).split(',');
assert.ok(selectedCapabilities.includes('mxlc1.current'));
assert.ok(
  selectedCapabilities.includes('mxlc1.historical-profile'),
  'the same product, installation, and public key may retain historical profile capabilities'
);
for (const forbiddenCapability of [
  'mxlc1.unscoped-connection',
  'mxlc1.cross-tuple',
  'mxlc1.other-install',
  'mxlc1.other-public-key',
  'mxlc1.legacy-without-public-key'
]) {
  assert.ok(
    !selectedCapabilities.includes(forbiddenCapability),
    `${forbiddenCapability} must not cross its product/install/public-key trust tuple`
  );
}
assert.match(
  functionSource(mainSource, 'leaseCapabilitiesForEnrollment'),
  /record\.productId === productId[\s\S]*record\.installId === installId[\s\S]*record\.publicKey === publicKey/,
  'enrollment capabilities must remain inside the current product, installation, and key tuple'
);
assert.match(
  functionSource(mainSource, 'ensurePendingLeaseCapability'),
  /pending:\$\{productId\}:\$\{installId\}:\$\{requestedProfile\}:\$\{userId\}/,
  'new pending capabilities must not be reused across installations'
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
const protectPersistedRuntime = Function(
  'normalizeAuth',
  'normalizeInstallation',
  'normalizeLeaseCapabilities',
  'nullableString',
  'secureCredentialStorageAvailable',
  'idleConnection',
  'nowIso',
  'stableOwnershipInstanceId',
  'safeStorage',
  `${functionSource(mainSource, 'protectPersistedRuntime')}; return protectPersistedRuntime;`
)(
  () => null,
  (value) => value && typeof value === 'object' ? value : { keyPair: null },
  (value) => value && typeof value === 'object' ? value : {},
  (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
  () => true,
  () => ({}),
  () => '2026-07-30T01:02:05.000Z',
  () => 'ownership-instance',
  {
    encryptString: (value) => Buffer.from(`sealed:${value}`)
  }
);
const protectedReleasedCapabilityRuntime = protectPersistedRuntime({
  installation: { keyPair: null },
  leaseCapabilities: retiredLeaseRuntime.leaseCapabilities
});
assert.deepEqual(protectedReleasedCapabilityRuntime.leaseCapabilities, {});
assert.ok(protectedReleasedCapabilityRuntime.encryptedLeaseCapabilities);
assert.equal(
  JSON.stringify(protectedReleasedCapabilityRuntime).includes(retainedReleasedCapability),
  false,
  'a retained released capability must not be persisted in plaintext'
);
assert.equal(
  Buffer.from(protectedReleasedCapabilityRuntime.encryptedLeaseCapabilities, 'base64')
    .toString('utf8')
    .includes(retainedReleasedCapability),
  true,
  'the encrypted keyring payload must retain the released capability'
);
const visibleRuntime = Function(
  'runtime',
  'visibleInstallation',
  'visibleConnection',
  'visibleAuth',
  'visibleFeishuAuthFlow',
  'visibleForegroundNetworkOperation',
  'diagnosticLogStatus',
  `${functionSource(mainSource, 'visibleRuntime')}; return visibleRuntime;`
)(
  {},
  (value) => value,
  (value) => value,
  (value) => value,
  () => null,
  () => null,
  () => null
);
const visibleReleasedCapabilityRuntime = visibleRuntime({
  installation: null,
  connection: null,
  auth: null,
  leaseCapabilities: retiredLeaseRuntime.leaseCapabilities,
  encryptedLeaseCapabilities: protectedReleasedCapabilityRuntime.encryptedLeaseCapabilities
});
assert.equal(Object.hasOwn(visibleReleasedCapabilityRuntime, 'leaseCapabilities'), false);
assert.equal(Object.hasOwn(visibleReleasedCapabilityRuntime, 'encryptedLeaseCapabilities'), false);
assert.match(
  functionSource(mainSource, 'writePrivateJsonFile'),
  /serializePrivateJsonFileWrite\(filePath,[\s\S]*mode: 0o600[\s\S]*renamePrivateJsonFileWithRetry\(temporaryPath, filePath\)[\s\S]*fs\.chmod\(filePath, 0o600\)/,
  'runtime state files must be atomically replaced with private permissions'
);

const retryableWindowsRenameError = Function(
  `${functionSource(mainSource, 'isRetryableWindowsPrivateJsonRenameError')}; return isRetryableWindowsPrivateJsonRenameError;`
)();
for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  assert.equal(
    retryableWindowsRenameError({ code, syscall: 'rename' }, 'win32'),
    true,
    `${code} must be retried on Windows`
  );
}
assert.equal(
  retryableWindowsRenameError({ code: 'EPERM', syscall: 'rename' }, 'darwin'),
  false,
  'the Windows rename workaround must not change non-Windows behavior'
);

const windowsRenameRetryDelays = [25, 75, 150, 300];
const renamePrivateJsonFileWithRetry = Function(
  'WINDOWS_PRIVATE_JSON_RENAME_RETRY_DELAYS_MS',
  'isRetryableWindowsPrivateJsonRenameError',
  'fs',
  'delay',
  'process',
  `${functionSource(mainSource, 'renamePrivateJsonFileWithRetry')}; return renamePrivateJsonFileWithRetry;`
)(
  windowsRenameRetryDelays,
  retryableWindowsRenameError,
  { rename: async () => undefined },
  async () => undefined,
  { platform: 'linux' }
);
let renameAttempts = 0;
const observedRenameDelays = [];
await renamePrivateJsonFileWithRetry('source.tmp', 'target.json', {
  platform: 'win32',
  rename: async () => {
    renameAttempts += 1;
    if (renameAttempts < 3) {
      throw Object.assign(new Error('transient Windows file lock'), {
        code: renameAttempts === 1 ? 'EPERM' : 'EBUSY',
        syscall: 'rename'
      });
    }
  },
  wait: async (delayMs) => {
    observedRenameDelays.push(delayMs);
  }
});
assert.equal(renameAttempts, 3);
assert.deepEqual(observedRenameDelays, windowsRenameRetryDelays.slice(0, 2));

renameAttempts = 0;
await assert.rejects(
  renamePrivateJsonFileWithRetry('source.tmp', 'target.json', {
    platform: 'win32',
    rename: async () => {
      renameAttempts += 1;
      throw Object.assign(new Error('persistent Windows file lock'), {
        code: 'EACCES',
        syscall: 'rename'
      });
    },
    wait: async () => undefined
  }),
  (err) => err?.code === 'EACCES'
);
assert.equal(
  renameAttempts,
  windowsRenameRetryDelays.length + 1,
  'Windows rename retries must remain finite'
);

const privateJsonFileWriteQueues = new Map();
const serializePrivateJsonFileWrite = Function(
  'privateJsonFileWriteQueues',
  `${functionSource(mainSource, 'serializePrivateJsonFileWrite')}; return serializePrivateJsonFileWrite;`
)(privateJsonFileWriteQueues);
let releaseFirstWrite;
const firstWriteGate = new Promise((resolve) => {
  releaseFirstWrite = resolve;
});
const writeOrder = [];
const firstWrite = serializePrivateJsonFileWrite('same-runtime.json', async () => {
  writeOrder.push('first-start');
  await firstWriteGate;
  writeOrder.push('first-end');
});
const secondWrite = serializePrivateJsonFileWrite('same-runtime.json', async () => {
  writeOrder.push('second-start');
});
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(writeOrder, ['first-start'], 'writes to the same runtime path must serialize');
releaseFirstWrite();
await Promise.all([firstWrite, secondWrite]);
assert.deepEqual(writeOrder, ['first-start', 'first-end', 'second-start']);
assert.equal(privateJsonFileWriteQueues.size, 0, 'completed per-path write queues must be released');

const saveRuntimeSource = functionSource(mainSource, 'saveRuntime');
const saveRuntimeEvents = [];
const saveRuntimeWarnings = [];
let h2oMirrorSourceRevision = null;
const saveRuntimeWithFailedMirror = Function(
  'persistableRuntime',
  'writePrivateJsonFile',
  'runtimePath',
  'protectPersistedRuntime',
  'savePersistedH2oRuntime',
  'queueDiagnosticLog',
  'errorMessage',
  'maybeSnapshotAppsState',
  `${saveRuntimeSource}; return saveRuntime;`
)(
  (value) => value,
  async () => {
    saveRuntimeEvents.push('primary');
  },
  () => 'mx-h2i-runtime.json',
  (value) => value,
  async (_runtime, sourceRuntimeUpdatedAt) => {
    saveRuntimeEvents.push('mirror');
    h2oMirrorSourceRevision = sourceRuntimeUpdatedAt;
    throw Object.assign(new Error('mirror is locked'), {
      code: 'EPERM',
      syscall: 'rename'
    });
  },
  (...args) => {
    saveRuntimeWarnings.push(args);
  },
  (err) => err.message,
  async () => {
    saveRuntimeEvents.push('snapshot');
  }
);
await saveRuntimeWithFailedMirror({
  apps: { h2o: { runtime: { status: 'ready' } } },
  updatedAt: '2026-07-28T01:02:03.000Z'
});
assert.deepEqual(saveRuntimeEvents, ['primary', 'mirror', 'snapshot']);
assert.equal(h2oMirrorSourceRevision, '2026-07-28T01:02:03.000Z');
assert.equal(saveRuntimeWarnings.length, 1);
assert.equal(saveRuntimeWarnings[0][0], 'warning');
assert.equal(saveRuntimeWarnings[0][1], 'runtime.h2o-mirror-save-failed');

const shouldMergePersistedH2oRuntime = Function(
  'nullableString',
  'arrayValue',
  'h2oHasUsableSubscription',
  'h2oRuntimePersistenceFingerprint',
  `${functionSource(mainSource, 'shouldMergePersistedH2oRuntime')}; return shouldMergePersistedH2oRuntime;`
)(
  (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
  (value, fallback) => Array.isArray(value) ? value : fallback,
  (subscription) => subscription?.usable === true,
  (runtimeValue) => runtimeValue?.fingerprint || 'primary-fingerprint'
);
const h2oRuntimePersistenceFingerprint = Function(
  'h2oPluginRuntime',
  'createHash',
  `${functionSource(mainSource, 'h2oRuntimePersistenceFingerprint')}; return h2oRuntimePersistenceFingerprint;`
)(
  (value) => value,
  createHash
);
const h2oFingerprintInput = {
  mode: 'rule',
  tunInstalled: true,
  adminUrl: 'http://127.0.0.1:19090',
  ports: { mixed: 7890 },
  activeSubscriptionId: 'sub-1',
  activeSubscription: { id: 'sub-1', url: 'https://example.test/sub' },
  subscriptions: [{ id: 'sub-1', url: 'https://example.test/sub' }],
  rules: ['DOMAIN,example.test,DIRECT']
};
assert.equal(
  h2oRuntimePersistenceFingerprint(h2oFingerprintInput),
  h2oRuntimePersistenceFingerprint({ ...h2oFingerprintInput }),
  'equivalent H2O persistence content must have a stable fingerprint'
);
assert.notEqual(
  h2oRuntimePersistenceFingerprint(h2oFingerprintInput),
  h2oRuntimePersistenceFingerprint({
    ...h2oFingerprintInput,
    rules: ['DOMAIN,example.test,PROXY']
  }),
  'an H2O persistence mutation must change the fingerprint independently of runtime.updatedAt'
);
assert.equal(
  shouldMergePersistedH2oRuntime(
    { updatedAt: '2026-07-28T01:02:03.000Z' },
    {
      fingerprint: 'primary-new',
      subscriptions: [{ usable: true }],
      activeSubscription: { usable: true }
    },
    {
      runtime: { rules: ['stale'] },
      sourceRuntimeUpdatedAt: '2026-07-28T01:02:03.000Z',
      sourceRuntimeFingerprint: 'primary-old'
    }
  ),
  false,
  'an H2O content change must reject a stale mirror even when global runtime.updatedAt was not bumped'
);
assert.equal(
  shouldMergePersistedH2oRuntime(
    { updatedAt: '2026-07-28T01:02:03.000Z' },
    {
      fingerprint: 'primary-current',
      subscriptions: [{ usable: true }],
      activeSubscription: { usable: true }
    },
    {
      runtime: { rules: ['current'] },
      sourceRuntimeFingerprint: 'primary-current'
    }
  ),
  true,
  'a mirror with the same H2O content fingerprint may participate in recovery'
);
assert.equal(
  shouldMergePersistedH2oRuntime(
    { updatedAt: '2026-07-28T01:02:04.000Z' },
    { subscriptions: [{ usable: true }], activeSubscription: { usable: true } },
    {
      runtime: { rules: ['stale'] },
      sourceRuntimeUpdatedAt: '2026-07-28T01:02:03.000Z'
    }
  ),
  false,
  'a mirror older than the primary runtime must never override H2O state after restart'
);
assert.equal(
  shouldMergePersistedH2oRuntime(
    { updatedAt: '2026-07-28T01:02:03.000Z' },
    { subscriptions: [{ usable: true }], activeSubscription: { usable: true } },
    {
      runtime: { rules: ['current'] },
      sourceRuntimeUpdatedAt: '2026-07-28T01:02:03.000Z'
    }
  ),
  true,
  'a mirror written from the same primary revision may participate in recovery'
);
assert.equal(
  shouldMergePersistedH2oRuntime(
    { updatedAt: '2026-07-28T01:02:03.000Z' },
    { subscriptions: [], activeSubscription: null },
    { runtime: { subscriptions: [{ usable: true }] } }
  ),
  true,
  'a legacy unversioned mirror remains a recovery source only when primary H2O data is unusable'
);
assert.equal(
  shouldMergePersistedH2oRuntime(
    { updatedAt: '2026-07-28T01:02:03.000Z' },
    { subscriptions: [{ usable: true }], activeSubscription: { usable: true } },
    { runtime: { subscriptions: [{ usable: true }] } }
  ),
  false,
  'a legacy unversioned mirror must not override an already usable primary runtime'
);

const localRuntimePersistenceError = Function(
  `${functionSource(mainSource, 'isLocalRuntimePersistenceError')}; return isLocalRuntimePersistenceError;`
)();
assert.equal(
  localRuntimePersistenceError({ code: 'EPERM', syscall: 'rename' }),
  true
);
assert.equal(
  localRuntimePersistenceError({ code: 'EPERM', syscall: 'kill' }),
  false,
  'an unrelated OS permission error must not be labeled as local runtime persistence'
);
const classifyConnectionError = Function(
  'errorMessage',
  'isLocalRuntimePersistenceError',
  'isPublicIcpBlockedError',
  'publicHostFromUrl',
  'runtime',
  'DEFAULT_BOOTSTRAP_HOST',
  `${functionSource(mainSource, 'classifyConnectionError')}; return classifyConnectionError;`
)(
  (err) => `${err.message} / ${err.code}`,
  localRuntimePersistenceError,
  () => false,
  () => null,
  { config: {} },
  'h2i.minsight-ai.com'
);
const localPersistenceClassification = classifyConnectionError(
  Object.assign(new Error('operation not permitted'), {
    code: 'EPERM',
    syscall: 'rename'
  })
);
assert.equal(localPersistenceClassification.state, 'local-storage-error');
assert.doesNotMatch(localPersistenceClassification.message, /后端不可达|server-unavailable/);
const publicKeyConflictClassification = classifyConnectionError({
  status: 401,
  message: 'This WireGuard public key is already bound to another active lease'
});
assert.equal(publicKeyConflictClassification.state, 'forbidden');
assert.match(publicKeyConflictClassification.message, /不是 Domestic 443 或 Internal 网络不可达/);
assert.match(publicKeyConflictClassification.message, /release 旧租约/);
const isLauncherPublicKeyConflictError = Function(
  'errorMessage',
  `${functionSource(mainSource, 'isLauncherPublicKeyConflictError')}; return isLauncherPublicKeyConflictError;`
)((err) => err.message || '');
assert.equal(
  isLauncherPublicKeyConflictError({
    status: 401,
    message: 'This WireGuard public key is already bound to another active lease'
  }),
  true
);
assert.equal(
  isLauncherPublicKeyConflictError({
    status: 401,
    message: 'valid launcher lease capability required'
  }),
  false,
  'only the public-key conflict may trigger local identity rotation'
);
const identityRepairSource = functionSource(mainSource, 'connectLauncherNetworkWithLocalIdentityRepair');
assert.match(identityRepairSource, /isLauncherPublicKeyConflictError\(err\)/);
assert.match(identityRepairSource, /rotateLocalLauncherIdentity\('public-key-conflict-auto-repair'\)/);
assert.match(identityRepairSource, /requestTag:\s*`\$\{stringValue\(input\.requestTag, 'connect'\)\}-identity-repair`/);
assert.match(identityRepairSource, /preservePreviousOnRetryFailure === true/);
assert.match(identityRepairSource, /runtime\.installation = previousRuntime\.installation/);
assert.match(
  mainSource,
  /connectLauncherNetworkWithLocalIdentityRepair\(\{[\s\S]*requestTag: provider === 'feishu' \? 'feishu-employee' : 'employee'[\s\S]*preservePreviousOnRetryFailure: Boolean\(networkFallback\)/,
  'staff promotion must roll back local identity when retry repair cannot obtain a new lease'
);
const identityRotationSource = functionSource(mainSource, 'rotateLocalLauncherIdentity');
assert.match(identityRotationSource, /createLauncherWireGuardKeyPair\(\)/);
assert.match(identityRotationSource, /installId = `inst_\$\{productId\}_/);
assert.match(identityRotationSource, /deviceId = `dev_\$\{productId\}_/);
assert.match(identityRotationSource, /runtime\.leaseCapabilities = normalizeLeaseCapabilities/);
assert.match(identityRotationSource, /runtime\.connection = \{\s*\.\.\.idleConnection\(\)/);
assert.match(mainSource, /ipcMain\.handle\('mx-h2i:reset-local-network-identity'/);
assert.match(
  preloadSource,
  /resetLocalNetworkIdentity: \(\) => ipcRenderer\.invoke\('mx-h2i:reset-local-network-identity'\)/
);
assert.match(rendererSource, /data-action="resetLocalNetworkIdentity"/);
assert.match(rendererSource, /请先断开匿名连接/);
assert.doesNotMatch(rendererSource, /data-action="disconnect">清理旧连接/);

const retainedRuntime = {
  connection: {
    state: 'connected',
    mode: 'guest',
    localIp: '10.89.100.12',
    diagnostics: { retained: true }
  },
  auth: { accessToken: 'ephemeral-test-token' },
  feedback: null
};
const makeApplyLocalRuntimePersistenceError = (runtimeValue) => Function(
  'runtime',
  'idleConnection',
  'nowIso',
  'touchRuntime',
  `${functionSource(mainSource, 'applyLocalRuntimePersistenceError')}; return applyLocalRuntimePersistenceError;`
)(
  runtimeValue,
  () => ({ state: 'idle', mode: 'guest', diagnostics: {} }),
  () => '2026-07-28T00:00:00.000Z',
  () => undefined
);
const applyLocalRuntimePersistenceError = makeApplyLocalRuntimePersistenceError(retainedRuntime);
const applyConnectionError = Function(
  'runtime',
  'retainableConnectionSnapshot',
  'classifyConnectionError',
  'queueDiagnosticError',
  'authoritativeAnonymousEnrollmentDisabledError',
  'applyAuthoritativeAnonymousEnrollmentDisabledState',
  'anonymousRecoveryBlockedByPolicy',
  'applyAnonymousLoginDisabledState',
  'applyLocalRuntimePersistenceError',
  'idleConnection',
  'nowIso',
  'touchRuntime',
  `${functionSource(mainSource, 'applyConnectionError')}; return applyConnectionError;`
)(
  retainedRuntime,
  (connection) => connection,
  () => localPersistenceClassification,
  () => undefined,
  () => false,
  () => undefined,
  () => false,
  () => undefined,
  applyLocalRuntimePersistenceError,
  () => ({ state: 'idle', mode: 'guest', diagnostics: {} }),
  () => '2026-07-28T00:00:00.000Z',
  () => undefined
);
await applyConnectionError(
  '员工账号登录失败',
  Object.assign(new Error('operation not permitted'), {
    code: 'EPERM',
    syscall: 'rename'
  })
);
assert.equal(
  retainedRuntime.connection.state,
  'connected',
  'a local persistence failure must preserve a retained connection instead of marking the server unavailable'
);
assert.equal(retainedRuntime.connection.diagnostics.localPersistence.ok, false);
assert.doesNotMatch(retainedRuntime.feedback.message, /bootstrap API 暂不可达/);

const centralRuntime = {
  connection: {
    state: 'connecting',
    mode: 'employee',
    diagnostics: {}
  },
  auth: null,
  feedback: null
};
const retainedGuestFallback = {
  state: 'connected',
  mode: 'guest',
  localIp: '10.89.100.12',
  leaseId: 'lease-retained-guest',
  routePlan: { productId: 'mx-h2i' },
  wireGuard: { active: true },
  diagnostics: { retained: true }
};
let centralBroadcasts = 0;
const saveAndBroadcast = Function(
  'saveRuntime',
  'runtime',
  'isLocalRuntimePersistenceError',
  'retainableConnectionSnapshot',
  'classifyConnectionError',
  'queueDiagnosticError',
  'applyLocalRuntimePersistenceError',
  'broadcastState',
  `${functionSource(mainSource, 'saveAndBroadcast')}; return saveAndBroadcast;`
)(
  async () => {
    throw Object.assign(new Error('persistent Windows file lock'), {
      code: 'EPERM',
      syscall: 'rename'
    });
  },
  centralRuntime,
  localRuntimePersistenceError,
  (connection) => (
    ['connected', 'tunnel-only', 'lease-only', 'degraded'].includes(connection?.state)
      ? connection
      : null
  ),
  () => localPersistenceClassification,
  () => undefined,
  makeApplyLocalRuntimePersistenceError(centralRuntime),
  () => {
    centralBroadcasts += 1;
  }
);
await assert.rejects(
  saveAndBroadcast({ fallbackConnection: retainedGuestFallback }),
  (err) => err?.code === 'EPERM'
);
assert.equal(centralBroadcasts, 1, 'the in-memory local-storage diagnosis must be broadcast before IPC rejects');
assert.equal(centralRuntime.connection.state, 'connected');
assert.equal(centralRuntime.connection.leaseId, 'lease-retained-guest');
assert.equal(centralRuntime.connection.wireGuard.active, true);
assert.equal(centralRuntime.connection.diagnostics.localPersistence.ok, false);

assert.match(
  functionSource(mainSource, 'promoteEmployeeConnection'),
  /saveAndBroadcast\(\{\s*fallbackConnection:\s*networkFallback\s*\}\)/,
  'a failed transition save must restore the live guest/employee fallback instead of reporting idle'
);

assert.match(
  functionSource(mainSource, 'completeExternalSystemDomainProxyApply'),
  /attachSystemDomainProxyConnectionProof\(status, reason\)/,
  'the combined macOS WireGuard/PAC transaction must collect live system DNS proof before deciding connected'
);
assert.match(
  functionSource(mainSource, 'prepareSystemDomainProxyForWireGuardInstall'),
  /systemDomainProxyDomains\([\s\S]*preConnectSystemDomainProxyDiagnosticHost\(\)/,
  'the combined first-connect transaction must include the exact H2I child even while state is lease-only'
);
assert.match(
  functionSource(mainSource, 'prepareSystemDomainProxyForWireGuardInstall'),
  /prepareExternalApply[\s\S]*transactionToken/,
  'the foreground macOS apply must carry the manager transaction token through the combined shell'
);
assert.match(
  functionSource(mainSource, 'completeExternalSystemDomainProxyApply'),
  /completeExternalApply\(transactionToken, reason\)/,
  'a started external transaction must finalize the exact prepared token'
);
assert.match(
  functionSource(mainSource, 'reconcilePendingExternalSystemDomainProxyApplyAfterStartup'),
  /status\?\.pending !== true[\s\S]*transactionToken[\s\S]*completeExternalApply\([\s\S]*transactionToken,[\s\S]*app-startup-pending-reconcile/,
  'cold start must reconcile a crashed external transaction by tokenized readback before local-edge resume'
);
assert.match(
  functionSource(mainSource, 'abortPreparedSystemDomainProxyApply'),
  /abortExternalApply\(transactionToken,[\s\S]*execution/,
  'a not-started or explicitly canceled external transaction must abort without a system restore'
);
assert.doesNotMatch(
  functionSource(mainSource, 'attachDarwinSystemDnsProof'),
  /runtime\.auth\s*=|stopWireGuard|disconnectConnection/,
  'a failed macOS DNS proof may only gate connected versus tunnel-only; it must not clear auth or stop WireGuard'
);
for (const refreshFunction of [
  'refreshSystemDomainProxyAfterNetworkChange',
  'refreshSystemDomainProxyForRuntime'
]) {
  assert.match(
    functionSource(mainSource, refreshFunction),
    /expectedConnection[\s\S]*expectedEpoch[\s\S]*systemDomainProxyRefreshContextCurrent[\s\S]*recordSystemDomainProxyDiagnostics/,
    `${refreshFunction} must discard a system DNS proof completed for a superseded connection`
  );
}
assert.match(
  functionSource(mainSource, 'maybeSkipSystemDomainProxyApply'),
  /statusVerified[\s\S]*resumeDarwinLocalEdge[\s\S]*localEdgeResumed[\s\S]*background-live-state-verified/,
  'startup recovery must restart only the local edge, then reuse strictly matching live macOS state without applying or prompting'
);
assert.match(
  functionSource(mainSource, 'applyNetworkSession'),
  /latchPreparedSystemDomainProxyFailure\(combinedSystemDomainProxy, err\)[\s\S]*latchPreparedSystemDomainProxyFailure\(combinedSystemDomainProxy, wireGuardResult\)[\s\S]*!connectionReady/,
  'Connect/Login combined cancellation or failed proof must latch the policy before any background retry'
);
assert.match(
  functionSource(mainSource, 'attachDarwinSystemDnsProof'),
  /darwinSystemResolutionExpectedTargets[\s\S]*expectedInternalTargets: expectedTargets/,
  'the connected gate must bind the selected H2I hostname to its exact ProductNetwork target'
);
assert.match(
  functionSource(mainSource, 'ensureSystemDomainProxyForRuntimeOnce'),
  /forceDarwinRefresh:[\s\S]*reason === 'manual-repair'/,
  'a user-requested repair must bypass the metadata fast path exactly once without enabling background mutations'
);
assert.match(
  functionSource(mainSource, 'ensureSystemDomainProxyForRuntimeOnce'),
  /backgroundConnection[\s\S]*backgroundEpoch[\s\S]*maybeSkipSystemDomainProxyApply[\s\S]*networkRecoveryPaused[\s\S]*systemDomainProxyRefreshContextCurrent\(backgroundConnection, backgroundEpoch\)[\s\S]*systemDomainProxyManager\.apply/,
  'pause or connection changes during background preflight must be re-checked immediately before privileged apply'
);
assert.match(
  functionSource(mainSource, 'repairDarwinEndpointRouteBeforeBootstrap'),
  /allowPrivileged: false/,
  'Connect/Login pre-bootstrap must not open a separate endpoint-route authorization dialog'
);
const connectGuardSource = functionSource(mainSource, 'probeConnectedModeBeforeTransition');
assert.match(connectGuardSource, /statusVerified\(\)[\s\S]*attachSystemDomainProxyConnectionProof/);
assert.doesNotMatch(
  connectGuardSource,
  /ensureSystemDomainProxyForRuntime/,
  'the foreground connect guard must be read-only so one Connect/Login action cannot prompt before the final combined shell'
);
assert.doesNotMatch(
  functionSource(mainSource, 'shouldAllowPrivilegedPreBootstrapRecovery'),
  /process\.platform === 'darwin'/,
  'Darwin retained recovery must defer privilege to the final combined transaction by default'
);
assert.match(
  functionSource(mainSource, 'ensureSystemDomainProxyForRuntimeOnce'),
  /domains\.length === 0[\s\S]*process\.platform === 'darwin' && backgroundRefresh[\s\S]*background-no-domains[\s\S]*disableSystemDomainProxyForRuntime/,
  'a Darwin background tick with no domains must remain read-only instead of opening a restore prompt'
);
assert.match(
  functionSource(mainSource, 'maybeSkipSystemDomainProxyApply'),
  /lastSystemDomainProxyPrivilegedFailureSignature[\s\S]*privileged-repair-failed-awaiting-user-retry/,
  'a confirmed-but-failed privileged transaction must not reopen the macOS authorization dialog on every background tick'
);
assert.match(
  functionSource(mainSource, 'repairSystemNetworkForRuntime'),
  /process\.platform === 'darwin'[\s\S]*recordSystemDomainProxyDiagnostics\([\s\S]*const connected/,
  'an explicit macOS repair must immediately promote a proven employee tunnel instead of waiting for the next background tick'
);
const repairSource = functionSource(mainSource, 'repairSystemNetworkForRuntime');
assert.match(
  repairSource,
  /allowPrivileged: false[\s\S]*shouldRecoverWireGuardConnection[\s\S]*prepareSystemDomainProxyForWireGuardInstall[\s\S]*darwin-combined-shell-unavailable[\s\S]*darwinExtraInstallShell: combinedSystemDomainProxy\?\.shell[\s\S]*completeExternalSystemDomainProxyApply/,
  'one explicit macOS repair must combine endpoint/WireGuard/PAC/DNS changes into one foreground authorization transaction'
);
assert.match(
  repairSource,
  /darwin-system-proxy-repair-deferred-after-wireguard[\s\S]*lastSystemDomainProxyPrivilegedFailureSignature[\s\S]*lastSystemDomainProxyAuthorizationCanceledSignature/,
  'a degraded or canceled combined transaction must be latched and an older manager must defer a second prompt'
);
assert.doesNotMatch(
  repairSource,
  /repairDarwinStaleEndpointRoutesForRuntime\([^)]*allowPrivileged: true/,
  'manual repair must not open a separate endpoint-route authorization dialog'
);
assert.match(
  launcherWireGuardSource,
  /repairWireGuardTunnelRoutes\(\{[\s\S]*darwinExtraRepairShell: input\.darwinServiceIdentity\?\.darwinExtraInstallShell/,
  'the Launcher WireGuard repair must forward the combined PAC/DNS shell'
);
assert.match(
  coreWireGuardSource,
  /darwinExtraRepairShell\?:[\s\S]*darwinEndpointBypassCommands[\s\S]*input\.darwinExtraRepairShell[\s\S]*const authorizationCanceled = isWireGuardAuthorizationCancelled[\s\S]*authorizationCanceled/,
  'the single WireGuard authorization shell must include endpoint/PAC/DNS repair and classify cancellation'
);
assert.match(
  functionSource(mainSource, 'wireGuardRuntimeOptions'),
  /darwinLaunchDaemon: true[\s\S]*fallbackToAppManaged: false/,
  'a failed/canceled combined LaunchDaemon transaction must not fall back to a second app-managed authorization dialog'
);
const authorizationCanceledClassifierSource = functionSource(
  mainSource,
  'isUserAuthorizationCanceledError'
);
assert.match(
  authorizationCanceledClassifierSource,
  /value\?\.authorizationCanceled === true/,
  'structured authorization cancellation must take precedence over message heuristics'
);
assert.match(
  authorizationCanceledClassifierSource,
  /-128[\s\S]*管理员授权/,
  'text fallback must be limited to the AppleScript cancellation code or an explicit administrator-authorization message'
);
assert.doesNotMatch(
  authorizationCanceledClassifierSource,
  /user canceled\|user cancelled\|用户已取消\|取消授权\|已取消\|osascript\.\*cancel/i,
  'generic canceled text must not roll back a combined transaction that may already have partially committed'
);
assert.match(
  repairSource,
  /before-system-domain-proxy-ensure[\s\S]*ensureSystemDomainProxyForRuntime[\s\S]*before-system-domain-proxy-restore-stale[\s\S]*restoreStale[\s\S]*before-system-domain-proxy-disable[\s\S]*disableSystemDomainProxyForRuntime/,
  'manual repair must re-check cancellation immediately before every remaining potentially privileged PAC/restore branch'
);
assert.match(
  repairSource,
  /recordSystemDomainProxyDiagnostics[\s\S]*system-domain-proxy-recorded[\s\S]*collectNetworkEnvironmentDiagnostics[\s\S]*diagnostics-after[\s\S]*runtime\.feedback/,
  'read-only repair diagnostics may finish after cancel but must checkpoint before overwriting paused feedback'
);
assert.match(
  functionSource(mainSource, 'connectAndProbeWireGuardPath'),
  /result\?\.authorizationCanceled === true[\s\S]*route: null[\s\S]*ready: false/,
  'authorization cancellation must stop before route/Internal probes and other post-install side effects'
);
assert.match(
  functionSource(mainSource, 'startWireGuardForSession'),
  /attempt\.result\?\.authorizationCanceled === true[\s\S]*wireGuardAuthorizationCanceledFailure/,
  'the raw launcher authorization-canceled result must reach the foreground state machine'
);

assert.match(
  mainSource,
  /ipcMain\.handle\('mx-h2i:cancel-network-operation',[\s\S]*requestForegroundNetworkOperationCancel/,
  'main IPC must expose a dedicated foreground network cancel path'
);
assert.match(
  functionSource(mainSource, 'beginForegroundNetworkOperation'),
  /networkMutationEpoch \+= 1[\s\S]*snapshot:[\s\S]*connection:[\s\S]*identity:[\s\S]*auth:[\s\S]*broadcastState\(\)/,
  'every explicit foreground flow must invalidate stale recovery and expose a retained snapshot before waiting'
);
const cancelNetworkSource = functionSource(mainSource, 'requestForegroundNetworkOperationCancel');
assert.match(
  cancelNetworkSource,
  /operation-id-mismatch[\s\S]*networkRecoveryPaused = true[\s\S]*networkMutationEpoch \+= 1[\s\S]*cancelScheduledWireGuardRecovery\(\)[\s\S]*broadcastState\(\)[\s\S]*void saveRuntime/,
  'cancel must CAS the optional operation id, stop later recovery, broadcast immediately, and persist asynchronously'
);
assert.doesNotMatch(
  cancelNetworkSource,
  /stopWireGuardForRuntime|disableSystemDomainProxyForRuntime|runtime\.auth\s*=\s*null/,
  'cancel must not disconnect a healthy tunnel, restore system settings, or clear employee auth'
);
assert.match(
  functionSource(mainSource, 'visibleForegroundNetworkOperation'),
  /kind:[\s\S]*status:[\s\S]*stage:[\s\S]*cancelable:[\s\S]*promptActive:[\s\S]*paused:/,
  'renderer state must distinguish running, cancel-requested, and paused recovery'
);
assert.match(
  functionSource(mainSource, 'scheduleWireGuardRecovery'),
  /networkRecoveryPaused[\s\S]*setTimeout[\s\S]*networkRecoveryPaused/,
  'a pause must gate both scheduling and already-scheduled background recovery callbacks'
);
assert.match(
  functionSource(mainSource, 'wireGuardRecoveryIdentity'),
  /mutationEpoch: networkMutationEpoch/,
  'cancel epoch changes must supersede an in-flight background recovery result'
);
const applySessionSource = functionSource(mainSource, 'applyNetworkSession');
assert.match(
  applySessionSource,
  /preflight-settled[\s\S]*abortPrePrivilegeTransition[\s\S]*before-system-authorization-command[\s\S]*privilegedStarted: true/,
  'cancel during connect preflight must abort prepared PAC and handover state before any privileged command starts'
);
assert.match(
  applySessionSource,
  /authorizationCanceled[\s\S]*abortPreparedSystemDomainProxyApply[\s\S]*completeExternalSystemDomainProxyApply[\s\S]*cancelRequested/,
  'authorization cancel must abort a not-run token, while a started/unknown shell must finalize before honoring app cancel'
);
assert.match(
  functionSource(mainSource, 'repairSystemNetworkForRuntime'),
  /before-privileged-repair[\s\S]*privilegedStarted: true[\s\S]*completeExternalSystemDomainProxyApply[\s\S]*system-repair-probed/,
  'manual repair must checkpoint before privilege and finalize/read back before stopping a canceled flow'
);
assert.match(
  applySessionSource,
  /const beforeDarwinPrivilegedCommand = \(\) => \{[\s\S]*checkpoint\('before-darwin-privileged-command'\)[\s\S]*markPreparedSystemDomainProxyPrivilegedHandoff[\s\S]*darwinPrivilegedCommandStarted = true[\s\S]*startWireGuardForSession\(\{[\s\S]*beforeDarwinPrivilegedCommand/,
  'the final cancel checkpoint must run inside the launcher hook immediately before the real Darwin privileged command'
);
assert.match(
  functionSource(mainSource, 'markPreparedSystemDomainProxyPrivilegedHandoff'),
  /markExternalApplyHandoff\(transactionToken\)[\s\S]*externalApplyPhase !== 'privileged-handoff'[\s\S]*throw err/,
  'the token handoff must be durably and synchronously marked before osascript; any mismatch must fail closed'
);
assert.match(
  functionSource(mainSource, 'repairSystemNetworkForRuntime'),
  /beforeDarwinPrivilegedCommand[\s\S]*markPreparedSystemDomainProxyPrivilegedHandoff\(combinedSystemDomainProxy\)[\s\S]*darwinPrivilegedCommandStarted = true/,
  'manual repair must use the same durable token handoff before its combined authorization command'
);
assert.match(
  applySessionSource,
  /!darwinPrivilegedCommandStarted[\s\S]*abortPreparedSystemDomainProxyApply[\s\S]*restoreForegroundStandaloneOwnershipSnapshot/,
  'a hook cancellation before osascript must abort prepared PAC and restore/release the connecting ownership claim'
);
assert.match(
  applySessionSource,
  /wireGuardResult\.authorizationCanceled === true[\s\S]*restoreForegroundStandaloneOwnershipSnapshot[\s\S]*retainedForegroundConnection[\s\S]*restoreForegroundNetworkOperationSnapshot/,
  'AppleScript -128 must restore ownership and a retained employee/guest snapshot instead of clearing auth'
);
assert.match(
  applySessionSource,
  /darwin-external-prepare-unavailable-deferred[\s\S]*ensureSystemDomainProxyForRuntime\('post-connect'\)/,
  'an old Darwin system-proxy manager must defer PAC/DNS after the WireGuard prompt instead of opening a second dialog'
);
assert.match(
  applySessionSource,
  /combinedSystemDomainProxy && !combinedSystemDomainProxy\.shell[\s\S]*abortPrePrivilegeTransition\('pre-connect-combined-shell-unavailable'\)[\s\S]*restoreForegroundNetworkOperationSnapshot[\s\S]*markForegroundNetworkOperationPaused/,
  'a durable pending or uncombinable PAC state must reconcile/abort handover and preserve login before any authorization command'
);
assert.match(
  applySessionSource,
  /connection-proof-ready[\s\S]*before-superseded-lease-retirement[\s\S]*retireSupersededLocalLeases[\s\S]*after-superseded-lease-retirement[\s\S]*before-connection-events/,
  'cancel after system commit must stop lease retirement and later event scheduling at explicit checkpoints'
);
assert.match(
  applySessionSource,
  /checkpointCommittedTransition[\s\S]*state: connectionReady[\s\S]*markForegroundNetworkOperationPaused[\s\S]*saveAndBroadcast/,
  'a post-commit cancel must preserve the proven live connection instead of rolling system state back'
);
const abortPreparedSource = functionSource(mainSource, 'abortPreparedSystemDomainProxyApply');
assert.match(
  abortPreparedSource,
  /external-apply-durable-state-pending[\s\S]*completeExternalSystemDomainProxyApply/,
  'a durable pending token may represent an already-committed shell and must reconcile by readback'
);
assert.match(
  abortPreparedSource,
  /external-apply-transaction-in-flight[\s\S]*currentSystemDomainProxyStatus/,
  'a token owned by another in-memory transaction must never be aborted by this foreground flow'
);

const restoreSnapshotBox = {
  current: {
    connection: { state: 'lease-only', mode: 'employee', leaseId: 'new-staff-lease' },
    identity: { kind: 'user', account: 'new@example.com' },
    auth: { accessToken: 'new-staff-token' }
  }
};
const restoreSnapshotHarness = Function(
  'box',
  `let runtime = box.current;
function foregroundOperationConnectionHasLiveTunnel() { return false; }
function idleConnection() { return { state: 'idle', mode: 'guest' }; }
${functionSource(mainSource, 'restoreForegroundNetworkOperationSnapshot')}
return (operation) => { restoreForegroundNetworkOperationSnapshot(operation); box.current = runtime; };`
)(restoreSnapshotBox);
restoreSnapshotHarness({
  snapshot: {
    connection: { state: 'connected', mode: 'guest', leaseId: 'guest-lease' },
    identity: { kind: 'anonymous', account: null },
    auth: null
  }
});
assert.equal(restoreSnapshotBox.current.connection.mode, 'guest');
assert.equal(restoreSnapshotBox.current.identity.kind, 'anonymous');
assert.equal(
  restoreSnapshotBox.current.auth,
  null,
  'guest-to-employee cancellation must restore an explicit null guest auth instead of retaining the new employee token'
);

const disconnectHandlerStart = mainSource.indexOf("ipcMain.handle('mx-h2i:disconnect'");
const disconnectHandlerEnd = mainSource.indexOf("ipcMain.handle('mx-h2i:reset-local-network-identity'", disconnectHandlerStart);
assert.ok(disconnectHandlerStart >= 0 && disconnectHandlerEnd > disconnectHandlerStart);
const disconnectHandlerSource = mainSource.slice(disconnectHandlerStart, disconnectHandlerEnd);
const managedReleaseStart = disconnectHandlerSource.indexOf("!systemDomainRestoreScript");
const managedReleaseEnd = disconnectHandlerSource.indexOf('const wireGuard = await stopWireGuardForRuntime', managedReleaseStart);
const managedReleaseSource = disconnectHandlerSource.slice(managedReleaseStart, managedReleaseEnd);
assert.equal((managedReleaseSource.match(/disableSystemDomainProxyForRuntime\(/g) || []).length, 1);
assert.doesNotMatch(
  managedReleaseSource,
  /stopWireGuardForRuntime/,
  'a Darwin shared-owner disconnect turn must choose managed PAC release and return before opening a WireGuard authorization dialog'
);
assert.match(
  disconnectHandlerSource,
  /darwinProxyRetainedForOtherOwners[\s\S]*darwin-shared-proxy-retained-for-other-owners/,
  'the second disconnect phase must leave another Launcher owner\'s PAC/local edge intact'
);
assert.match(
  disconnectHandlerSource,
  /darwinCombinedRestoreStarted[\s\S]*wireGuard\?\.privilegedExecution === 'started'[\s\S]*darwinCombinedRestoreFailed[\s\S]*本次不会继续弹出第二个授权窗口/,
  'a started but failed combined uninstall/restore must retain auth and local edge without starting a second privileged cleanup'
);
assert.match(
  disconnectHandlerSource,
  /darwinCombinedRestoreCompleted[\s\S]*wireGuard\?\.ok === true[\s\S]*wireGuard\?\.privilegedExecution === 'started'[\s\S]*completeExternalSystemDomainProxyRestore/,
  'disconnect may finalize an external PAC restore only after a successful privileged command'
);
assert.doesNotMatch(
  disconnectHandlerSource,
  /systemDomainRestoreScript && wireGuard\?\.launchDaemon[\s\S]*completeExternalSystemDomainProxyRestore/,
  'a read-only LaunchDaemon status object must not be mistaken for execution of the combined restore shell'
);
assert.ok(
  disconnectHandlerSource.indexOf('const systemDomainProxy =')
    < disconnectHandlerSource.indexOf("releaseStandaloneOwnershipForRuntime('disconnect')"),
  'Darwin PAC/restore proof must settle before standalone ownership is released'
);
assert.match(
  disconnectHandlerSource,
  /darwinSystemProxyCleanupReady[\s\S]*runtime\.auth = retainedAuth[\s\S]*return visibleRuntime\(\)[\s\S]*releaseStandaloneOwnershipForRuntime\('disconnect'\)/,
  'a canceled or failed Darwin proxy restore must preserve auth, state, local edge, and ownership'
);
assert.match(
  functionSource(mainSource, 'normalizeDiagnostics'),
  /disconnectManagedRelease:/,
  'the two-phase shared-owner cleanup marker must survive restart before the WireGuard-only second phase'
);
const credentialFailureSource = functionSource(mainSource, 'reconcileCredentialStorageFailureAfterStartup');
assert.match(
  credentialFailureSource,
  /process\.platform === 'darwin' && !darwinRestoreScript[\s\S]*disableSystemDomainProxyForRuntime\([\s\S]*throw new Error[\s\S]*stopWireGuardForRuntime/,
  'credential fail-close must persist a deferred cleanup after one managed Darwin action and never continue to a second prompt'
);
assert.match(
  credentialFailureSource,
  /process\.platform === 'darwin' \? 1 : 2/,
  'any non-combined Darwin credential cleanup retry budget must be exactly one'
);
assert.match(
  functionSource(launcherWireGuardSource, 'resolveLauncherWireGuardRuntime'),
  /darwinLaunchDaemon !== true[\s\S]*userspaceAvailable[\s\S]*method: userspaceAvailable \? 'darwin-userspace' : 'missing'/,
  'MX-H2I LaunchDaemon mode must ignore a stale wg-quick/Bash4 runtime and force userspace or fail closed'
);
assert.match(
  functionSource(launcherWireGuardSource, 'connectLauncherWireGuardPeer'),
  /darwinLaunchDaemon === true[\s\S]*fallbackToAppManaged === false[\s\S]*privilegedExecution: 'not-started'[\s\S]*setWireGuardTunnelState/,
  'missing Darwin userspace tools must return before the app-managed osascript fallback'
);

assert.match(
  functionSource(mainSource, 'normalizeDiagnostics'),
  /localPersistence:[\s\S]*label:[\s\S]*message:[\s\S]*updatedAt:/,
  'local persistence diagnostics must survive a later successful save and restart'
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
assert.match(
  preloadSource,
  /cancelNetworkOperation: \(operationId = null\) => ipcRenderer\.invoke\([\s\S]*'mx-h2i:cancel-network-operation',[\s\S]*\{ id:/,
  'the preload bridge must pass an optional exact operation id to the cancel IPC'
);
assert.match(rendererSource, /'login-feishu': \(\) => api\.startFeishuLogin\?\.\(\)/);
assert.match(rendererSource, /'cancel-feishu-login': \(\) => api\.cancelFeishuLogin\?\.\(\)/);
const runActionSource = functionSource(rendererSource, 'runAction');
assert.match(
  runActionSource,
  /catch\s*\{[\s\S]*api\.getState\(\)\.catch\(\(\) => null\)[\s\S]*state = next/,
  'a rejected IPC action must refresh the broadcast in-memory diagnosis instead of becoming unhandled'
);
assert.match(
  runActionSource,
  /action === 'cancelNetworkOperation'[\s\S]*busyAction = ''[\s\S]*busyActionRunId = cancelRunId[\s\S]*api\.cancelNetworkOperation\?\.\(operationId\)/,
  'network cancel must bypass the busy action while invalidating its stale renderer turn'
);
assert.doesNotMatch(
  runActionSource,
  /if \(!operationId\) return/,
  'automatic retained recovery must remain pausable even when there is no foreground operation id'
);
assert.match(
  runActionSource,
  /if \(busyActionRunId !== runId\) return;[\s\S]*finally[\s\S]*if \(busyActionRunId === runId\)/,
  'an older connect promise must neither commit stale state nor clear a newer retry'
);
assert.match(
  runActionSource,
  /networkOperationBlocksMutation\(\) && isNetworkMutatingAction\(action\)/,
  'cancel-requested must block a second network mutation until the main operation pauses'
);
assert.match(
  functionSource(rendererSource, 'networkOperationInProgress'),
  /!operation\?\.id[\s\S]*operation\?\.kind === 'background-recovery'[\s\S]*return false/,
  'id-less automatic recovery is advisory and must not block repair or disconnect'
);
assert.match(
  functionSource(rendererSource, 'networkOperationBlocksMutation'),
  /cancelNetworkOperationInFlight[\s\S]*networkOperationInProgress\(\)[\s\S]*rendererPendingNetworkOperation\(\)/,
  'the cancel IPC handoff and renderer-to-main startup gap must stay mutually exclusive'
);

const networkOperationUiSource = functionSource(rendererSource, 'renderNetworkOperationControl');
assert.match(
  networkOperationUiSource,
  /visibleOperation\?\.status === 'paused' && pendingRendererOperation[\s\S]*visibleOperation \|\| pendingRendererOperation/,
  'the cancel control must render immediately while IPC has not broadcast its operation id yet'
);
assert.match(networkOperationUiSource, /data-action="cancelNetworkOperation"/);
assert.match(networkOperationUiSource, /取消本次连接|停止后续恢复/);
assert.match(networkOperationUiSource, /系统权限框[\s\S]*系统权限框中点“取消”/);
assert.match(networkOperationUiSource, /重新修复网络[\s\S]*重新连接[\s\S]*返回员工登录/);
assert.match(networkOperationUiSource, /data-network-operation-status="paused"[\s\S]*已停止后续恢复/);
assert.doesNotMatch(
  networkOperationUiSource,
  /data-action="disconnect"/,
  'logical cancel and paused retry UI must never be implemented as disconnect'
);
const backgroundRecoveryUi = Function(
  'state',
  `let busyAction = '';
let cancelNetworkOperationInFlight = false;
function escapeHtml(value) { return String(value); }
function escapeAttr(value) { return String(value); }
${functionSource(rendererSource, 'currentNetworkOperation')}
${functionSource(rendererSource, 'networkOperationPaused')}
${functionSource(rendererSource, 'networkOperationKind')}
${functionSource(rendererSource, 'networkOperationIsRepair')}
${functionSource(rendererSource, 'networkOperationIsGuestConnect')}
${functionSource(rendererSource, 'rendererPendingNetworkOperation')}
${networkOperationUiSource}
return renderNetworkOperationControl();`
)({
  connection: { state: 'connecting', mode: 'employee' },
  networkOperation: {
    id: null,
    kind: 'background-recovery',
    status: 'running',
    cancelable: true,
    message: '正在原位校验保留网络'
  }
});
assert.match(backgroundRecoveryUi, /停止后续恢复/);
assert.match(backgroundRecoveryUi, /data-action="cancelNetworkOperation"/);
assert.match(backgroundRecoveryUi, /data-operation-id=""/);

const operationGate = Function(
  'state',
  'busyAction',
  'cancelNetworkOperationInFlight',
  `${functionSource(rendererSource, 'currentNetworkOperation')}
${functionSource(rendererSource, 'networkOperationInProgress')}
${functionSource(rendererSource, 'rendererPendingNetworkOperation')}
${functionSource(rendererSource, 'networkOperationBlocksMutation')}
${functionSource(rendererSource, 'networkOperationPaused')}
${functionSource(rendererSource, 'isConnectionPending')}
function feishuAuthStage() { return ''; }
return {
  blocks: networkOperationBlocksMutation(),
  pending: isConnectionPending()
};`
);
assert.deepEqual(operationGate({
  connection: { state: 'tunnel-only' },
  networkOperation: { id: null, kind: 'background-recovery', status: 'running' }
}, '', false), { blocks: false, pending: false });
assert.deepEqual(operationGate({
  connection: { state: 'connecting' },
  networkOperation: { id: null, kind: 'background-recovery', status: 'running' }
}, '', false), { blocks: false, pending: false });
assert.deepEqual(operationGate({
  connection: { state: 'connecting' },
  networkOperation: { id: 'foreground-1', kind: 'employee-connect', status: 'running' }
}, '', false), { blocks: true, pending: true });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const firstConnect = deferred();
const retryConnect = deferred();
let connectCalls = 0;
let disconnectCalls = 0;
const pausedState = {
  connection: { state: 'idle', mode: 'guest' },
  networkOperation: {
    id: 'op-connect-1',
    kind: 'guest-connect',
    status: 'paused',
    stage: 'paused',
    cancelable: false
  }
};
const runActionHarness = Function(
  'api',
  `${functionSource(rendererSource, 'currentNetworkOperation')}
${functionSource(rendererSource, 'networkOperationInProgress')}
${functionSource(rendererSource, 'rendererPendingNetworkOperation')}
${functionSource(rendererSource, 'networkOperationBlocksMutation')}
${functionSource(rendererSource, 'isNetworkMutatingAction')}
let state = { connection: { state: 'idle', mode: 'guest' }, networkOperation: null, apps: {} };
let busyAction = '';
let busyActionRunId = 0;
let actionRunSequence = 0;
let cancelNetworkOperationInFlight = false;
let modeDraft = 'guest';
let selectedAppId = '';
let appCenterRoute = '';
let appInspectorCollapsed = false;
function render() {}
function syncEmployeeLoginDraftFromState() {}
function isGuestConnectionActive() { return state.connection?.mode === 'guest' && state.connection?.state !== 'idle'; }
async function setScreen() {}
${runActionSource}
return {
  runAction,
  setState(next) { state = next; },
  getState() { return state; },
  getBusyAction() { return busyAction; }
};`
)({
  connectGuest: () => (++connectCalls === 1 ? firstConnect.promise : retryConnect.promise),
  disconnect: async () => {
    disconnectCalls += 1;
    return { connection: { state: 'idle', mode: 'guest' }, networkOperation: null, apps: {} };
  },
  cancelNetworkOperation: async () => pausedState,
  getState: async () => pausedState
});

const staleConnectTurn = runActionHarness.runAction('connectGuest');
runActionHarness.setState({
  connection: { state: 'connecting', mode: 'guest' },
  networkOperation: {
    id: 'op-connect-1',
    kind: 'guest-connect',
    status: 'running',
    stage: 'bootstrap',
    cancelable: true
  },
  apps: {}
});
await runActionHarness.runAction('cancelNetworkOperation', { id: 'op-connect-1' });
assert.equal(runActionHarness.getState().networkOperation.status, 'paused');
const retryTurn = runActionHarness.runAction('connectGuest');
assert.equal(runActionHarness.getBusyAction(), 'connectGuest');
firstConnect.resolve({ connection: { state: 'connected', mode: 'guest', localIp: '10.89.100.9' }, networkOperation: null, apps: {} });
await staleConnectTurn;
assert.equal(
  runActionHarness.getBusyAction(),
  'connectGuest',
  'the canceled promise finally must not clear a newer retry busy state'
);
assert.equal(
  runActionHarness.getState().networkOperation.status,
  'paused',
  'the canceled promise response must not overwrite the paused/newer state'
);
retryConnect.resolve({ connection: { state: 'connected', mode: 'guest', localIp: '10.89.100.10' }, networkOperation: null, apps: {} });
await retryTurn;
assert.equal(runActionHarness.getBusyAction(), '');
assert.equal(runActionHarness.getState().connection.localIp, '10.89.100.10');
runActionHarness.setState({
  connection: { state: 'tunnel-only', mode: 'employee', localIp: '10.89.50.2' },
  networkOperation: {
    id: null,
    kind: 'background-recovery',
    status: 'running',
    cancelable: true
  },
  apps: {}
});
await runActionHarness.runAction('disconnect');
assert.equal(
  disconnectCalls,
  1,
  'an id-less retained-recovery hint must not block an explicit disconnect'
);

const employeeUiSource = functionSource(rendererSource, 'renderEmployeeLogin');
assert.match(employeeUiSource, /data-action="\$\{feishuAction\}"/);
assert.match(employeeUiSource, /使用飞书登录/);
assert.doesNotMatch(
  employeeUiSource,
  /connectGuest|使用访客连接/,
  'the default employee login must not expose idle anonymous enrollment'
);
assert.match(employeeUiSource, /data-action="disconnect"/);
assert.match(employeeUiSource, /仅断开访客模式/);
assert.match(employeeUiSource, /当前访客 IP/);
assert.match(employeeUiSource, /data-action="show-advanced"/);

const retainedEmployeeSession = Function(
  'state',
  `${functionSource(rendererSource, 'isRetainedEmployeeSession')}; return isRetainedEmployeeSession();`
);
const validEmployeeAuth = {
  provider: 'feishu',
  expiresAt: new Date(Date.now() + 60_000).toISOString()
};
assert.equal(retainedEmployeeSession({
  auth: validEmployeeAuth,
  identity: { kind: 'user' },
  connection: { state: 'tunnel-only', mode: 'employee' }
}), true, 'an authenticated retained employee tunnel must remain an employee session');
assert.equal(retainedEmployeeSession({
  auth: { ...validEmployeeAuth, expiresAt: new Date(Date.now() - 60_000).toISOString() },
  identity: { kind: 'user' },
  connection: { state: 'tunnel-only', mode: 'employee' }
}), false, 'an expired employee token must return to the login flow');
assert.equal(retainedEmployeeSession({
  auth: validEmployeeAuth,
  identity: { kind: 'user' },
  connection: { state: 'tunnel-only', mode: 'guest' }
}), false, 'a guest tunnel must never be presented as a retained employee session');

const retainedEmployeeUiSource = functionSource(rendererSource, 'renderEmployeeRecovery');
assert.match(retainedEmployeeUiSource, /data-action="repairSystemNetwork"/);
assert.match(retainedEmployeeUiSource, /data-action="disconnect"/);
assert.match(retainedEmployeeUiSource, /无需重新登录/);
assert.doesNotMatch(
  retainedEmployeeUiSource,
  /login-employee|login-feishu|connectGuest/,
  'a retained employee tunnel must offer repair/disconnect without restarting authentication'
);
assert.match(
  functionSource(rendererSource, 'renderPhone'),
  /renderNetworkOperationControl\(\)[\s\S]*retainedEmployee[\s\S]*renderEmployeeRecovery\(\)[\s\S]*renderEmployeeLogin/,
  'the phone must route an authenticated employee tunnel-only state to recovery before login'
);
assert.match(
  functionSource(rendererSource, 'renderAdvancedPhone'),
  /renderNetworkOperationControl\(\)/,
  'advanced repair must retain the same cancel and paused controls, including id-less background recovery'
);

const anonymousUiSource = functionSource(rendererSource, 'renderAnonymousAccessPanel');
assert.match(anonymousUiSource, /const action = disconnectable \? 'disconnect' : 'connectGuest'/);
assert.match(anonymousUiSource, /renderConnectionRecoverySteps\(retainedGuest\)/);
assert.match(anonymousUiSource, /data-action="resetLocalNetworkIdentity"/);
assert.match(anonymousUiSource, /员工网络正在使用中/);

console.log('Feishu loopback OAuth and advanced anonymous-entry safety tests passed');
