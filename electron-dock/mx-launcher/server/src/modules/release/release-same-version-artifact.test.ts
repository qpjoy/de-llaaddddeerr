import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { ReleaseManagementPlanInput } from '../../types.js';
import { evaluateReleaseCheck } from './release-check.js';
import { ReleaseController } from './release.controller.js';

const sameVersionInput: ReleaseManagementPlanInput = {
  releaseId: 'mx-h2i-installer-same-version', productId: 'mx-h2i', appId: 'mx-h2i', channel: 'stable',
  launcherComponentId: 'mx-h2i', launcherUpdatePolicy: 'app-installer',
  launcherCurrentVersion: '3.0.0', launcherTargetVersion: '3.0.0',
  appUpdatePolicy: 'app-managed', appCurrentVersion: '3.0.0', appTargetVersion: '3.0.0',
  activationMode: 'installer-manual', rolloutStrategy: 'all', rolloutPercentage: 100, e2eResult: 'passed'
};
const checkInput = (version = '3.0.0') => ({
  installId: 'same-version-install', productId: 'mx-h2i', channel: 'stable', platform: 'darwin', arch: 'arm64',
  components: { 'mx-h2i': version }
});

test('uploaded same-version installer retains its downloadable artifact without becoming an automatic update', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-same-version-'));
  const previous = { storeDir: process.env.MX_RELEASE_ARTIFACT_STORE_DIR, opsToken: process.env.MX_INTERNAL_OPS_TOKEN,
    publicBase: process.env.MX_PUBLIC_BASE_URL };
  process.env.MX_RELEASE_ARTIFACT_STORE_DIR = directory;
  process.env.MX_INTERNAL_OPS_TOKEN = 'same-version-test-ops';
  process.env.MX_PUBLIC_BASE_URL = '';
  t.after(async () => {
    for (const [key, value] of [['MX_RELEASE_ARTIFACT_STORE_DIR', previous.storeDir], ['MX_INTERNAL_OPS_TOKEN', previous.opsToken], ['MX_PUBLIC_BASE_URL', previous.publicBase]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const store = new MemoryStore({ ...loadConfig(), environment: 'same-version-artifact-test' });
  const controller = new ReleaseController(store);
  const bytes = Buffer.from('MX-H2I same-version installer bytes\n');
  const req = Readable.from([bytes]) as IncomingMessage;
  req.headers = { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'x-mx-ops-token': process.env.MX_INTERNAL_OPS_TOKEN };
  const { artifact } = await controller.uploadArtifact(req, {
    releaseId: sameVersionInput.releaseId, productId: 'mx-h2i', componentId: 'mx-h2i', channel: 'stable',
    kind: 'app-installer', version: '3.0.0', platform: 'darwin', arch: 'universal', storage: 'server',
    fileName: 'MinCave-3.0.0-mac-universal.dmg'
  });
  const { plan } = await controller.createManagementPlan(req, {
    ...sameVersionInput,
    artifactKind: artifact.kind, artifactVersion: artifact.version, artifactUrl: artifact.url,
    artifactDigest: artifact.digest, artifactSignature: artifact.signature, artifactSizeBytes: artifact.sizeBytes,
    artifactPlatform: artifact.platform, artifactArch: artifact.arch, artifactFileName: artifact.fileName
  });
  assert.equal(plan.artifacts.length, 1, 'the uploaded installer survives; a no-op app does not acquire an invented artifact');
  const saved = plan.artifacts[0];
  assert.deepEqual({ kind: saved.kind, componentId: saved.componentId, version: saved.version, url: saved.url,
    digest: saved.digest, sizeBytes: saved.sizeBytes, platform: saved.platform, arch: saved.arch, fileName: saved.fileName }, {
    kind: 'app-installer', componentId: 'mx-h2i', version: '3.0.0', url: artifact.url,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, sizeBytes: bytes.length,
    platform: 'darwin', arch: 'universal', fileName: 'MinCave-3.0.0-mac-universal.dmg'
  });
  assert.equal(saved.activation, 'installer-manual');
  assert.equal(saved.autoApply, false);
  assert.equal(plan.activation.majorUpdateRequiresInstaller, true);
  assert.equal(plan.activation.manualConfirmRequired, true);
  assert.equal(plan.activation.connectionSafeMode, true);
  assert.equal(plan.components.launcher.updateAvailable, false);
  assert.equal(plan.components.app.updateAvailable, false);
  assert.equal(plan.decisions.readyToPromote, false);
  assert.equal(evaluateReleaseCheck([plan], checkInput()).status, 'up-to-date');
  assert.equal(evaluateReleaseCheck([plan], checkInput('2.9.0')).status, 'up-to-date', 'a deliberately no-op plan stays no-op for older clients');

  const historyQuery = { componentId: 'mx-h2i', channel: 'stable', platform: 'darwin', arch: 'arm64' };
  const history = await controller.releaseHistory(historyQuery);
  assert.equal(history.releases.length, 1);
  assert.equal(history.releases[0].artifactUrl, artifact.url);
  assert.equal(history.releases[0].artifactDigest, artifact.digest);
  const responseHeaders = new Map<string, unknown>();
  const response = { setHeader: (name: string, value: unknown) => { responseHeaders.set(name, value); } } as unknown as ServerResponse;
  const download = await controller.downloadArtifact(artifact.artifactId, response);
  assert.ok(download);
  const downloaded: Buffer[] = [];
  for await (const chunk of download.getStream()) downloaded.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(downloaded), bytes, 'the registered history URL resolves to the actual uploaded bytes');
  assert.equal(responseHeaders.get('X-MX-Artifact-Digest'), artifact.digest);

  const { plan: withdrawn } = await controller.updateManagementPlan(req, plan.planId, { withdrawn: true });
  assert.deepEqual(withdrawn.artifacts, plan.artifacts);
  assert.equal((await controller.releaseHistory(historyQuery)).releases.length, 0);
  assert.equal(evaluateReleaseCheck([withdrawn], checkInput()).status, 'up-to-date');
});

test('ordinary no-op plans do not manufacture artifacts and higher-version installers still update normally', () => {
  const store = new MemoryStore({ ...loadConfig(), environment: 'same-version-domain-test' });
  for (const partialArtifact of [{}, { artifactKind: 'app-installer' }, { artifactUrl: '/uploaded.dmg' }]) {
    const plan = store.createReleaseManagementPlan({ ...sameVersionInput, ...partialArtifact });
    assert.deepEqual(plan.artifacts, []);
  }
  const normal = store.createReleaseManagementPlan({ ...sameVersionInput, launcherCurrentVersion: '2.9.0',
    artifactKind: 'app-installer', artifactVersion: '3.0.0', artifactUrl: '/uploaded.dmg',
    artifactDigest: `sha256:${'a'.repeat(64)}`, artifactPlatform: 'darwin', artifactArch: 'universal' });
  assert.equal(normal.artifacts.length, 1);
  assert.equal(normal.artifacts[0].activation, 'installer-manual');
  assert.equal(normal.decisions.readyToPromote, true);
  assert.equal(evaluateReleaseCheck([normal], checkInput('2.9.0')).status, 'update-available');
  assert.equal(evaluateReleaseCheck([normal], checkInput('3.0.0')).status, 'up-to-date');
  const withdrawn = store.updateReleaseManagementPlan(normal.planId, { withdrawn: true, updatedBy: 'test-admin' });
  assert.equal(evaluateReleaseCheck([withdrawn], checkInput('2.9.0')).status, 'up-to-date');
});
