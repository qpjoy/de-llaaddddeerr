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
  /kind: Deployment[\s\S]*?name: mx-internal-coredns[\s\S]*?hostNetwork: true[\s\S]*?dnsPolicy: ClusterFirstWithHostNet/,
  'Internal CoreDNS must own the node network that carries 10.88.88.88'
);
assert.doesNotMatch(
  manifest,
  /hostPort:\s*53/,
  'duplicate UDP/TCP containerPort 53 entries must not rely on strategic-merge hostPort'
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
  /\[ "\$host_network" = "true" \][\s\S]*?\[ -n "\$pod_ip" \] && \[ "\$pod_ip" = "\$host_ip" \]/,
  'deploy must prove that the CoreDNS pod uses the host network'
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

console.log('Internal CoreDNS host-network UDP/TCP exposure smoke passed');
