import { createHash } from 'node:crypto';

const baseUrl = (
  firstPositionalArg()
  || process.env.MX_RELEASE_SMOKE_BASE_URL
  || process.env.MX_SMOKE_BASE_URL
  || 'http://127.0.0.1:18090'
).replace(/\/+$/, '');

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const runId = `${stamp}_${Math.random().toString(16).slice(2, 8)}`;
const summary = {
  baseUrl,
  runId,
  artifacts: [],
  plans: [],
  decisions: []
};

await checkHealth();
await checkPolicy('renderer-ui', 'mx-h2i-renderer', 'automatic');
await checkPolicy('app-installer', 'mx-h2i', 'mandatory');
const uploadedInstallerArtifact = await uploadSmokeArtifact('darwin', 'arm64', 'dmg');
const uploadedWindowsArtifact = await uploadSmokeArtifact('win32', 'x64', 'exe');

const hotPlan = await createPlan({
  releaseId: `rel_smoke_hot_${runId}`,
  channel: 'smoke',
  productId: 'mx-h2i',
  appId: 'mx-h2i',
  launcherComponentId: 'mx-h2i-renderer',
  launcherUpdatePolicy: 'renderer-ui',
  launcherCurrentVersion: '0.1.0',
  launcherTargetVersion: '0.1.1',
  appComponentId: 'mx-h2i-config',
  appUpdatePolicy: 'config-snapshot',
  appCurrentVersion: '0.1.0',
  appTargetVersion: '0.1.1',
  artifactKind: 'renderer-ui',
  artifactVersion: '0.1.1',
  artifactUrl: `https://release.invalid/mx-h2i/${runId}/renderer-ui.zip`,
  artifactDigest: `sha256:smoke-hot-${runId}`,
  activationMode: 'hot-auto',
  rolloutStrategy: 'gray',
  rolloutPercentage: 10,
  rolloutRings: ['internal-dogfood', 'canary', 'stable'],
  featureKeys: ['mx-h2i.release.hot-update'],
  suiteId: 'mx-h2i-release-smoke',
  topology: 'h-d-i-release-smoke',
  sites: ['internal-main', 'domestic-main'],
  e2eResult: 'passed',
  createdBy: 'release-center-smoke',
  requestId: `release-center-smoke-hot-${runId}`
});

assertPlan(hotPlan, {
  releaseIdPrefix: 'rel_smoke_hot_',
  gate: 'passed',
  readyToPromote: true,
  artifactKind: 'renderer-ui',
  updateMode: 'automatic',
  hotUpdateAuto: true,
  majorUpdateRequiresInstaller: false,
  rolloutStrategy: 'gray'
});

const majorPlan = await createPlan({
  releaseId: `rel_smoke_major_${runId}`,
  channel: 'smoke',
  productId: 'mx-h2i',
  appId: 'mx-h2i',
  launcherComponentId: 'mx-h2i',
  launcherUpdatePolicy: 'app-installer',
  launcherCurrentVersion: '0.1.0',
  launcherTargetVersion: '0.2.0',
  appUpdatePolicy: 'app-managed',
  appCurrentVersion: '0.1.0',
  appTargetVersion: '0.1.0',
  artifactKind: 'app-installer',
  artifactVersion: '0.2.0',
  artifactUrl: absoluteUrl(uploadedInstallerArtifact.downloadPath),
  artifactDigest: uploadedInstallerArtifact.digest,
  artifactSizeBytes: uploadedInstallerArtifact.sizeBytes,
  artifactPlatform: 'darwin',
  artifactArch: 'arm64',
  artifactFileName: uploadedInstallerArtifact.fileName,
  activationMode: 'installer-manual',
  rolloutStrategy: 'all',
  rolloutPercentage: 100,
  rolloutRings: ['internal-dogfood', 'stable'],
  suiteId: 'mx-h2i-installer-smoke',
  topology: 'h-d-i-installer-smoke',
  sites: ['internal-main', 'domestic-main'],
  e2eResult: 'passed',
  createdBy: 'release-center-smoke',
  requestId: `release-center-smoke-major-${runId}`
});

