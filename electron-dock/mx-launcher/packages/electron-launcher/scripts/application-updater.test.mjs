import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createElectronLauncherApplicationUpdater } from '../dist/application-updater.js';

test('silent ASAR delivery checks once per network identity and stages without restarting', async () => {
  const artifactBody = Buffer.from('compass-asar-update');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass-2.0.3.asar', artifactBody),
      'app-installer': null
    },
    deliveryMode: 'silent-download-next-start'
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-asar-'));
  const actions = [];
  const states = [];
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({
      baseUrl: fixture.baseUrl,
      installId: 'install_luopan',
      userId: 'user_luopan'
    }),
    onState: (state) => states.push(state),
    onProgress: (progress) => {
      assert.throws(() => {
        progress.bytesReceived = -1;
      }, TypeError);
    },
    relaunch: () => actions.push('relaunch'),
    exit: () => actions.push('exit')
  });
  try {
    const [state, duplicateState] = await Promise.all([
      updater.handleNetworkReady(),
      updater.handleNetworkReady()
    ]);
    assert.equal(state.phase, 'ready');
    assert.equal(duplicateState.phase, 'ready');
    assert.equal(state.artifactClass, 'asar');
    assert.equal(state.staged, true);
    assert.deepEqual(actions, []);
    const pointer = JSON.parse(await readFile(join(baseDir, 'launcher-packages', 'luopan.pending.json'), 'utf8'));
    assert.equal(pointer.version, '2.0.3');
    assert.deepEqual(await readFile(pointer.path), artifactBody);
    const checksAfterFirstRun = fixture.checkRequests.length;
    assert.equal(checksAfterFirstRun, 2);
    assert.equal((await updater.handleNetworkReady()).phase, 'ready');
    assert.equal(fixture.checkRequests.length, checksAfterFirstRun);
    assert.ok(states.some((item) => item.phase === 'downloading'));
    assert.ok(states.some((item) => item.phase === 'verifying'));
    assert.equal(states.at(-1).percent, 100);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('installer fallback preserves product hooks and opens only the exact staged release', async () => {
  const artifactBody = Buffer.from('windows-installer');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': null,
      'app-installer': releaseArtifact('app-installer', '2.0.3', 'Compass-2.0.3.exe', artifactBody)
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-installer-'));
  const actions = [];
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    platform: 'win32',
    arch: 'x64',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_windows', userId: null }),
    openInstaller: async (filePath) => {
      actions.push(`open:${filePath}`);
      assert.deepEqual(await readFile(filePath), artifactBody);
    },
    beforeInstallCleanup: () => actions.push('cleanup'),
    exit: (code) => actions.push(`exit:${code}`)
  });
  try {
    const available = await updater.check();
    assert.equal(available.phase, 'available');
    assert.equal(available.artifactClass, 'installer');
    const ready = await updater.download();
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.artifactKind, 'app-installer');
    const installed = await updater.install();
    assert.equal(installed.reason, 'installer opened');
    assert.match(actions[0], /^open:/);
    assert.deepEqual(actions.slice(1), ['cleanup', 'exit:0']);
    assert.ok(actions[0].includes(join('updates', 'release_app-installer', 'Compass-2.0.3.exe')));
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('cancel interrupts a download and never activates, opens, restarts, or exits', async () => {
  const artifactBody = Buffer.alloc(256 * 1024, 9);
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass-2.0.3.asar', artifactBody),
      'app-installer': null
    },
    slowArtifact: true
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-cancel-'));
  const actions = [];
  let updater;
  let cancelled = false;
  updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_cancel', userId: null }),
    beforeActivate: () => actions.push('activate'),
    openInstaller: () => actions.push('open'),
    relaunch: () => actions.push('relaunch'),
    exit: () => actions.push('exit'),
    onProgress: (progress) => {
      if (!cancelled && progress.bytesReceived > 0) {
        cancelled = true;
        updater.cancel('cancel from product UI');
      }
    }
  });
  try {
    assert.equal((await updater.check()).phase, 'available');
    const state = await updater.download();
    assert.equal(state.phase, 'cancelled');
    assert.match(state.reason, /cancel from product UI/);
    assert.deepEqual(actions, []);
    const updateDir = join(baseDir, 'updates', 'release_app-asar');
    assert.deepEqual(
      await readdir(updateDir).catch(() => []),
      []
    );
    await assert.rejects(readFile(join(baseDir, 'launcher-packages', 'luopan.pending.json')));
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('cancel aborts a slow package resolver and an immediate check retry is not queued behind it', async () => {
  const artifactBody = Buffer.from('resolver-retry-update');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass-resolver-retry.asar', artifactBody),
      'app-installer': null
    },
    slowResolverOnce: true,
    slowResolverDelayMs: 5_000
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-resolver-cancel-'));
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_resolver_retry', userId: null })
  });
  try {
    const firstCheck = updater.check();
    await waitFor(() => fixture.resolverRequests.length === 1);
    assert.equal(updater.cancel('cancel slow product resolution').phase, 'cancelled');
    const retriedCheck = updater.check();
    const [cancelled, retried] = await within(
      Promise.all([firstCheck, retriedCheck]),
      1_000,
      'cancelled resolver kept the application update workflow blocked'
    );
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(retried.phase, 'available');
    assert.equal(fixture.resolverRequests.length, 2);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('portable and development distributions fail closed before reading network context', async () => {
  let contextReads = 0;
  const updater = createElectronLauncherApplicationUpdater({
    baseDir: join(tmpdir(), 'unused-application-updater'),
    packageName: 'compass',
    currentVersion: '2.0.2',
    distribution: 'portable',
    getContext: () => {
      contextReads += 1;
      return null;
    }
  });
  const state = await updater.check();
  assert.equal(state.phase, 'unsupported');
  assert.equal(contextReads, 0);
});

test('a product selector cannot inject an artifact outside the server decision', async () => {
  const body = Buffer.from('candidate');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass.asar', body),
      'app-installer': null
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-selector-'));
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_selector', userId: null }),
    selectArtifact: ([candidate]) => ({
      ...candidate,
      artifact: { ...candidate.artifact, url: 'https://attacker.invalid/update.asar' }
    })
  });
  try {
    const state = await updater.check();
    assert.equal(state.phase, 'error');
    assert.match(state.error, /must return one of the supplied candidates/);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('check and download are serialized into one immutable release decision', async () => {
  const artifactBody = Buffer.from('serialized-asar-update');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass-serialized.asar', artifactBody),
      'app-installer': null
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-serialized-'));
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_serialized', userId: null })
  });
  try {
    const checkPromise = updater.check();
    const downloadPromise = updater.download();
    assert.equal((await checkPromise).phase, 'available');
    assert.equal((await downloadPromise).phase, 'ready');
    assert.equal(fixture.checkRequests.length, 2);
    assert.equal(fixture.artifactRequests.length, 1);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('a changed network identity requires a fresh check before download', async () => {
  const artifactBody = Buffer.from('context-bound-update');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass-context.asar', artifactBody),
      'app-installer': null
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-context-'));
  let installId = 'install_a';
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId, userId: 'user_a' })
  });
  try {
    assert.equal((await updater.check()).phase, 'available');
    installId = 'install_b';
    const result = await updater.download();
    assert.equal(result.phase, 'error');
    assert.match(result.error, /context changed; check again/);
    assert.equal(fixture.artifactRequests.length, 0);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('the application controller rejects artifacts without an anchored digest and size', async () => {
  const artifactBody = Buffer.from('unanchored-update');
  const artifact = releaseArtifact('app-asar', '2.0.3', 'Compass-unanchored.asar', artifactBody);
  artifact.digest = null;
  artifact.sizeBytes = null;
  const fixture = await startReleaseCenter({
    artifacts: { 'app-asar': artifact, 'app-installer': null }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-integrity-'));
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_integrity', userId: null })
  });
  try {
    const result = await updater.check();
    assert.equal(result.phase, 'error');
    assert.match(result.error, /requires a SHA-256 digest/);
    assert.equal(fixture.artifactRequests.length, 0);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('network gate blocks installer hooks before OS handoff', async () => {
  const artifactBody = Buffer.from('gated-installer');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': null,
      'app-installer': releaseArtifact('app-installer', '2.0.3', 'Compass-gated.exe', artifactBody)
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-gate-'));
  const actions = [];
  let gate = 'idle';
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    platform: 'win32',
    arch: 'x64',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_gate', userId: null }),
    networkGate: () => gate,
    openInstaller: () => actions.push('open'),
    beforeInstallCleanup: () => actions.push('cleanup'),
    exit: () => actions.push('exit')
  });
  try {
    assert.equal((await updater.download()).phase, 'ready');
    gate = 'recovering';
    const result = await updater.install();
    assert.equal(result.phase, 'error');
    assert.match(result.error, /network state is recovering/);
    assert.deepEqual(actions, []);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('public state and selector candidates cannot mutate the private decision', async () => {
  const artifactBody = Buffer.from('immutable-decision');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass-immutable.asar', artifactBody),
      'app-installer': null
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-immutable-'));
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_immutable', userId: null }),
    selectArtifact: ([candidate]) => {
      assert.throws(() => {
        candidate.artifact.url = 'https://attacker.invalid/update.asar';
      }, TypeError);
      return candidate;
    }
  });
  try {
    const result = await updater.check();
    assert.equal(result.phase, 'available');
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.selectedArtifact), true);
    const originalUrl = result.selectedArtifact.url;
    assert.throws(() => {
      result.selectedArtifact.url = 'https://attacker.invalid/from-state.asar';
    }, TypeError);
    assert.equal(updater.getState().selectedArtifact.url, originalUrl);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('installer handoff is idempotent and cannot be cancelled after it succeeds', async () => {
  const artifactBody = Buffer.from('one-installer-handoff');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': null,
      'app-installer': releaseArtifact('app-installer', '2.0.3', 'Compass-once.exe', artifactBody)
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-once-'));
  const actions = [];
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    platform: 'win32',
    arch: 'x64',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_once', userId: null }),
    openInstaller: () => actions.push('open'),
    beforeInstallCleanup: () => actions.push('cleanup'),
    exit: () => actions.push('exit')
  });
  try {
    assert.equal((await updater.download()).phase, 'ready');
    assert.equal((await updater.install()).reason, 'installer opened');
    assert.equal((await updater.install()).reason, 'installation handoff already started; duplicate install was ignored');
    const postHandoffCancel = updater.cancel('cancel after installer opened');
    assert.equal(postHandoffCancel.phase, 'installing');
    assert.match(postHandoffCancel.reason, /cannot undo/);
    assert.deepEqual(actions, ['open', 'cleanup', 'exit']);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('a failed installer opener remains retryable and commits only after a successful handoff', async () => {
  const artifactBody = Buffer.from('retry-installer-handoff');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': null,
      'app-installer': releaseArtifact('app-installer', '2.0.3', 'Compass-retry.exe', artifactBody)
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-retry-open-'));
  const actions = [];
  let openAttempts = 0;
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    platform: 'win32',
    arch: 'x64',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_retry_open', userId: null }),
    openInstaller: () => {
      openAttempts += 1;
      actions.push(`open:${openAttempts}`);
      if (openAttempts === 1) throw new Error('simulated shell.openPath failure');
    },
    beforeInstallCleanup: () => actions.push('cleanup'),
    exit: () => actions.push('exit')
  });
  try {
    assert.equal((await updater.download()).phase, 'ready');
    const failed = await updater.install();
    assert.equal(failed.phase, 'error');
    assert.match(failed.error, /shell\.openPath failure/);
    assert.deepEqual(actions, ['open:1']);

    const retried = await updater.install();
    assert.equal(retried.reason, 'installer opened');
    assert.deepEqual(actions, ['open:1', 'open:2', 'cleanup', 'exit']);
    assert.equal((await updater.install()).reason, 'installation handoff already started; duplicate install was ignored');
    const cancelled = updater.cancel('too late after retry');
    assert.equal(cancelled.phase, 'installing');
    assert.match(cancelled.reason, /cannot undo/);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('multi-component checks fail fast by default and allow explicit migration best-effort', async () => {
  const artifactBody = Buffer.from('best-effort-installer');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': null,
      'app-installer': releaseArtifact('app-installer', '2.0.3', 'Compass-best-effort.exe', artifactBody)
    },
    checkFailures: new Set(['app-asar'])
  });
  const failFastDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-fail-fast-'));
  const bestEffortDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-best-effort-'));
  const common = {
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    platform: 'win32',
    arch: 'x64',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_modes', userId: null })
  };
  try {
    const failFast = createElectronLauncherApplicationUpdater({ ...common, baseDir: failFastDir });
    const failed = await failFast.check();
    assert.equal(failed.phase, 'error');
    assert.match(failed.error, /500/);

    const bestEffort = createElectronLauncherApplicationUpdater({
      ...common,
      baseDir: bestEffortDir,
      componentCheckFailureMode: 'best-effort'
    });
    const available = await bestEffort.check();
    assert.equal(available.phase, 'available');
    assert.equal(available.artifactClass, 'installer');
  } finally {
    await fixture.close();
    await rm(failFastDir, { recursive: true, force: true });
    await rm(bestEffortDir, { recursive: true, force: true });
  }
});

test('ASAR install requires both relaunch and exit before handoff', async () => {
  const artifactBody = Buffer.from('restart-contract-asar');
  const fixture = await startReleaseCenter({
    artifacts: {
      'app-asar': releaseArtifact('app-asar', '2.0.3', 'Compass-restart-contract.asar', artifactBody),
      'app-installer': null
    }
  });
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-application-updater-restart-contract-'));
  const actions = [];
  const updater = createElectronLauncherApplicationUpdater({
    baseDir,
    packageName: 'compass',
    productId: 'luopan',
    allowLegacyProductFallback: true,
    currentVersion: '2.0.2',
    getContext: () => ({ baseUrl: fixture.baseUrl, installId: 'install_restart', userId: null }),
    relaunch: () => actions.push('relaunch')
  });
  try {
    assert.equal((await updater.download()).phase, 'ready');
    const result = await updater.install();
    assert.equal(result.phase, 'error');
    assert.match(result.error, /requires relaunch and exit/);
    assert.deepEqual(actions, []);
  } finally {
    await fixture.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

async function startReleaseCenter(options) {
  const resolverRequests = [];
  const checkRequests = [];
  const artifactRequests = [];
  const timers = new Set();
  const delayedResponses = new Set();
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/internal/v1/releases/products/resolve?')) {
      resolverRequests.push(request.url);
      const payload = {
        identity: {
          appId: 'luopan',
          productId: 'luopan',
          packageName: 'compass',
          launcherMode: 'standalone',
          networkProductId: 'luopan',
          componentId: 'luopan',
          rendererComponentId: 'luopan-renderer',
          channel: 'stable',
          channels: ['stable']
        }
      };
      if (options.slowResolverOnce && resolverRequests.length === 1) {
        delayedResponses.add(response);
        const timer = setTimeout(() => {
          timers.delete(timer);
          delayedResponses.delete(response);
          if (!response.destroyed) json(response, payload);
        }, options.slowResolverDelayMs ?? 1_000);
        timers.add(timer);
        response.on('close', () => {
          clearTimeout(timer);
          timers.delete(timer);
          delayedResponses.delete(response);
        });
        return;
      }
      json(response, payload);
      return;
    }
    if (request.url === '/internal/v1/release/check' && request.method === 'POST') {
      const input = JSON.parse(await readBody(request));
      checkRequests.push(input);
      const kind = input.artifactKinds?.[0];
      if (options.checkFailures?.has(kind)) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: `forced ${kind} failure` }));
        return;
      }
      const artifact = options.artifacts[kind] ?? null;
      json(response, releaseCheckPayload(kind, artifact, options.deliveryMode));
      return;
    }
    if (request.url === '/internal/v1/release/reports' && request.method === 'POST') {
      json(response, { ok: true });
      return;
    }
    const artifact = Object.values(options.artifacts).find(
      (candidate) => candidate && request.url === `/artifacts/${candidate.fileName}`
    );
    if (artifact) {
      artifactRequests.push(request.url);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(artifact.body.length)
      });
      if (options.slowArtifact) {
        response.write(artifact.body.subarray(0, 1024));
        const timer = setTimeout(() => response.end(artifact.body.subarray(1024)), 300);
        timers.add(timer);
        response.on('close', () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
      } else {
        response.end(artifact.body);
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    resolverRequests,
    checkRequests,
    artifactRequests,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const response of delayedResponses) response.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function releaseArtifact(kind, version, fileName, body) {
  return {
    artifactId: `artifact_${kind}`,
    kind,
    componentId: 'luopan',
    version,
    source: 'test',
    url: `/artifacts/${fileName}`,
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    signature: null,
    sizeBytes: body.length,
    platform: kind === 'app-installer' ? 'win32' : null,
    arch: kind === 'app-installer' ? 'x64' : null,
    fileName,
    activation: kind === 'app-installer' ? 'installer-manual' : 'restart-auto',
    autoApply: kind !== 'app-installer',
    restartRequired: true,
    requiredAppRestart: true,
    notes: [],
    body
  };
}

function releaseCheckPayload(kind, artifact, deliveryMode = 'prompt-download-restart') {
  const currentVersion = '2.0.2';
  const targetVersion = artifact?.version ?? currentVersion;
  const decision = {
    componentKind: kind,
    componentId: 'luopan',
    currentVersion,
    targetVersion,
    updateAvailable: Boolean(artifact),
    updateMode: artifact ? 'automatic' : 'none',
    canSkip: true,
    canDefer: true,
    requiresGate: false,
    rollbackRequired: false,
    reason: artifact ? 'update available' : 'already current'
  };
  return {
    status: artifact ? 'update-available' : 'up-to-date',
    reason: decision.reason,
    planId: artifact ? `plan_${kind}` : null,
    releaseId: artifact ? `release_${kind}` : null,
    channel: 'stable',
    decision,
    artifacts: artifact ? [{ ...artifact, body: undefined }] : [],
    activation: null,
    releaseNotes: artifact ? `# ${artifact.version}` : null,
    deliveryMode,
    featureFlags: [],
    rollout: { matchedBy: null, bucket: null, percentage: null },
    signedAt: '2026-09-03T00:00:00.000Z',
    signature: { algorithm: 'hmac-sha256', keyId: 'test', value: 'test' }
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
