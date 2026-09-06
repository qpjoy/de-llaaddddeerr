import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createElectronLauncherReleaseUpdateExecutor } from '../dist/release-update-executor.js';
import {
  createElectronLauncherReleaseUpdater,
  downloadElectronLauncherReleaseArtifactToFile
} from '../dist/release-updater.js';

test('package identity resolution rebinds only platform-owned downloads to the current Internal origin', async () => {
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
      const payload = releaseCheckPayload(
        'http://10.88.88.88:18090/internal/v1/release-artifacts/artifact_other/download/app.zip?token=old#file'
      );
      payload.artifacts.push({
        ...artifactRef('https://cdn.example.test/releases/app.zip', null, null),
        artifactId: 'artifact_cdn'
      });
      payload.artifacts.push({
        ...artifactRef('http://10.88.88.88:18090/internal/v1/release-artifacts/artifact_metadata', null, null),
        artifactId: 'artifact_metadata'
      });
      return jsonResponse(payload);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://10.88.100.3:18090',
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
  assert.equal(result.deliveryMode, 'silent-download-next-start');
  assert.equal(
    result.artifacts[0].url,
    'http://10.88.100.3:18090/internal/v1/release-artifacts/artifact_other/download/app.zip?token=old#file'
  );
  assert.equal(result.artifacts[1].url, 'https://cdn.example.test/releases/app.zip');
  assert.equal(
    result.artifacts[2].url,
    'http://10.88.88.88:18090/internal/v1/release-artifacts/artifact_metadata'
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

test('release check falls back only for an absent endpoint, never for server failures', async () => {
  let legacyRequests = 0;
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://release-center.internal',
    productId: 'luopan',
    channel: 'stable',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/internal/v1/release/check')) {
        return jsonResponse({ message: 'temporary failure' }, 500);
      }
      legacyRequests += 1;
      throw new Error(`legacy flow must not run: ${url}`);
    }
  });

  await assert.rejects(
    updater.check({
      componentId: 'luopan',
      componentKind: 'app-installer',
      currentVersion: '1.0.0',
      installId: 'install_luopan'
    }),
    /Release Center request failed: 500/
  );
  assert.equal(legacyRequests, 0);
});

test('release check uses the legacy flow for a 404 endpoint', async () => {
  const requests = [];
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://old-release-center.internal',
    productId: 'luopan',
    channel: 'stable',
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/internal/v1/release/check')) {
        return jsonResponse({ message: 'not found' }, 404);
      }
      if (String(url).endsWith('/internal/v1/release-management/plans')) {
        return jsonResponse({ plans: [] });
      }
      if (String(url).endsWith('/internal/v1/releases/policy/evaluate')) {
        return jsonResponse({
          decision: policyDecision({
            componentId: 'luopan',
            componentKind: 'app-installer',
            currentVersion: '1.0.0',
            targetVersion: '1.0.0',
            updateAvailable: false
          })
        });
      }
      throw new Error(`unexpected request ${url}`);
    }
  });

  const result = await updater.check({
    componentId: 'luopan',
    componentKind: 'app-installer',
    currentVersion: '1.0.0',
    installId: 'install_luopan'
  });
  assert.equal(result.checkSource, 'plans-legacy');
  assert.ok(requests.some((url) => url.endsWith('/internal/v1/release-management/plans')));
});

