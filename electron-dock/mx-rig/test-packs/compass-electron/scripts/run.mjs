import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { CATALOG_DIGEST_ALGORITHM, catalogDigest } from './catalog-digest.mjs';

const laneArguments = process.argv.filter((argument) => argument.startsWith('--lane='));
const argumentLane = laneArguments[0]?.slice('--lane='.length).trim() || null;
const environmentLane = process.env.MX_AUTO_ELECTRON_LANE?.trim() || null;
const canonicalProfile = process.env.MX_AUTO_PROFILE?.trim() || null;
const legacyProfile = process.env.MXT_PROFILE?.trim() || null;
let laneSelectionError = null;
if (laneArguments.length > 1) laneSelectionError = 'Only one --lane value is allowed.';
if (canonicalProfile && legacyProfile && canonicalProfile !== legacyProfile) {
  laneSelectionError = 'MX_AUTO_PROFILE and MXT_PROFILE disagree.';
}
const profile = canonicalProfile || legacyProfile;
let profileLane = null;
if (profile === 'mock') profileLane = 'bootstrap';
else if (profile === 'real' || profile === 'real-test') profileLane = 'auth';
else if (profile) laneSelectionError = 'The Compass Electron profile must be mock or real.';
if (argumentLane && environmentLane && argumentLane !== environmentLane) {
  laneSelectionError = '--lane and MX_AUTO_ELECTRON_LANE disagree.';
}
const explicitLane = argumentLane || environmentLane;
if (explicitLane && !['bootstrap', 'auth'].includes(explicitLane)) {
  laneSelectionError = 'The Compass Electron lane must be bootstrap or auth.';
}
if (explicitLane && profileLane && explicitLane !== profileLane) {
  laneSelectionError = 'The requested lane conflicts with the platform profile.';
}
const lane = laneSelectionError ? 'unresolved' : explicitLane || profileLane || 'bootstrap';
const expectedCaseIds =
  lane === 'auth'
    ? ['CPS-EL-AUTH-001']
    : ['CPS-EL-BOOT-001', 'CPS-EL-BOOT-002'];

const artifactRoot = resolve(
  process.env.MX_AUTO_ARTIFACTS_DIR ||
    process.env.MXT_ARTIFACTS_DIR ||
    process.env.MX_AUTOTEST_ARTIFACTS_DIR ||
    'artifacts'
);
const configuredArtifactRoot = Boolean(
  process.env.MX_AUTO_ARTIFACTS_DIR ||
    process.env.MXT_ARTIFACTS_DIR ||
    process.env.MX_AUTOTEST_ARTIFACTS_DIR
);
if (!configuredArtifactRoot) {
  // The pack owns its local default. Platform-provided roots are never erased:
  // they must be a fresh, per-Run directory or the run is blocked below.
  rmSync(artifactRoot, { recursive: true, force: true });
}
// Any entry is unsafe, not only a filename this pack recognises. The legacy
// runner uploads the whole root, so an unknown leftover could be another
// run's evidence or a secret.
const staleOutputNames =
  configuredArtifactRoot && existsSync(artifactRoot) ? readdirSync(artifactRoot).sort() : [];
for (const directory of ['junit', 'logs', 'report', 'screenshots', 'traces', 'videos']) {
  mkdirSync(resolve(artifactRoot, directory), { recursive: true });
}
const blockedManifestPath = resolve(artifactRoot, 'preflight.json');
rmSync(blockedManifestPath, { force: true });

function optionalSha256(value) {
  const normalized = String(value || '').replace(/^sha256:/u, '').toLowerCase();
  return /^[0-9a-f]{64}$/u.test(normalized) ? `sha256:${normalized}` : null;
}

function testSourceCommit() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  if (status.status !== 0 || String(status.stdout || '').trim()) return null;
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
  const commit = revision.status === 0 ? revision.stdout.trim().toLowerCase() : '';
  return /^[0-9a-f]{40}$/u.test(commit) ? commit : null;
}

