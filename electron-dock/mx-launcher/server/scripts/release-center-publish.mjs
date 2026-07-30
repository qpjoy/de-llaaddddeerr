import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '../../..');
// Product selector: `--product luopan` publishes plans for any standalone
// launcher product. Component naming follows the launcher convention the
// clients check against: installer and ASAR plans target `<product>`, renderer
// hot plans target `<product>-renderer` (override with --component-id). Release matching is
// componentId-based. The scoped Publisher API additionally requires the
// product to be registered and enabled in AppCenter.
const product = safeProductId(args.product || process.env.MX_RELEASE_PRODUCT || 'mx-h2i');
const isDefaultProduct = product === 'mx-h2i';
const baseUrl = requiredArg('base-url', args.baseUrl || process.env.MX_RELEASE_BASE_URL || process.env.MX_SMOKE_BASE_URL)
  .replace(/\/+$/, '');
if (args.accessToken) {
  throw new Error('Do not pass --access-token on the command line; use MX_RELEASE_ACCESS_TOKEN');
}
let releaseAccessToken = optionalArg(process.env.MX_RELEASE_ACCESS_TOKEN);
const releaseClientId = optionalArg(args.clientId || process.env.MX_RELEASE_CLIENT_ID);
if (args.clientSecret) {
  throw new Error('Do not pass --client-secret on the command line; use MX_RELEASE_CLIENT_SECRET from a CI secret store');
}
const releaseClientSecret = optionalArg(process.env.MX_RELEASE_CLIENT_SECRET);
const releaseOpsToken = optionalArg(process.env.MX_INTERNAL_OPS_TOKEN);
const approveRelease = boolArg(args.approve ?? process.env.MX_RELEASE_APPROVE, false);
const releaseScopes = [
  'sdk.release.publish',
  'sdk.release.read',
  ...(approveRelease ? ['sdk.release.approve'] : [])
].join(' ');
let authenticationMode = releaseAccessToken ? 'access-token' : releaseOpsToken ? 'internal-ops' : 'legacy-admin';
if (!releaseAccessToken && (releaseClientId || releaseClientSecret)) {
  if (!releaseClientId || !releaseClientSecret) {
    throw new Error('--client-id and MX_RELEASE_CLIENT_SECRET are both required for client_credentials authentication');
  }
  releaseAccessToken = await exchangeReleaseAccessToken(releaseClientId, releaseClientSecret);
  authenticationMode = 'client-credentials';
}
if (approveRelease && !releaseAccessToken) {
  throw new Error('--approve requires --access-token or client_credentials authentication');
}
const artifactPathInput = requiredArg('artifact', args.artifact || process.env.MX_RELEASE_ARTIFACT);
const artifactPath = await resolveArtifactPath(artifactPathInput);
let artifactUrl = optionalArg(args.artifactUrl || process.env.MX_RELEASE_ARTIFACT_URL);
const version = requiredArg('version', args.version || process.env.MX_RELEASE_VERSION);
const channel = args.channel || process.env.MX_RELEASE_CHANNEL || 'stable';
const currentVersion = args.currentVersion || process.env.MX_RELEASE_CURRENT_VERSION || '0.1.0';
const kind = args.kind || process.env.MX_RELEASE_KIND || 'installer';
if (!['installer', 'asar', 'hot'].includes(kind)) {
  throw new Error('--kind must be installer, asar, or hot');
}
const requestedDeliveryMode = args.deliveryMode
  || process.env.MX_RELEASE_DELIVERY_MODE
  || 'prompt-download-restart';
