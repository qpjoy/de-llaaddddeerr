#!/usr/bin/env node
// Called inside the production deploy lock, before image build or workload changes.
import { networkInterfaces } from 'node:os';
import { createConnection, createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE, initializeProfile, internalOrigin, readProfile, repairBootstrapCa } from './identity-profile.mjs';
import { NS, inspectIdentity, run } from './identity-deploy.mjs';

function privateAddress(address) {
  try { internalOrigin(`https://${address}:18443`); return true; } catch { return false; }
}

export function selectOrigin({ profile, requested, interfaces, nodes, baseUrl }) {
  const addresses = new Set(Object.values(interfaces).flat().filter(row =>
    (row.family === 'IPv4' || row.family === 4) && privateAddress(row.address)).map(row => row.address));
  // Production recovery targets a local single-node cluster; never prepare an
  // address on this host for a different kubectl context or another cluster node.
  if (nodes.length !== 1 || !nodes[0].status?.addresses?.some(row => row.type === 'InternalIP' && addresses.has(row.address))) {
    throw new Error('身份自动开启要求当前主机的单节点集群；请检查节点内网 IP 与 kubeconfig');
  }
  let origin = profile?.origin;
  if (requested) {
    const selected = internalOrigin(requested);
    if (origin && selected !== origin) throw new Error('已有身份入口地址不同；issuer 变更须单独迁移，不能覆盖');
    origin = selected;
  }
  if (!origin) {
    let gateway;
    try { gateway = new URL(baseUrl).hostname; } catch { /* A fresh install may have no ConfigMap yet. */ }
    const nodeAddresses = nodes[0].status.addresses.filter(row => row.type === 'InternalIP' && addresses.has(row.address));
    const address = addresses.has(gateway) ? gateway : nodeAddresses.length === 1 ? nodeAddresses[0].address : null;
    if (!address) throw new Error('无法确定唯一的内网地址；请使用 ops identity on https://本机内网IP:18443');
    origin = internalOrigin(`https://${address}:18443`);
  }
  if (!addresses.has(new URL(origin).hostname)) throw new Error('身份入口 IP 不在本机；请恢复原地址或规划迁移，不能自动更换 issuer');
  return { origin, node: nodes[0].metadata.name };
}

export function inspectPorts({ origin, node, pods, replicaSets, deployment }) {
  const { hostname, port } = new URL(origin);
  const ownedSets = new Set(replicaSets.filter(rs => rs.metadata.namespace === NS && deployment?.metadata.uid &&
    rs.metadata.ownerReferences?.some(owner => owner.controller && owner.kind === 'Deployment' && owner.uid === deployment.metadata.uid))
    .map(rs => rs.metadata.uid));
  let managedPort = false;
  for (const pod of pods) {
    if (['Succeeded', 'Failed'].includes(pod.status?.phase) || (pod.spec.nodeName && pod.spec.nodeName !== node)) continue;
    const containers = [...(pod.spec.containers ?? []), ...(pod.spec.initContainers ?? [])];
    const conflict = containers.some(container => (container.ports ?? []).some(p => (p.protocol ?? 'TCP') === 'TCP' &&
      Number(p.hostPort || (pod.spec.hostNetwork ? p.containerPort : 0)) === Number(port) &&
      (!p.hostIP || ['0.0.0.0', '::', hostname].includes(p.hostIP))));
    if (!conflict) continue;
    const owned = pod.metadata.namespace === NS && pod.metadata.ownerReferences?.some(owner =>
      owner.controller && owner.kind === 'ReplicaSet' && ownedSets.has(owner.uid));
    if (!owned) throw new Error(`身份端口 ${hostname}:${port} 已被 Kubernetes Pod ${pod.metadata.namespace}/${pod.metadata.name} 占用；不会停止它或自动换端口`);
    managedPort = true;
  }
  return managedPort;
}

export async function probePort(origin, managedPort = false) {
  const { hostname, port } = new URL(origin);
  const reachable = await new Promise(resolve => {
    const socket = createConnection({ host: hostname, port: Number(port) });
    const done = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
  // CNI hostPort forwarding may not own a host socket. Pod reservations above
  // catch that case even when the application is not yet accepting connections.
  if (reachable && !managedPort) throw new Error(`身份端口 ${hostname}:${port} 已有服务响应；不会接管或自动换端口`);
  await new Promise((resolve, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', error => reject(new Error(`身份端口 ${hostname}:${port} 无法绑定（${error.code}）；请检查占用或指定其他独立端口`)));
    server.listen({ host: hostname, port: Number(port), exclusive: true }, () => server.close(resolve));
  });
}

export async function prepareIdentity({ enable = false, requested, file = PROFILE, execute = run,
  interfaces = networkInterfaces(), probe = probePort, log = console.log } = {}) {
  let p;
  try { p = readProfile(file); }
  catch {
    p = repairBootstrapCa(file, () => {
      try { inspectIdentity(null, execute, true); }
      catch { throw new Error('无法确认 SSO 尚未发布；停止自动修复 CA，请检查集群可达性与现有身份资源。原档案未修改。'); }
    });
    log('已修复 OpenSSL 1.1.1 初次生成 CA 的重复扩展；OIDC 密钥、CA 私钥和服务证书保持不变。');
    log(`原档案已备份到 ${join(dirname(file), 'profile.before-ca-repair.json')}；CA 证书指纹已改变，如曾导入请重新信任 ca.crt。`);
  }
  const { deployment } = inspectIdentity(p, execute, enable);
  if (!p && !enable) {
    log('个人 SSO 尚未开启；可运行 bash scripts/manage.sh ops identity on 自动配置并部署。');
    return;
  }
  const get = args => JSON.parse(execute([...args, '-o', 'json']) || '{}');
  const nodes = get(['get', 'nodes']).items ?? [];
  const config = get(['-n', NS, 'get', 'configmap', 'mx-launcher-internal-config', '--ignore-not-found']);
  const selected = selectOrigin({ profile: p, requested, interfaces, nodes, baseUrl: config.data?.MX_PUBLIC_BASE_URL });
  const pods = get(['get', 'pods', '--all-namespaces']).items ?? [];
  const replicaSets = deployment ? get(['-n', NS, 'get', 'replicasets']).items ?? [] : [];
  const managedPort = inspectPorts({ ...selected, pods, replicaSets, deployment });
  await probe(selected.origin, managedPort);
  // Generate credentials only after every read-only check succeeded. Interrupted
  // deploys retain the same profile and can resume with on or the normal deploy.
  const saved = initializeProfile(selected.origin, file);
  writeFileSync(join(dirname(file), 'ca.crt'), saved.caCert, { mode: 0o644 });
  log(`身份部署档案已${p ? '复用' : '生成'}：${saved.origin}；继续原 deploy 完成开启。`);
  log(`管理员首次需信任 ${join(dirname(file), 'ca.crt')}；请备份身份档案和 Launcher 数据库。`);
  return saved;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, requested, ...extra] = process.argv.slice(2);
    if (!['on', 'preflight'].includes(action) || extra.length || (action === 'preflight' && requested)) throw new Error('Use bash scripts/manage.sh ops identity on [https://内网IPv4:18443]');
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('身份开启/部署预检须在本机 Linux 部署主机以 root 运行');
    await prepareIdentity({ enable: action === 'on', requested });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
