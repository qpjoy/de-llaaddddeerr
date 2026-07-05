import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '../../..');
const baseUrl = requiredArg('base-url', args.baseUrl || process.env.MX_RELEASE_BASE_URL || process.env.MX_SMOKE_BASE_URL)
  .replace(/\/+$/, '');
const artifactPathInput = requiredArg('artifact', args.artifact || process.env.MX_RELEASE_ARTIFACT);
const artifactPath = await resolveArtifactPath(artifactPathInput);
let artifactUrl = optionalArg(args.artifactUrl || process.env.MX_RELEASE_ARTIFACT_URL);
const version = requiredArg('version', args.version || process.env.MX_RELEASE_VERSION);
const channel = args.channel || process.env.MX_RELEASE_CHANNEL || 'stable';
const currentVersion = args.currentVersion || process.env.MX_RELEASE_CURRENT_VERSION || '0.1.0';
const kind = args.kind || process.env.MX_RELEASE_KIND || 'installer';
const e2eResult = args.e2eResult || process.env.MX_RELEASE_E2E_RESULT || 'running';
const storage = args.storage || process.env.MX_RELEASE_ARTIFACT_STORAGE || 'auto';
const artifactPlatform = normalizePlatform(args.platform || process.env.MX_RELEASE_PLATFORM || (kind === 'hot' ? 'all' : process.platform));
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const releaseId = args.releaseId || (kind === 'hot'
  ? `mx-h2i-hot-${version}-${runId}`
  : `mx-h2i-installer-${version}-${runId}`);
const artifactKind = kind === 'hot' ? 'renderer-ui' : 'mx-h2i-installer';
const artifactComponentId = kind === 'hot' ? args.componentId || 'mx-h2i-renderer' : 'mx-h2i';

const artifactStat = await stat(artifactPath);
const digest = `sha256:${await sha256File(artifactPath)}`;
let artifactSizeBytes = artifactStat.size;
let uploadedArtifact = null;

if (!artifactUrl || boolArg(args.uploadArtifact, false) || args.upload === 'internal') {
  uploadedArtifact = await uploadArtifact();
  artifactUrl = absoluteArtifactUrl(uploadedArtifact.artifact?.downloadPath || uploadedArtifact.artifact?.url);
  artifactSizeBytes = uploadedArtifact.artifact?.sizeBytes || artifactSizeBytes;
}

if (!artifactUrl) throw new Error('Missing --artifact-url and artifact upload did not return a URL');

const body = kind === 'hot' ? hotUpdateBody() : installerBody();
const payload = await requestJson('/internal/v1/release-management/plans', {
  method: 'POST',
  body
});

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  artifact: {
    path: artifactPath,
    url: artifactUrl,
    digest,
    sizeBytes: artifactSizeBytes,
    platform: artifactPlatform,
    storage: uploadedArtifact?.artifact?.storage || (uploadedArtifact ? storage : 'external-url'),
    uploaded: Boolean(uploadedArtifact),
    uploadArtifactId: uploadedArtifact?.artifact?.artifactId || null
  },
  plan: {
    planId: payload.plan?.planId,
    releaseId: payload.plan?.releaseId,
    channel: payload.plan?.channel,
    artifactKinds: payload.plan?.artifacts?.map((artifact) => artifact.kind) || [],
    activation: payload.plan?.activation,
    gate: payload.plan?.test?.gate?.verdict
  }
}, null, 2));

function installerBody() {
  return {
    releaseId,
    channel,
    productId: 'mx-h2i',
    appId: 'mx-h2i',
    launcherComponentId: 'mx-h2i',
    launcherUpdatePolicy: 'mx-h2i-installer',
    launcherCurrentVersion: currentVersion,
    launcherTargetVersion: version,
    appUpdatePolicy: 'app-managed',
    appCurrentVersion: currentVersion,
    appTargetVersion: currentVersion,
    artifactKind: 'mx-h2i-installer',
    artifactVersion: version,
    artifactUrl,
    artifactDigest: digest,
    artifactSizeBytes,
    artifactPlatform,
    activationMode: 'installer-manual',
    rolloutStrategy: args.rolloutStrategy || 'manual-ring',
    rolloutPercentage: numberArg(args.rolloutPercentage, 0),
    rolloutRings: listArg(args.rolloutRings, ['internal-dogfood', 'stable']),
    suiteId: args.suiteId || 'mx-h2i-installer-release',
    topology: args.topology || 'h-d-i-installer-release',
    sites: listArg(args.sites, ['internal-main', 'domestic-main']),
    e2eResult,
    createdBy: args.createdBy || 'release-center-publish',
    requestId: `release-center-publish-installer-${runId}`
  };
}

function hotUpdateBody() {
  return {
    releaseId,
    channel,
    productId: 'mx-h2i',
    appId: 'mx-h2i',
    launcherComponentId: artifactComponentId,
    launcherUpdatePolicy: 'renderer-ui',
    launcherCurrentVersion: currentVersion,
    launcherTargetVersion: version,
    appComponentId: 'mx-h2i-config',
    appUpdatePolicy: 'config-snapshot',
    appCurrentVersion: currentVersion,
    appTargetVersion: version,
    artifactKind: 'renderer-ui',
    artifactVersion: version,
    artifactUrl,
    artifactDigest: digest,
    artifactSizeBytes,
    artifactPlatform,
    activationMode: 'hot-auto',
    rolloutStrategy: args.rolloutStrategy || 'gray',
    rolloutPercentage: numberArg(args.rolloutPercentage, 10),
    rolloutRings: listArg(args.rolloutRings, ['internal-dogfood', 'canary', 'stable']),
    featureKeys: listArg(args.featureKeys, ['mx-h2i.release.hot-update']),
    suiteId: args.suiteId || 'mx-h2i-hot-release',
    topology: args.topology || 'h-d-i-hot-release',
    sites: listArg(args.sites, ['internal-main', 'domestic-main']),
    e2eResult,
    createdBy: args.createdBy || 'release-center-publish',
    requestId: `release-center-publish-hot-${runId}`
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
    parsed[key] = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
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

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  if (normalized === 'mac' || normalized === 'macos' || normalized === 'darwin') return 'darwin';
  if (normalized === 'win' || normalized === 'windows' || normalized === 'win32') return 'win32';
  if (normalized === 'linux') return 'linux';
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

async function uploadArtifact() {
  const params = new URLSearchParams({
    releaseId,
    kind: artifactKind,
    version,
    componentId: artifactComponentId,
    fileName: basename(artifactPath),
    digest,
    storage,
    ...(artifactPlatform ? { platform: artifactPlatform } : {})
  });
  const response = await fetch(`${baseUrl}/internal/v1/release-artifacts?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: createReadStream(artifactPath),
    duplex: 'half'
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`POST /internal/v1/release-artifacts failed ${response.status}: ${JSON.stringify(body)}`);
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
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
