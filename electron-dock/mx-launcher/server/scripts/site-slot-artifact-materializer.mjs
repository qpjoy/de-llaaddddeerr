#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mxRoot = resolve(scriptDir, '../..');
const args = process.argv.slice(2);
const kind = args.find((arg) => !arg.startsWith('--')) || 'all';
const outDirArg = optionValue('--out-dir');
const outputBase = resolve(outDirArg || process.env.SITE_SLOT_ARTIFACT_OUTPUT_DIR || join(mxRoot, 'artifacts/site-slots'));
const releaseRevision = process.env.SITE_SLOT_RELEASE_REVISION || gitRevision() || timestampRevision();

if (!['oversea', 'domestic', 'all'].includes(kind)) {
  die('Usage: node server/scripts/site-slot-artifact-materializer.mjs [oversea|domestic|all] [--out-dir DIR]');
}

const materialized = [];
if (kind === 'oversea' || kind === 'all') materialized.push(materializeOversea());
if (kind === 'domestic' || kind === 'all') materialized.push(materializeDomestic());

console.log(JSON.stringify({
  ok: true,
  releaseRevision,
  outputBase,
  artifactSets: materialized.map((manifest) => ({
    kind: manifest.kind,
    artifactRoot: manifest.artifactRoot,
    modules: manifest.modules.map((module) => ({
      moduleId: module.moduleId,
      status: module.status,
      artifact: module.artifact,
      sha256: module.sha256
    }))
  }))
}, null, 2));

function materializeOversea() {
  const artifactRoot = resetArtifactRoot('oversea');
  const modules = [];
  modules.push(createTarModule({
    artifactRoot,
    moduleId: 'hysteria2-access-stack',
    artifactName: 'mx-oversea-access-stack.tar.gz',
    targetPath: '/opt/mx/current/hysteria2-access-stack',
    status: 'ready',
    metadata: {
      accessRuntime: 'hysteria2-only',
      mihomoDeployment: 'internal-managed',
      routingPolicy: 'cn-direct',
      reservedInternalCidrs: ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16', '10.91.0.0/16'],
      domesticGatewayIp: '10.88.0.1',
      subscriptionStore: 'config-center',
      tunnelCliRegistration: '@qpjoy/tunnel-cli register'
    },
    notes: ['Real hysteria2 access stack module; mihomo/subscription storage stay on Internal, CN traffic stays direct, and the target host does not receive the repository root.'],
    buildStaging: (staging) => {
      const sourceRoot = resolve(mxRoot, 'site-slots/oversea/hysteria2-access-stack');
      copyRequired(sourceRoot, staging, [
        '.env.example',
        'Caddyfile',
        'docker-compose.yml',
        'manage.sh',
        'scripts/reconcile-tunnel-state.mjs',
        'scripts/reconcile-tunnel-state.py'
      ]);
      chmodIfExists(join(staging, 'manage.sh'), 0o755);
    }
  }));
  modules.push(createPlaceholderServicesTar({
    artifactRoot,
    kind: 'oversea',
    artifactName: 'mx-oversea-services.tar.gz',
    targetPath: '/opt/mx/current/oversea',
    enabledModules: ['access-node', 'site-agent', 'runner-worker', 'observability-forwarder']
  }));
  return writeManifest('oversea', artifactRoot, modules);
}

function materializeDomestic() {
  const artifactRoot = resetArtifactRoot('domestic');
  const modules = [];
  modules.push(createTunnelCliTar(artifactRoot));
  modules.push(createWireGuardTemplate(artifactRoot));
  modules.push(createPlaceholderServicesTar({
    artifactRoot,
    kind: 'domestic',
    artifactName: 'mx-domestic-services.tar.gz',
    targetPath: '/opt/mx/current/domestic',
    enabledModules: ['relay-facade', 'h2i-proxy', 'api-proxy', 'snapshot-cache', 'observability-forwarder']
  }));
  return writeManifest('domestic', artifactRoot, modules);
}

