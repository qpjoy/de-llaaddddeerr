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
  'diagnosticLogStatus',
  `${functionSource(mainSource, 'visibleRuntime')}; return visibleRuntime;`
)(
  {},
  (value) => value,
  (value) => value,
  (value) => value,
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
assert.match(rendererSource, /data-action="resetLocalNetworkIdentity">清理旧连接/);
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
assert.match(rendererSource, /'login-feishu': \(\) => api\.startFeishuLogin\?\.\(\)/);
assert.match(rendererSource, /'cancel-feishu-login': \(\) => api\.cancelFeishuLogin\?\.\(\)/);
assert.match(
  functionSource(rendererSource, 'runAction'),
  /catch\s*\{[\s\S]*api\.getState\(\)\.catch\(\(\) => null\)[\s\S]*state = next/,
  'a rejected IPC action must refresh the broadcast in-memory diagnosis instead of becoming unhandled'
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

const anonymousUiSource = functionSource(rendererSource, 'renderAnonymousAccessPanel');
assert.match(anonymousUiSource, /const action = connected \? 'disconnect' : 'connectGuest'/);
assert.match(anonymousUiSource, /renderConnectionRecoverySteps\(retainedGuest\)/);
assert.match(anonymousUiSource, /data-action="resetLocalNetworkIdentity"/);
assert.match(anonymousUiSource, /员工网络正在使用中/);

console.log('Feishu loopback OAuth and advanced anonymous-entry safety tests passed');