if (!['prompt-download-restart', 'manual-download', 'silent-download-next-start'].includes(requestedDeliveryMode)) {
  throw new Error('--delivery-mode must be prompt-download-restart, manual-download, or silent-download-next-start');
}
if (requestedDeliveryMode === 'silent-download-next-start' && kind !== 'asar') {
  throw new Error('--delivery-mode silent-download-next-start is only supported for --kind asar');
}
const e2eResult = args.e2eResult || process.env.MX_RELEASE_E2E_RESULT || 'running';
if (releaseAccessToken && e2eResult !== 'running') {
  throw new Error('Scoped Publisher plans always start pending; use the gate endpoint or --approve with evidence after validation');
}
const storage = args.storage || process.env.MX_RELEASE_ARTIFACT_STORAGE || 'auto';
const artifactPlatform = normalizePlatform(args.platform || process.env.MX_RELEASE_PLATFORM || (kind === 'hot' ? 'all' : process.platform));
const artifactArch = normalizeArch(args.arch || process.env.MX_RELEASE_ARCH || (kind === 'hot' ? 'all' : process.arch));
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${randomBytes(4).toString('hex')}`;
const releaseId = args.releaseId || `${product}-${kind}-${version}-${runId}`;
const planRequestId = optionalArg(args.requestId || process.env.MX_RELEASE_REQUEST_ID)
  || `release-center-publish-${kind}-${runId}`;
const gateRequestId = optionalArg(args.gateRequestId || process.env.MX_RELEASE_GATE_REQUEST_ID)
  || `${planRequestId}-gate`;
const artifactKind = kind === 'hot' ? 'renderer-ui' : kind === 'asar' ? 'app-asar' : 'app-installer';
const artifactComponentId = kind === 'hot' ? args.componentId || `${product}-renderer` : product;
// Point-targeting (docs/19 §6.1): a one-user gray release is
// `--target-user usr_xxx`; repeat or comma-separate for more.
const targetUserIds = listArg(args.targetUser ?? args.targetUsers, []);
const targetInstallIds = listArg(args.targetInstall ?? args.targetInstalls, []);
const hasExplicitTargets = targetUserIds.length > 0 || targetInstallIds.length > 0;
const releaseNotes = optionalArg(args.notes ?? args.releaseNotes ?? process.env.MX_RELEASE_NOTES);
const approvalEvidencePath = optionalArg(
  args.approvalEvidence ?? process.env.MX_RELEASE_APPROVAL_EVIDENCE
);
const confirmFullRollout = boolArg(
  args.confirmFullRollout ?? process.env.MX_RELEASE_CONFIRM_FULL_ROLLOUT,
  false
);
const approvalEvidence = approveRelease
  ? await readApprovalEvidence(approvalEvidencePath)
  : null;

const artifactStat = await stat(artifactPath);
const digest = `sha256:${await sha256File(artifactPath)}`;
let artifactSizeBytes = artifactStat.size;
let uploadedArtifact = null;

// The scoped SDK publishing facade only accepts artifacts uploaded by the
// authenticated principal. Legacy Admin mode retains external artifact URLs.
if (releaseAccessToken || !artifactUrl || boolArg(args.uploadArtifact, false) || args.upload === 'internal') {
  uploadedArtifact = await uploadArtifact();
  artifactUrl = absoluteArtifactUrl(uploadedArtifact.artifact?.url || uploadedArtifact.artifact?.downloadPath);
  artifactSizeBytes = uploadedArtifact.artifact?.sizeBytes || artifactSizeBytes;
}

if (!artifactUrl) throw new Error('Missing --artifact-url and artifact upload did not return a URL');

const body = releaseAccessToken
  ? scopedReleaseBody(requiredResponseString(
      'artifact.artifactId',
      uploadedArtifact?.artifact?.artifactId
    ))
  : kind === 'hot'
    ? hotUpdateBody()
    : kind === 'asar'
      ? asarUpdateBody()
      : installerBody();
const createPath = releaseAccessToken
  ? '/internal/v1/sdk/releases'
  : '/internal/v1/release-management/plans';
const payload = await requestJson(createPath, {
  method: 'POST',
  body,
  accessToken: releaseAccessToken,
  internalOps: !releaseAccessToken
});
let plan = releasePlanFromPayload(payload);
let approval = null;
if (approveRelease) {
  const planId = requiredResponseString('plan.planId', plan?.planId);
  const gateVerdict = plan?.test?.gate?.verdict;
  const planHasTargets = Boolean(
    plan?.rollout?.audience?.userIds?.length
    || plan?.rollout?.audience?.installIds?.length
  );
  const planIsFullRollout = !planHasTargets
    && plan?.rollout?.strategy === 'all'
    && Number(plan?.rollout?.percentage) >= 100;
  if (planIsFullRollout && !confirmFullRollout) {
    throw new Error(
      '--approve on an all/100% plan requires --confirm-full-rollout after canary evidence review'
    );
  }
  if (confirmFullRollout && !planIsFullRollout) {
    throw new Error('--confirm-full-rollout is only valid for an all/100% plan without targets');
  }
  // TestGateVerdict has no "running" value. Until the E2E step completes, a
  // newly created plan evaluates to "blocked". Keep accepting "running" for
  // compatibility with older/mocked servers.
  if (gateVerdict && gateVerdict !== 'running' && gateVerdict !== 'blocked') {
    throw new Error(`--approve requires a pending release gate, got ${gateVerdict}`);
  }
  approval = await requestJson(`/internal/v1/sdk/releases/${encodeURIComponent(planId)}/gate`, {
    method: 'POST',
    body: {
      status: 'passed',
      message: optionalArg(args.approvalMessage || process.env.MX_RELEASE_APPROVAL_MESSAGE)
        || 'Approved by release-center-publish',
      evidence: {
        ...approvalEvidence,
        artifactId: uploadedArtifact?.artifact?.artifactId || null,
        artifactDigest: digest,
        targetUserIds,
        targetInstallIds,
        fullRolloutConfirmed: planIsFullRollout && confirmFullRollout
      },
      requestId: gateRequestId
    },
    accessToken: releaseAccessToken
  });
  plan = releasePlanFromPayload(approval) || plan;
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  authentication: authenticationMode,
  artifact: {
    path: artifactPath,
    url: artifactUrl,
    digest,
    sizeBytes: artifactSizeBytes,
    platform: artifactPlatform,
    arch: artifactArch,
    storage: uploadedArtifact?.artifact?.storage || (uploadedArtifact ? storage : 'external-url'),
    uploaded: Boolean(uploadedArtifact),
    uploadArtifactId: uploadedArtifact?.artifact?.artifactId || null
  },
  plan: {
    planId: plan?.planId,
    releaseId: plan?.releaseId,
    channel: plan?.channel,
    artifactKinds: plan?.artifacts?.map((artifact) => artifact.kind) || [],
    activation: plan?.activation,
    gate: plan?.test?.gate?.verdict,
    approved: Boolean(approval)
  }
}, null, 2));

function installerBody() {
  return {
    releaseId,
    channel,
    productId: product,
    appId: product,
    launcherComponentId: product,
    launcherUpdatePolicy: 'app-installer',
    launcherCurrentVersion: currentVersion,
    launcherTargetVersion: version,
    appUpdatePolicy: 'app-managed',
    appCurrentVersion: currentVersion,
    appTargetVersion: currentVersion,
    artifactKind: 'app-installer',
    artifactVersion: version,
    artifactUrl,
    artifactDigest: digest,
    artifactSizeBytes,
    artifactPlatform,
    artifactArch,
    artifactFileName: basename(artifactPath),
    activationMode: 'installer-manual',
    deliveryMode: 'prompt-download-restart',
    rolloutStrategy: args.rolloutStrategy || (hasExplicitTargets ? 'manual-ring' : 'all'),
    rolloutPercentage: numberArg(args.rolloutPercentage, hasExplicitTargets ? 0 : 100),
    rolloutRings: listArg(args.rolloutRings, ['internal-dogfood', 'stable']),
    targetUserIds,
    targetInstallIds,
    releaseNotes,
    suiteId: args.suiteId || `${product}-installer-release`,
    topology: args.topology || (isDefaultProduct ? 'h-d-i-installer-release' : `${product}-installer-release`),
    sites: listArg(args.sites, ['internal-main', 'domestic-main']),
    e2eResult,
    createdBy: args.createdBy || 'release-center-publish',
    requestId: planRequestId
  };
}

function hotUpdateBody() {
  return {
    releaseId,
    channel,
    productId: product,
    appId: product,
    launcherComponentId: artifactComponentId,
    launcherUpdatePolicy: 'renderer-ui',
    launcherCurrentVersion: currentVersion,
    launcherTargetVersion: version,
    appComponentId: `${product}-config`,
    appUpdatePolicy: 'config-snapshot',
    appCurrentVersion: currentVersion,
    appTargetVersion: version,
    artifactKind: 'renderer-ui',
    artifactVersion: version,
    artifactUrl,
    artifactDigest: digest,
    artifactSizeBytes,
    artifactPlatform,
    artifactArch,
    artifactFileName: basename(artifactPath),
    activationMode: 'hot-auto',
    deliveryMode: 'prompt-download-restart',
    rolloutStrategy: args.rolloutStrategy || 'gray',
    rolloutPercentage: numberArg(args.rolloutPercentage, 10),
    rolloutRings: listArg(args.rolloutRings, ['internal-dogfood', 'canary', 'stable']),
    featureKeys: listArg(args.featureKeys, [`${product}.release.hot-update`]),
    targetUserIds,
    targetInstallIds,
    releaseNotes,
    suiteId: args.suiteId || `${product}-hot-release`,
    topology: args.topology || (isDefaultProduct ? 'h-d-i-hot-release' : `${product}-hot-release`),
    sites: listArg(args.sites, ['internal-main', 'domestic-main']),
    e2eResult,
    createdBy: args.createdBy || 'release-center-publish',
    requestId: planRequestId
  };
}

function asarUpdateBody() {
  return {
    releaseId,
    channel,
    productId: product,
    appId: product,
    launcherComponentId: product,
    launcherUpdatePolicy: 'app-asar',
    launcherCurrentVersion: currentVersion,
    launcherTargetVersion: version,
    appComponentId: `${product}-config`,
    appUpdatePolicy: 'config-snapshot',
    appCurrentVersion: currentVersion,
    appTargetVersion: currentVersion,
    artifactKind: 'app-asar',
    artifactVersion: version,
    artifactUrl,
    artifactDigest: digest,
    artifactSizeBytes,
    artifactPlatform,
    artifactArch,
    artifactFileName: basename(artifactPath),
    activationMode: 'restart-auto',
    deliveryMode: requestedDeliveryMode,
    rolloutStrategy: args.rolloutStrategy || (hasExplicitTargets ? 'manual-ring' : 'gray'),
    rolloutPercentage: numberArg(args.rolloutPercentage, hasExplicitTargets ? 0 : 10),
    rolloutRings: listArg(args.rolloutRings, ['internal-dogfood', 'canary', 'stable']),
    featureKeys: listArg(args.featureKeys, [`${product}.release.asar-update`]),
    targetUserIds,
    targetInstallIds,
    releaseNotes,
    suiteId: args.suiteId || `${product}-asar-release`,
    topology: args.topology || (isDefaultProduct ? 'h-d-i-asar-release' : `${product}-asar-release`),
    sites: listArg(args.sites, ['internal-main', 'domestic-main']),
    e2eResult,
    createdBy: args.createdBy || 'release-center-publish',
    requestId: planRequestId
  };
}

function scopedReleaseBody(artifactId) {
  const stagedUpdate = kind === 'hot' || kind === 'asar';
  return {
    artifactId,
    currentVersion,
    channel,
    rolloutStrategy: args.rolloutStrategy || (stagedUpdate
      ? 'gray'
      : hasExplicitTargets
        ? 'manual-ring'
        : 'all'),
    rolloutPercentage: numberArg(
      args.rolloutPercentage,
      stagedUpdate ? 10 : hasExplicitTargets ? 0 : 100
    ),
    rolloutRings: listArg(
      args.rolloutRings,
      stagedUpdate ? ['internal-dogfood', 'canary', 'stable'] : ['internal-dogfood', 'stable']
    ),
    featureKeys: stagedUpdate
      ? listArg(args.featureKeys, [`${product}.release.${kind === 'asar' ? 'asar' : 'hot'}-update`])
      : [],
    targetUserIds,
    targetInstallIds,
    releaseNotes,
    deliveryMode: kind === 'asar' || requestedDeliveryMode === 'manual-download'
      ? requestedDeliveryMode
      : 'prompt-download-restart',
    suiteId: args.suiteId || `${product}-${kind}-release`,
    topology: args.topology || (isDefaultProduct
      ? `h-d-i-${kind}-release`
      : `${product}-${kind}-release`),
    sites: listArg(args.sites, ['internal-main', 'domestic-main']),
    requestId: planRequestId
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') continue;
    if (!item.startsWith('--')) continue;
    const [rawKey, inlineValue] = item.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const nextValue = argv[index + 1];
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (nextValue !== undefined && !nextValue.startsWith('--')) {
      parsed[key] = nextValue;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function requiredArg(name, value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing --${name}`);
}

