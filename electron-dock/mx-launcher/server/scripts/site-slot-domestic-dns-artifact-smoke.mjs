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
const domainPath = resolve(serverRoot, 'src/store/domain.ts');
const internalGatewayPath = resolve(mxLauncherRoot, 'deploy/k8s/internal-shadow/45-internal-gateway.yaml');
const internalConfigPath = resolve(mxLauncherRoot, 'deploy/k8s/internal-shadow/10-configmap.yaml');
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
  assert.equal(services.metadata?.bootstrapHost, 'h2i.minsight-ai.com');
  assert.equal(services.metadata?.publicGatewayNetwork, 'compass-gateway_default');
  assert.equal(services.metadata?.publicGatewayUpstream, 'http://mx-domestic-edge:8088');
  assert.equal(services.metadata?.internalDnsUpstream, '10.88.88.88:53');

  mkdirSync(unpackRoot);
  execFileSync('tar', [
    '-xzf',
    join(artifactRoot, basename(services.artifact)),
    '-C',
    unpackRoot
  ]);

  const compose = readFileSync(join(unpackRoot, 'docker-compose.yml'), 'utf8');
  const publicGatewayCompose = readFileSync(
    join(unpackRoot, 'docker-compose.public-gateway.yml'),
    'utf8'
  );
  const caddyfile = readFileSync(join(unpackRoot, 'Caddyfile'), 'utf8');
  const publicTlsCaddyfile = readFileSync(join(unpackRoot, 'Caddyfile.public-tls'), 'utf8');
  const corefile = readFileSync(join(unpackRoot, 'Corefile'), 'utf8');
  const envExample = readFileSync(join(unpackRoot, '.env.example'), 'utf8');
  const readme = readFileSync(join(unpackRoot, 'README.md'), 'utf8');
  const manage = readFileSync(join(unpackRoot, 'manage.sh'), 'utf8');
  execFileSync('bash', ['-n', join(unpackRoot, 'manage.sh')]);

  assert.match(compose, /\$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}:53\/udp/);
  assert.match(compose, /\$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}:53\/tcp/);
  assert.match(compose, /\$\{MX_DOMESTIC_EDGE_BIND:-127\.0\.0\.1\}:\$\{MX_DOMESTIC_EDGE_PORT:-18090\}:8088\/tcp/);
  assert.match(compose, /public-tls:[\s\S]*profiles:[\s\S]*- public-tls[\s\S]*\$\{MX_DOMESTIC_HTTPS_BIND:-0\.0\.0\.0\}:\$\{MX_DOMESTIC_HTTPS_PORT:-443\}:443\/tcp/);
  assert.doesNotMatch(
    compose,
    /compass-gateway_default|public_gateway/,
    'the default stack must remain runnable before the external Compass network exists'
  );
  assert.match(
    publicGatewayCompose,
    /domestic-edge:[\s\S]*public_gateway:[\s\S]*aliases:[\s\S]*- mx-domestic-edge/
  );
  assert.match(publicGatewayCompose, /external: true/);
  assert.match(
    publicGatewayCompose,
    /name: \$\{MX_DOMESTIC_PUBLIC_GATEWAY_NETWORK:-compass-gateway_default\}/
  );
  assert.doesNotMatch(
    compose,
    /MX_DOMESTIC_HTTP_PORT/,
    'the optional TLS owner must use TLS-ALPN on 443 and must not claim a V1-owned port 80'
  );
  assert.match(publicTlsCaddyfile, /\{\$MX_DOMESTIC_BOOTSTRAP_HOST:h2i\.minsight-ai\.com\}/);
  assert.match(publicTlsCaddyfile, /disable_http_challenge/);
  assert.match(
    caddyfile,
    /@publicFeishuConfig \{[\s\S]*?method GET[\s\S]*?path \/internal\/v1\/sdk\/oauth\/feishu\/config[\s\S]*?\}/
  );
  assert.match(
    caddyfile,
    /@publicLauncherProduct \{[\s\S]*?method GET[\s\S]*?path_regexp launcherProduct \^\/internal\/v1\/launcher-network\/products\/\[A-Za-z0-9\._-\]\+\$[\s\S]*?\}/
  );
  assert.match(
    caddyfile,
    /@publicClientPost \{[\s\S]*?method POST[\s\S]*?\/internal\/v1\/sdk\/oauth\/token[\s\S]*?\/internal\/v1\/sdk\/oauth\/feishu\/authorize[\s\S]*?\/internal\/v1\/sdk\/oauth\/feishu\/token[\s\S]*?\/internal\/v1\/launcher-network\/enrollments[\s\S]*?\/internal\/v1\/launcher-network\/snapshots[\s\S]*?\}/
  );
  assert.match(
    caddyfile,
    /@publicLeaseOperation \{[\s\S]*?method POST[\s\S]*?path_regexp launcherLeaseOperation \^\/internal\/v1\/launcher-network\/leases\/\[A-Za-z0-9\._-\]\+\/\(release\|domestic-peer\/sync\|internal-direct-peer\/sync\|domestic-relay\/diagnostics\)\$[\s\S]*?\}/
  );
  // Clash cannot send a Bearer, so the token-in-path subscription is the only
  // user-center surface allowed through the public edge.
  assert.match(
    caddyfile,
    /@publicOverseaAggregate \{[\s\S]*?method GET[\s\S]*?path_regexp overseaAggregate \^\/internal\/v1\/oversea-subscriptions\/mx-v1-\[A-Za-z0-9_-\]\+\\\.yaml\$[\s\S]*?\}/
  );
  assert.match(
    caddyfile,
    /@publicOverseaSubscription \{[\s\S]*?method GET[\s\S]*?path_regexp overseaSubscription \^\/internal\/v1\/site-slots\/\[A-Za-z0-9\._-\]\+\/subscriptions\/hysteria2\/\[A-Za-z0-9\._-\]\+\\\.yaml\$[\s\S]*?\}/
  );
  assert.doesNotMatch(
    caddyfile,
    /path_regexp[^\n]*user-center/,
    'the Bearer-guarded user-center subscription must never be reachable from the public edge'
  );
  assert.match(
    caddyfile,
    /@blockedControlPlane path \/internal \/internal\/\* \/api \/api\/\* \/h2i \/h2i\/\*/
  );
  assert.match(caddyfile, /respond @blockedControlPlane "forbidden\\n" 403/);
  assert.doesNotMatch(caddyfile, /handle_path \/api\/\*/);
  assert.doesNotMatch(caddyfile, /handle_path \/h2i\/\*/);
  assert.doesNotMatch(caddyfile, /handle \/internal\/\*/);
  assert.doesNotMatch(caddyfile, /config-center/);
  assert.equal(
    [...caddyfile.matchAll(/^\s*header_up X-Forwarded-For \{http\.request\.header\.X-Forwarded-For\}\s*$/gm)].length,
    7,
    'the loopback edge must preserve the client IP value cleaned by the public TLS owner'
  );

  assert.match(
    publicTlsCaddyfile,
    /@publicHealth \{[\s\S]*?method GET[\s\S]*?path \/healthz \/bootstrap-healthz \/internal-healthz[\s\S]*?\}/
  );
  assert.match(publicTlsCaddyfile, /@publicFeishuConfig \{[\s\S]*?method GET/);
  assert.match(publicTlsCaddyfile, /@publicLauncherProduct \{[\s\S]*?method GET/);
  assert.match(publicTlsCaddyfile, /@publicClientPost \{[\s\S]*?method POST/);
  assert.match(publicTlsCaddyfile, /@publicLeaseOperation \{[\s\S]*?method POST/);
  assert.match(publicTlsCaddyfile, /@publicOverseaAggregate \{[\s\S]*?method GET/);
  assert.match(publicTlsCaddyfile, /@publicOverseaSubscription \{[\s\S]*?method GET/);
  assert.equal(
    [...publicTlsCaddyfile.matchAll(/^\s*reverse_proxy domestic-edge:8088\s*\{$/gm)].length,
    7,
    'public TLS must proxy only health plus the six explicit client-bootstrap matcher groups'
  );
  assert.equal(
    [...publicTlsCaddyfile.matchAll(/^\s*header_up X-Forwarded-For \{remote_host\}\s*$/gm)].length,
    7,
    'the public TLS owner must overwrite user-supplied forwarding headers with the socket client IP'
  );
  assert.match(publicTlsCaddyfile, /respond "not found\\n" 404/);
  assert.doesNotMatch(publicTlsCaddyfile, /path \/internal\/\*/);
  assert.doesNotMatch(publicTlsCaddyfile, /path \/api\/\*/);
  assert.doesNotMatch(publicTlsCaddyfile, /path \/h2i\/\*/);
  assert.doesNotMatch(publicTlsCaddyfile, /config-center/);
  assert.doesNotMatch(compose, /MX_DOMESTIC_DNS_BIND:-0\.0\.0\.0/);
  assert.doesNotMatch(compose, /MX_DOMESTIC_DNS_PORT:-50053/);
  assert.match(corefile, /^\s*forward \. 10\.88\.88\.88:53\s*$/m);
  assert.doesNotMatch(
    corefile,
    /223\.5\.5\.5|119\.29\.29\.29|1\.1\.1\.1|8\.8\.8\.8/,
    'Internal split-DNS names must fail closed instead of falling back to public DNS'
  );
  assert.match(envExample, /^MX_DOMESTIC_DNS_BIND=10\.88\.0\.1$/m);
  assert.match(envExample, /^MX_DOMESTIC_DNS_PORT=53$/m);
  assert.match(envExample, /^MX_DOMESTIC_EDGE_BIND=127\.0\.0\.1$/m);
  assert.match(envExample, /^MX_DOMESTIC_BOOTSTRAP_HOST=h2i\.minsight-ai\.com$/m);
  assert.match(envExample, /^MX_DOMESTIC_PUBLIC_GATEWAY_NETWORK=compass-gateway_default$/m);
  assert.match(envExample, /^MX_DOMESTIC_HTTPS_PORT=443$/m);
  assert.doesNotMatch(envExample, /^MX_DOMESTIC_DNS_BIND=0\.0\.0\.0$/m);
  assert.doesNotMatch(envExample, /^MX_DOMESTIC_DNS_PORT=50053$/m);
  assert.match(readme, /CoreDNS edge cache on `10\.88\.0\.1:53`/);
  assert.match(readme, /\$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}/);
  assert.match(readme, /Internal lookups to the live authority on `10\.88\.88\.88:53`/);
  assert.match(manage, /DNS profile bind: \$\{MX_DOMESTIC_DNS_BIND:-10\.88\.0\.1\}:\$\{MX_DOMESTIC_DNS_PORT:-53\}/);
  assert.match(manage, /COMPOSE_PROFILES=dns compose up -d --force-recreate --no-deps dns-forwarder/);
  assert.match(manage, /up-public-tls/);
  assert.match(manage, /COMPOSE_PROFILES=public-tls compose up -d --force-recreate public-tls/);
  assert.match(manage, /PUBLIC_GATEWAY_MARKER="\$STACK_DIR\/data\/public-gateway-enabled"/);
  assert.match(
    manage,
    /docker compose -f docker-compose\.yml -f docker-compose\.public-gateway\.yml "\$@"/
  );
  assert.match(manage, /docker network inspect "\$network"/);
  assert.match(manage, /touch "\$PUBLIC_GATEWAY_MARKER"/);
  assert.match(
    manage,
    /stop_public_tls_fallback\(\)[\s\S]*COMPOSE_PROFILES=public-tls compose_public_gateway stop public-tls/
  );
  assert.match(
    manage,
    /start_domestic_edge\(\)[\s\S]*docker network inspect "\$network"[\s\S]*compose_public_gateway up -d --force-recreate "\$@" domestic-edge/
  );
  assert.match(manage, /official Compass public gateway is enabled; public-tls must not compete for TCP 443/);
  assert.match(readme, /Compass nginx reaches this service at `http:\/\/mx-domestic-edge:8088`/);
  assert.match(manage, /curl -fsS --connect-timeout 5 --max-time 20 "https:\/\/\$\{authority\}\/bootstrap-healthz"/);
  assert.doesNotMatch(manage, /MX_DOMESTIC_DNS_BIND:-0\.0\.0\.0/);
  assert.doesNotMatch(manage, /MX_DOMESTIC_DNS_PORT:-50053/);

  const adminController = readFileSync(adminControllerPath, 'utf8');
  const domain = readFileSync(domainPath, 'utf8');
  const internalGateway = readFileSync(internalGatewayPath, 'utf8');
  const internalConfig = readFileSync(internalConfigPath, 'utf8');
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
    'runtime config apply must prove that the Internal authority returns its gateway address'
  );
  assert.match(
    adminController,
    /const dnsProbeName = 'gateway\.internal\.mx\.';/,
    'runtime config apply must probe an Internal authoritative name over UDP and TCP'
  );
  assert.doesNotMatch(
    adminController,
    /const dnsProbeName = `\$\{publicBootstrapUrl\.hostname\}\.`;/,
    'the DNS probe must not require the public bootstrap hostname to resolve to an Internal address'
  );
  assert.match(
    adminController,
    /const publicBootstrapUrl = new URL\(config\.edge\.publicBaseUrl\);[\s\S]*?const publicBootstrapHealthUrl = `\$\{publicBootstrapUrl\.origin\}\/bootstrap-healthz`;/,
    'the public HTTPS probe must continue to use the configured bootstrap origin'
  );
  assert.doesNotMatch(
    adminController,
    /const dnsProbeName = 'h2i\.mxinfo-inc\.cn\.'/,
    'runtime config apply must not probe the retired public default unconditionally'
  );
  assert.match(
    domain,
    /dnsRecordForTarget\('gateway\.internal\.mx', apiTarget, 'internal-service'\)/,
    'the fixed runtime DNS probe name must be present in the Internal authoritative zone'
  );
  assert.match(
    adminController,
    /mx_public_https_verify\(\)[\s\S]*curl -fsS --connect-timeout 5 --max-time 15 "\$public_bootstrap_health_url"/,
    'runtime apply must verify the real public HTTPS route with the system trust store'
  );
  assert.doesNotMatch(
    adminController,
    /mx_dns_port_busy/,
    'a V1 listener on another WireGuard address must not suppress the V2 DNS service'
  );
  for (const [name, gatewaySource] of [
    ['static Internal gateway', internalGateway],
    ['runtime-rendered Internal gateway', domain]
  ]) {
    assert.match(
      gatewaySource,
      /remote_ip 10\.88\.0\.1[\s\S]*?header X-MX-Forwarded-By domestic-edge/,
      `${name} must trust a cleaned forwarding header only from the Domestic WireGuard source`
    );
    assert.match(
      gatewaySource,
      /handle @domesticEdge \{[\s\S]*?header_up X-Forwarded-For \{http\.request\.header\.X-Forwarded-For\}/,
      `${name} must preserve the public-edge-cleaned client IP`
    );
    assert.match(
      gatewaySource,
      /handle \{[\s\S]*?header_up X-Forwarded-For \{remote_host\}[\s\S]*?header_up -X-MX-Forwarded-By/,
      `${name} must overwrite spoofed forwarding headers on direct Internal requests`
    );
  }
  assert.match(
    internalConfig,
    /MX_HTTP_TRUST_PROXY_HOPS:\s*"1"/,
    'the API must trust only its immediate Internal gateway after that gateway normalizes client IP'
  );

  console.log('OK coexistence DNS apply proves gateway.internal.mx over UDP/TCP and public bootstrap over HTTPS');
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
