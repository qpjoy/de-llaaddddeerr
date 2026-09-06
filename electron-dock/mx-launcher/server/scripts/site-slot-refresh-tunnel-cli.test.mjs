import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  tunnelCliExecutableFiles,
  tunnelCliFullFallbackFiles,
  tunnelCliFullFallbackReady
} from './site-slot-tunnel-cli-contract.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '../../../..');
const refreshScript = join(scriptDir, 'site-slot-refresh-tunnel-cli.mjs');
const checkedInFallbackRoot = join(
  repositoryRoot,
  'electron-dock/mx-launcher/site-slots/domestic/qp-tunnel-cli'
);
const requiredFiles = tunnelCliFullFallbackFiles;
const executableFiles = new Set(tunnelCliExecutableFiles);

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mx-tunnel-cli-refresh-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const temp = join(root, 'temp');
  const omitted = new Set(options.omit ?? []);
  for (const file of requiredFiles) {
    if (omitted.has(file)) continue;
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    if (file === 'package.json') {
      writeFileSync(path, JSON.stringify({ name: '@qpjoy/tunnel-cli', version: '9.9.9' }));
    } else {
      writeFileSync(path, `fixture:${file}\n`);
    }
    if (executableFiles.has(file)) chmodSync(path, 0o600);
  }
  return {
    root,
    source,
    target,
    temp,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test('refresh copies every CLI module and shell resource required by the fallback', () => {
  const files = fixture();
  try {
    const output = execFileSync(process.execPath, [
      refreshScript,
      '--from-local', files.source,
      '--target-dir', files.target,
      '--temp-dir', files.temp
    ], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.packageVersion, '9.9.9');

    for (const file of requiredFiles) {
      const target = join(files.target, file);
      assert.equal(existsSync(target), true, `${file} must be copied`);
      if (file !== 'package.json') {
        assert.equal(readFileSync(target, 'utf8'), `fixture:${file}\n`);
      }
      if (executableFiles.has(file)) {
        assert.equal(statSync(target).mode & 0o111, 0o111, `${file} must be executable`);
      }
    }
  } finally {
    files.cleanup();
  }
});

test('refresh rejects an incomplete OpenVPN runtime before replacing the current fallback', () => {
  const files = fixture({ omit: ['resources/openvpn-client.sh'] });
  try {
    mkdirSync(files.target, { recursive: true });
    const sentinel = join(files.target, 'current-fallback');
    writeFileSync(sentinel, 'keep');
    assert.throws(() => execFileSync(process.execPath, [
      refreshScript,
      '--from-local', files.source,
      '--target-dir', files.target,
      '--temp-dir', files.temp
    ], { stdio: 'pipe' }), /Missing required @qpjoy\/tunnel-cli file/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    files.cleanup();
  }
});

test('materializer readiness rejects every missing CLI module or shell resource', () => {
  const files = fixture();
  try {
    assert.equal(tunnelCliFullFallbackReady(files.source), true);
    for (const file of requiredFiles) {
      const path = join(files.source, file);
      const content = readFileSync(path);
      rmSync(path);
      assert.equal(tunnelCliFullFallbackReady(files.source), false, `${file} must be required`);
      writeFileSync(path, content);
    }
  } finally {
    files.cleanup();
  }
});

test('the checked-in full fallback source is present and not hidden by ignore rules', () => {
  for (const file of requiredFiles) {
    const source = join(checkedInFallbackRoot, file);
    assert.equal(existsSync(source), true, `${file} must exist in the checked-in fallback source`);
    const ignored = spawnSync('git', [
      'check-ignore',
      '--no-index',
      '-q',
      '--',
      source
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    });
    assert.equal(
      ignored.status,
      1,
      `${file} must not be ignored (git check-ignore status ${ignored.status}: ${ignored.stderr.trim()})`
    );
  }
});

test('host-runner keeps the legacy H2I readiness floor for already deployed archives', () => {
  const hostRunner = readFileSync(join(scriptDir, 'internal-service-peer-host-runner.mjs'), 'utf8');
  const readinessFunction = hostRunner.slice(
    hostRunner.indexOf('function fallbackTunnelCliRuntimeReady() {'),
    hostRunner.indexOf('\nfunction fallbackArchiveFingerprint(')
  );
  for (const file of ['package/package.json', 'package/dist/index.js', 'package/dist/h2i.js']) {
    assert.match(readinessFunction, new RegExp(file.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(readinessFunction, /dist\/(open|wg)|openvpn-|wireguard\.sh|china-ipv4/);
});

test('the shadow-image readiness gate uses the same complete package contract', () => {
  const manageScript = readFileSync(join(scriptDir, '../../scripts/manage.sh'), 'utf8');
  const readinessFunction = manageScript.slice(
    manageScript.indexOf('qp_tunnel_cli_fallback_ready() {'),
    manageScript.indexOf('\nqp_tunnel_cli_fallback_version() {')
  );
  const readinessLines = new Set(readinessFunction.split('\n').map((line) => line.trim()));
  for (const file of requiredFiles) {
    assert.equal(readinessLines.has(file), true, `${file} must be checked by manage.sh`);
  }
});
