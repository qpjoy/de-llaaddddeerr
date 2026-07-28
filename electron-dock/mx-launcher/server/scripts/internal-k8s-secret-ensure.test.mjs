import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  canonicalizeSdkServiceAccountSecrets,
  formatReadySummary,
  hasRetainedPostgresHostData,
  observedSecretBundleDigest,
  parseEnvFile,
  planInternalK8sSecrets,
  resolveKnownEnvironment
} from './internal-k8s-secret-ensure.mjs';

const namespace = 'mx-internal-shadow';
const deterministicSecret = () => 'generated-secret-000000000000000000000000';

function environment(fileContent = '', processEnvironment = {}) {
  return resolveKnownEnvironment(parseEnvFile(fileContent), processEnvironment);
}

function secret(name, values, metadata = {}) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      ...metadata
    },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        Buffer.from(value, 'utf8').toString('base64')
      ])
    )
  };
}

function decoded(resource, key) {
  return Buffer.from(resource.data[key], 'base64').toString('utf8');
}

function resource(plan, name) {
  return plan.resources.find((item) => item.metadata.name === name);
}

test('process environment takes precedence over parsed env values', () => {
  const resolved = environment(
    'PG_USER=file-user\nMX_INTERNAL_OPS_TOKEN=file-token-000000000000000000000000\n',
    {
      PG_USER: 'process-user',
      MX_INTERNAL_OPS_TOKEN: 'process-token-0000000000000000000'
    }
  );
  assert.equal(resolved.values.PG_USER, 'process-user');
  assert.equal(
    resolved.values.MX_INTERNAL_OPS_TOKEN,
    'process-token-0000000000000000000'
  );
});

test('retained PostgreSQL host data markers are detected without reading database files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-postgres-marker-'));
  const marker = join(directory, 'pgdata', 'PG_VERSION');
  try {
    assert.equal(hasRetainedPostgresHostData([marker]), false);
    mkdirSync(join(directory, 'pgdata'), { recursive: true });
    writeFileSync(marker, '16\n', { mode: 0o600 });
    assert.equal(hasRetainedPostgresHostData([marker]), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('existing database identity is preserved and defaults never overwrite it', () => {
  const existingDb = secret('mx-launcher-db', {
    PG_USER: 'established-user',
    PG_PASSWORD: 'established-password',
    PG_DB: 'established-db',
    DATABASE_HOST: 'postgres.internal',
    DATABASE_URL: 'legacy-url',
    'operator-note': 'preserve-me'
  });
  const existingOps = secret('mx-internal-ops', {
    token: 'existing-ops-token-000000000000000000000'
  });
  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment(''),
    existingSecrets: {
      'mx-launcher-db': existingDb,
      'mx-internal-ops': existingOps
    },
    randomSecret: deterministicSecret
  });
  const db = resource(plan, 'mx-launcher-db');

  assert.equal(decoded(db, 'PG_USER'), 'established-user');
  assert.equal(decoded(db, 'PG_PASSWORD'), 'established-password');
  assert.equal(decoded(db, 'PG_DB'), 'established-db');
  assert.equal(decoded(db, 'DATABASE_HOST'), 'postgres.internal');
  assert.equal(decoded(db, 'operator-note'), 'preserve-me');
  assert.equal(
    decoded(db, 'DATABASE_URL'),
    'postgres://established-user:established-password@postgres.internal:5432/established-db'
  );
});

test('existing database credentials reject accidental env replacement', () => {
  assert.throws(
    () => planInternalK8sSecrets({
      namespace,
      environment: environment('PG_PASSWORD=different-password\n'),
      existingSecrets: {
        'mx-launcher-db': secret('mx-launcher-db', {
          PG_USER: 'mx_internal',
          PG_PASSWORD: 'established-password',
          PG_DB: 'mx_internal_shadow'
        }),
        'mx-internal-ops': secret('mx-internal-ops', {
          token: 'existing-ops-token-000000000000000000000'
        })
      },
      randomSecret: deterministicSecret
    }),
    /does not match the existing mx-launcher-db Secret/
  );
});

test('new database Secret derives a URL with encoded credentials', () => {
  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment(
      'PG_USER=first@user\n'
      + 'PG_PASSWORD=p@ss:/%?#\n'
      + 'PG_DB=first/db\n'
    ),
    existingSecrets: {},
    randomSecret: deterministicSecret
  });
  assert.equal(
    decoded(resource(plan, 'mx-launcher-db'), 'DATABASE_URL'),
    'postgres://first%40user:p%40ss%3A%2F%25%3F%23@mx-internal-postgres.mx-internal-shadow.svc.cluster.local:5432/first%2Fdb'
  );
});

