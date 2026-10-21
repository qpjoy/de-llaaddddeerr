#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { resolveContainerdAddress } from './k8s-runtime.mjs';

const NAME = 'mx-identity-public', NS = 'mx-internal-shadow', IP = '10.88.88.88';
const NODE = 'mx-internal-server', CLUSTER = '399f2349-3a34-48f4-8105-d7bae56ca136';
const RUNTIME = '/run/mx-k8s-containerd/containerd.sock';
const DIGEST = 'mx.qpjoy.com/identity-config-digest', RESTART = 'kubectl.kubernetes.io/restartedAt';
const FILE = fileURLToPath(import.meta.url);
export const recoveryLocks = ['/run/mx-move-k8s.lock', '/run/mx-move-etcd.lock',
  '/run/mx-launcher-deploy.lock', '/var/lib/mx-move/k8s-runtime-install.lock'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireState = (ok, code) => { if (!ok) throw Object.assign(Error(code), { recoveryCode: code }); };
function commandCategory(result) {
  const stderr = result.stderr || '';
  if (result.error?.code === 'ETIMEDOUT' || /timed out|context deadline exceeded|Timeout/i.test(stderr)) return 'timeout';
  if (result.error || result.signal) return 'exec_failure';
  if (/Error from server \(Conflict\)|object has been modified|test operation.*failed|test failed|testing value.*failed/i.test(stderr)) return 'conflict';
  if (/Error from server \(Forbidden\)|\bforbidden\b/i.test(stderr)) return 'forbidden';
  if (/Error from server \(NotFound\)|\bnot found\b/i.test(stderr)) return 'not_found';
  if (/Error from server \((Invalid|BadRequest)\)|unknown (flag|shorthand flag|command)|flag needs an argument|invalid argument/i.test(stderr)) return 'invalid_argument';
  return 'unknown';
}
export function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20000, ...options });
  if (result.error || result.status !== 0)
    throw Object.assign(Error('command_failed'), { recoveryCode: 'command_failed', commandCategory: commandCategory(result) });
  return result.stdout;
}
export function recoveryFailure(error) {
  return { ok: false, code: error.recoveryCode || 'recovery_failed',
    stage: ['restart', 'rollout', 'postcheck'].includes(error.stage) ? error.stage : 'preflight',
    ...(error.commandCategory ? { commandCategory: error.commandCategory } : {}),
    mutationAttempted: error.mutationAttempted === true,
    restartSubmitted: error.restartSubmitted === true ? true : error.mutationAttempted === true ? 'unknown' : false,
    ...(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(error.attemptedAt || '') ? { attemptedAt: error.attemptedAt } : {}) };
}
export function wrapperFailure(result, apply) {
  const locked = !result.error && !result.signal && result.status === 73;
  return { ok: false, code: locked ? 'operation_locked' : 'recovery_failed', stage: locked ? 'lock' : 'wrapper',
    ...(locked ? {} : { commandCategory: commandCategory(result) }),
    mutationAttempted: apply && !locked ? 'unknown' : false,
    restartSubmitted: apply && !locked ? 'unknown' : false };
}
function health(url) {
  return new Promise(resolveProbe => {
    const req = request(url, { headers: { Host: 'auth.minsight-ai.com' } }, res => {
      res.resume(); resolveProbe({ status: res.statusCode, category: 'http' });
    });
    const timer = setTimeout(() => req.destroy(), 4000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', error => resolveProbe({ status: 0, category: error.code === 'ECONNREFUSED' ? 'refused' : 'unavailable' }));
    req.end();
  });
}

// Only this Internal host and completed migration are supported. All returned data is sanitized.
export async function recoverPublicAuth({ apply = false, run = execute, probe = health,
  runtime = () => resolveContainerdAddress({ run: (cmd, args, options) => spawnSync(cmd, args, { ...options, encoding: 'utf8' }) }),
  host = { platform: process.platform, uid: process.getuid?.(), name: hostname(),
    addresses: Object.values(networkInterfaces()).flat().map(v => v?.cidr) },
} = {}) {
  requireState(host.platform === 'linux' && host.uid === 0 && host.name === NODE && host.addresses.includes(`${IP}/32`), 'wrong_host');
  const k = (args, options) => run('kubectl', ['--kubeconfig=/etc/kubernetes/admin.conf',
    '--request-timeout=15s', '-n', NS, ...args], options);
  const get = (...args) => JSON.parse(k(['get', ...args, '-o', 'json']));
  const cri = (address, action, value) => JSON.parse(run('crictl', [`--runtime-endpoint=unix://${address}`,
    `--image-endpoint=unix://${address}`, '--timeout=10s', action, value]));
  const cleanImage = value => String(value || '').replace(/^(docker-pullable|containerd):\/\//, '');
  const imageId = (address, value) => {
    requireState(Boolean(value), 'image_unknown');
    const id = cri(address, 'inspecti', cleanImage(value)).status?.id;
    requireState(/^sha256:[a-f0-9]{64}$/.test(id || ''), 'image_unknown'); return id;
  };
  function snapshot() {
    requireState(get('namespace', 'kube-system').metadata?.uid === CLUSTER, 'cluster_changed');
    const nodes = get('nodes').items, node = nodes?.[0];
    requireState(nodes?.length === 1 && node.metadata?.name === NODE && node.metadata.labels?.['kubernetes.io/hostname'] === NODE
      && node.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True'), 'node_changed');
    requireState(!node.spec?.unschedulable, 'node_unschedulable');
    const migration = JSON.parse(run('python3', ['-B', fileURLToPath(new URL('../../mx-base/mx-move/k8s/cutover.py', import.meta.url)), 'status']));
    requireState(migration.phase === 'services-restored' && migration.may_write === true
      && migration.automatic_checks_passed === true, 'migration_incomplete');
    const address = runtime(); requireState(address === RUNTIME, 'runtime_changed');
    const d = get('deployment', NAME), spec = d.spec, status = d.status || {};
    requireState(d.metadata?.uid && d.metadata.resourceVersion && !d.metadata.deletionTimestamp && !spec.paused && spec.replicas === 1
      && spec.strategy?.type === 'Recreate' && status.observedGeneration >= d.metadata.generation
      && ['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas'].every(key => status[key] === 1), 'deployment_unstable');
    const container = spec.template.spec.containers?.[0], ports = container?.ports;
    requireState(spec.template.spec.containers.length === 1 && container.name === 'identity' && container.imagePullPolicy === 'Never'
      && ports?.length === 1 && ports[0].hostIP === IP && ports[0].hostPort === 18444 && ports[0].containerPort === 18444
      && (ports[0].protocol || 'TCP') === 'TCP' && !spec.template.spec.hostNetwork
      && container.env?.some(e => e.name === 'MX_IDENTITY_ENTRY' && e.value === 'public'), 'public_template_changed');
    const tolerations = spec.template.spec.tolerations || [];
    requireState((node.spec?.taints || []).filter(t => ['NoSchedule', 'NoExecute'].includes(t.effect)).every(taint =>
      tolerations.some(t => (!t.effect || t.effect === taint.effect)
        && (t.operator === 'Exists' ? (!t.key || t.key === taint.key)
          : (!t.operator || t.operator === 'Equal') && t.key === taint.key && (t.value || '') === (taint.value || ''))
        && (taint.effect !== 'NoExecute' || t.tolerationSeconds == null))), 'node_taint_untolerated');
    const replicas = get('replicasets', '-l', `app=${NAME}`).items.filter(rs => rs.metadata.ownerReferences?.some(o => o.controller && o.uid === d.metadata.uid));
    const pods = get('pods', '-l', `app=${NAME}`).items.filter(p => p.metadata.ownerReferences?.some(o => o.controller && replicas.some(rs => rs.metadata.uid === o.uid)));
    requireState(pods.length === 1, 'pod_set_changed');
    const p = pods[0], c = p.status?.containerStatuses?.find(value => value.name === 'identity');
    requireState(p.metadata.uid && !p.metadata.deletionTimestamp && p.spec.nodeName === NODE && p.status?.phase === 'Running'
      && p.status.conditions?.some(v => v.type === 'Ready' && v.status === 'True') && c?.ready && c.state?.running
      && p.spec.containers?.length === 1 && p.spec.containers[0].image === container.image && isIP(p.status.podIP || '') === 4, 'pod_unstable');
    const secret = get('secret', 'mx-identity-runtime');
    const config = digest(Object.entries(secret.data || {}).sort(([a], [b]) => a.localeCompare(b)));
    requireState(secret.data?.['config.json'] && config === spec.template.metadata.annotations?.[DIGEST]
      && config === p.metadata.annotations?.[DIGEST], 'identity_config_changed');
    const containerId = String(c.containerID || '').replace(/^containerd:\/\//, '');
    requireState(/^[a-f0-9]{64}$/.test(containerId), 'container_unknown');
    const running = cri(address, 'inspect', containerId).status;
    requireState(running?.state === 'CONTAINER_RUNNING' && running.metadata?.name === 'identity'
      && running.labels?.['io.kubernetes.pod.uid'] === p.metadata.uid, 'container_changed');
    const currentImage = imageId(address, running.imageRef);
    requireState(currentImage === imageId(address, c.imageID) && currentImage === imageId(address, container.image), 'image_changed');
    const template = structuredClone(spec.template); delete template.metadata.annotations[RESTART];
    return { deployment: d.metadata.uid, resourceVersion: d.metadata.resourceVersion, generation: d.metadata.generation,
      template: digest(template), restart: spec.template.metadata.annotations[RESTART] ?? null,
      pod: p.metadata.uid, podIP: p.status.podIP, containerId, image: currentImage, config,
      node: node.metadata.uid, runtime: address, migration: migration.transaction };
  }
  async function condition(state) {
    requireState((await probe(`http://${state.podIP}:18444/healthz`)).status === 200, 'pod_health_failed');
    const result = await probe(`http://${IP}:18444/healthz`);
    requireState(result.status === 200 || (result.status === 0 && result.category === 'refused'), 'host_failure_not_refused');
    return result.status === 200;
  }
  const before = snapshot();
  if (await condition(before)) return { ok: true, action: 'already_healthy', applied: false };
  if (!apply) return { ok: true, action: 'restart_required', applied: false };
  const confirmed = snapshot(); requireState(digest(confirmed) === digest(before), 'state_changed');
  if (await condition(confirmed)) return { ok: true, action: 'already_healthy', applied: false };
  const restartedAt = new Date().toISOString();
  let stage = 'restart', restartSubmitted = 'unknown';
  try {
    // Only UID, resourceVersion and a timestamp enter argv; no credentials or shell.
    k(['patch', 'deployment', NAME, '--type=json', '-p', JSON.stringify([
      { op: 'test', path: '/metadata/uid', value: confirmed.deployment },
      { op: 'test', path: '/metadata/resourceVersion', value: confirmed.resourceVersion },
      { op: 'add', path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt', value: restartedAt },
    ])]);
    restartSubmitted = true; stage = 'rollout';
    run('kubectl', ['--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=160s', '-n', NS,
      'rollout', 'status', `deployment/${NAME}`, '--timeout=150s'], { timeout: 165000 });
    stage = 'postcheck';
    const after = snapshot();
    requireState(after.pod !== before.pod && after.generation === before.generation + 1 && after.restart === restartedAt
      && ['deployment', 'template', 'image', 'config', 'node', 'runtime', 'migration'].every(key => after[key] === before[key]), 'recovery_state_changed');
    requireState(await condition(after), 'hostport_not_recovered');
    return { ok: true, action: 'recovered', applied: true };
  } catch (error) {
    // A lost patch response does not prove it failed. Never retry the mutation.
    throw Object.assign(error, { mutationAttempted: true, stage, restartSubmitted, attemptedAt: restartedAt });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === FILE) {
  try {
    const args = process.argv.slice(2);
    requireState(args.every(value => ['--apply', '--locked'].includes(value)) && new Set(args).size === args.length, 'invalid_arguments');
    requireState(process.platform === 'linux' && process.getuid() === 0, 'linux_root_required');
    if (!args.includes('--locked')) {
      const command = recoveryLocks.flatMap(lock => ['flock', '-n', '-E', '73', lock]);
      const result = spawnSync(command.shift(), [...command, process.execPath, FILE, '--locked', ...args],
        { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 600000 });
      if (!result.error && !result.signal && result.stdout?.trim()) process.stdout.write(result.stdout);
      else process.stdout.write(JSON.stringify(wrapperFailure(result, args.includes('--apply'))) + '\n');
      process.exitCode = result.error || result.status !== 0 ? 1 : 0;
    } else {
      const result = await recoverPublicAuth({ apply: args.includes('--apply') });
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (error) {
    process.stdout.write(JSON.stringify(recoveryFailure(error)) + '\n');
    process.exitCode = 1;
  }
}
