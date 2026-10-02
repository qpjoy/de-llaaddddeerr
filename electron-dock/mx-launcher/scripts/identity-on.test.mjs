import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { inspectPorts, prepareIdentity, probePort, selectOrigin } from './identity-on.mjs';
import { resources } from './identity-deploy.mjs';

const nodes = [{ metadata: { name: 'internal' }, status: { addresses: [{ type: 'InternalIP', address: '192.168.1.2' }] } }];
const interfaces = { eth0: [{ family: 'IPv4', address: '192.168.1.2' }], wg0: [{ family: 'IPv4', address: '10.88.88.88' }] };
const baseUrl = 'http://10.88.88.88:18090';
const origin = 'https://10.88.88.88:18443';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-on-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = []; const live = new Map();
  const execute = args => {
    calls.push(args);
    assert.ok(args.includes('get'), 'preflight must not mutate the cluster');
    if (args[0] === 'get') return JSON.stringify({ items: args[1] === 'nodes' ? nodes : live.get('pods') ?? [] });
    if (args[3] === 'configmap') return JSON.stringify({ data: { MX_PUBLIC_BASE_URL: baseUrl } });
    if (args[3] === 'replicasets') return JSON.stringify({ items: live.get('replicasets') ?? [] });
    return JSON.stringify(live.get(`${args[3]}:${args[4]}`) ?? null).replace(/^null$/, '');
  };
  return { file: join(dir, 'profile.json'), execute, interfaces, calls, live, log() {}, probe: async () => {} };
}

test('address discovery prefers the current local gateway, retains issuer, and refuses another host', () => {
  const input = { nodes, interfaces, baseUrl };
  assert.equal(selectOrigin(input).origin, origin);
  assert.equal(selectOrigin({ ...input, baseUrl: 'http://old.example:18090' }).origin, 'https://192.168.1.2:18443');
  assert.equal(selectOrigin({ ...input, profile: { origin: 'https://192.168.1.2:18543' } }).origin, 'https://192.168.1.2:18543');
  assert.equal(selectOrigin({ ...input, requested: 'https://192.168.1.2:18543' }).origin, 'https://192.168.1.2:18543');
  assert.throws(() => selectOrigin({ ...input, profile: { origin }, requested: 'https://192.168.1.2:18443' }), /迁移/);
  assert.throws(() => selectOrigin({ ...input, requested: 'https://192.168.1.99:18443' }), /不在本机/);
  assert.throws(() => selectOrigin({ ...input, interfaces: {} }), /当前主机/);
  assert.throws(() => selectOrigin({ ...input, nodes: [...nodes, ...nodes] }), /单节点/);
});

test('on creates one durable profile after checks; retry and subsequent deploy keep all credentials', async t => {
  const f = fixture(t); const probes = []; const logs = [];
  const options = { ...f, enable: true, probe: async (...args) => probes.push(args), log: line => logs.push(line) };
  const p = await prepareIdentity(options);
  const bytes = readFileSync(f.file, 'utf8');
  assert.equal(p.origin, origin);
  assert.equal(readFileSync(join(f.file, '..', 'ca.crt'), 'utf8'), p.caCert);
  assert.deepEqual(await prepareIdentity(options), p, 'interrupted deployment can retry');
  const live = resources(p, 'abc123'); live.deployment.metadata.uid = 'identity-deployment';
  for (const value of Object.values(live)) f.live.set(`${value.kind.toLowerCase()}:${value.metadata.name}`, value);
  f.live.set('replicasets', [{ metadata: { namespace: 'mx-internal-shadow', uid: 'identity-rs', ownerReferences: [{ kind: 'Deployment', controller: true, uid: 'identity-deployment' }] } }]);
  f.live.set('pods', [{ metadata: { namespace: 'mx-internal-shadow', name: 'identity-pod', ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'identity-rs' }] },
    spec: { nodeName: 'internal', containers: live.deployment.spec.template.spec.containers }, status: { phase: 'Running' } }]);
  assert.deepEqual(await prepareIdentity({ ...options, enable: false }), p, 'ordinary deploy maintains the profile');
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
  assert.deepEqual(probes, [[origin, false], [origin, false], [origin, true]]);
  assert.ok(!logs.join('').includes(p.clientSecret));
  await assert.rejects(prepareIdentity({ ...options, requested: 'https://192.168.1.2:18443' }), /迁移/);
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
});

test('ordinary deployment does not enable SSO or generate keys without an explicit on', async t => {
  const f = fixture(t);
  await prepareIdentity({ ...f, probe: async () => assert.fail('unconfigured should not probe') });
  assert.equal(existsSync(f.file), false);
  assert.ok(!f.calls.some(args => args.includes('pods')));
});

test('busy host port, lost profile and foreign SSO all fail before creating credentials', async t => {
  const f = fixture(t);
  await assert.rejects(prepareIdentity({ ...f, enable: true, probe: async () => { throw new Error('port busy'); } }), /port busy/);
  assert.equal(existsSync(f.file), false);
  f.live.set('secret:mx-identity-runtime', { metadata: { name: 'mx-identity-runtime' } });
  await assert.rejects(prepareIdentity({ ...f, enable: true }), /档案丢失/);
  assert.equal(existsSync(f.file), false);
  f.live.clear(); f.live.set('secret:mx-launcher-admin-sso', { metadata: { name: 'mx-launcher-admin-sso' } });
  await assert.rejects(prepareIdentity({ ...f, enable: true }), /已有 SSO/);
  assert.equal(existsSync(f.file), false);
  f.live.clear(); f.live.set('pods', [{ metadata: { namespace: 'other', name: 'waiting' }, status: { phase: 'Pending' },
    spec: { containers: [{ ports: [{ hostPort: 18443 }] }] } }]);
  await assert.rejects(prepareIdentity({ ...f, enable: true }), /Pod other\/waiting 占用/);
  assert.equal(existsSync(f.file), false);
});