function optionalArg(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function listArg(value, fallback) {
  if (!value) return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function numberArg(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function safeProductId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid --product: ${value}`);
  }
  return normalized;
}

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  if (normalized === 'mac' || normalized === 'macos' || normalized === 'darwin') return 'darwin';
  if (normalized === 'win' || normalized === 'windows' || normalized === 'win32') return 'win32';
  if (normalized === 'linux') return 'linux';
  return normalized;
}

function normalizeArch(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  if (normalized === 'amd64' || normalized === 'x86_64') return 'x64';
  if (normalized === 'aarch64') return 'arm64';
  if (normalized === 'x86') return 'ia32';
  if (normalized === 'universal2') return 'universal';
  return normalized;
}

async function resolveArtifactPath(value) {
  const candidates = isAbsolute(value)
    ? [value]
    : [
        resolve(process.cwd(), value),
        resolve(serverRoot, value),
        resolve(workspaceRoot, value)
      ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Artifact file not found: ${value}. Tried: ${candidates.join(', ')}`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

async function readApprovalEvidence(pathValue) {
  if (!pathValue) {
    throw new Error(
      '--approve requires --approval-evidence <json-file> (or MX_RELEASE_APPROVAL_EVIDENCE)'
    );
  }
  const path = await resolveArtifactPath(pathValue);
  let evidence;
  try {
    evidence = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`Approval evidence must be a readable JSON file: ${path}`);
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Approval evidence must be a JSON object');
  }
  for (const field of ['artifactDigestVerified', 'osSignatureVerified', 'installSmokePassed']) {
    if (evidence[field] !== true) {
      throw new Error(`Approval evidence requires ${field}=true`);
    }
  }
  return evidence;
}

async function uploadArtifact() {
  const params = new URLSearchParams({
    releaseId,
    productId: product,
    channel,
    kind: artifactKind,
    version,
    componentId: artifactComponentId,
    fileName: basename(artifactPath),
    digest,
    storage,
    ...(artifactPlatform ? { platform: artifactPlatform } : {}),
    ...(artifactArch ? { arch: artifactArch } : {})
  });
  const uploadPath = releaseAccessToken
    ? '/internal/v1/sdk/releases/artifacts'
    : '/internal/v1/release-artifacts';
  const response = await fetch(`${baseUrl}${uploadPath}?${params}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/octet-stream',
      ...bearerHeaders(releaseAccessToken),
      ...(!releaseAccessToken ? internalOpsHeaders() : {})
    },
    body: createReadStream(artifactPath),
    duplex: 'half'
  });
  const text = await response.text();
  const body = parseResponseJson(text, uploadPath);
  if (!response.ok) {
    throw new Error(requestFailureMessage('POST', uploadPath, response.status, body));
  }
  return body;
}

function absoluteArtifactUrl(value) {
  if (!value) return null;
  const text = String(value);
  if (/^https?:\/\//i.test(text)) return text;
  return `${baseUrl}${text.startsWith('/') ? text : `/${text}`}`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...bearerHeaders(options.accessToken),
      ...(options.internalOps ? internalOpsHeaders() : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = parseResponseJson(text, path);
  if (!response.ok) {
    throw new Error(requestFailureMessage(options.method || 'GET', path, response.status, body));
  }
  return body;
}

async function exchangeReleaseAccessToken(clientId, clientSecret) {
  const payload = await requestJson('/internal/v1/sdk/oauth/token', {
    method: 'POST',
    body: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: 'mx-sdk',
      scope: releaseScopes
    }
  });
  return requiredResponseString(
    'token.access_token',
    payload?.token?.access_token || payload?.access_token
  );
}

function bearerHeaders(accessToken) {
  return accessToken ? { authorization: `Bearer ${accessToken}` } : {};
}

function internalOpsHeaders() {
  return releaseOpsToken ? { 'x-mx-ops-token': releaseOpsToken } : {};
}

function releasePlanFromPayload(payload) {
  return payload?.release || payload?.plan || null;
}

function requiredResponseString(name, value) {
  const normalized = optionalArg(value);
  if (normalized) return normalized;
  throw new Error(`Release Center response is missing ${name}`);
}

function parseResponseJson(text, path) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} returned a non-JSON response`);
  }
}

function requestFailureMessage(method, path, status, body) {
  const rawMessage = Array.isArray(body?.message)
    ? body.message.join('; ')
    : typeof body?.message === 'string'
      ? body.message
      : null;
  const suffix = rawMessage ? `: ${redactCredentials(rawMessage)}` : '';
  return `${method} ${path} failed ${status}${suffix}`;
}

function redactCredentials(value) {
  let result = String(value);
  for (const credential of [releaseAccessToken, releaseClientSecret, releaseOpsToken]) {
    if (credential) result = result.split(credential).join('[redacted]');
  }
  return result;
}