test('release check forwards AbortSignal and does not downgrade cancellation', async () => {
  const controller = new AbortController();
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://release-center.internal',
    productId: 'luopan',
    channel: 'stable',
    fetchImpl: async (_url, init = {}) => new Promise((_resolve, reject) => {
      assert.equal(init.signal, controller.signal);
      init.signal.addEventListener('abort', () => {
        const error = new Error('check cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })
  });
  const pending = updater.check({
    componentId: 'luopan',
    componentKind: 'app-installer',
    currentVersion: '1.0.0',
    installId: 'install_luopan',
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
});

test('package resolution cancellation aborts an abandoned resolver and allows an immediate retry', async () => {
  let resolverRequests = 0;
  let firstResolverSignal = null;
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://release-center.internal',
    packageName: 'compass',
    channel: 'stable',
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('/releases/products/resolve?')) {
        resolverRequests += 1;
        if (resolverRequests === 1) {
          firstResolverSignal = init.signal;
          return new Promise((_resolve, reject) => {
            const rejectCancelled = () => {
              const error = new Error('resolver cancelled');
              error.name = 'AbortError';
              reject(error);
            };
            if (init.signal?.aborted) rejectCancelled();
            else init.signal?.addEventListener('abort', rejectCancelled, { once: true });
          });
        }
        return jsonResponse({ identity: releaseProductIdentity() });
      }
      if (String(url).endsWith('/internal/v1/release/check')) {
        return jsonResponse(releaseCheckPayload(null, 'other-desktop'));
      }
      throw new Error(`unexpected request ${url}`);
    }
  });
  const controller = new AbortController();
  const firstCheck = updater.check({
    componentKind: 'app-installer',
    currentVersion: '1.0.0',
    installId: 'install_other',
    signal: controller.signal
  });
  assert.ok(firstResolverSignal instanceof AbortSignal);
  controller.abort('cancel slow resolver');
  await assert.rejects(firstCheck, (error) => error?.name === 'AbortError');
  assert.equal(firstResolverSignal.aborted, true);

  const retried = await updater.check({
    componentKind: 'app-installer',
    currentVersion: '1.0.0',
    installId: 'install_other'
  });
  assert.equal(retried.status, 'up-to-date');
  assert.equal(resolverRequests, 2);
});

test('one resolver caller abort does not poison another caller sharing the pending request', async () => {
  let resolverRequests = 0;
  let resolverSignal = null;
  let resolveRequest;
  const updater = createElectronLauncherReleaseUpdater({
    baseUrl: 'http://release-center.internal',
    packageName: 'compass',
    fetchImpl: async (url, init = {}) => {
      assert.match(String(url), /\/releases\/products\/resolve\?/);
      resolverRequests += 1;
      resolverSignal = init.signal;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    }
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = updater.resolveProduct({ signal: firstController.signal });
  const second = updater.resolveProduct({ signal: secondController.signal });
  assert.equal(resolverRequests, 1);
  firstController.abort('only first caller cancelled');
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(resolverSignal.aborted, false);
  resolveRequest(jsonResponse({ identity: releaseProductIdentity() }));
  assert.equal((await second).productId, 'other-desktop');
  assert.equal(resolverRequests, 1);
});

test('direct downloader resolves relative URLs, reports progress, and safely replaces an existing target', async () => {
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
    await writeFile(targetPath, 'stale-artifact');
    const progress = [];
    await downloadElectronLauncherReleaseArtifactToFile({
      artifact: artifactRef('/artifact.bin', digest, payload.length),
      targetPath,
      baseUrl: `http://127.0.0.1:${address.port}`,
      onProgress: (event) => progress.push(event)
    });
    assert.deepEqual(await readFile(targetPath), payload);
    assert.equal(progress[0].phase, 'downloading');
    assert.equal(progress.at(-1).phase, 'verifying');
    assert.equal(progress.at(-1).bytesReceived, payload.length);
    assert.equal(progress.at(-1).totalBytes, payload.length);
    assert.equal(progress.at(-1).percent, 100);

    await writeFile(targetPath, 'another-stale-artifact');
    await downloadElectronLauncherReleaseArtifactToFile({
      artifact: artifactRef('/artifact.bin', digest, payload.length),
      targetPath,
      baseUrl: `http://127.0.0.1:${address.port}`
    });
    assert.deepEqual(await readFile(targetPath), payload);
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.includes('.download-') || entry.includes('.previous-')),
      []
    );
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

test('download cancellation removes its unique temporary file and preserves an existing target', async () => {
  const payload = Buffer.alloc(256 * 1024, 7);
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  const timers = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length)
    });
    response.write(payload.subarray(0, 1024));
    const timer = setTimeout(() => response.end(payload.subarray(1024)), 500);
    timers.add(timer);
    response.on('close', () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-cancel-'));
  const targetPath = join(directory, 'artifact.bin');
  const previous = Buffer.from('verified-previous-artifact');
  await writeFile(targetPath, previous);
  const controller = new AbortController();
  try {
    await assert.rejects(
      downloadElectronLauncherReleaseArtifactToFile({
        artifact: artifactRef(`http://127.0.0.1:${address.port}/slow.bin`, digest, payload.length),
        targetPath,
        signal: controller.signal,
        onProgress: (event) => {
          if (event.bytesReceived > 0) controller.abort(new Error('user cancelled update'));
        }
      }),
      (error) => error?.name === 'AbortError' && /user cancelled update/.test(error.message)
    );
    assert.deepEqual(await readFile(targetPath), previous);
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.includes('.download-')),
      []
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('download timeout aborts a stalled body and cleans up', async () => {
  const timers = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '4' });
    response.flushHeaders();
    const timer = setTimeout(() => response.end('late'), 500);
    timers.add(timer);
    response.on('close', () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-timeout-'));
  try {
    await assert.rejects(
      downloadElectronLauncherReleaseArtifactToFile({
        artifact: artifactRef(`http://127.0.0.1:${address.port}/stalled.bin`, null, 4),
        targetPath: join(directory, 'stalled.bin'),
        timeoutMs: 50
      }),
      /timed out after 50ms/
    );
    assert.deepEqual(
      (await readdir(directory)).filter((entry) => entry.includes('.download-')),
      []
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('renderer activation failure preserves the current pointer and removes the failed active file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-slot-'));
  const slotDir = join(directory, 'update-slots', 'renderer');
  const currentPath = join(slotDir, 'active-1.0.0-existing.js');
  const stagedPath = join(directory, 'renderer-2.0.0.js');
  const current = { version: '1.0.0', path: currentPath, activatedAt: 'earlier' };
  await mkdir(slotDir, { recursive: true });
  await writeFile(currentPath, 'existing');
  await writeFile(stagedPath, 'candidate');
  await writeFile(join(slotDir, 'current.json'), JSON.stringify(current));
  const applied = [];
  const executor = createElectronLauncherReleaseUpdateExecutor({
    updater: noopUpdater(),
    baseDir: directory,
    applyRenderer: async (path) => {
      applied.push(path);
      if (path !== currentPath) throw new Error('renderer rejected candidate');
    }
  });
  const artifact = {
    ...artifactRef(null, null, null, 'other-desktop-renderer'),
    artifactId: 'artifact_renderer_2',
    version: '2.0.0',
    fileName: 'renderer-2.0.0.js'
  };
  try {
    await assert.rejects(
      executor.activateStaged(artifact, stagedPath, { releaseId: 'release_2' }),
      /renderer rejected candidate/
    );
    assert.deepEqual(JSON.parse(await readFile(join(slotDir, 'current.json'), 'utf8')), current);
    assert.equal(applied.length, 2);
    assert.equal(applied[1], currentPath);
    assert.deepEqual(
      (await readdir(slotDir)).filter((entry) => entry.startsWith('active-2.0.0-')),
      []
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rollback applies the previous slot before swapping pointers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-rollback-'));
  const slotDir = join(directory, 'update-slots', 'renderer');
  const current = { version: '2.0.0', path: join(slotDir, 'current.js'), activatedAt: 'now' };
  const previous = { version: '1.0.0', path: join(slotDir, 'previous.js'), activatedAt: 'earlier' };
  await mkdir(slotDir, { recursive: true });
  await writeFile(current.path, 'current');
  await writeFile(previous.path, 'previous');
  await writeFile(join(slotDir, 'current.json'), JSON.stringify(current));
  await writeFile(join(slotDir, 'previous.json'), JSON.stringify(previous));
  const executor = createElectronLauncherReleaseUpdateExecutor({
    updater: noopUpdater(),
    baseDir: directory,
    applyRenderer: async () => {
      throw new Error('previous renderer rejected');
    }
  });
  try {
    await assert.rejects(executor.rollback('renderer'), /previous renderer rejected/);
    assert.deepEqual(JSON.parse(await readFile(join(slotDir, 'current.json'), 'utf8')), current);
    assert.deepEqual(JSON.parse(await readFile(join(slotDir, 'previous.json'), 'utf8')), previous);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('installer opening rejects ambiguous legacy matches and accepts an exact release with a relative URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-installer-'));
  const fileName = 'Compass Setup.exe';
  const firstPath = join(directory, 'updates', 'release_1', fileName);
  const secondPath = join(directory, 'updates', 'release_2', fileName);
  const outsidePath = join(directory, fileName);
  await mkdir(join(directory, 'updates', 'release_1'), { recursive: true });
  await mkdir(join(directory, 'updates', 'release_2'), { recursive: true });
  await writeFile(firstPath, 'first');
  await writeFile(secondPath, 'second');
  await writeFile(outsidePath, 'outside');
  const opened = [];
  const executor = createElectronLauncherReleaseUpdateExecutor({
    updater: noopUpdater(),
    baseDir: directory,
    openInstaller: async (path) => opened.push(path)
  });
  const artifact = {
    ...artifactRef(
      '/internal/v1/release-artifacts/artifact_compass/download/Compass%20Setup.exe',
      null,
      null,
      'luopan'
    ),
    artifactId: 'artifact_compass',
    fileName: null
  };
  try {
    await assert.rejects(
      executor.openStagedInstaller(artifact),
      /ambiguous across releases/
    );
    await assert.rejects(
      executor.openStagedInstaller(artifact, { stagedPath: outsidePath }),
      /must stay inside/
    );
    await assert.rejects(
      executor.openStagedInstaller(artifact, { releaseId: 'release_2', stagedPath: firstPath }),
      /does not match the requested releaseId/
    );
    assert.equal(await executor.openStagedInstaller(artifact, { releaseId: 'release_2' }), secondPath);
    assert.deepEqual(opened, [secondPath]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('executor reports activation failures accurately and is not successful when every artifact fails', async () => {
  const payload = Buffer.from('renderer-candidate');
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': String(payload.length) });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-executor-'));
  const reports = [];
  const phases = [];
  const progress = [];
  const artifact = {
    ...artifactRef(
      `http://127.0.0.1:${address.port}/renderer.js`,
      digest,
      payload.length,
      'other-desktop-renderer'
    ),
    artifactId: 'artifact_renderer_failure',
    version: '2.0.0',
    fileName: 'renderer.js',
    autoApply: true
  };
  const executor = createElectronLauncherReleaseUpdateExecutor({
    updater: noopUpdater(reports),
    baseDir: directory,
    onPhase: (phase) => phases.push(phase),
    applyRenderer: async () => {
      throw new Error('cannot activate renderer');
    }
  });
  try {
    const result = await executor.execute(
      updateCheck(artifact, `http://127.0.0.1:${address.port}`),
      { onProgress: (event) => progress.push(event) }
    );
    assert.equal(result.executed, false);
    assert.equal(result.artifacts[0].phase, 'failed');
    assert.match(result.artifacts[0].error, /cannot activate renderer/);
    assert.ok(reports.some((report) => report.status === 'artifact-activation-failed'));
    assert.deepEqual(phases, ['checking', 'downloading', 'verifying', 'staged', 'activating', 'failed']);
    assert.equal(progress.at(-1).phase, 'verifying');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('executor forwards cancellation and progress without staging or activating the artifact', async () => {
  const payload = Buffer.alloc(128 * 1024, 3);
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  let timer;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': String(payload.length) });
    response.write(payload.subarray(0, 1024));
    timer = setTimeout(() => response.end(payload.subarray(1024)), 500);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  const directory = await mkdtemp(join(tmpdir(), 'mx-release-executor-cancel-'));
  const reports = [];
  const phases = [];
  const controller = new AbortController();
  const artifact = {
    ...artifactRef(
      `http://127.0.0.1:${address.port}/Compass.exe`,
      digest,
      payload.length,
      'luopan'
    ),
    artifactId: 'artifact_cancelled',
    fileName: 'Compass.exe'
  };
  const executor = createElectronLauncherReleaseUpdateExecutor({
    updater: noopUpdater(reports),
    baseDir: directory,
    onPhase: (phase) => phases.push(phase),
    openInstaller: async () => {
      throw new Error('cancelled installer must not open');
    }
  });
  try {
    const result = await executor.execute(
      updateCheck(artifact, `http://127.0.0.1:${address.port}`),
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.bytesReceived > 0) controller.abort(new Error('cancel from UI'));
        }
      }
    );
    assert.equal(result.executed, false);
    assert.match(result.reason, /cancel from UI/);
    assert.equal(result.artifacts[0].phase, 'cancelled');
    assert.ok(reports.some((report) => report.status === 'download-cancelled'));
    assert.equal(phases.at(-1), 'cancelled');
    assert.equal(await readFile(join(directory, 'updates', 'release_test', 'Compass.exe')).then(() => true).catch(() => false), false);
  } finally {
    clearTimeout(timer);
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

function releaseProductIdentity() {
  return {
    appId: 'other-desktop',
    productId: 'other-desktop',
    packageName: 'compass',
    launcherMode: 'standalone',
    networkProductId: 'other-desktop',
    componentId: 'other-desktop',
    rendererComponentId: 'other-desktop-renderer',
    channel: 'stable',
    channels: ['stable']
  };
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
    deliveryMode: 'silent-download-next-start',
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

function policyDecision(overrides = {}) {
  return {
    componentKind: 'renderer-ui',
    componentId: 'other-desktop-renderer',
    currentVersion: '1.0.0',
    targetVersion: '2.0.0',
    updateAvailable: true,
    updateMode: 'automatic',
    canSkip: true,
    canDefer: true,
    requiresGate: false,
    rollbackRequired: false,
    reason: 'test update',
    ...overrides
  };
}

function updateCheck(artifact, baseUrl) {
  const decision = policyDecision({
    componentKind: artifact.kind,
    componentId: artifact.componentId,
    targetVersion: artifact.version
  });
  return {
    checkedAt: new Date().toISOString(),
    baseUrl,
    status: 'update-available',
    plan: {
      planId: 'plan_test',
      releaseId: 'release_test',
      environment: 'internal',
      channel: 'stable',
      installId: 'install_test',
      userId: null,
      createdBy: 'test',
      components: { app: decision },
      artifacts: [artifact],
      createdAt: new Date().toISOString()
    },
    decision,
    artifacts: [artifact],
    reason: 'test update'
  };
}

function noopUpdater(reports = []) {
  return {
    resolveProduct: async () => {
      throw new Error('not used');
    },
    check: async () => {
      throw new Error('not used');
    },
    report: async (report) => {
      reports.push(report);
      return { ok: true };
    }
  };
}
