#!/usr/bin/env node

// Offline patch preparation only. Applying it rolls the shared gateway Pod.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = readFileSync(new URL('../deploy/k8s/internal-shadow/45-internal-gateway.yaml', import.meta.url), 'utf8');
export const gatewayStartup = manifest.match(/          args:\n            - \|\n([\s\S]*?)          ports:/)[1].replace(/^              /gm, '');
// Only the pre-fix startup, the narrow emergency recovery and this revision
// are supported.
// Refuse custom live scripts instead of overwriting an operator's changes.
export const legacyGatewayStartup = gatewayStartup
  .replace(/^port80_owner=.*\ncase "\$port80_owner" in\n[\s\S]*?^esac\n/m, '')
  .replace('if [ "$port80_owner" = host-nginx ] || awk ', 'if awk ')
  .replace(/^  if \[ "\$port80_owner" = host-nginx \]; then\n[\s\S]*?^  fi\n/m,
    '  echo "host port 80 is already in use; starting Internal gateway on fallback port 8008"\n');
export const emergencyGatewayStartup = legacyGatewayStartup.replace("if awk 'NR > 1",
  "if [ \"${MX_INTERNAL_GATEWAY_PORT80_OWNER:-auto}\" = host-nginx ] || awk 'NR > 1");

export function gatewayPort80Patch(current) {
  if (current?.apiVersion !== 'apps/v1' || current?.kind !== 'DaemonSet'
    || current.metadata?.name !== 'mx-internal-gateway'
    || current.metadata?.namespace !== 'mx-internal-shadow'
    || typeof current.metadata?.resourceVersion !== 'string' || !current.metadata.resourceVersion.trim()
    || current.spec?.template?.spec?.hostNetwork !== true) {
    throw new Error('expected the existing mx-internal-shadow/mx-internal-gateway host-network DaemonSet with resourceVersion');
  }
  const containers = current.spec.template.spec.containers;
  const gateways = Array.isArray(containers) ? containers.filter(container => container.name === 'gateway') : [];
  const container = gateways[0];
  if (gateways.length !== 1 || JSON.stringify(container.command) !== JSON.stringify(['/bin/sh', '-ec'])
    || container.args?.length !== 1 || typeof container.args[0] !== 'string'
    || ![legacyGatewayStartup, emergencyGatewayStartup, gatewayStartup].some(script => script.trimEnd() === container.args[0].trimEnd())) {
    throw new Error('unrecognized gateway startup; inspect the live configuration before changing port ownership');
  }
  if (container.env != null && !Array.isArray(container.env)) throw new Error('unrecognized gateway environment; no patch generated');
  const owner = (container.env ?? []).filter(entry => entry.name === 'MX_INTERNAL_GATEWAY_PORT80_OWNER');
  if (owner.length > 1 || owner.some(entry => entry.valueFrom || !['', 'auto', 'host-nginx'].includes(entry.value))) {
    throw new Error('unrecognized existing port-80 ownership setting; no patch generated');
  }
  return {
    metadata: { resourceVersion: current.metadata.resourceVersion },
    spec: { template: { spec: { containers: [{
      name: 'gateway',
      args: [gatewayStartup],
      env: [{ name: 'MX_INTERNAL_GATEWAY_PORT80_OWNER', value: 'host-nginx' }]
    }] } } }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/k8s-gateway-port80-patch.mjs <saved-daemonset.json>');
    const content = readFileSync(process.argv[2], 'utf8');
    let current;
    try { current = JSON.parse(content); } catch { throw new Error('saved DaemonSet is not valid JSON'); }
    process.stdout.write(`${JSON.stringify(gatewayPort80Patch(current), null, 2)}\n`);
  } catch (error) {
    console.error(`gateway port-80 patch preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
