import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  prepareReleaseOssK8sSecretResource,
  prepareReleaseOssSecretEnv,
  validateReleaseOssK8sSecret,
  validateReleaseOssLocalEnvironment
} from './release-oss-secret-env.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-release-oss-secret-'));
  return {
    dir,
    input: join(dir, '.env'),
    output: join(dir, 'secret.env'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function writePrivate(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function releaseOssSecret(values, extraData = {}) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'mx-release-oss',
      resourceVersion: '123'
    },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries({ ...values, ...extraData })
        .map(([key, value]) => [key, Buffer.from(value, 'utf8').toString('base64')])
    )
  };
}

test('prepares only release OSS keys and returns a stable digest', () => {
  const files = fixture();
  try {
    writePrivate(files.input, [
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
    if (process.platform !== 'win32') {
      assert.equal(statSync(files.output).mode & 0o777, 0o600);
    }
  } finally {
    files.cleanup();
  }
});

test('process environment overrides the server env file', () => {
  const files = fixture();
  try {
    writePrivate(files.input, [
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
    writePrivate(files.input, [
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
    writePrivate(files.input, 'MX_RELEASE_OSS_SECRET_SOURCE=external\n');
    assert.deepEqual(
      prepareReleaseOssSecretEnv(files.input, files.output, {}),
      { status: 'external', digest: null, keys: [] }
    );
  } finally {
    files.cleanup();
  }
});

test('partial local rotation merges existing known values without copying unknown keys', () => {
  const files = fixture();
  const rotatedSecret = 'rotated-secret-value';
  try {
    writePrivate(files.input, `MX_RELEASE_OSS_ACCESS_KEY_SECRET=${rotatedSecret}\n`);
    const existing = releaseOssSecret(
      {
        MX_RELEASE_OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
        MX_RELEASE_OSS_BUCKET: 'mx-launcher',
        MX_RELEASE_OSS_ACCESS_KEY_ID: 'existing-id',
        MX_RELEASE_OSS_ACCESS_KEY_SECRET: 'existing-secret',
        MX_RELEASE_OSS_SECURITY_TOKEN: 'existing-token',
        MX_RELEASE_OSS_PREFIX: 'existing/prefix',
        MX_RELEASE_OSS_PUBLIC_BASE_URL: 'https://downloads.example.test',
        MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS: '7200'
      },
      { 'operator-note': 'preserve-through-merge-patch' }
    );

    const result = prepareReleaseOssSecretEnv(files.input, files.output, {}, existing);
    const content = readFileSync(files.output, 'utf8');

    assert.equal(result.status, 'ready');
    assert.match(content, /MX_RELEASE_OSS_ACCESS_KEY_ID=existing-id/);
    assert.match(content, new RegExp(`MX_RELEASE_OSS_ACCESS_KEY_SECRET=${rotatedSecret}`));
    assert.match(content, /MX_RELEASE_OSS_SECURITY_TOKEN=existing-token/);
    assert.match(content, /MX_RELEASE_OSS_PREFIX=existing\/prefix/);
    assert.doesNotMatch(content, /operator-note|preserve-through-merge-patch/);
  } finally {
    files.cleanup();
  }
});

test('blank required placeholders preserve existing credentials and K8s resource preserves unknown data', () => {
  const files = fixture();
  const resourceOutput = join(files.dir, 'secret.json');
  try {
    writePrivate(files.input, [
      'MX_RELEASE_OSS_SECRET_SOURCE=auto',
      'MX_RELEASE_OSS_ENDPOINT=',
      'MX_RELEASE_OSS_BUCKET=',
      'MX_RELEASE_OSS_ACCESS_KEY_ID=',
      'MX_RELEASE_OSS_ACCESS_KEY_SECRET=',
      'MX_RELEASE_OSS_PREFIX=existing/prefix'
    ].join('\n'));
    const existing = releaseOssSecret(
      {
        MX_RELEASE_OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
        MX_RELEASE_OSS_BUCKET: 'mx-launcher',
        MX_RELEASE_OSS_ACCESS_KEY_ID: 'existing-id',
        MX_RELEASE_OSS_ACCESS_KEY_SECRET: 'existing-secret',
        MX_RELEASE_OSS_SECURITY_TOKEN: 'existing-token',
        MX_RELEASE_OSS_PREFIX: 'existing/prefix',
        MX_RELEASE_OSS_PUBLIC_BASE_URL: 'https://downloads.example.test',
        MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS: '7200'
      },
      { 'operator-note': 'preserve-byte-for-byte' }
    );
    existing.metadata.ownerReferences = [{
      apiVersion: 'external-secrets.io/v1beta1',
      kind: 'ExternalSecret',
      name: 'release-oss',
      uid: 'owner-uid'
    }];
    existing.metadata.finalizers = ['example.test/cleanup'];
    existing.metadata.annotations = {
      'kubectl.kubernetes.io/last-applied-configuration': '{"data":"legacy-secret-copy"}'
    };

    const result = prepareReleaseOssK8sSecretResource(
      files.input,
      resourceOutput,
      'mx-internal-shadow',
      {},
      existing
    );
    const resource = JSON.parse(readFileSync(resourceOutput, 'utf8'));

    assert.equal(result.status, 'ready');
    assert.equal(resource.metadata.resourceVersion, '123');
    if (process.platform !== 'win32') {
      assert.equal(statSync(resourceOutput).mode & 0o777, 0o600);
    }
    assert.deepEqual(resource.metadata.ownerReferences, existing.metadata.ownerReferences);
    assert.deepEqual(resource.metadata.finalizers, existing.metadata.finalizers);
    assert.equal(
      Object.hasOwn(
        resource.metadata.annotations,
        'kubectl.kubernetes.io/last-applied-configuration'
      ),
      false
    );
    assert.equal(
      resource.data.MX_RELEASE_OSS_ACCESS_KEY_SECRET,
      existing.data.MX_RELEASE_OSS_ACCESS_KEY_SECRET
    );
    assert.equal(resource.data['operator-note'], existing.data['operator-note']);
  } finally {
    files.cleanup();
  }
});

test('env mode can explicitly clear security token and public URL without clearing required values', () => {
  const files = fixture();
  try {
    writePrivate(files.input, [
      'MX_RELEASE_OSS_SECRET_SOURCE=env',
      'MX_RELEASE_OSS_ACCESS_KEY_SECRET=rotated-secret',
      'MX_RELEASE_OSS_SECURITY_TOKEN=',
      'MX_RELEASE_OSS_PUBLIC_BASE_URL='
    ].join('\n'));
    const existing = releaseOssSecret({
      MX_RELEASE_OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
      MX_RELEASE_OSS_BUCKET: 'mx-launcher',
      MX_RELEASE_OSS_ACCESS_KEY_ID: 'existing-id',
      MX_RELEASE_OSS_ACCESS_KEY_SECRET: 'existing-secret',
      MX_RELEASE_OSS_SECURITY_TOKEN: 'old-token',
      MX_RELEASE_OSS_PREFIX: 'existing/prefix',
      MX_RELEASE_OSS_PUBLIC_BASE_URL: 'https://downloads.example.test',
      MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS: '7200'
    });

    prepareReleaseOssSecretEnv(files.input, files.output, {}, existing);
    const content = readFileSync(files.output, 'utf8');

    assert.match(content, /MX_RELEASE_OSS_ACCESS_KEY_ID=existing-id/);
    assert.match(content, /MX_RELEASE_OSS_ACCESS_KEY_SECRET=rotated-secret/);
    assert.match(content, /MX_RELEASE_OSS_SECURITY_TOKEN=\n/);
    assert.match(content, /MX_RELEASE_OSS_PUBLIC_BASE_URL=\n/);
  } finally {
    files.cleanup();
  }
});

test('immutable existing OSS Secret rejects a planned data rotation during preflight', () => {
  const files = fixture();
  try {
    writePrivate(files.input, 'MX_RELEASE_OSS_ACCESS_KEY_SECRET=rotated-secret\n');
    const existing = {
      ...releaseOssSecret({
        MX_RELEASE_OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
        MX_RELEASE_OSS_BUCKET: 'mx-launcher',
        MX_RELEASE_OSS_ACCESS_KEY_ID: 'existing-id',
        MX_RELEASE_OSS_ACCESS_KEY_SECRET: 'existing-secret',
        MX_RELEASE_OSS_SECURITY_TOKEN: '',
        MX_RELEASE_OSS_PREFIX: 'mx-launcher/releases',
        MX_RELEASE_OSS_PUBLIC_BASE_URL: '',
        MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS: '3600'
      }),
      immutable: true
    };

    assert.throws(
      () => prepareReleaseOssK8sSecretResource(
        files.input,
        join(files.dir, 'secret.json'),
        'mx-internal-shadow',
        {},
        existing
      ),
      /immutable and cannot be updated/
    );
  } finally {
    files.cleanup();
  }
});

test('local validation allows a partial rotation to defer completeness to cluster preflight', () => {
  const files = fixture();
  try {
    writePrivate(files.input, 'MX_RELEASE_OSS_ACCESS_KEY_SECRET=rotated-secret\n');
    assert.deepEqual(
      validateReleaseOssLocalEnvironment(files.input, {}),
      { status: 'partial', digest: null, keys: [] }
    );
  } finally {
    files.cleanup();
  }
});

test('existing Kubernetes Secret validation requires all canonical keys and validates TTL', () => {
  const complete = releaseOssSecret({
    MX_RELEASE_OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
    MX_RELEASE_OSS_BUCKET: 'mx-launcher',
    MX_RELEASE_OSS_ACCESS_KEY_ID: 'existing-id',
    MX_RELEASE_OSS_ACCESS_KEY_SECRET: 'existing-secret',
    MX_RELEASE_OSS_SECURITY_TOKEN: '',
    MX_RELEASE_OSS_PREFIX: 'mx-launcher/releases',
    MX_RELEASE_OSS_PUBLIC_BASE_URL: '',
    MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS: '3600'
  });
  assert.deepEqual(validateReleaseOssK8sSecret(complete), { resourceVersion: '123' });

  const incomplete = structuredClone(complete);
  delete incomplete.data.MX_RELEASE_OSS_SECURITY_TOKEN;
  assert.throws(
    () => validateReleaseOssK8sSecret(incomplete),
    /incomplete; missing MX_RELEASE_OSS_SECURITY_TOKEN/
  );

  const invalidTtl = structuredClone(complete);
  invalidTtl.data.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS = Buffer.from('10').toString('base64');
  assert.throws(
    () => validateReleaseOssK8sSecret(invalidTtl),
    /integer between 60 and 86400/
  );
});

test('rejects a group/world-readable server env file', { skip: process.platform === 'win32' }, () => {
  const files = fixture();
  try {
    writeFileSync(files.input, 'MX_RELEASE_OSS_SECRET_SOURCE=external\n', { mode: 0o644 });
    chmodSync(files.input, 0o644);
    assert.throws(
      () => validateReleaseOssLocalEnvironment(files.input, {}),
      /chmod 600/
    );
  } finally {
    files.cleanup();
  }
});
