import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createElectronLauncherReleaseUpdater,
  downloadElectronLauncherReleaseArtifactToFile
} from '../dist/release-updater.js';

test('package identity resolution drives release check and makes artifact URLs absolute', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('/releases/products/resolve?')) {
      return jsonResponse({
        identity: {
          appId: 'other-desktop',
          productId: 'other-desktop',
          packageName: '@example/other-desktop',
          launcherMode: 'embed',
          networkProductId: 'mx-h2i',
          componentId: 'other-desktop',
          rendererComponentId: 'other-desktop-renderer',
          channel: 'stable',
          channels: ['beta', 'stable']
        }
      });
    }
    if (String(url).endsWith('/internal/v1/release/check')) {
      const body = JSON.parse(init.body);
      assert.equal(body.productId, 'other-desktop');
      assert.deepEqual(body.components, { 'other-desktop-renderer': '1.0.0' });
      assert.deepEqual(body.artifactKinds, ['renderer-ui']);
      assert.equal(body.channel, 'stable');
      return jsonResponse(releaseCheckPayload('/internal/v1/release-artifacts/artifact_other/download/app.zip'));
    }
    throw new Error(`unexpected request ${url}`);
  };
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://10.88.88.88:18090',
    packageName: '@example/other-desktop',
    channel: 'stable',
    fetchImpl
  });

  const result = await updater.check({
    componentKind: 'renderer-ui',
    currentVersion: '1.0.0',
    installId: 'install_other',
    platform: 'darwin',
    arch: 'arm64'
  });

  assert.equal(result.decision.componentId, 'other-desktop-renderer');
  assert.equal(
    result.artifacts[0].url,
    'http://10.88.88.88:18090/internal/v1/release-artifacts/artifact_other/download/app.zip'
  );
  assert.equal(requests.filter((request) => request.url.includes('/products/resolve?')).length, 1);
});

test('legacy product fallback is explicit and only handles servers without the resolver', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/releases/products/resolve?')) {
      return jsonResponse({ message: 'not found' }, 404);
    }
    if (String(url).endsWith('/internal/v1/release/check')) {
      const body = JSON.parse(init.body);
      assert.equal(body.productId, 'luopan');
      assert.deepEqual(body.components, { luopan: '0.1.0' });
      assert.deepEqual(body.artifactKinds, ['app-installer']);
      return jsonResponse(releaseCheckPayload(null, 'luopan'));
    }
    throw new Error(`unexpected request ${url}`);
  };
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://old-release-center.internal',
    packageName: '@qpjoy/luopan-demo',
    channel: 'shadow',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    fetchImpl
  });

  const result = await updater.check({
    componentKind: 'app-installer',
    currentVersion: '0.1.0',
    installId: 'install_luopan'
  });
  assert.equal(result.status, 'up-to-date');
  assert.equal((await updater.resolveProduct()).productId, 'luopan');
});

test('direct downloader resolves relative URLs only with an explicit baseUrl', async () => {
  const payload = Buffer.from('release-artifact');
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  const server = createServer((request, response) => {
    if (request.url === '/artifact.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length)
      });
      response.end(payload);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-updater-'));
  const targetPath = join(directory, 'artifact.bin');
  try {
    await downloadElectronLauncherReleaseArtifactToFile({
      artifact: artifactRef('/artifact.bin', digest, payload.length),
      targetPath,
      baseUrl: `http://127.0.0.1:${address.port}`
    });
    assert.deepEqual(await readFile(targetPath), payload);
    await assert.rejects(
      downloadElectronLauncherReleaseArtifactToFile({
        artifact: artifactRef('/artifact.bin', digest, payload.length),
        targetPath: join(directory, 'missing-base.bin')
      }),
      /requires baseUrl/
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function releaseCheckPayload(url, componentId = 'other-desktop-renderer') {
  return {
    status: 'up-to-date',
    reason: 'already current',
    planId: null,
    releaseId: null,
    channel: componentId === 'luopan' ? 'shadow' : 'stable',
    decision: {
      componentKind: componentId.endsWith('-renderer') ? 'renderer-ui' : 'app-installer',
      componentId,
      currentVersion: componentId === 'luopan' ? '0.1.0' : '1.0.0',
      targetVersion: componentId === 'luopan' ? '0.1.0' : '1.0.0',
      updateAvailable: false,
      updateMode: 'none',
      canSkip: true,
      canDefer: true,
      requiresGate: false,
      rollbackRequired: false,
      reason: 'already current'
    },
    artifacts: url ? [artifactRef(url, null, null, componentId)] : [],
    activation: null,
    releaseNotes: null,
    featureFlags: [],
    rollout: { matchedBy: null, bucket: null, percentage: null },
    signedAt: '2026-07-30T00:00:00.000Z',
    signature: { algorithm: 'hmac-sha256', keyId: 'test', value: 'test' }
  };
}

function artifactRef(url, digest, sizeBytes, componentId = 'other-desktop-renderer') {
  return {
    artifactId: 'artifact_other',
    kind: componentId.endsWith('-renderer') ? 'renderer-ui' : 'app-installer',
    componentId,
    version: '1.0.0',
    source: 'test',
    url,
    digest,
    signature: null,
    sizeBytes,
    platform: 'darwin',
    arch: 'arm64',
    fileName: 'artifact.bin',
    activation: componentId.endsWith('-renderer') ? 'hot-auto' : 'installer-manual',
    autoApply: componentId.endsWith('-renderer'),
    restartRequired: false,
    requiredAppRestart: false,
    notes: []
  };
}