test('partial Feishu configuration fails before a Secret bundle can be produced', () => {
  assert.throws(
    () => planInternalK8sSecrets({
      namespace,
      environment: environment('MX_FEISHU_APP_ID=cli_test\n'),
      existingSecrets: {},
      randomSecret: deterministicSecret
    }),
    /Feishu OAuth configuration is incomplete/
  );
});

test('partial Feishu env safely fills missing values from the existing Secret', () => {
  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment('MX_FEISHU_APP_SECRET=new-secret-value\n'),
    existingSecrets: {
      'mx-launcher-db': secret('mx-launcher-db', {
        PG_USER: 'mx_internal',
        PG_PASSWORD: 'db-password',
        PG_DB: 'mx_internal_shadow'
      }),
      'mx-internal-ops': secret('mx-internal-ops', {
        token: 'existing-ops-token-000000000000000000000'
      }),
      'mx-feishu-oauth': secret('mx-feishu-oauth', {
        'app-id': 'cli_existing',
        'app-secret': 'old-secret-value',
        'tenant-keys': 'tenant-a'
      })
    },
    randomSecret: deterministicSecret
  });
  const feishu = resource(plan, 'mx-feishu-oauth');
  assert.equal(decoded(feishu, 'app-id'), 'cli_existing');
  assert.equal(decoded(feishu, 'app-secret'), 'new-secret-value');
  assert.equal(decoded(feishu, 'tenant-keys'), 'tenant-a');
});

test('an incomplete existing Feishu Secret fails closed when env does not repair it', () => {
  assert.throws(
    () => planInternalK8sSecrets({
      namespace,
      environment: environment(''),
      existingSecrets: {
        'mx-launcher-db': secret('mx-launcher-db', {
          PG_USER: 'mx_internal',
          PG_PASSWORD: 'db-password',
          PG_DB: 'mx_internal_shadow'
        }),
        'mx-internal-ops': secret('mx-internal-ops', {
          token: 'existing-ops-token-000000000000000000000'
        }),
        'mx-feishu-oauth': secret('mx-feishu-oauth', {
          'app-id': 'cli_existing',
          'app-secret': 'existing-feishu-secret'
        })
      },
      randomSecret: deterministicSecret
    }),
    /mx-feishu-oauth is incomplete; missing tenant-keys/
  );
});

test('unconfigured optional Secrets are validated where required but otherwise skipped', () => {
  const existingSdk = secret(
    'mx-sdk-service-account-secrets',
    {
      'secrets.json': JSON.stringify({
        service: 'existing-sdk-secret-000000000000000000000'
      })
    }
  );
  const existingFeishu = secret('mx-feishu-oauth', {
    'app-id': 'cli_existing',
    'app-secret': 'existing-feishu-secret',
    'tenant-keys': 'tenant-a'
  });
  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment(''),
    existingSecrets: {
      'mx-launcher-db': secret('mx-launcher-db', {
        PG_USER: 'mx_internal',
        PG_PASSWORD: 'db-password',
        PG_DB: 'mx_internal_shadow',
        DATABASE_HOST: 'mx-internal-postgres.mx-internal-shadow.svc.cluster.local',
        DATABASE_URL: 'postgres://mx_internal:db-password@mx-internal-postgres.mx-internal-shadow.svc.cluster.local:5432/mx_internal_shadow'
      }),
      'mx-internal-ops': secret('mx-internal-ops', {
        token: 'existing-ops-token-000000000000000000000'
      }),
      'mx-feishu-oauth': existingFeishu,
      'mx-sdk-service-account-secrets': existingSdk
    },
    randomSecret: deterministicSecret
  });

  assert.equal(
    plan.changedItems.some((item) => item.metadata.name === 'mx-feishu-oauth'),
    false
  );
  assert.equal(
    plan.changedItems.some((item) => item.metadata.name === 'mx-sdk-service-account-secrets'),
    false
  );
});

