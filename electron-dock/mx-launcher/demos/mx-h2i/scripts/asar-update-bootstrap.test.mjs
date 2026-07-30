import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  confirmElectronLauncherAsarLaunch,
  markElectronLauncherAsarLaunchFailed,
  selectElectronLauncherAsar
} = require('@qpjoy/electron-launcher/asar-bootstrap');

test('runtime resolves ESM launcher imports through the installed base package', async () => {
  const source = await readFile(new URL('../src/main-runtime.cjs', import.meta.url), 'utf8');
  assert.match(source, /function importInstalledPackage\(specifier\)/);
  assert.doesNotMatch(source, /import\(['"]@qpjoy\/electron-launcher/);
});

test('promotes a newer pending ASAR and confirms it after ready', async () => {
  const fixture = await createFixture();
  try {
    const artifact = await fixture.asar('2.1.3');
    await fixture.pointer('pending', { version: '2.1.3', path: artifact, activatedAt: 'next-start' });
    const selected = selectElectronLauncherAsar({
      baseDir: fixture.baseDir,
      componentId: 'mx-h2i',
      baseVersion: '2.1.2',
      pid: 4242,
      processAlive: () => false
    });
    assert.equal(selected.path, artifact);
    assert.equal(selected.source, 'pending');
    assert.equal(confirmElectronLauncherAsarLaunch({
      baseDir: fixture.baseDir,
      componentId: 'mx-h2i',
      activePath: artifact
    }), true);
    assert.equal(await fixture.exists('launching'), false);
    assert.equal((await fixture.read('healthy')).version, '2.1.3');
  } finally {
    await fixture.cleanup();
  }
});

test('rolls back to the previous ASAR after an unconfirmed launch', async () => {
  const fixture = await createFixture();
  try {
    const previous = await fixture.asar('2.1.2');
    const current = await fixture.asar('2.1.3');
    await fixture.pointer('previous', { version: '2.1.2', path: previous, activatedAt: 'earlier' });
    await fixture.pointer('current', { version: '2.1.3', path: current, activatedAt: 'later' });
    await fixture.pointer('launching', { version: '2.1.3', path: current, pid: 5151 });
    const selected = selectElectronLauncherAsar({
      baseDir: fixture.baseDir,
      componentId: 'mx-h2i',
      baseVersion: '2.1.1',
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
  const fixture = await createFixture();
  try {
    const artifact = await fixture.asar('2.1.3');
    await fixture.pointer('current', { version: '2.1.3', path: artifact, activatedAt: 'earlier' });
    const selected = selectElectronLauncherAsar({
      baseDir: fixture.baseDir,
      componentId: 'mx-h2i',
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
  const fixture = await createFixture();
  try {
    const previous = await fixture.asar('2.1.2');
    const current = await fixture.asar('2.1.3');
    await fixture.pointer('previous', { version: '2.1.2', path: previous, activatedAt: 'earlier' });
    await fixture.pointer('current', { version: '2.1.3', path: current, activatedAt: 'later' });
    assert.equal(markElectronLauncherAsarLaunchFailed({
      baseDir: fixture.baseDir,
      componentId: 'mx-h2i',
      baseVersion: '2.1.1',
      activePath: current,
      reason: 'synthetic require failure'
    }), true);
    assert.equal((await fixture.read('current')).path, previous);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'mx-h2i-asar-'));
  const pointerDir = path.join(baseDir, 'launcher-packages');
  await mkdir(pointerDir, { recursive: true });
  const file = (name) => path.join(pointerDir, `mx-h2i.${name}.json`);
  return {
    baseDir,
    async asar(version) {
      const artifact = path.join(baseDir, `MX-H2I-${version}.asar`);
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