assertPlan(majorPlan, {
  releaseIdPrefix: 'rel_smoke_major_',
  gate: 'passed',
  readyToPromote: true,
  artifactKind: 'app-installer',
  updateMode: 'mandatory',
  hotUpdateAuto: false,
  majorUpdateRequiresInstaller: true,
  rolloutStrategy: 'all',
  sizeBytes: uploadedInstallerArtifact.sizeBytes,
  platform: 'darwin',
  arch: 'arm64',
  fileName: uploadedInstallerArtifact.fileName
});

const windowsPlan = await createPlan({
  releaseId: `rel_smoke_windows_${runId}`,
  channel: 'smoke',
  productId: 'mx-h2i',
  appId: 'mx-h2i',
  launcherComponentId: 'mx-h2i',
  launcherUpdatePolicy: 'app-installer',
  launcherCurrentVersion: '0.1.0',
  launcherTargetVersion: '0.2.0',
  appUpdatePolicy: 'app-managed',
  appCurrentVersion: '0.1.0',
  appTargetVersion: '0.1.0',
  artifactKind: 'app-installer',
  artifactVersion: '0.2.0',
  artifactUrl: absoluteUrl(uploadedWindowsArtifact.downloadPath),
  artifactDigest: uploadedWindowsArtifact.digest,
  artifactSizeBytes: uploadedWindowsArtifact.sizeBytes,
  artifactPlatform: 'win32',
  artifactArch: 'x64',
  artifactFileName: uploadedWindowsArtifact.fileName,
  activationMode: 'installer-manual',
  rolloutStrategy: 'all',
  rolloutPercentage: 100,
  rolloutRings: ['internal-dogfood', 'stable'],
  suiteId: 'mx-h2i-installer-smoke',
  topology: 'h-d-i-installer-smoke',
  sites: ['internal-main', 'domestic-main'],
  e2eResult: 'passed',
  createdBy: 'release-center-smoke',
  requestId: `release-center-smoke-windows-${runId}`
});

assertPlan(windowsPlan, {
  releaseIdPrefix: 'rel_smoke_windows_',
  gate: 'passed',
  readyToPromote: true,
  artifactKind: 'app-installer',
  updateMode: 'mandatory',
  hotUpdateAuto: false,
  majorUpdateRequiresInstaller: true,
  rolloutStrategy: 'all',
  sizeBytes: uploadedWindowsArtifact.sizeBytes,
  platform: 'win32',
  arch: 'x64',
  fileName: uploadedWindowsArtifact.fileName
});

await checkReleaseDecision('darwin', 'arm64', majorPlan.releaseId, 'dmg');
await checkReleaseDecision('win32', 'x64', windowsPlan.releaseId, 'exe');
await checkReleaseIsCurrentVersionSafe();
await checkReleaseHistory('darwin', 'arm64', majorPlan.releaseId);
await checkListIncludes(hotPlan.planId, majorPlan.planId, windowsPlan.planId);

console.log(JSON.stringify({
  ok: true,
  ...summary
}, null, 2));

function firstPositionalArg() {
  return process.argv.slice(2).find((arg) => arg && arg !== '--' && !arg.startsWith('--'));
}

async function checkHealth() {
  const body = await requestJson('/healthz');
  assert(body?.ok === true, 'healthz did not return ok=true');
}

async function checkPolicy(componentKind, componentId, expectedMode) {
  const body = await requestJson('/internal/v1/releases/policy/evaluate', {
    method: 'POST',
    body: {
      componentKind,
      componentId,
      currentVersion: '0.1.0',
      targetVersion: '0.1.1',
      channel: 'smoke',
      installId: `release-smoke-install-${runId}`,
      userId: 'usr_release_smoke'
    }
  });
  const decision = body?.decision;
  assert(decision?.componentKind === componentKind, `${componentKind} decision kind mismatch`);
  assert(decision?.updateAvailable === true, `${componentKind} should have updateAvailable=true`);
  assert(decision?.updateMode === expectedMode, `${componentKind} updateMode expected ${expectedMode}, got ${decision?.updateMode}`);
  summary.decisions.push({
    componentKind,
    componentId,
    updateMode: decision.updateMode,
    requiresGate: decision.requiresGate
  });
}

