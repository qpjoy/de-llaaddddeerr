#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, '..');
const mxLauncherRoot = resolve(serverRoot, '..');
const adminControllerPath = resolve(serverRoot, 'src/modules/admin/admin.controller.ts');
const outputRoot = mkdtempSync(join(tmpdir(), 'mx-domestic-dns-artifact-smoke-'));
const artifactRoot = join(outputRoot, 'domestic');
const unpackRoot = join(outputRoot, 'unpacked');

try {
  execFileSync(process.execPath, [
    join(scriptDir, 'site-slot-artifact-materializer.mjs'),
    'domestic',
    '--out-dir',
    outputRoot
  ], {
    cwd: mxLauncherRoot,
    env: {
      ...process.env,
      MX_SITE_SLOT_ALLOW_DEGRADED_QP_TUNNEL_CLI: '1',
      SITE_SLOT_RELEASE_REVISION: 'domestic-dns-53-smoke'
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });

  const manifest = JSON.parse(readFileSync(join(artifactRoot, 'manifest.json'), 'utf8'));
  const services = manifest.modules.find((module) => module.moduleId === 'domestic-services');
  assert.ok(services, 'domestic-services module is missing');
  assert.equal(services.metadata?.dnsBind, '10.88.0.1');
  assert.equal(services.metadata?.dnsPort, 53);
  assert.equal(services.metadata?.internalDnsUpstream, '10.88.88.88:53');

  mkdirSync(unpackRoot);
  execFileSync('tar', [
    '-xzf',
    join(artifactRoot, basename(services.artifact)),
    '-C',
    unpackRoot
  ]);

  const compose = readFileSync(join(unpackRoot, 'docker-compose.yml'), 'utf8');
  const corefile = readFileSync(join(unpackRoot, 'Corefile'), 'utf8');
  const envExample = readFileSync(join(unpackRoot, '.env.example'), 'utf8');
  const readme = readFileSync(join(unpackRoot, 'README.md'), 'utf8');
  const manage = readFileSync(join(unpackRoot, 'manage.sh'), 'utf8');
  execFileSync('bash', ['-n', join(unpackRoot, 'manage.sh')]);

  assert.match(compose, /\$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}:53\/udp/);
  assert.match(compose, /\$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}:53\/tcp/);
  assert.doesNotMatch(compose, /MX_DOMESTIC_DNS_BIND:-0\.0\.0\.0/);
  assert.doesNotMatch(compose, /MX_DOMESTIC_DNS_PORT:-50053/);
  assert.match(corefile, /forward \. 10\.88\.88\.88:53(?:\s|$)/);
  assert.match(envExample, /^MX_DOMESTIC_DNS_BIND=10\.88\.0\.1$/m);
  assert.match(envExample, /^MX_DOMESTIC_DNS_PORT=53$/m);
  assert.doesNotMatch(envExample, /^MX_DOMESTIC_DNS_BIND=0\.0\.0\.0$/m);
  assert.doesNotMatch(envExample, /^MX_DOMESTIC_DNS_PORT=50053$/m);
  assert.match(readme, /CoreDNS edge cache on `10\.88\.0\.1:53`/);
  assert.match(readme, /\$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}/);
  assert.match(readme, /Internal lookups to the live authority on `10\.88\.88\.88:53`/);
  assert.match(manage, /DNS profile bind: \$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}/);
  assert.match(manage, /COMPOSE_PROFILES=dns compose up -d --force-recreate --no-deps dns-forwarder/);
  assert.doesNotMatch(manage, /MX_DOMESTIC_DNS_BIND:-0\.0\.0\.0/);
  assert.doesNotMatch(manage, /MX_DOMESTIC_DNS_PORT:-50053/);

  const adminController = readFileSync(adminControllerPath, 'utf8');
  assert.match(
    adminController,
    /function domesticDnsEdgeCorefileContent[\s\S]*?'  forward \. 10\.88\.88\.88:53'/,
    'the live Domestic runtime apply path must use the reachable Internal DNS authority'
  );
  assert.doesNotMatch(
    adminController,
    /function domesticDnsEdgeCorefileContent[\s\S]*?'  forward \. 10\.88\.88\.88:50053'/,
    'the default live apply path must not target an unbound Internal port'
  );
  assert.match(
    adminController,
    /up -d --force-recreate --no-deps mx-domestic-dns-edge/,
    'runtime config apply must recreate the DNS service after atomically replacing its bind-mounted Corefile'
  );
  assert.match(
    adminController,
    /dig @"\$dns_bind" -p "\$dns_port" "\$dns_probe_name" A \+time=3 \+tries=1 \+short/,
    'runtime config apply must verify a UDP DNS query against the configured bind and port'
  );
  assert.match(
    adminController,
    /dig @"\$dns_bind" -p "\$dns_port" "\$dns_probe_name" A \+tcp \+time=3 \+tries=1 \+short/,
    'runtime config apply must verify a TCP DNS query against the configured bind and port'
  );
  assert.match(
    adminController,
    /dnsExpectedAnswer = '10\.88\.88\.88'/,
    'runtime config apply must prove that the V2 name is forwarded to Internal authority'
  );
  assert.doesNotMatch(
    adminController,
    /mx_dns_port_busy/,
    'a V1 listener on another WireGuard address must not suppress the V2 DNS service'
  );

  console.log('OK coexistence DNS apply recreates and proves UDP/TCP 10.88.0.1:53 -> Internal 10.88.88.88:53');
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