test('hostPort detection covers pending/wildcard/hostNetwork reservations; only exact controller ownership is reused', () => {
  const deployment = { metadata: { uid: 'identity-deployment' } };
  const replicaSets = [{ metadata: { namespace: 'mx-internal-shadow', uid: 'identity-rs', ownerReferences: [{ kind: 'Deployment', controller: true, uid: deployment.metadata.uid }] } }];
  const pod = { metadata: { namespace: 'mx-internal-shadow', name: 'identity-pod', ownerReferences: [{ kind: 'ReplicaSet', controller: true, uid: 'identity-rs' }] },
    spec: { nodeName: 'internal', containers: [{ ports: [{ hostIP: '10.88.88.88', hostPort: 18443 }] }] }, status: { phase: 'Running' } };
  const args = { origin, node: 'internal', pods: [pod], replicaSets, deployment };
  assert.equal(inspectPorts(args), true);
  const foreign = structuredClone(pod); foreign.metadata.ownerReferences[0].uid = 'foreign-rs'; foreign.status.phase = 'Pending';
  delete foreign.spec.nodeName; foreign.spec.containers[0].ports[0].hostIP = '0.0.0.0';
  assert.throws(() => inspectPorts({ ...args, pods: [foreign] }), /占用/);
  foreign.spec.hostNetwork = true; foreign.spec.containers[0].ports = [{ containerPort: 18443 }];
  assert.throws(() => inspectPorts({ ...args, pods: [foreign] }), /占用/);
  foreign.status.phase = 'Succeeded'; assert.equal(inspectPorts({ ...args, pods: [foreign] }), false);
});

test('TCP probe rejects a real occupied socket, never stops it, and accepts a freed socket', async () => {
  const server = createServer(socket => socket.end());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = `https://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(probePort(address), /已有服务响应/);
    await assert.rejects(probePort(address, true), /EADDRINUSE/);
    assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await probePort(address);
});

const source = readFileSync(new URL('./manage.sh', import.meta.url), 'utf8');
const shellFunction = name => {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body); return body;
};
const runShell = (script, env = {}) => spawnSync('bash', ['-c', `set -Eeuo pipefail\nsay() { echo "$*"; }\ndie() { echo "$*" >&2; exit 1; }\n${script}`],
  { env: { ...process.env, ...env }, encoding: 'utf8' });

test('identity on performs the original deploy, forwarding the optional origin and existing build proxy; failures propagate', () => {
  const script = `${shellFunction('ops_identity_on')}\n${shellFunction('identity_prepare_for_deploy')}
    uname() { echo Linux; }; id() { echo 0; }
    node() { printf 'PREPARE:%s\\n' "$@"; }
    ops_internal_production() { echo DEPLOY:$1; identity_prepare_for_deploy; echo PROXY:$MX_LAUNCHER_BUILD_PROXY; return "\${TEST_EXIT:-0}"; }
    ops_identity_on "$TEST_ORIGIN"`;
  const env = { SCRIPT_DIR: '/fixture', TEST_ORIGIN: origin, MX_LAUNCHER_BUILD_PROXY: 'http://127.0.0.1:7789' };
  let result = runShell(script, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DEPLOY:deploy/);
  assert.match(result.stdout, /PREPARE:on\nPREPARE:https:\/\/10\.88\.88\.88:18443/);
  assert.match(result.stdout, /PROXY:http:\/\/127\.0\.0\.1:7789/);
  result = runShell(script, { ...env, TEST_EXIT: '27' }); assert.equal(result.status, 27);
});

test('identity preparation runs after recovery lock/restore and before build; failure stops the deploy', () => {
  const calls = [...shellFunction('ops_internal_production').matchAll(/^\s+(\w+)\b/gm)].map(match => match[1]);
  const commands = new Set([...calls, 'k8s_configure_proxy_bypass', 'k8s_namespace', 'k8s_manifest_dir', 'internal_production_predeploy_gate']);
  const stubs = [...commands].filter(name => !['case', 'esac', 'local', 'shift', 'if', 'fi', 'else', 'say', 'export', 'identity_prepare_for_deploy', 'ops_internal_production', 'launcher_with_build_proxy'].includes(name))
    .map(name => `${name}() { echo CALL:${name}; }`).join('\n');
  const script = `${shellFunction('ops_internal_production')}\n${stubs}
    launcher_with_build_proxy() { "$@"; }
    identity_prepare_for_deploy() { echo CALL:identity_prepare; return "\${TEST_EXIT:-0}"; }
    ops_internal_production deploy`;
  const env = { MX_INTERNAL_PRODUCTION_NATIVE_HOST_RUNNER_INSTALL: '0', MX_INSIGHT_HUB_DEPLOY: '0', K8S_INTERNAL_API_RESTARTED: '0' };
  let result = runShell(script, env); assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.indexOf('CALL:identity_prepare') > result.stdout.indexOf('CALL:k8s_production_recovery_state'));
  assert.ok(result.stdout.indexOf('CALL:shadow_image_build') > result.stdout.indexOf('CALL:identity_prepare'));
  result = runShell(script, { ...env, TEST_EXIT: '28' }); assert.equal(result.status, 28);
  assert.doesNotMatch(result.stdout, /CALL:shadow_image_build|CALL:k8s_apply\n/);
});
