import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mainSource = readFileSync(
  fileURLToPath(new URL('../src-electron/electron-main.ts', import.meta.url)),
  'utf8'
);
const bootstrapSource = readFileSync(
  fileURLToPath(new URL('../src-electron/electron-bootstrap.cjs', import.meta.url)),
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

const secureStorageSource = functionSource(mainSource, 'secureCredentialStorageAvailable');
assert.match(secureStorageSource, /safeStorage\.isEncryptionAvailable\(\)/);
assert.match(secureStorageSource, /process\.platform !== 'linux'/);
assert.match(secureStorageSource, /getSelectedStorageBackend/);
assert.match(secureStorageSource, /backend !== 'basic_text'/);

const protectSource = functionSource(mainSource, 'protectCredentialVault');
assert.match(protectSource, /safeStorage\.encryptString\(JSON\.stringify\(normalized\)\)/);
assert.match(protectSource, /credentialStorageFailure[\s\S]*Refusing to overwrite unreadable protected credentials/);
const unprotectSource = functionSource(mainSource, 'unprotectCredentialVault');
assert.match(unprotectSource, /safeStorage\.decryptString\(Buffer\.from\(ciphertext, 'base64'\)\)/);
assert.match(unprotectSource, /credentialStorageFailure = errorMessage\(error\)/);

const pendingSource = functionSource(mainSource, 'ensurePendingLeaseCapability');
assert.match(
  pendingSource,
  /existing\?\.capability[\s\S]*return \{ credentialKey, capability: existing\.capability \}/,
  'a failed anonymous enrollment retry must reuse its already-persisted pending capability'
);
assert.match(pendingSource, /`mxlc1\.\$\{randomBytes\(32\)\.toString\('base64url'\)\}`/);
assert.match(pendingSource, /leaseId: null[\s\S]*identityKind,[\s\S]*publicKey: keyPair\.publicKey/);

const enrollmentCapabilitySource = functionSource(mainSource, 'leaseCapabilitiesForEnrollment');
assert.match(enrollmentCapabilitySource, /item\.productId === state\.config\.productId/);
assert.match(enrollmentCapabilitySource, /item\.installId === state\.installId/);
assert.match(enrollmentCapabilitySource, /item\.publicKey === publicKey/);
assert.match(enrollmentCapabilitySource, /\.slice\(0, 16\)/);
assert.match(enrollmentCapabilitySource, /capabilities\.join\(','\)/);

const rememberSource = functionSource(mainSource, 'rememberLeaseCredential');
assert.match(
  rememberSource,
  /key !== pendingCredentialKey[\s\S]*item\.leaseId !== leaseId[\s\S]*retained\[leaseId\]/,
  'a successful enrollment must promote the pending capability to the real lease id'
);
assert.match(rememberSource, /stringValue\(lease\.capability\) \|\| fallbackCapability/);

const connectSource = functionSource(mainSource, 'requestLuopanLease');
const persistBeforeConnect = connectSource.indexOf('await saveRuntime();');
const connectCall = connectSource.indexOf('launcherClient().connectNetwork({');
assert.ok(persistBeforeConnect >= 0 && persistBeforeConnect < connectCall, 'new capability and key must persist before enrollment');
assert.match(connectSource, /identityKind,[\s\S]*leaseProfile: loggedIn \? 'employee' : 'anonymous'/);
assert.match(connectSource, /userId: userId \?\? undefined/);
assert.match(
  connectSource,
  /accessToken: loggedIn \? activeAccessToken : undefined/,
  'password user enrollment must carry the active MX bearer token'
);
assert.match(connectSource, /leaseCapability,[\s\S]*newLeaseCapability: pendingCapability\.capability/);
assert.match(connectSource, /keyPair,[\s\S]*privateKey: keyPair\.privateKey,[\s\S]*publicKey: keyPair\.publicKey/);
assert.match(
  connectSource,
  /rememberLeaseCredential\(session\.lease, pendingCapability\.credentialKey\);[\s\S]*await saveRuntime\(\)/,
  'the returned capability must be safely persisted for the second anonymous connect'
);

assert.match(
  mainSource,
  /activeAccessToken = auth\.accessToken;[\s\S]*credentialVault\.accessToken = auth\.accessToken;/,
  'password login must feed both the active user connect path and encrypted persistence'
);
const changePasswordSource = functionSource(mainSource, 'requestLuopanOwnPasswordChange');
assert.match(changePasswordSource, /effectiveApiBaseUrl\(\).*\/internal\/v1\/sdk\/users\/me\/password/);
assert.match(changePasswordSource, /Authorization: `Bearer \$\{accessToken\}`/);
assert.match(
  mainSource,
  /ipcMain\.handle\('luopan:change-password'[\s\S]*requestLuopanOwnPasswordChange\(activeAccessToken, currentPassword, newPassword\)[\s\S]*credentialVault\.accessToken = null/,
  'self-service password change must use the in-tunnel bearer path and clear the revoked local token'
);

const releaseSource = functionSource(mainSource, 'releaseLuopanServerLeases');
assert.match(releaseSource, /\/release`/);
assert.match(releaseSource, /capability: credential\.capability/);
assert.match(releaseSource, /forgetLeaseCredential\(candidate\.leaseId\)/);
const disconnectSource = functionSource(mainSource, 'disconnectLuopanDataPlane');
assert.match(disconnectSource, /if \(stopped\)[\s\S]*releaseLuopanServerLeases\(sessionToStop\)/);
assert.match(
  disconnectSource,
  /catch \(error\) \{[\s\S]*server lease release pending/,
  'remote release is best effort and must not undo a successful local stop'
);
assert.match(
  disconnectSource,
  /try \{[\s\S]*await setOversea\(overseaAfterDisconnect\);[\s\S]*catch \(error\)[\s\S]*must never[\s\S]*prevent local WireGuard\/routes from being removed/,
  'an unreadable safeStorage vault must not block local data-plane teardown'
);
assert.match(
  disconnectSource,
  /try \{[\s\S]*await saveRuntime\(\);[\s\S]*catch \(error\)[\s\S]*persistenceComplete = false/,
  'post-stop persistence failure must be reported without undoing local cleanup'
);

const loadRuntimeSource = functionSource(mainSource, 'loadRuntime');
assert.match(
  loadRuntimeSource,
  /!hasProtectedCredentials[\s\S]*parsed\.credentialVaultVersion !== CREDENTIAL_VAULT_VERSION[\s\S]*legacyCredentialCleanupRequired/,
  'a pre-vault runtime must enter the one-time legacy migration path'
);
assert.match(
  functionSource(mainSource, 'completeLegacyCredentialMigration'),
  /rotateLauncherRuntimeIdentity\('after legacy local data-plane cleanup'\)/,
  'legacy cleanup must rotate both identifiers instead of weakening the server key-rotation gate'
);
const identityRotationSource = functionSource(mainSource, 'rotateLauncherRuntimeIdentity');
assert.match(identityRotationSource, /state\.installId = nextRuntimeIdentityId\(state\.config\.productId, 'inst'\)/);
assert.match(identityRotationSource, /state\.deviceId = nextRuntimeIdentityId\(state\.config\.productId, 'dev'\)/);
assert.match(identityRotationSource, /credentialVault = emptyCredentialVault\(\)/);
assert.match(
  connectSource,
  /if \(legacyCredentialCleanupRequired\)[\s\S]*disconnectLuopanDataPlane\('reset'\)[\s\S]*if \(!migrated\)[\s\S]*return false/,
  'enrollment must wait for legacy local cleanup and identity rotation'
);
assert.match(
  connectSource,
  /canRecoverAnonymousLeaseCapabilityLoss\(error, identityKind, options\)[\s\S]*rotateLauncherRuntimeIdentity\('after anonymous lease capability was lost'\)[\s\S]*requestLuopanLease\(\{ allowLostCapabilityRecovery: false \}\)/,
  'anonymous lease capability loss must recover by rotating local identity and retrying only once'
);
assert.match(
  functionSource(mainSource, 'shutdownLuopanApplication'),
  /await runtimeSaveQueue\.catch\([\s\S]*must not trap the app in before-quit/,
  'a failed final runtime write must not block quit after local teardown succeeds'
);
assert.match(
  functionSource(mainSource, 'currentReleaseVersion'),
  /runningElectronLauncherVersion\(baseApplicationVersion\(\)\)/,
  'Release Center currentVersion must use Luopan package/ASAR version, not Electron runtime version'
);
assert.match(
  functionSource(mainSource, 'baseApplicationVersion'),
  /packageJsonVersion\(process\.env\.MX_LAUNCHER_BASE_PACKAGE_JSON\)[\s\S]*app\.getVersion\(\)/,
  'Luopan dev mode must prefer package.json version before falling back to Electron app.getVersion()'
);
assert.match(
  bootstrapSource,
  /const basePackageJson = resolveBasePackageJson\(basePackageRoot\);[\s\S]*const baseVersion = readPackageVersion\(basePackageJson\) \|\| app\.getVersion\(\);/,
  'Luopan ASAR bootstrap must select updates against the base app version, not Electron runtime version'
);

const registerIpcSource = functionSource(mainSource, 'registerIpc');
const configDisconnect = registerIpcSource.indexOf("await disconnectLuopanDataPlane('config-change'");
const configAssignment = registerIpcSource.indexOf('state.config = next;');
assert.ok(
  configDisconnect >= 0 && configDisconnect < configAssignment,
  'a config-channel change must release the old lease through the old server before switching URLs'
);
assert.match(registerIpcSource, /const endpointChanged = channelChanged \|\| bootstrapChanged/);
assert.match(
  registerIpcSource,
  /disconnectLuopanDataPlane\('config-change', \{[\s\S]*requireServerRelease: true[\s\S]*if \(!disconnected\)[\s\S]*return visibleRuntime\(\);[\s\S]*state\.config = next/,
  'endpoint changes must be rejected unless old local cleanup, remote release, and persistence all succeed'
);
assert.match(
  registerIpcSource,
  /state\.config = next;[\s\S]*credentialVault\.leaseCredentials = \{\}/,
  'pending capabilities from the old endpoint must not be sent to the new origin'
);

console.log('Luopan launcher network capability checks passed.');
