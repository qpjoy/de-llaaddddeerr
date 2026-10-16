import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('a configured artifact root blocks on every pre-existing entry and preserves it', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'mx-auto-artifact-root-'));
  const artifactRoot = join(scratch, 'run-artifacts');
  const executable = join(scratch, 'fake-compass');
  const leftover = join(artifactRoot, 'unrelated-secret.txt');
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(leftover, 'must-not-be-uploaded-or-deleted');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o700);
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, ['scripts/run.mjs'], {
    cwd: packRoot,
    env: {
      PATH: process.env.PATH,
      MX_AUTO_APP_PATH: executable,
      MX_AUTO_ARTIFACTS_DIR: artifactRoot,
      COMPASS_E2E_NETWORK_MODE: 'dedicated-runner',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /not a fresh per-Run root/u);
  assert.equal(readFileSync(leftover, 'utf8'), 'must-not-be-uploaded-or-deleted');
});