function initializeSidecar() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const lockBytes = readFileSync(resolve('pnpm-lock.yaml'));
  const catalogBytes = readFileSync(resolve('case-catalog.electron.json'));
  const sourceCommit = testSourceCommit();
  const applicationDigest = optionalSha256(
    process.env.MX_AUTO_APP_SHA256 || process.env.MXT_APP_SHA256
  );
  const warnings = [];
  if (!sourceCommit) warnings.push('Test source commit unavailable because the pack is not in a clean Git checkout.');
  if (!applicationDigest) warnings.push('Application artifact digest was not supplied by the runner.');

  const sidecar = {
    schemaVersion: 1,
    runId: process.env.MX_AUTO_RUN_ID || process.env.MXT_RUN_ID || null,
    startedAt: new Date().toISOString(),
    suite: 'compass-electron-smoke',
    lane,
    engine: {
      name: 'playwright-electron',
      version: packageJson.devDependencies?.playwright || null,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      lockDigest: `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`
    },
    sources: {
      application: applicationDigest ? { artifactDigest: applicationDigest } : {},
      tests: sourceCommit ? { commit: sourceCommit } : {},
      catalog: {
        suite: 'compass-electron-smoke',
        digestAlgorithm: CATALOG_DIGEST_ALGORITHM,
        digest: catalogDigest(catalogBytes)
      }
    },
    coverage: {
      nativeDialogs: {
        mode: 'unsupported',
        note: 'Playwright Electron does not claim OS-native dialog coverage.'
      },
      systemPermissions: {
        mode: 'manual-witness',
        note: 'UAC, Keychain and privileged network prompts require a separate witnessed lane.'
      }
    },
    cases: [],
    warnings
  };
  writeFileSync(
    resolve(artifactRoot, 'mx-autotest.sidecar.json'),
    `${JSON.stringify(sidecar, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function recordedCaseIds() {
  try {
    const sidecar = JSON.parse(
      readFileSync(resolve(artifactRoot, 'mx-autotest.sidecar.json'), 'utf8')
    );
    return Array.isArray(sidecar.cases)
      ? sidecar.cases
          .map((entry) => (typeof entry?.caseId === 'string' ? entry.caseId : null))
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function junitHasAssertionFailure() {
  try {
    return /<failure(?:\s|>)/u.test(
      readFileSync(resolve(artifactRoot, 'junit', 'compass-electron.xml'), 'utf8')
    );
  } catch {
    return false;
  }
}

function blocked(stage, reason) {
  writeFileSync(
    blockedManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'blocked',
        suite: 'compass-electron-smoke',
        lane,
        stage,
        reason,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  console.error(`[blocked] ${reason}`);
  process.exit(2);
}

function playwrightControllerEnvironment() {
  const environment = {};
  const authLaneAllowlist = new Set([
    'COMPASS_AUTH_CAPTCHA_MODE',
    'COMPASS_E2E_ACCOUNT',
    'COMPASS_E2E_PASSWORD'
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (['DEBUG', 'DEBUG_FILE', 'NODE_DEBUG', 'NODE_OPTIONS', 'PWDEBUG'].includes(upper)) continue;
    if (upper.startsWith('PLAYWRIGHT_')) continue;
    const sensitive = /(ACCOUNT|AUTH|COOKIE|CREDENTIAL|JWT|PASSWORD|PRIVATE[_-]?KEY|SECRET|TOKEN)/u.test(
      upper
    );
    if (sensitive && !(lane === 'auth' && authLaneAllowlist.has(upper))) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    CI: '1',
    MX_AUTO_WRAPPER_GUARD: 'compass-electron-v1',
    MX_AUTO_ELECTRON_LANE: lane,
    MX_AUTO_APP_PATH: resolvedAppPath,
    MX_AUTO_ARTIFACTS_DIR: artifactRoot,
    MXT_APP_PATH: resolvedAppPath,
    MXT_ARTIFACTS_DIR: artifactRoot,
    ...(lane === 'auth'
      ? {
          COMPASS_AUTH_CAPTCHA_MODE: process.env.COMPASS_AUTH_CAPTCHA_MODE,
          COMPASS_E2E_ACCOUNT: process.env.COMPASS_E2E_ACCOUNT,
          COMPASS_E2E_PASSWORD: process.env.COMPASS_E2E_PASSWORD
        }
      : {}),
    // Playwright 1.63 otherwise writes an AI-oriented page snapshot into
    // error-context.md. In an auth Run that snapshot could contain form values.
    PLAYWRIGHT_NO_COPY_PROMPT: '1'
  };
}

function scrubAuthArtifacts() {
  if (lane !== 'auth') return;
  // The auth lane intentionally keeps only JUnit + explicit metadata. Remove
  // Playwright's per-test context directory even though the pinned no-copy
  // guard is enabled, then defensively redact common exact encodings in text.
  rmSync(resolve(artifactRoot, 'logs', 'playwright'), { recursive: true, force: true });
  const account = process.env.COMPASS_E2E_ACCOUNT || '';
  const password = process.env.COMPASS_E2E_PASSWORD || '';
  const xmlEscape = (value) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  const variants = new Set(
    [
      account,
      password,
      encodeURIComponent(account),
      encodeURIComponent(password),
      Buffer.from(account).toString('base64'),
      Buffer.from(password).toString('base64'),
      Buffer.from(`${account}:${password}`).toString('base64'),
      xmlEscape(account),
      xmlEscape(password)
    ].filter((value) => value.length >= 4)
  );
  for (const relativePath of [
    ['junit', 'compass-electron.xml'],
    ['mx-autotest.sidecar.json'],
    ['preflight.json']
  ]) {
    const path = resolve(artifactRoot, ...relativePath);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    if ([...variants].some((secret) => content.includes(secret))) {
      rmSync(path, { force: true });
      throw new Error('A credential representation reached an auth artifact.');
    }
    chmodSync(path, 0o600);
  }
}

if (staleOutputNames.length > 0) {
  blocked(
    'artifact-root',
    `The configured artifact directory is not a fresh per-Run root (found: ${staleOutputNames.join(', ')}).`
  );
}
if (laneSelectionError) blocked('profile', laneSelectionError);

try {
  initializeSidecar();
} catch (error) {
  blocked(
    'toolchain',
    `The test-pack could not initialize its evidence contract: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

const appPath =
  process.env.MX_AUTO_APP_PATH || process.env.MXT_APP_PATH || process.env.MX_AUTOTEST_APP_PATH;
if (!appPath) {
  blocked('artifact', 'A packaged Compass executable is required.');
}

const resolvedAppPath = resolve(appPath);
if (!existsSync(resolvedAppPath)) {
  blocked('artifact', `The configured Compass executable does not exist (${basename(resolvedAppPath)}).`);
}
let executable;
try {
  executable = statSync(resolvedAppPath);
} catch {
  blocked('artifact', `The configured Compass executable cannot be inspected (${basename(resolvedAppPath)}).`);
}
if (!executable.isFile()) {
  blocked('artifact', 'MX_AUTO_APP_PATH must point to the packaged executable, not an installer or app directory.');
}
if (process.platform !== 'win32' && (executable.mode & 0o111) === 0) {
  blocked('artifact', 'The configured Compass target is not executable on this runner.');
}

const networkMode = process.env.COMPASS_E2E_NETWORK_MODE;
if (!['dedicated-runner', 'reviewed-isolated-build'].includes(networkMode)) {
  blocked(
    'network-safety',
    'Set COMPASS_E2E_NETWORK_MODE=dedicated-runner or reviewed-isolated-build after verifying that this run cannot change an MX-H2I user session.'
  );
}

if (lane === 'auth') {
  if (!process.env.COMPASS_E2E_ACCOUNT || !process.env.COMPASS_E2E_PASSWORD) {
    blocked('credentials', 'The formal auth lane requires a dedicated Compass test account and password.');
  }
  if (
    process.env.COMPASS_E2E_ACCOUNT.length < 4 ||
    process.env.COMPASS_E2E_PASSWORD.length < 8 ||
    /[\r\n]/u.test(process.env.COMPASS_E2E_ACCOUNT) ||
    /[\r\n]/u.test(process.env.COMPASS_E2E_PASSWORD)
  ) {
    blocked('credentials', 'The dedicated Compass test credentials do not meet the acceptance safety policy.');
  }
  if (process.env.COMPASS_AUTH_CAPTCHA_MODE !== 'reviewed-test-hook') {
    blocked(
      'captcha',
      'The packaged app has no automatable production captcha contract. Formal auth requires COMPASS_AUTH_CAPTCHA_MODE=reviewed-test-hook and a separately reviewed non-production acceptance build.'
    );
  }
  let playwrightImplementation = '';
  try {
    playwrightImplementation = readFileSync(resolve('node_modules', 'playwright', 'lib', 'index.js'), 'utf8');
  } catch {
    blocked('toolchain-security', 'The pinned Playwright privacy guard could not be inspected.');
  }
  if (!playwrightImplementation.includes('PLAYWRIGHT_NO_COPY_PROMPT')) {
    blocked(
      'toolchain-security',
      'This Playwright build cannot prove that automatic failure-page snapshots are disabled for the auth lane.'
    );
  }
}

const cli = resolve('node_modules', '@playwright', 'test', 'cli.js');
const result = spawnSync(process.execPath, [cli, 'test'], {
  stdio: 'inherit',
  env: playwrightControllerEnvironment()
});
try {
  scrubAuthArtifacts();
} catch {
  blocked('evidence-security', 'The auth artifact privacy cleanup could not be completed safely.');
}

if (result.error) {
  blocked('toolchain', `Playwright could not start: ${result.error.message}`);
}
if (existsSync(blockedManifestPath)) process.exit(2);
if (result.status == null) blocked('toolchain', 'Playwright ended without an exit status.');
const recordedIds = recordedCaseIds();
const missingCaseIds = expectedCaseIds.filter((caseId) => !recordedIds.includes(caseId));
const unexpectedCaseIds = recordedIds.filter((caseId) => !expectedCaseIds.includes(caseId));
const preserveEstablishedProductFailure = result.status === 1 && junitHasAssertionFailure();
if (
  unexpectedCaseIds.length > 0 ||
  (missingCaseIds.length > 0 && !preserveEstablishedProductFailure)
) {
  blocked(
    'test-execution',
    `Playwright did not complete the ${lane} case contract (missing: ${
      missingCaseIds.join(', ') || 'none'
    }; unexpected: ${unexpectedCaseIds.join(', ') || 'none'}); inspect junit/ and logs/.`
  );
}
process.exit(result.status);