test('configured SDK maps are strict while omitted legacy Secrets are preserved without blocking deploy', () => {
  assert.throws(
    () => canonicalizeSdkServiceAccountSecrets('{"svc":"short"}'),
    /at least 32 characters/
  );
  assert.throws(
    () => canonicalizeSdkServiceAccountSecrets(
      '{"invalid service id":"valid-secret-00000000000000000000000"}'
    ),
    /invalid service account id/
  );
  assert.throws(
    () => canonicalizeSdkServiceAccountSecrets(JSON.stringify({
      svc_too_long: 'x'.repeat(4097)
    })),
    /at most 4096 characters/
  );
  for (const legacyData of [
    { 'secrets.json': '{not-json}' },
    { 'operator-note': 'missing-the-runtime-key' }
  ]) {
    const legacy = secret('mx-sdk-service-account-secrets', legacyData);
    const plan = planInternalK8sSecrets({
      namespace,
      environment: environment(''),
      existingSecrets: {
        'mx-launcher-db': secret('mx-launcher-db', {
          PG_USER: 'mx_internal',
          PG_PASSWORD: 'db-password',
          PG_DB: 'mx_internal_shadow'
        }),
        'mx-internal-ops': secret('mx-internal-ops', {
          token: 'existing-ops-token-000000000000000000000'
        }),
        'mx-sdk-service-account-secrets': legacy
      },
      randomSecret: deterministicSecret
    });
    assert.deepEqual(resource(plan, 'mx-sdk-service-account-secrets').data, legacy.data);
  }
});

test('SDK map is canonical and replaces the whole account map', () => {
  const firstSecret = 'first-secret-00000000000000000000000';
  const secondSecret = 'second-secret-0000000000000000000000';
  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment(
      `MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON='{" z-service ":"${secondSecret}","a-service":"${firstSecret}"}'\n`
    ),
    existingSecrets: {
      'mx-launcher-db': secret('mx-launcher-db', {
        PG_USER: 'mx_internal',
        PG_PASSWORD: 'db-password',
        PG_DB: 'mx_internal_shadow'
      }),
      'mx-internal-ops': secret('mx-internal-ops', {
        token: 'existing-ops-token-000000000000000000000'
      }),
      'mx-sdk-service-account-secrets': secret(
        'mx-sdk-service-account-secrets',
        {
          'secrets.json': JSON.stringify({
            removed: 'removed-secret-000000000000000000000'
          }),
          'operator-note': 'preserve-me'
        }
      )
    },
    randomSecret: deterministicSecret
  });
  const sdk = resource(plan, 'mx-sdk-service-account-secrets');

  assert.equal(
    decoded(sdk, 'secrets.json'),
    `{"a-service":"${firstSecret}","z-service":"${secondSecret}"}`
  );
  assert.equal(decoded(sdk, 'operator-note'), 'preserve-me');
  assert.equal(decoded(sdk, 'secrets.json').includes('removed'), false);
});

test('unknown Kubernetes data keys survive all managed updates', () => {
  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment(
      'DATABASE_HOST=postgres-new.internal\n'
      + 'MX_INTERNAL_OPS_TOKEN=rotated-ops-token-0000000000000000000000\n'
    ),
    existingSecrets: {
      'mx-launcher-db': secret('mx-launcher-db', {
        PG_USER: 'mx_internal',
        PG_PASSWORD: 'db-password',
        PG_DB: 'mx_internal_shadow',
        custom: 'db-custom'
      }),
      'mx-internal-ops': secret('mx-internal-ops', {
        token: 'existing-ops-token-000000000000000000000',
        custom: 'ops-custom'
      })
    },
    randomSecret: deterministicSecret
  });

  assert.equal(decoded(resource(plan, 'mx-launcher-db'), 'custom'), 'db-custom');
  assert.equal(decoded(resource(plan, 'mx-internal-ops'), 'custom'), 'ops-custom');
});

test('a planned bundle is idempotent when used as the next observed state', () => {
  const initial = planInternalK8sSecrets({
    namespace,
    environment: environment(
      'MX_FEISHU_APP_ID=cli_test\n'
      + 'MX_FEISHU_APP_SECRET=feishu-secret\n'
      + 'MX_FEISHU_ALLOWED_TENANT_KEYS=tenant-b, tenant-a,tenant-b\n'
    ),
    existingSecrets: {},
    randomSecret: deterministicSecret
  });
  assert.ok(initial.changedCount > 0);

  const observed = Object.fromEntries(
    initial.resources.map((item) => [item.metadata.name, item])
  );
  const repeated = planInternalK8sSecrets({
    namespace,
    environment: environment(
      'MX_FEISHU_APP_ID=cli_test\n'
      + 'MX_FEISHU_APP_SECRET=feishu-secret\n'
      + 'MX_FEISHU_ALLOWED_TENANT_KEYS=tenant-b, tenant-a,tenant-b\n'
    ),
    existingSecrets: observed,
    randomSecret: () => {
      throw new Error('idempotent planning must not generate another secret');
    }
  });

  assert.equal(repeated.changedCount, 0);
  assert.equal(repeated.bundleDigest, initial.bundleDigest);
});