async function createPlan(body) {
  const payload = await requestJson('/internal/v1/release-management/plans', {
    method: 'POST',
    body
  });
  assert(payload?.plan?.planId, `create plan ${body.releaseId} did not return planId`);
  summary.plans.push({
    planId: payload.plan.planId,
    releaseId: payload.plan.releaseId,
    channel: payload.plan.channel
  });
  return payload.plan;
}

function assertPlan(plan, expected) {
  assert(plan.releaseId?.startsWith(expected.releaseIdPrefix), `releaseId prefix mismatch: ${plan.releaseId}`);
  assert(plan.test?.gate?.verdict === expected.gate, `${plan.releaseId} gate expected ${expected.gate}`);
  assert(plan.decisions?.readyToPromote === expected.readyToPromote, `${plan.releaseId} readyToPromote mismatch`);
  assert(plan.components?.launcher?.updateMode === expected.updateMode, `${plan.releaseId} launcher updateMode mismatch`);
  assert(plan.artifacts?.some((artifact) => artifact.kind === expected.artifactKind), `${plan.releaseId} missing artifact kind ${expected.artifactKind}`);
  if (expected.sizeBytes !== undefined) {
    assert(plan.artifacts?.some((artifact) => artifact.sizeBytes === expected.sizeBytes), `${plan.releaseId} missing artifact size ${expected.sizeBytes}`);
  }
  if (expected.platform !== undefined) {
    assert(plan.artifacts?.some((artifact) => artifact.platform === expected.platform), `${plan.releaseId} missing artifact platform ${expected.platform}`);
  }
  if (expected.arch !== undefined) {
    assert(plan.artifacts?.some((artifact) => artifact.arch === expected.arch), `${plan.releaseId} missing artifact arch ${expected.arch}`);
  }
  if (expected.fileName !== undefined) {
    assert(plan.artifacts?.some((artifact) => artifact.fileName === expected.fileName), `${plan.releaseId} missing artifact fileName ${expected.fileName}`);
  }
  assert(plan.activation?.hotUpdateAuto === expected.hotUpdateAuto, `${plan.releaseId} hotUpdateAuto mismatch`);
  assert(plan.activation?.majorUpdateRequiresInstaller === expected.majorUpdateRequiresInstaller, `${plan.releaseId} major installer flag mismatch`);
  assert(plan.activation?.connectionSafeMode === true, `${plan.releaseId} must keep connectionSafeMode=true`);
  assert(plan.rollout?.strategy === expected.rolloutStrategy, `${plan.releaseId} rollout strategy mismatch`);
}

async function uploadSmokeArtifact(platform, arch, extension) {
  const body = Buffer.from(`mx-h2i ${platform}/${arch} release smoke artifact ${runId}\n`, 'utf8');
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const params = new URLSearchParams({
    releaseId: `rel_smoke_major_${runId}`,
    productId: 'mx-h2i',
    channel: 'smoke',
    kind: 'app-installer',
    version: '0.2.0',
    componentId: 'mx-h2i',
    fileName: `MX-H2I-0.2.0-${platform}-${arch}-${runId}.${extension}`,
    digest,
    platform,
    arch
  });
  const payload = await requestJson(`/internal/v1/release-artifacts?${params}`, {
    method: 'POST',
    body,
    raw: true
  });
  const artifact = payload?.artifact;
  assert(artifact?.downloadPath, 'artifact upload did not return downloadPath');
  assert(artifact.downloadPath.endsWith(`/${encodeURIComponent(artifact.fileName)}`), 'artifact downloadPath must preserve the installer file name');
  assert(artifact?.digest === digest, `artifact upload digest mismatch: ${artifact?.digest}`);
  const downloaded = await fetch(absoluteUrl(artifact.downloadPath));
  const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
  assert(downloaded.ok, `artifact download failed ${downloaded.status}`);
  assert(downloadedBytes.equals(body), 'artifact download content mismatch');
  summary.artifacts.push({
    artifactId: artifact.artifactId,
    downloadPath: artifact.downloadPath,
    digest: artifact.digest,
    sizeBytes: artifact.sizeBytes,
    platform: artifact.platform,
    arch: artifact.arch,
    fileName: artifact.fileName
  });
  return artifact;
}

