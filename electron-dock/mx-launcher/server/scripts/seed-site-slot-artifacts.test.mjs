import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { seedSiteSlotArtifacts } from './seed-site-slot-artifacts.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const WG_FILES = [
  'mx-domestic-wg-relay.conf',
  'mx-domestic-wg.conf',
  'mx-internal-service-peer.conf',
  'mx-internal-service-peer-apply.sh',
  'mx-domestic-relay.env'
];
const SUBSCRIPTION_FILES = [
  'mx-domestic-bootstrap-subscription.yaml',
  'mx-internal-egress-subscription.yaml'
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mx-site-slot-seed-'));
  const image = join(root, 'image');
  const runtime = join(root, 'runtime');
  mkdirSync(image, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  return {
    root,
    image,
    runtime,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function module(moduleId, status, files, metadata = {}) {
  return {
    moduleId,
    status,
    artifact: `server/artifacts/site-slots/domestic/${files[0]}`,
    artifactPath: `/app/runtime-artifacts/site-slots/domestic/${files[0]}`,
    sha256: null,
    bytes: null,
    targetPath: `/target/${moduleId}`,
    metadata,
    sourcePaths: [],
    files,
    notes: [`${moduleId}-${status}`]
  };
}

function manifest(kind, revision, modules) {
  return {
    manifestVersion: 'site-slot-artifacts-v1',
    kind,
    releaseRevision: revision,
    generatedAt: '2026-08-13T00:00:00.000Z',
    modules
  };
}

function writeArtifactSet(root, kind, value, files = {}) {
  const artifactRoot = join(root, kind);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(join(artifactRoot, 'manifest.json'), JSON.stringify(value, null, 2));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(artifactRoot, name), content);
  }
}

function readManifest(root, kind = 'domestic') {
  return JSON.parse(readFileSync(join(root, kind, 'manifest.json'), 'utf8'));
}

function moduleById(value, moduleId) {
  return value.modules.find((item) => item.moduleId === moduleId);
}

test('image refresh preserves ready runtime WireGuard and runtime subscription secrets only', () => {
  const files = fixture();
  try {
    const imageWireguard = module('wireguard-config', 'template', WG_FILES, {
      secretMaterial: 'placeholder'
    });
    const imageDomesticService = module('domestic-services', 'ready', ['domestic-services.tar.gz'], {
      release: 'new'
    });
    const imageBootstrap = module('domestic-bootstrap-subscription', 'runtime-generated', [SUBSCRIPTION_FILES[0]], {
      source: 'image-contract',
      containsSecret: true
    });
    const imageInternalEgress = module('internal-egress-subscription', 'runtime-generated', [SUBSCRIPTION_FILES[1]], {
      source: 'image-contract',
      containsSecret: true
    });
    writeArtifactSet(files.image, 'domestic', manifest('domestic', 'image-v2', [
      imageDomesticService,
      imageBootstrap,
      imageInternalEgress,
      imageWireguard
    ]), {
      ...Object.fromEntries(WG_FILES.map((name) => [name, `image-template:${name}`])),
      [SUBSCRIPTION_FILES[0]]: 'image-must-not-win-bootstrap',
      [SUBSCRIPTION_FILES[1]]: 'image-must-not-win-internal',
      'domestic-services.tar.gz': 'image-domestic-service-v2'
    });
    writeArtifactSet(files.image, 'oversea', manifest('oversea', 'image-v2', [
      module('oversea-services', 'ready', ['oversea-services.tar.gz'], { release: 'new' })
    ]), {
      'oversea-services.tar.gz': 'image-oversea-service-v2'
    });

    const runtimeWireguard = module('wireguard-config', 'ready', WG_FILES, {
      secretMaterial: 'injected',
      publicEndpoint: '116.62.51.154:51280'
    });
    const runtimeBootstrap = module('domestic-bootstrap-subscription', 'runtime-generated', [SUBSCRIPTION_FILES[0]], {
      generation: 'runtime-bootstrap',
      containsSecret: true
    });
    const runtimeInternalEgress = module('internal-egress-subscription', 'runtime-generated', [SUBSCRIPTION_FILES[1]], {
      generation: 'runtime-internal',
      containsSecret: true
    });
    writeArtifactSet(files.runtime, 'domestic', manifest('domestic', 'runtime-v1', [
      module('domestic-services', 'ready', ['domestic-services.tar.gz'], { release: 'old' }),
      runtimeBootstrap,
      runtimeInternalEgress,
      runtimeWireguard
    ]), {
      ...Object.fromEntries(WG_FILES.map((name) => [name, `runtime-secret:${name}`])),
      [SUBSCRIPTION_FILES[0]]: 'runtime-bootstrap-secret',
      [SUBSCRIPTION_FILES[1]]: 'runtime-internal-secret',
      'domestic-services.tar.gz': 'runtime-domestic-service-v1'
    });
    chmodSync(join(files.runtime, 'domestic', 'mx-internal-service-peer-apply.sh'), 0o700);
    for (const name of SUBSCRIPTION_FILES) chmodSync(join(files.runtime, 'domestic', name), 0o600);
    const runtimeSecretEvidence = Object.fromEntries(
      SUBSCRIPTION_FILES.map((name) => {
        const path = join(files.runtime, 'domestic', name);
        return [name, {
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
          mode: statSync(path).mode & 0o777
        }];
      })
    );
    writeArtifactSet(files.runtime, 'oversea', manifest('oversea', 'runtime-v1', []), {
      'oversea-services.tar.gz': 'runtime-oversea-service-v1'
    });

    const result = seedSiteSlotArtifacts({ imageDir: files.image, runtimeDir: files.runtime });
    assert.equal(result.status, 'seeded');
    assert.deepEqual(result.preservedModules, [
      'domestic-bootstrap-subscription',
      'internal-egress-subscription',
      'wireguard-config'
    ]);
    for (const name of WG_FILES) {
      assert.equal(readFileSync(join(files.runtime, 'domestic', name), 'utf8'), `runtime-secret:${name}`);
    }
    assert.equal(
      statSync(join(files.runtime, 'domestic', 'mx-internal-service-peer-apply.sh')).mode & 0o777,
      0o700
    );
    assert.equal(readFileSync(join(files.runtime, 'domestic', SUBSCRIPTION_FILES[0]), 'utf8'), 'runtime-bootstrap-secret');
    assert.equal(readFileSync(join(files.runtime, 'domestic', SUBSCRIPTION_FILES[1]), 'utf8'), 'runtime-internal-secret');
    for (const name of SUBSCRIPTION_FILES) {
      const path = join(files.runtime, 'domestic', name);
      assert.equal(
        createHash('sha256').update(readFileSync(path)).digest('hex'),
        runtimeSecretEvidence[name].sha256
      );
      assert.equal(statSync(path).mode & 0o777, runtimeSecretEvidence[name].mode);
    }
    assert.equal(readFileSync(join(files.runtime, 'domestic', 'domestic-services.tar.gz'), 'utf8'), 'image-domestic-service-v2');
    assert.equal(readFileSync(join(files.runtime, 'oversea', 'oversea-services.tar.gz'), 'utf8'), 'image-oversea-service-v2');

    const seededManifest = readManifest(files.runtime);
    assert.deepEqual(moduleById(seededManifest, 'wireguard-config'), runtimeWireguard);
    assert.deepEqual(moduleById(seededManifest, 'domestic-bootstrap-subscription'), runtimeBootstrap);
    assert.deepEqual(moduleById(seededManifest, 'internal-egress-subscription'), runtimeInternalEgress);
    assert.deepEqual(moduleById(seededManifest, 'domestic-services'), imageDomesticService);
    const manifestText = readFileSync(join(files.runtime, 'domestic', 'manifest.json'));
    const expectedSha = createHash('sha256').update(manifestText).digest('hex');
    assert.equal(
      readFileSync(join(files.runtime, 'domestic', 'manifest.json.sha256'), 'utf8'),
      `${expectedSha}  manifest.json\n`
    );
    assert.equal(readFileSync(join(files.runtime, '.image-artifact-revision'), 'utf8'), `${result.revision}\n`);
  } finally {
    files.cleanup();
  }
});

test('missing or invalid runtime WireGuard seeds the image template and no image-layer subscription secrets', () => {
  const files = fixture();
  try {
    const imageWireguard = module('wireguard-config', 'template', WG_FILES, {
      secretMaterial: 'placeholder'
    });
    const imageBootstrap = module('domestic-bootstrap-subscription', 'ready', [SUBSCRIPTION_FILES[0]], {
      source: 'internal-config-center',
      containsSecret: true
    });
    const imageInternalEgress = module('internal-egress-subscription', 'ready', [SUBSCRIPTION_FILES[1]], {
      source: 'internal-config-center',
      containsSecret: true
    });
    writeArtifactSet(files.image, 'domestic', manifest('domestic', 'image-v1', [
      imageBootstrap,
      imageInternalEgress,
      imageWireguard
    ]), {
      ...Object.fromEntries(WG_FILES.map((name) => [name, `template:${name}`])),
      [SUBSCRIPTION_FILES[0]]: 'stale-image-bootstrap-secret',
      [SUBSCRIPTION_FILES[1]]: 'stale-image-internal-secret'
    });
    writeArtifactSet(files.image, 'oversea', manifest('oversea', 'image-v1', []));
    writeArtifactSet(files.runtime, 'domestic', manifest('domestic', 'runtime-invalid', [
      module('wireguard-config', 'ready', WG_FILES, { secretMaterial: 'placeholder' })
    ]), {
      ...Object.fromEntries(WG_FILES.map((name) => [name, `invalid-runtime:${name}`])),
      [SUBSCRIPTION_FILES[0]]: 'orphan-runtime-bootstrap-secret',
      [SUBSCRIPTION_FILES[1]]: 'orphan-runtime-internal-secret'
    });

    seedSiteSlotArtifacts({ imageDir: files.image, runtimeDir: files.runtime });
    for (const name of WG_FILES) {
      assert.equal(readFileSync(join(files.runtime, 'domestic', name), 'utf8'), `template:${name}`);
    }
    for (const name of SUBSCRIPTION_FILES) {
      assert.equal(existsSync(join(files.runtime, 'domestic', name)), false);
    }
    const seededManifest = readManifest(files.runtime);
    assert.deepEqual(moduleById(seededManifest, 'wireguard-config'), imageWireguard);
    assert.deepEqual(moduleById(seededManifest, 'domestic-bootstrap-subscription'), {
      ...imageBootstrap,
      status: 'runtime-generated',
      sha256: null,
      bytes: null
    });
    assert.deepEqual(moduleById(seededManifest, 'internal-egress-subscription'), {
      ...imageInternalEgress,
      status: 'runtime-generated',
      sha256: null,
      bytes: null
    });
  } finally {
    files.cleanup();
  }
});

test('a failed refresh never advances the image revision stamp', () => {
  const files = fixture();
  try {
    const runtimeWireguard = module('wireguard-config', 'ready', WG_FILES, {
      secretMaterial: 'injected'
    });
    writeArtifactSet(files.runtime, 'domestic', manifest('domestic', 'runtime-v1', [runtimeWireguard]), {
      ...Object.fromEntries(WG_FILES.map((name) => [name, `runtime-secret:${name}`]))
    });
    const domesticRoot = join(files.image, 'domestic');
    mkdirSync(domesticRoot, { recursive: true });
    writeFileSync(join(domesticRoot, 'manifest.json'), '{invalid-json');
    writeArtifactSet(files.image, 'oversea', manifest('oversea', 'image-v1', []));
    assert.throws(
      () => seedSiteSlotArtifacts({ imageDir: files.image, runtimeDir: files.runtime }),
      /image Domestic artifact manifest is invalid/
    );
    assert.equal(existsSync(join(files.runtime, '.image-artifact-revision')), false);
    assert.equal(
      readFileSync(join(files.runtime, 'domestic', 'mx-domestic-wg-relay.conf'), 'utf8'),
      'runtime-secret:mx-domestic-wg-relay.conf'
    );
    assert.equal(readManifest(files.runtime).releaseRevision, 'runtime-v1');
  } finally {
    files.cleanup();
  }
});

test('the Internal deployment delegates artifact seeding to the tested script', () => {
  const deployment = readFileSync(
    join(scriptDir, '../../deploy/k8s/internal-shadow/40-internal-api.yaml'),
    'utf8'
  );
  assert.match(deployment, /- node\s+- \/app\/scripts\/seed-site-slot-artifacts\.mjs/);
  assert.match(deployment, /- --image-dir\s+- \/app\/artifacts\/site-slots/);
  assert.match(deployment, /- --runtime-dir\s+- \/app\/runtime-artifacts\/site-slots/);
  assert.doesNotMatch(deployment, /cp -a \/app\/artifacts\/site-slots/);
});

test('image materialization never preserves runtime subscription secrets', () => {
  const files = fixture();
  try {
    const domesticRoot = join(files.runtime, 'domestic');
    mkdirSync(domesticRoot, { recursive: true });
    for (const name of SUBSCRIPTION_FILES) {
      writeFileSync(join(domesticRoot, name), `runtime-secret-that-must-not-enter-image:${name}`);
      chmodSync(join(domesticRoot, name), 0o600);
    }
    const materializer = join(scriptDir, 'site-slot-artifact-materializer.mjs');
    execFileSync(process.execPath, [
      materializer,
      'domestic',
      '--out-dir', files.runtime,
      '--no-preserve-runtime-secrets'
    ], {
      env: {
        ...process.env,
        MX_SITE_SLOT_ALLOW_DEGRADED_QP_TUNNEL_CLI: '1',
        MX_DOMESTIC_RELAY_PRIVATE_KEY: 'A'.repeat(43) + '=',
        MX_DOMESTIC_RELAY_PUBLIC_KEY: 'B'.repeat(43) + '=',
        MX_INTERNAL_SERVICE_PRIVATE_KEY: 'C'.repeat(43) + '=',
        MX_INTERNAL_SERVICE_PUBLIC_KEY: 'D'.repeat(43) + '=',
        MX_DOMESTIC_PUBLIC_ENDPOINT: '203.0.113.250:59999'
      },
      stdio: 'ignore'
    });

    for (const name of SUBSCRIPTION_FILES) {
      assert.equal(existsSync(join(domesticRoot, name)), false, `${name} must not exist in image artifacts`);
    }
    const value = readManifest(files.runtime);
    const wireguard = moduleById(value, 'wireguard-config');
    assert.equal(wireguard.status, 'template');
    assert.equal(wireguard.metadata.secretMaterial, 'placeholder');
    for (const name of WG_FILES) {
      const content = readFileSync(join(domesticRoot, name), 'utf8');
      assert.doesNotMatch(content, /A{43}=|B{43}=|C{43}=|D{43}=|203\.0\.113\.250:59999/);
    }
    for (const moduleId of ['domestic-bootstrap-subscription', 'internal-egress-subscription']) {
      const runtimeModule = moduleById(value, moduleId);
      assert.equal(runtimeModule.status, 'runtime-generated');
      assert.equal(runtimeModule.sha256, null);
      assert.equal(runtimeModule.bytes, null);
      assert.equal(runtimeModule.metadata.containsSecret, true);
    }

    const manageSource = readFileSync(join(scriptDir, '../../scripts/manage.sh'), 'utf8');
    assert.match(
      manageSource,
      /site-slot-artifact-materializer\.mjs all --out-dir server\/artifacts\/site-slots --no-preserve-runtime-secrets/,
      'the Docker image build must always opt out of runtime-secret preservation'
    );
    const dockerIgnore = readFileSync(join(scriptDir, '../.dockerignore'), 'utf8');
    for (const directory of ['release-center', 'ssh', 'internal-shadow-gates']) {
      assert.match(
        dockerIgnore,
        new RegExp(`^artifacts/${directory}$$`, 'm'),
        `runtime-owned artifacts/${directory} must stay outside every Docker build context`
      );
    }
    for (const name of SUBSCRIPTION_FILES) {
      assert.match(
        dockerIgnore,
        new RegExp(`^artifacts/site-slots/domestic/${name.replaceAll('.', '\\.')}$$`, 'm'),
        `${name} must be excluded from every Docker build context`
      );
    }
  } finally {
    files.cleanup();
  }
});