test('changed existing Secrets retain resourceVersion and remove legacy last-applied data', () => {
  const initial = planInternalK8sSecrets({
    namespace,
    environment: environment(''),
    existingSecrets: {},
    randomSecret: deterministicSecret
  });
  const observed = Object.fromEntries(initial.resources.map((item, index) => [
    item.metadata.name,
    {
      ...item,
      metadata: {
        ...item.metadata,
        resourceVersion: String(40 + index),
        ownerReferences: [{
          apiVersion: 'external-secrets.io/v1beta1',
          kind: 'ExternalSecret',
          name: item.metadata.name,
          uid: `owner-${index}`
        }],
        finalizers: ['example.test/cleanup'],
        annotations: {
          ...item.metadata.annotations,
          'kubectl.kubernetes.io/last-applied-configuration': '{"data":"must-not-be-retained"}'
        }
      }
    }
  ]));

  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment(''),
    existingSecrets: observed,
    randomSecret: () => {
      throw new Error('existing credentials must be reused');
    }
  });

  assert.equal(plan.changedCount, 2);
  for (const item of plan.changedItems) {
    const source = observed[item.metadata.name];
    assert.match(item.metadata.resourceVersion, /^4[01]$/);
    assert.deepEqual(item.metadata.ownerReferences, source.metadata.ownerReferences);
    assert.deepEqual(item.metadata.finalizers, source.metadata.finalizers);
    assert.equal(
      Object.hasOwn(item.metadata.annotations, 'kubectl.kubernetes.io/last-applied-configuration'),
      false
    );
  }
});

test('summary version is based on Kubernetes resource versions, never secret material', () => {
  const secretMaterial = 'do-not-print-this-secret-0000000000000';
  const plan = planInternalK8sSecrets({
    namespace,
    environment: environment(`MX_INTERNAL_OPS_TOKEN=${secretMaterial}\n`),
    existingSecrets: {},
    randomSecret: deterministicSecret
  });
  const observed = Object.fromEntries(
    plan.resources.map((item, index) => [
      item.metadata.name,
      {
        ...item,
        metadata: {
          ...item.metadata,
          resourceVersion: String(index + 100)
        }
      }
    ])
  );
  const version = observedSecretBundleDigest(namespace, observed);
  const summary = formatReadySummary(version, plan.changedCount);

  assert.match(summary, /^ready sha256-[a-f0-9]{64} \d+$/);
  assert.equal(summary.includes(secretMaterial), false);
  assert.equal(summary.includes('MX_INTERNAL_OPS_TOKEN'), false);
  assert.notEqual(version, plan.bundleDigest);
});

