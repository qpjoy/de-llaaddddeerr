#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mxLauncherRoot = resolve(scriptDir, '../..');
const manifest = readFileSync(
  resolve(mxLauncherRoot, 'deploy/k8s/internal-shadow/15-dns-control-target.yaml'),
  'utf8'
);
const manage = readFileSync(resolve(mxLauncherRoot, 'scripts/manage.sh'), 'utf8');

assert.match(
  manifest,
  /kind: Deployment[\s\S]*?name: mx-internal-coredns[\s\S]*?name: coredns[\s\S]*?image: coredns\/coredns:1\.11\.3/,
  'Internal CoreDNS must remain a dedicated authority deployment'
);
assert.doesNotMatch(
  manifest,
  /hostNetwork:\s*true/,
  'Internal CoreDNS must not collide with host DNS listeners through hostNetwork'
);
assert.doesNotMatch(
  manifest,
  /hostPort:\s*53/,
  'duplicate UDP/TCP containerPort 53 entries must not be managed by strategic apply'
);
assert.match(
  manifest,
  /name: dns-udp[\s\S]*?port: 53[\s\S]*?targetPort: 53[\s\S]*?protocol: UDP/,
  'the Internal DNS Service must expose UDP 53'
);
assert.match(
  manifest,
  /name: dns-tcp[\s\S]*?port: 53[\s\S]*?targetPort: 53[\s\S]*?protocol: TCP/,
  'the Internal DNS Service must expose TCP 53'
);
assert.match(
  manifest,
  /10\.88\.88\.88 h2i\.mxinfo-inc\.cn/,
  'the create-only baseline must not resolve the MX-H2I readiness host through public DNS'
);
assert.match(
  manage,
  /if configmap_read_error="\$\(kubectl -n mx-dns get configmap coredns -o name 2>&1\)"[\s\S]*?preserve Internal CoreDNS ConfigMap managed by Config Center[\s\S]*?\*"\(NotFound\)"\*\|\*" not found"\*[\s\S]*?create baseline Internal CoreDNS ConfigMap[\s\S]*?refusing an ambiguous baseline overwrite/,
  'repeat deploys must preserve the Config Center-managed live zone'
);
assert.match(
  manage,
  /kubectl -n mx-dns patch deployment mx-internal-coredns --type=json[\s\S]*?"name":"dns-udp","containerPort":53,"hostIP":"10\.88\.88\.88","hostPort":53,"protocol":"UDP"[\s\S]*?"name":"dns-tcp","containerPort":53,"hostIP":"10\.88\.88\.88","hostPort":53,"protocol":"TCP"/,
  'deploy must patch both protocol-specific host ports onto only the Internal overlay address'
);
assert.match(
  manage,
  /\[ "\$host_network" != "true" \][\s\S]*?grep -Fxq '10\.88\.88\.88\/53\/53\/UDP'[\s\S]*?grep -Fxq '10\.88\.88\.88\/53\/53\/TCP'/,
  'deploy must verify pod networking, hostIP, hostPort, and both protocols'
);
assert.match(
  manage,
  /dig \+time=3 \+tries=1 "@\$probe_server" "\$probe_host" A \+short[\s\S]*?dig \+tcp \+time=3 \+tries=1 "@\$probe_server" "\$probe_host" A \+short/,
  'deploy must verify the expected Internal A record over both UDP and TCP'
);
assert.match(
  manage,
  /probe_server="\$\{MX_INTERNAL_DNS_PROBE_SERVER:-\$expected_ip\}"[\s\S]*?Internal overlay DNS address \$expected_ip is not assigned on this host/,
  'production verification must prove the real 10.88.88.88 overlay endpoint, not only the node IP'
);
assert.match(
  manage,
  /-o go-template='\{\{range \$key, \$value := \.spec\.selector\.matchLabels\}\}[\s\S]*?kubectl -n "\$ns" logs "\$pod" --all-containers --previous --tail=200/,
  'rollout diagnostics must resolve workload pods and include previous crash logs'
);

console.log('Internal CoreDNS host-port UDP/TCP exposure smoke passed');