function createTunnelCliTar(artifactRoot) {
  const sourceRoot = resolve(mxRoot, 'site-slots/domestic/qp-tunnel-cli');
  const packageJson = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
  return createTarModule({
    artifactRoot,
    moduleId: 'qp-tunnel-cli',
    artifactName: 'mx-domestic-qp-tunnel-cli-fallback.tar.gz',
    targetPath: '/opt/mx/current/qp-tunnel-cli',
    status: 'ready',
    metadata: {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      npmInstallCommand: 'npm i -g @qpjoy/tunnel-cli',
      refreshCommand: 'bash scripts/manage.sh ops site-slot refresh-tunnel-cli latest',
      fallbackMode: 'mihomo-client-resource-wrapper'
    },
    notes: ['Official path is npm i -g @qpjoy/tunnel-cli; this no-outbound fallback only wraps resources/mihomo-client.sh for bootstrap commands.'],
    buildStaging: (staging) => {
      copyRequired(sourceRoot, join(staging, 'package'), [
        'package.json',
        'README.md',
        'README.setup.md',
        'dist/index.js',
        'dist/hdo.js',
        'dist/index.d.ts',
        'dist/hdo.d.ts',
        'resources/mihomo-client.sh'
      ]);
      const binDir = join(staging, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'qp-tunnel-cli'), [
        '#!/usr/bin/env sh',
        'set -eu',
        'ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
        'exec "$ROOT/package/resources/mihomo-client.sh" "$@"',
        ''
      ].join('\n'));
      chmodIfExists(join(binDir, 'qp-tunnel-cli'), 0o755);
      chmodIfExists(join(staging, 'package/resources/mihomo-client.sh'), 0o755);
    }
  });
}

function createWireGuardTemplate(artifactRoot) {
  const relayConfigPath = join(artifactRoot, 'mx-domestic-wg-relay.conf');
  const compatibilityConfigPath = join(artifactRoot, 'mx-domestic-wg.conf');
  const internalPeerConfigPath = join(artifactRoot, 'mx-internal-service-peer.conf');
  const relayEnvPath = join(artifactRoot, 'mx-domestic-relay.env');
  const relayConfig = [
    '# MX Domestic WireGuard relay template generated by Artifact Materializer V1.',
    '# Internal owns key material. Replace placeholders before real apply.',
    '# Domestic is the public relay: it listens on 51820 and owns 10.88.0.1.',
    '[Interface]',
    'Address = 10.88.0.1/16',
    'ListenPort = 51820',
    'PrivateKey = <domestic-relay-private-key-from-internal-secret>',
    'Table = off',
    'SaveConfig = false',
    'PostUp = sysctl -w net.ipv4.ip_forward=1',
    '',
    '# Internal service peer. Internal has no public ingress and dials this relay outbound.',
    '[Peer]',
    'PublicKey = <internal-service-public-key-from-internal-secret>',
    'AllowedIPs = 10.90.0.10/32',
    '',
    '# Home peers are appended by Internal-signed relay leases after enroll.',
    '# User leases: 10.89.0.0/16; guest leases: 10.91.0.0/16.',
    ''
  ].join('\n');
  const internalPeerConfig = [
    '# MX Internal service peer template generated by Artifact Materializer V1.',
    '# Apply inside Internal runtime so Internal can reach Domestic relay without public ingress.',
    '[Interface]',
    'Address = 10.90.0.10/32',
    'PrivateKey = <internal-service-private-key-from-internal-secret>',
    'DNS = 10.88.0.1',
    'Table = off',
    '',
    '[Peer]',
    'PublicKey = <domestic-relay-public-key-from-internal-secret>',
    'Endpoint = <domestic-public-ip>:51820',
    'AllowedIPs = 10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16',
    'PersistentKeepalive = 25',
    ''
  ].join('\n');
  const relayEnv = [
    'MX_DOMESTIC_GATEWAY_IP=10.88.0.1',
    'MX_INTERNAL_SERVICE_IP=10.90.0.10',
    'MX_WG_INTERFACE=mx-domestic',
    'MX_WG_LISTEN_PORT=51820',
    'MX_PUBLIC_FACADE_MODE=bootstrap-only',
    'MX_STEADY_STATE_ACCESS=domestic-wg-relay-primary',
    'MX_USER_RELAY_CIDR=10.89.0.0/16',
    'MX_INTERNAL_SERVICE_CIDR=10.90.0.0/16',
    'MX_GUEST_RELAY_CIDR=10.91.0.0/16',
    ''
  ].join('\n');
  writeFileSync(relayConfigPath, relayConfig);
  writeFileSync(compatibilityConfigPath, relayConfig);
  writeFileSync(internalPeerConfigPath, internalPeerConfig);
  writeFileSync(relayEnvPath, relayEnv);
  const bytes = [relayConfigPath, compatibilityConfigPath, internalPeerConfigPath, relayEnvPath]
    .reduce((sum, file) => sum + statSync(file).size, 0);
  return {
    moduleId: 'wireguard-config',
    status: 'template',
    artifact: relative(mxRoot, relayConfigPath),
    artifactPath: relayConfigPath,
    sha256: sha256File(relayConfigPath),
    bytes,
    targetPath: '/etc/wireguard/mx-domestic.conf',
    sourcePaths: [],
    files: ['mx-domestic-wg-relay.conf', 'mx-domestic-wg.conf', 'mx-internal-service-peer.conf', 'mx-domestic-relay.env'],
    metadata: {
      domesticGatewayIp: '10.88.0.1',
      internalServicePeerIp: '10.90.0.10',
      listenPort: 51820,
      hdiWithoutRelay: 'bootstrap-proxy-only',
      steadyStateAccess: 'domestic-wg-relay-primary',
      userRelayCidr: '10.89.0.0/16',
      guestRelayCidr: '10.91.0.0/16'
    },
    notes: [
      'Template artifact only; Internal secret injection must replace placeholders before real apply.',
      'Domestic installs mx-domestic-wg-relay.conf; Internal consumes mx-internal-service-peer.conf to dial the public relay outbound.'
    ]
  };
}

