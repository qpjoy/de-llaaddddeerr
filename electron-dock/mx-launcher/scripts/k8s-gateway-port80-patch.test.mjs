import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { emergencyGatewayStartup, gatewayPort80Patch, gatewayStartup, legacyGatewayStartup } from './k8s-gateway-port80-patch.mjs';

const originalStartup = readFileSync(new URL('./fixtures/gateway-pre-port80-owner.sh', import.meta.url), 'utf8');
const emergencyStartup = originalStartup.replace("if awk 'NR > 1",
  "if [ \"${MX_INTERNAL_GATEWAY_PORT80_OWNER:-auto}\" = host-nginx ] || awk 'NR > 1");
const cli = fileURLToPath(new URL('./k8s-gateway-port80-patch.mjs', import.meta.url));
const ownerName = 'MX_INTERNAL_GATEWAY_PORT80_OWNER';

function daemonset(startup = originalStartup) {
  return {
    apiVersion: 'apps/v1', kind: 'DaemonSet',
    metadata: { name: 'mx-internal-gateway', namespace: 'mx-internal-shadow', resourceVersion: '12345', labels: { keep: 'yes' } },
    spec: { template: { spec: {
      hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet',
      containers: [{ name: 'gateway', image: 'caddy:2.8.4-alpine', command: ['/bin/sh', '-ec'], args: [startup],
        env: [{ name: 'UNRELATED_SECRET', value: 'must-not-appear-in-patch' }],
        ports: [{ containerPort: 18090 }], volumeMounts: [{ name: 'caddy-config', mountPath: '/etc/caddy-source' }] },
      { name: 'unrelated-sidecar', image: 'keep-this' }],
      volumes: [{ name: 'caddy-config', configMap: { name: 'mx-internal-gateway-caddy' } }]
    } } }
  };
}

test('the accepted legacy and emergency scripts match the independent pre-fix fixture', () => {
  assert.equal(legacyGatewayStartup, originalStartup);
  assert.equal(emergencyGatewayStartup, emergencyStartup);
  assert.notEqual(gatewayStartup, originalStartup);
});

test('known revisions produce only a version-guarded args/env strategic merge patch', () => {
  for (const startup of [originalStartup, emergencyStartup, gatewayStartup, originalStartup.trimEnd()]) {
    const current = daemonset(startup);
    const before = structuredClone(current);
    const patch = gatewayPort80Patch(current);
    assert.deepEqual(patch, {
      metadata: { resourceVersion: '12345' },
      spec: { template: { spec: { containers: [{ name: 'gateway', args: [gatewayStartup],
        env: [{ name: ownerName, value: 'host-nginx' }] }] } } }
    });
    assert.deepEqual(current, before);
    assert.doesNotMatch(JSON.stringify(patch), /must-not-appear|unrelated-sidecar|image|volumes|ports|command/);
  }
});

test('valid existing ownership is retained as an explicit host-nginx setting', () => {
  for (const value of ['', 'auto', 'host-nginx']) {
    const current = daemonset(emergencyStartup);
    current.spec.template.spec.containers[0].env.push({ name: ownerName, value });
    assert.equal(gatewayPort80Patch(current).spec.template.spec.containers[0].env[0].value, 'host-nginx');
  }
});

test('wrong resources, missing version and custom startup are rejected before any patch output', () => {
  const edits = [
    current => { current.kind = 'Deployment'; },
    current => { current.apiVersion = 'v1'; },
    current => { current.metadata.namespace = 'other'; },
    current => { current.metadata.name = 'other'; },
    current => { delete current.metadata.resourceVersion; },
    current => { current.metadata.resourceVersion = 123; },
    current => { current.metadata.resourceVersion = ' '; },
    current => { current.spec.template.spec.hostNetwork = false; },
    current => { current.spec.template.spec.containers = []; },
    current => { current.spec.template.spec.containers.push(structuredClone(current.spec.template.spec.containers[0])); },
    current => { current.spec.template.spec.containers[0].command = ['/bin/sh', '-c']; },
    current => { current.spec.template.spec.containers[0].args.push('extra'); },
    current => { current.spec.template.spec.containers[0].args[0] += '\necho custom\n'; },
    current => { current.spec.template.spec.containers[0].args[0] = originalStartup.replace(':80', ':81'); },
    current => { current.spec.template.spec.containers[0].env = {}; },
    current => { current.spec.template.spec.containers[0].env.push({ name: ownerName, value: 'nginx' }); },
    current => { current.spec.template.spec.containers[0].env.push({ name: ownerName, valueFrom: { secretKeyRef: { name: 'private' } } }); },
    current => { current.spec.template.spec.containers[0].env.push({ name: ownerName, value: 'auto' }, { name: ownerName, value: 'host-nginx' }); },
  ];
  for (const edit of edits) {
    const current = daemonset();
    edit(current);
    assert.throws(() => gatewayPort80Patch(current));
  }
});

test('offline CLI emits JSON only on success, never logs saved credentials and never edits input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-gateway-port80-patch-'));
  try {
    const input = join(dir, 'gateway.json');
    for (const content of [JSON.stringify(daemonset()), '{"sensitive":"must-not-appear-in-patch",', JSON.stringify(daemonset('custom-secret-script'))]) {
      writeFileSync(input, content);
      const result = spawnSync(process.execPath, [cli, input], { encoding: 'utf8', timeout: 5000 });
      assert.equal(readFileSync(input, 'utf8'), content);
      assert.doesNotMatch(result.stdout + result.stderr, /must-not-appear-in-patch|custom-secret-script/);
      if (content === JSON.stringify(daemonset())) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), gatewayPort80Patch(daemonset()));
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
