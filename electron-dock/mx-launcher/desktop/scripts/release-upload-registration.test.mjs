import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const renderer = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
function source(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(renderer);
  assert.ok(match, `${name} must exist`);
  const tail = renderer.slice(match.index);
  const next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}

const functions = [
  'uploadReleaseArtifactFromAdmin', 'releaseUploadInputFromForm', 'releasePlanBodyFromUpload',
  'releasePlanIncludesUploadedArtifact', 'releasePlanHasSameVersionArtifact', 'releaseDecisionList',
  'releasePlanArtifacts', 'releasePlanStatus', 'releasePlanIsWithdrawn', 'releaseDeliveryLabel',
  'releaseCenterPlans', 'commaList', 'absoluteReleaseArtifactUrl', 'cleanLauncherProductId'
];

function fixture(transform = plan => plan) {
  const uploaded = { artifactId: 'stored-dmg', url: '/release-artifacts/stored-dmg/download', digest: 'sha256:original', sizeBytes: 12345, fileName: 'MinCave-3.0.0.dmg', storage: 'oss' };
  const previous = { planId: 'previous-plan', releaseId: 'previous-release', artifacts: [] };
  const state = { dashboard: { latestReleasePlans: [previous] }, releaseCenter: { busy: false, drawer: { mode: 'upload' } } };
  const f = { state, uploads: [], requests: [], returned: null, previous, uploaded };
  const dependencies = {
    state,
    normalizedServerBase: () => 'https://launcher.example',
    releaseUploadProductError: () => '',
    releaseProductCurrentVersion: () => '3.0.0',
    uploadReleaseArtifactFile: async (input, file) => { f.uploads.push({ input, file }); return { artifact: uploaded }; },
    fetchJson: async (path, options) => {
      f.requests.push({ path, ...options });
      const body = options.body;
      f.returned = transform({
        planId: 'created-plan', releaseId: body.releaseId, channel: body.channel, productId: body.productId,
        components: { launcher: { componentId: body.launcherComponentId, componentKind: body.launcherUpdatePolicy, currentVersion: body.launcherCurrentVersion, targetVersion: body.launcherTargetVersion, updateAvailable: false } },
        artifacts: [{ artifactId: 'plan-generated-id', componentId: body.launcherComponentId, kind: body.artifactKind, version: body.artifactVersion, url: body.artifactUrl, digest: body.artifactDigest, fileName: body.artifactFileName, sizeBytes: body.artifactSizeBytes }],
        activation: { majorUpdateRequiresInstaller: true }, decisions: { readyToPromote: false }, test: { gate: { verdict: 'passed' } },
        releaseNotes: body.releaseNotes, rollout: { strategy: body.rolloutStrategy, percentage: body.rolloutPercentage }
      });
      return { plan: f.returned };
    },
    renderFoundationGrid() {}, renderReleaseCenterDrawer() {}, renderInspector() {}
  };
  f.api = Function(...Object.keys(dependencies), `
    const asArray = value => Array.isArray(value) ? value : [];
    ${functions.map(source).join('\n')}
    return { ${functions.join(', ')} };
  `)(...Object.values(dependencies));
  f.form = { elements: Object.fromEntries(Object.entries({
    productId: 'mx-h2i', kind: 'installer', platform: 'darwin', arch: 'universal', currentVersion: '3.0.0', version: '3.0.0', channel: 'stable', storage: 'oss', e2eResult: 'passed', rolloutStrategy: 'all', rolloutPercentage: '100', releaseNotes: 'Same-version installer'
  }).map(([key, value]) => [key, { value, setCustomValidity() {} }])) };
  f.form.elements.artifactFile = { files: [{ name: uploaded.fileName, type: 'application/octet-stream' }] };
  return f;
}

test('same-version upload sends real artifact metadata, preserves the server plan, and reports registration', async () => {
  const f = fixture();
  await f.api.uploadReleaseArtifactFromAdmin(f.form);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/internal/v1/release-management/plans');
  assert.equal(f.requests[0].body.launcherCurrentVersion, '3.0.0');
  assert.equal(f.requests[0].body.launcherTargetVersion, '3.0.0');
  assert.equal(f.requests[0].body.artifactDigest, f.uploaded.digest);
  assert.equal(f.requests[0].body.artifactUrl, 'https://launcher.example/release-artifacts/stored-dmg/download');
  assert.strictEqual(f.state.dashboard.latestReleasePlans[0], f.returned);
  assert.strictEqual(f.state.dashboard.latestReleasePlans[1], f.previous);
  assert.equal(f.state.releaseCenter.feedback.kind, 'success');
  assert.match(f.state.releaseCenter.feedback.message, /同版本已登记，不触发自动更新/);
  assert.equal(f.api.releasePlanStatus(f.returned), 'registered');
  assert.equal(f.api.releaseDeliveryLabel(f.returned), 'full installer');
  assert.deepEqual(f.api.releasePlanArtifacts(f.returned), f.returned.artifacts);
  assert.equal(f.returned.components.launcher.updateAvailable, false);
  assert.equal(f.returned.decisions.readyToPromote, false);
});

test('missing or mismatched real artifacts cannot report successful publication; returned plan remains reviewable', async () => {
  for (const transform of [
    plan => ({ ...plan, artifacts: [] }),
    ...['kind', 'version', 'digest', 'url'].map(field => plan => ({ ...plan, artifacts: [{ ...plan.artifacts[0], [field]: 'wrong' }] }))
  ]) {
    const f = fixture(transform);
    await f.api.uploadReleaseArtifactFromAdmin(f.form);
    assert.equal(f.state.releaseCenter.feedback.kind, 'error');
    assert.match(f.state.releaseCenter.feedback.message, /文件已上传，但发布记录未关联制品/);
    assert.match(f.state.releaseCenter.feedback.message, /更新 Internal 后重新创建/);
    assert.strictEqual(f.state.dashboard.latestReleasePlans[0], f.returned);
    assert.equal(f.state.releaseCenter.drawer.planId, f.returned.planId);
    assert.equal(f.state.releaseCenter.busy, false);
    assert.equal(f.requests.length, 1, 'do not silently retry or create duplicate release plans');
  }
});
