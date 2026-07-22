import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareReleaseOssSecretEnv } from './release-oss-secret-env.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-release-oss-secret-'));
  return {
    dir,
    input: join(dir, '.env'),
    output: join(dir, 'secret.env'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('prepares only release OSS keys and returns a stable digest', () => {
  const files = fixture();
  try {
    writeFileSync(files.input, [
      'MX_RELEASE_OSS_SECRET_SOURCE=env',
      'MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com',
      'MX_RELEASE_OSS_BUCKET=mx-launcher',
      'MX_RELEASE_OSS_ACCESS_KEY_ID=key-id',
      'MX_RELEASE_OSS_ACCESS_KEY_SECRET="key-secret"',
      'MX_RELEASE_OSS_PUBLIC_BASE_URL=',
      'UNRELATED_PASSWORD=must-not-be-copied'
    ].join('\n'));

    const first = prepareReleaseOssSecretEnv(files.input, files.output, {});
    const firstContent = readFileSync(files.output, 'utf8');
    const second = prepareReleaseOssSecretEnv(files.input, files.output, {});

    assert.equal(first.status, 'ready');
    assert.equal(first.digest, second.digest);
    assert.match(firstContent, /MX_RELEASE_OSS_ACCESS_KEY_SECRET=key-secret/);
    assert.match(firstContent, /MX_RELEASE_OSS_PREFIX=mx-launcher\/releases/);
    assert.match(firstContent, /MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS=3600/);
    assert.doesNotMatch(firstContent, /UNRELATED_PASSWORD/);
  } finally {
    files.cleanup();
  }
});

test('process environment overrides the server env file', () => {
  const files = fixture();
  try {
    writeFileSync(files.input, [
      'MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com',
      'MX_RELEASE_OSS_BUCKET=mx-launcher',
      'MX_RELEASE_OSS_ACCESS_KEY_ID=file-key-id',
      'MX_RELEASE_OSS_ACCESS_KEY_SECRET=file-secret'
    ].join('\n'));

    prepareReleaseOssSecretEnv(files.input, files.output, {
      MX_RELEASE_OSS_ACCESS_KEY_ID: 'environment-key-id'
    });

    assert.match(readFileSync(files.output, 'utf8'), /MX_RELEASE_OSS_ACCESS_KEY_ID=environment-key-id/);
  } finally {
    files.cleanup();
  }
});

test('rejects partial env configuration without writing secret material', () => {
  const files = fixture();
  try {
    writeFileSync(files.input, [
      'MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com',
      'MX_RELEASE_OSS_BUCKET=mx-launcher'
    ].join('\n'));

    assert.throws(
      () => prepareReleaseOssSecretEnv(files.input, files.output, {}),
      /MX_RELEASE_OSS_ACCESS_KEY_ID, MX_RELEASE_OSS_ACCESS_KEY_SECRET/
    );
  } finally {
    files.cleanup();
  }
});

test('supports external secret materialization without local credentials', () => {
  const files = fixture();
  try {
    writeFileSync(files.input, 'MX_RELEASE_OSS_SECRET_SOURCE=external\n');
    assert.deepEqual(
      prepareReleaseOssSecretEnv(files.input, files.output, {}),
      { status: 'external', digest: null, keys: [] }
    );
  } finally {
    files.cleanup();
  }
});