async function checkReleaseDecision(platform, arch, releaseId, extension) {
  const payload = await requestJson('/internal/v1/release/check', {
    method: 'POST',
    body: {
      installId: `release-smoke-${platform}-${arch}-${runId}`,
      channel: 'smoke',
      platform,
      arch,
      components: { 'mx-h2i': '0.1.0' }
    }
  });
  assert(payload.status === 'update-available', `${platform}/${arch} release should be update-available`);
  assert(payload.releaseId === releaseId, `${platform}/${arch} selected ${payload.releaseId}, expected ${releaseId}`);
  assert(payload.artifacts?.length === 1, `${platform}/${arch} should receive exactly one artifact`);
  const artifact = payload.artifacts[0];
  assert(artifact.platform === platform, `${platform}/${arch} artifact platform mismatch`);
  assert(artifact.arch === arch, `${platform}/${arch} artifact arch mismatch`);
  assert(artifact.fileName?.endsWith(`.${extension}`), `${platform}/${arch} artifact extension mismatch`);
  assert(artifact.url?.endsWith(`/${encodeURIComponent(artifact.fileName)}`), `${platform}/${arch} artifact URL lost the installer file name`);
}

async function checkReleaseIsCurrentVersionSafe() {
  const payload = await requestJson('/internal/v1/release/check', {
    method: 'POST',
    body: {
      installId: `release-smoke-newer-${runId}`,
      channel: 'smoke',
      platform: 'darwin',
      arch: 'arm64',
      components: { 'mx-h2i': '0.3.0' }
    }
  });
  assert(payload.status === 'up-to-date', 'a newer client must not be downgraded to an older release');
}

async function checkReleaseHistory(platform, arch, releaseId) {
  const params = new URLSearchParams({
    componentId: 'mx-h2i',
    channel: 'smoke',
    platform,
    arch
  });
  const payload = await requestJson(`/internal/v1/releases/history?${params}`);
  const releases = Array.isArray(payload?.releases) ? payload.releases : [];
  assert(releases.some((release) => release.releaseId === releaseId), 'release history missing platform release');
  assert(releases.every((release) => release.version && release.artifactKind && release.status !== 'unknown'), 'release history contains incomplete rows');
  assert(releases.every((release) => release.artifactId && release.artifactUrl && release.artifactDigest && release.fileName), 'release history is missing rollback artifact metadata');
  assert(releases.every((release) => release.artifactUrl.endsWith(`/${encodeURIComponent(release.fileName)}`)), 'release history artifact URL lost the installer file name');
  assert(releases.every((release) => !release.platform || release.platform === platform), 'release history leaked another platform');
  assert(releases.every((release) => !release.arch || release.arch === 'universal' || release.arch === arch), 'release history leaked another architecture');
}

async function checkListIncludes(...planIds) {
  const payload = await requestJson('/internal/v1/release-management/plans');
  const listedIds = new Set(Array.isArray(payload?.plans) ? payload.plans.map((plan) => plan.planId) : []);
  for (const planId of planIds) {
    assert(listedIds.has(planId), `listReleaseManagementPlans did not include ${planId}`);
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': options.raw ? 'application/octet-stream' : 'application/json' } : undefined,
    body: options.body ? options.raw ? options.body : JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${options.method || 'GET'} ${path} returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function absoluteUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
