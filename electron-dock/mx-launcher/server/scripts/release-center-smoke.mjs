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
  plans: [],
  decisions: []
};

await checkHealth();
await checkPolicy('renderer-ui', 'mx-h2i-renderer', 'automatic');
await checkPolicy('mx-h2i-installer', 'mx-h2i', 'mandatory');

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
  launcherUpdatePolicy: 'mx-h2i-installer',
  launcherCurrentVersion: '0.1.0',
  launcherTargetVersion: '0.2.0',
  appUpdatePolicy: 'app-managed',
  appCurrentVersion: '0.1.0',
  appTargetVersion: '0.1.0',
  artifactKind: 'mx-h2i-installer',
  artifactVersion: '0.2.0',
  artifactUrl: `https://release.invalid/mx-h2i/${runId}/MX-H2I-0.2.0.dmg`,
  artifactDigest: `sha256:smoke-major-${runId}`,
  activationMode: 'installer-manual',
  rolloutStrategy: 'manual-ring',
  rolloutPercentage: 0,
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
  artifactKind: 'mx-h2i-installer',
  updateMode: 'mandatory',
  hotUpdateAuto: false,
  majorUpdateRequiresInstaller: true,
  rolloutStrategy: 'manual-ring'
});

await checkListIncludes(hotPlan.planId, majorPlan.planId);

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
  assert(plan.activation?.hotUpdateAuto === expected.hotUpdateAuto, `${plan.releaseId} hotUpdateAuto mismatch`);
  assert(plan.activation?.majorUpdateRequiresInstaller === expected.majorUpdateRequiresInstaller, `${plan.releaseId} major installer flag mismatch`);
  assert(plan.activation?.connectionSafeMode === true, `${plan.releaseId} must keep connectionSafeMode=true`);
  assert(plan.rollout?.strategy === expected.rolloutStrategy, `${plan.releaseId} rollout strategy mismatch`);
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
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
