import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');
const manageScript = join(scriptDir, 'manage.sh');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-manage-predeploy-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'corepack.log');
  mkdirSync(bin);
  const corepack = join(bin, 'corepack');
  writeFileSync(corepack, `#!/bin/sh
printf '%s\\n' "$*" >> "$MX_MANAGE_PREDEPLOY_TEST_LOG"
case "$*" in
  *release-sdk-publisher.test.ts*) exit "\${MX_MANAGE_PREDEPLOY_TEST_RELEASE_STATUS:-0}" ;;
  *"run typecheck"*) exit "\${MX_MANAGE_PREDEPLOY_TEST_TYPECHECK_STATUS:-0}" ;;
esac
exit 0
`);
  chmodSync(corepack, 0o755);
  return {
    dir,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MX_MANAGE_PREDEPLOY_TEST_LOG: log
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function runPredeploy(env) {
  return spawnSync(
    'bash',
    [manageScript, 'ops', 'internal-production', 'predeploy'],
    { cwd: root, env, encoding: 'utf8' }
  );
}

test('predeploy uses the repository-pinned pnpm for the focused test and typecheck', () => {
  const files = fixture();
  try {
    const result = runPredeploy(files.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Internal production predeploy gate OK/);
    assert.deepEqual(readFileSync(files.log, 'utf8').trim().split('\n'), [
      `pnpm@10.24.0 --dir ${root}/server exec node --test --import tsx src/modules/release/release-sdk-publisher.test.ts`,
      `pnpm@10.24.0 --dir ${root}/server run typecheck`
    ]);
  } finally {
    files.cleanup();
  }
});

test('predeploy stops before typecheck when the focused release test fails', () => {
  const files = fixture();
  try {
    const result = runPredeploy({
      ...files.env,
      MX_MANAGE_PREDEPLOY_TEST_RELEASE_STATUS: '23'
    });
    assert.equal(result.status, 23);
    const calls = readFileSync(files.log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /release-sdk-publisher\.test\.ts/);
  } finally {
    files.cleanup();
  }
});

test('break-glass skip is explicit and does not run corepack', () => {
  const files = fixture();
  try {
    const result = runPredeploy({
      ...files.env,
      MX_INTERNAL_PRODUCTION_SKIP_PREDEPLOY_GATE: '1'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WARNING: skip Internal production predeploy gate/);
    assert.throws(() => readFileSync(files.log, 'utf8'), /ENOENT/);
  } finally {
    files.cleanup();
  }
});

test('invalid break-glass values fail closed', () => {
  const files = fixture();
  try {
    const result = runPredeploy({
      ...files.env,
      MX_INTERNAL_PRODUCTION_SKIP_PREDEPLOY_GATE: 'yes'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be 0 or 1/);
    assert.throws(() => readFileSync(files.log, 'utf8'), /ENOENT/);
  } finally {
    files.cleanup();
  }
});

test('deploy invokes the predeploy gate before building the Internal image', () => {
  const source = readFileSync(manageScript, 'utf8');
  const deployCase = source.match(/    deploy\|cycle\)\n([\s\S]*?)\n    apply\)/);
  assert.ok(deployCase, 'internal-production deploy case must exist');
  const gate = deployCase[1].indexOf('internal_production_predeploy_gate');
  const build = deployCase[1].indexOf('shadow_image_build');
  assert.ok(gate >= 0, 'deploy must invoke the predeploy gate');
  assert.ok(build > gate, 'predeploy gate must run before image build');
});