test('CLI keeps secret values out of kubectl argv and scrubs its child environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-k8s-secret-cli-'));
  const kubectlPath = join(directory, 'kubectl');
	  const invocationLog = join(directory, 'kubectl-invocations.jsonl');
	  const appliedManifest = join(directory, 'applied.json');
	  const kubectlState = join(directory, 'kubectl-state.json');
  const opsSecret = 'cli-ops-secret-000000000000000000000000';
  const databaseUrl = 'postgres://user:database-secret@db.internal/db';
  const ossSecret = 'oss-secret-that-must-not-reach-kubectl';
  try {
    writeFileSync(
      kubectlPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const sensitiveKeys = Object.keys(process.env).filter((key) =>
  key === 'MX_INTERNAL_OPS_TOKEN'
  || key === 'DATABASE_URL'
  || key.startsWith('MX_RELEASE_OSS_')
);
fs.appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify({ args, sensitiveKeys }) + '\\n');
const state = fs.existsSync(process.env.FAKE_KUBECTL_STATE)
  ? JSON.parse(fs.readFileSync(process.env.FAKE_KUBECTL_STATE, 'utf8'))
  : {};
if (args.includes('get') && args.includes('secret')) {
  const name = args[args.indexOf('secret') + 1];
  if (state[name]) {
    process.stdout.write(JSON.stringify(state[name]));
    process.exit(0);
  }
  process.stderr.write('Error from server (NotFound): secrets "missing" not found\\n');
  process.exit(1);
}
if (args.includes('get')) {
  process.stderr.write('Error from server (NotFound): resource not found\\n');
  process.exit(1);
}
const input = fs.readFileSync(0, 'utf8');
const manifest = JSON.parse(input);
const current = state[manifest.metadata.name];
if (args.includes('create') && current) {
  process.stderr.write('Error from server (AlreadyExists)\\n');
  process.exit(1);
}
if (
  args.includes('replace')
  && (!current || current.metadata.resourceVersion !== manifest.metadata.resourceVersion)
) {
  process.stderr.write('Error from server (Conflict)\\n');
  process.exit(1);
}
manifest.metadata.resourceVersion = String(
  current ? Number(current.metadata.resourceVersion) + 1 : 100 + Object.keys(state).length
);
state[manifest.metadata.name] = manifest;
fs.writeFileSync(process.env.FAKE_KUBECTL_STATE, JSON.stringify(state));
fs.appendFileSync(process.env.FAKE_KUBECTL_APPLY, JSON.stringify(manifest) + '\\n');
`,
      { mode: 0o700 }
    );
    chmodSync(kubectlPath, 0o700);

    const result = spawnSync(
      process.execPath,
      [
        new URL('./internal-k8s-secret-ensure.mjs', import.meta.url).pathname,
        'ensure',
        namespace,
        join(directory, 'missing.env')
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH || ''}`,
	          FAKE_KUBECTL_LOG: invocationLog,
	          FAKE_KUBECTL_APPLY: appliedManifest,
	          FAKE_KUBECTL_STATE: kubectlState,
          MX_INTERNAL_OPS_TOKEN: opsSecret,
          DATABASE_URL: databaseUrl,
          MX_RELEASE_OSS_ACCESS_KEY_SECRET: ossSecret
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ready sha256-[a-f0-9]{64} \d+\n$/);
    assert.equal(result.stdout.includes(opsSecret), false);
    assert.equal(result.stderr.includes(opsSecret), false);

    const invocations = readFileSync(invocationLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(invocations.length >= 5);
    assert.deepEqual(invocations.flatMap((entry) => entry.sensitiveKeys), []);
    assert.equal(JSON.stringify(invocations).includes(opsSecret), false);
    assert.equal(JSON.stringify(invocations).includes(databaseUrl), false);
    assert.equal(JSON.stringify(invocations).includes(ossSecret), false);

	    const manifests = readFileSync(appliedManifest, 'utf8')
	      .trim()
	      .split('\n')
	      .map((line) => JSON.parse(line));
	    assert.ok(manifests.some((item) => item.metadata.name === 'mx-launcher-db'));
	    assert.ok(manifests.some((item) => item.metadata.name === 'mx-internal-ops'));
	    assert.ok(invocations.some((entry) => entry.args.includes('create')));
	    assert.equal(invocations.some((entry) => entry.args.includes('apply')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI fails closed on a stale resourceVersion instead of overwriting a concurrent rotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-k8s-secret-conflict-'));
  const kubectlPath = join(directory, 'kubectl');
  const stateFile = join(directory, 'state.json');
  const replaceInput = join(directory, 'replace-input.json');
  const envFile = join(directory, 'server.env');
  const rotatedToken = 'rotated-ops-token-0000000000000000000000';
  const initial = planInternalK8sSecrets({
    namespace,
    environment: environment(''),
    existingSecrets: {},
    randomSecret: deterministicSecret
  });
  const state = Object.fromEntries(initial.resources.map((item, index) => [
    item.metadata.name,
    {
      ...item,
      metadata: {
        ...item.metadata,
        resourceVersion: String(index + 10)
      }
    }
  ]));
  try {
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    writeFileSync(envFile, `MX_INTERNAL_OPS_TOKEN=${rotatedToken}\n`, { mode: 0o600 });
    chmodSync(stateFile, 0o600);
    chmodSync(envFile, 0o600);
    writeFileSync(
      kubectlPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
if (args.includes('get') && args.includes('secret')) {
  const name = args[args.indexOf('secret') + 1];
  if (state[name]) {
    process.stdout.write(JSON.stringify(state[name]));
    process.exit(0);
  }
  process.stderr.write('Error from server (NotFound): secret not found\\n');
  process.exit(1);
}
if (args.includes('replace')) {
  fs.writeFileSync(process.env.FAKE_REPLACE_INPUT, fs.readFileSync(0, 'utf8'));
  process.stderr.write('Error from server (Conflict): object was modified\\n');
  process.exit(1);
}
process.stderr.write('unexpected kubectl invocation\\n');
process.exit(1);
`,
      { mode: 0o700 }
    );
    chmodSync(kubectlPath, 0o700);

    const result = spawnSync(
      process.execPath,
      [
        new URL('./internal-k8s-secret-ensure.mjs', import.meta.url).pathname,
        'ensure',
        namespace,
        envFile
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH || ''}`,
          FAKE_STATE: stateFile,
          FAKE_REPLACE_INPUT: replaceInput
        }
      }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed concurrently or could not be replaced/);
    assert.equal(result.stderr.includes(rotatedToken), false);
    assert.equal(result.stdout.includes(rotatedToken), false);
    assert.equal(readFileSync(stateFile, 'utf8').includes(rotatedToken), false);
    const replacement = JSON.parse(readFileSync(replaceInput, 'utf8'));
    assert.equal(replacement.metadata.name, 'mx-internal-ops');
    assert.equal(
      replacement.metadata.resourceVersion,
      state['mx-internal-ops'].metadata.resourceVersion
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI refuses to generate database credentials over retained PostgreSQL storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-k8s-secret-pvc-'));
  const kubectlPath = join(directory, 'kubectl');
  const applyMarker = join(directory, 'apply-was-called');
  try {
    writeFileSync(
      kubectlPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('persistentvolumeclaim') && process.env.FAKE_STORAGE_MODE === 'pvc') {
  process.stdout.write('persistentvolumeclaim/postgres-data-mx-internal-postgres-0\\n');
  process.exit(0);
}
if (args.includes('persistentvolume') && process.env.FAKE_STORAGE_MODE === 'pv') {
  process.stdout.write('persistentvolume/mx-internal-postgres-local-pv');
  process.exit(0);
}
if (args.includes('create') || args.includes('replace')) {
  fs.writeFileSync(process.env.FAKE_APPLY_MARKER, 'called');
}
process.stderr.write('Error from server (NotFound): secrets "missing" not found\\n');
process.exit(1);
`,
      { mode: 0o700 }
    );
    chmodSync(kubectlPath, 0o700);

    for (const storageMode of ['pvc', 'pv']) {
      const result = spawnSync(
        process.execPath,
        [
          new URL('./internal-k8s-secret-ensure.mjs', import.meta.url).pathname,
          'ensure',
          namespace,
          join(directory, 'missing.env')
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH || ''}`,
            FAKE_APPLY_MARKER: applyMarker,
            FAKE_STORAGE_MODE: storageMode
          }
        }
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /mx-launcher-db is missing while PostgreSQL PV/);
      assert.equal(existsSync(applyMarker), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI rejects a server env file that is group/world readable', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-k8s-secret-mode-'));
  const envFile = join(directory, 'server.env');
  try {
    writeFileSync(envFile, 'MX_INTERNAL_OPS_TOKEN=mode-test-token-000000000000000000000\n', {
      mode: 0o644
    });
    chmodSync(envFile, 0o644);
    const result = spawnSync(
      process.execPath,
      [
        new URL('./internal-k8s-secret-ensure.mjs', import.meta.url).pathname,
        'validate-env',
        namespace,
        envFile
      ],
      { encoding: 'utf8' }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /chmod 600/);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('kubeadm recovery preflight requires all original database identity values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-k8s-db-recovery-'));
  const envFile = join(directory, 'server.env');
  const command = [
    new URL('./internal-k8s-secret-ensure.mjs', import.meta.url).pathname,
    'validate-db-recovery-env',
    namespace,
    envFile
  ];
  try {
    writeFileSync(envFile, [
      'PG_USER=mx_internal',
      'PG_PASSWORD=original-database-secret',
      'PG_DB=mx_internal_shadow'
    ].join('\n'), { mode: 0o600 });
    chmodSync(envFile, 0o600);
    const complete = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(complete.status, 0, complete.stderr);

    writeFileSync(envFile, 'PG_USER=mx_internal\nPG_DB=mx_internal_shadow\n', {
      mode: 0o600
    });
    chmodSync(envFile, 0o600);
    const incomplete = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /requires the original PG_USER, PG_PASSWORD, and PG_DB together/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