function createPlaceholderServicesTar({ artifactRoot, kind, artifactName, targetPath, enabledModules }) {
  return createTarModule({
    artifactRoot,
    moduleId: `${kind}-services`,
    artifactName,
    targetPath,
    status: 'placeholder',
    notes: ['Shadow service bundle keeps the artifact contract stable until concrete site-agent/forwarder services land.'],
    buildStaging: (staging) => {
      writeFileSync(join(staging, 'README.md'), [
        `# MX ${kind} Services Placeholder`,
        '',
        'This artifact is intentionally module-scoped and does not contain the repository root.',
        'Replace this placeholder with concrete service code before production deployment.',
        ''
      ].join('\n'));
      writeFileSync(join(staging, 'docker-compose.yml'), [
        'name: mx-site-slot-placeholder',
        'services: {}',
        ''
      ].join('\n'));
      writeFileSync(join(staging, 'enabled-modules.json'), JSON.stringify({
        kind,
        enabledModules,
        placeholder: true
      }, null, 2));
    }
  });
}

function createTarModule({ artifactRoot, moduleId, artifactName, targetPath, status, metadata = {}, notes, buildStaging }) {
  const staging = join(artifactRoot, '.staging', moduleId);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  buildStaging(staging);

  const artifactPath = join(artifactRoot, artifactName);
  execFileSync('tar', ['-czf', artifactPath, '-C', staging, '.'], {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  });
  const files = listRelativeFiles(staging);
  return {
    moduleId,
    status,
    artifact: relative(mxRoot, artifactPath),
    artifactPath,
    sha256: sha256File(artifactPath),
    bytes: statSync(artifactPath).size,
    targetPath,
    metadata,
    sourcePaths: files.map((file) => `${moduleId}:${file}`),
    files,
    notes
  };
}

function writeManifest(kindValue, artifactRoot, modules) {
  rmSync(join(artifactRoot, '.staging'), { recursive: true, force: true });
  const manifest = {
    manifestVersion: 'site-slot-artifacts-v1',
    kind: kindValue,
    releaseRevision,
    generatedAt: new Date().toISOString(),
    artifactRoot,
    artifactRootRelative: relative(mxRoot, artifactRoot),
    policy: {
      packaging: 'module-scoped',
      transport: 'rsync-over-openssh-with-scp-fallback',
      excluded: ['.git', 'docs', 'tests', 'local fixtures', 'node_modules', 'unrelated workspace packages'],
      repositoryRootSynced: false
    },
    modules
  };
  const manifestPath = join(artifactRoot, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  manifest.manifestPath = manifestPath;
  manifest.manifestSha256 = sha256File(manifestPath);
  writeFileSync(`${manifestPath}.sha256`, `${manifest.manifestSha256}  manifest.json\n`);
  return manifest;
}

function resetArtifactRoot(kindValue) {
  const root = join(outputBase, kindValue);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function copyRequired(sourceRoot, targetRoot, files) {
  for (const file of files) {
    const source = join(sourceRoot, file);
    const target = join(targetRoot, file);
    if (!existsSync(source)) die(`Missing required artifact source: ${source}`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

function chmodIfExists(path, mode) {
  if (existsSync(path)) chmodSync(path, mode);
}

function listRelativeFiles(root) {
  const out = [];
  visit(root);
  return out.sort();

  function visit(dir) {
    const entries = execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    for (const entry of entries) out.push(relative(root, entry));
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: mxRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

function timestampRevision() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

function die(message) {
  console.error(message);
  process.exit(1);
}
