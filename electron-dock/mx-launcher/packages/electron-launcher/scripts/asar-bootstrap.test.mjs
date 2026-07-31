import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createElectronLauncherReleaseUpdateExecutor } from '../dist/release-update-executor.js';

const require = createRequire(import.meta.url);
const {
  confirmElectronLauncherAsarLaunch,
  markElectronLauncherAsarLaunchFailed,
  selectElectronLauncherAsar
} = require('../dist/asar-bootstrap.cjs');

test('promotes a newer pending ASAR and confirms it after ready', async () => {
  const fixture = await createFixture('shared-asar');
  try {
    const artifact = await fixture.asar('2.1.3');
    await fixture.pointer('pending', { version: '2.1.3', path: artifact, activatedAt: 'next-start' });
    const startedAt = performance.now();
    const selected = selectElectronLauncherAsar({
      baseDir: fixture.baseDir,
      componentId: fixture.componentId,
      baseVersion: '2.1.2',
      pid: 4242,
      processAlive: () => false
    });
    assert.ok(performance.now() - startedAt < 100, 'local pointer selection should stay below 100ms');
    assert.equal(selected.path, artifact);
    assert.equal(selected.source, 'pending');
    assert.equal(confirmElectronLauncherAsarLaunch({
      baseDir: fixture.baseDir,
      componentId: fixture.componentId,
      activePath: artifact
    }), true);
    assert.equal(await fixture.exists('launching'), false);
    assert.equal((await fixture.read('healthy')).version, '2.1.3');
  } finally {
    await fixture.cleanup();
  }
});

test('checks ASAR pointers as physical files under Electron', async () => {
  const source = await readFile(new URL('../src/asar-bootstrap.cts', import.meta.url), 'utf8');
  assert.match(source, /withElectronAsarDisabled\(\(\) => fs\.statSync\(pointer\.path\)\)/);
});

test('rolls back to the previous ASAR after an unconfirmed launch', async () => {
  const fixture = await createFixture('luopan');
  try {
    const previous = await fixture.asar('0.1.2');
    const current = await fixture.asar('0.1.3');
    await fixture.pointer('previous', { version: '0.1.2', path: previous, activatedAt: 'earlier' });
    await fixture.pointer('current', { version: '0.1.3', path: current, activatedAt: 'later' });
    await fixture.pointer('launching', { version: '0.1.3', path: current, pid: 5151 });
    const selected = selectElectronLauncherAsar({
      baseDir: fixture.baseDir,
      componentId: fixture.componentId,
      baseVersion: '0.1.1',
      pid: 6161,
      processAlive: () => false
    });
    assert.equal(selected.path, previous);
    assert.equal((await fixture.read('failed')).path, current);
  } finally {
    await fixture.cleanup();
  }
});

test('a newer full installer supersedes stale ASAR pointers', async () => {
  const fixture = await createFixture('mx-h2i');
  try {
    const artifact = await fixture.asar('2.1.3');
    await fixture.pointer('current', { version: '2.1.3', path: artifact, activatedAt: 'earlier' });
    const selected = selectElectronLauncherAsar({
      baseDir: fixture.baseDir,
      componentId: fixture.componentId,
      baseVersion: '2.2.0',
      pid: 7171,
      processAlive: () => false
    });
    assert.equal(selected.active, false);
    assert.equal(selected.version, '2.2.0');
    assert.equal(await fixture.exists('current'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('synchronous ASAR load failure immediately restores the previous pointer', async () => {
  const fixture = await createFixture('mx-h2i');
  try {
    const previous = await fixture.asar('2.1.2');
    const current = await fixture.asar('2.1.3');
    await fixture.pointer('previous', { version: '2.1.2', path: previous, activatedAt: 'earlier' });
    await fixture.pointer('current', { version: '2.1.3', path: current, activatedAt: 'later' });
    assert.equal(markElectronLauncherAsarLaunchFailed({
      baseDir: fixture.baseDir,
      componentId: fixture.componentId,
      baseVersion: '2.1.1',
      activePath: current,
      reason: 'synthetic require failure'
    }), true);
    assert.equal((await fixture.read('current')).path, previous);
  } finally {
    await fixture.cleanup();
  }
});

test('the shared executor stages an ASAR pointer consumed by the bootstrap', async () => {
  const fixture = await createFixture('luopan');
  try {
    const stagedPath = await fixture.asar('0.1.2');
    const executor = createElectronLauncherReleaseUpdateExecutor({
      updater: noopUpdater(),
      baseDir: fixture.baseDir
    });
    const activation = await executor.activateStaged(
      asarArtifact({ componentId: 'luopan', version: '0.1.2' }),
      stagedPath,
      { releaseId: 'rel_luopan_0.1.2' }
    );
    assert.equal(activation.deferredReason, 'restart required');
    const pending = await fixture.read('pending');
    assert.equal(pending.version, '0.1.2');
    assert.match(pending.path, /launcher-packages[/\\]luopan[/\\]0\.1\.2[/\\]/);
  } finally {
    await fixture.cleanup();
  }
});

test('the shared executor rejects unsafe component and version path segments', async () => {
  const fixture = await createFixture('luopan');
  try {
    const stagedPath = await fixture.asar('0.1.2');
    const executor = createElectronLauncherReleaseUpdateExecutor({
      updater: noopUpdater(),
      baseDir: fixture.baseDir
    });
    await assert.rejects(
      executor.activateStaged(
        asarArtifact({ componentId: '../escape', version: '0.1.2' }),
        stagedPath
      ),
      /invalid release artifact componentId/
    );
    await assert.rejects(
      executor.activateStaged(
        asarArtifact({ componentId: 'luopan', version: '../../escape' }),
        stagedPath
      ),
      /invalid release artifact version/
    );
  } finally {
    await fixture.cleanup();
  }
});

function noopUpdater() {
  return {
    resolveProduct: async () => {
      throw new Error('not used');
    },
    check: async () => {
      throw new Error('not used');
    },
    report: async () => ({ ok: true })
  };
}

function asarArtifact(overrides = {}) {
  return {
    artifactId: 'artifact_luopan_asar',
    kind: 'app-asar',
    componentId: 'luopan',
    version: '0.1.2',
    source: 'test',
    url: null,
    digest: null,
    signature: null,
    sizeBytes: null,
    platform: 'darwin',
    arch: 'arm64',
    fileName: 'Luopan-0.1.2.asar',
    activation: 'restart-auto',
    autoApply: true,
    restartRequired: true,
    requiredAppRestart: true,
    notes: [],
    ...overrides
  };
}

async function createFixture(componentId) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'electron-launcher-asar-'));
  const pointerDir = path.join(baseDir, 'launcher-packages');
  await mkdir(pointerDir, { recursive: true });
  const file = (name) => path.join(pointerDir, `${componentId}.${name}.json`);
  return {
    baseDir,
    componentId,
    async asar(version) {
      const artifact = path.join(baseDir, `${componentId}-${version}.asar`);
      await writeFile(artifact, version);
      return artifact;
    },
    pointer(name, value) {
      return writeFile(file(name), `${JSON.stringify(value)}\n`);
    },
    async read(name) {
      return JSON.parse(await readFile(file(name), 'utf8'));
    },
    async exists(name) {
      return readFile(file(name)).then(() => true).catch(() => false);
    },
    cleanup() {
      return rm(baseDir, { recursive: true, force: true });
    }
  };
}
