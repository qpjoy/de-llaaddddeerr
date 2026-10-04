#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE, initializeProfile, readProfile, renewProfile, savePrivate, publicStatus, diagnoseProfile } from './identity-profile.mjs';
import { publicAdminConfig } from './identity-public-profile.mjs';
import { identityProbe } from './identity-check.mjs';
import { writeInternalIngress } from './identity-ingress.mjs';

export const NS = 'mx-internal-shadow';
export const MANAGED = 'mx.qpjoy.com/identity-installation';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function run(args, input) {
  const result = spawnSync('kubectl', [`--request-timeout=${args.includes('rollout') ? '190s' : args.includes('exec') ? '40s' : '30s'}`, ...args], { input, encoding: 'utf8', timeout: 210000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status) throw new Error('身份部署 kubectl 操作失败；请检查集群与 Pod 状态（不输出凭据）');
  return result.stdout;
}
export function resources(p, revision) {
  const metadata = name => ({ name, namespace: NS, labels: { [MANAGED]: p.installationId } });
  const { issuer, origin, clientId, clientSecret, cookieKeys, jwks, applications, publicEntry } = p;
  const url = new URL(origin); const port = Number(url.port);
  const secret = (name, values) => ({ apiVersion: 'v1', kind: 'Secret', metadata: metadata(name), type: 'Opaque',
    data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) });
  const runtime = secret('mx-identity-runtime', { 'config.json': JSON.stringify({ issuer, origin, clientId, clientSecret, cookieKeys, jwks, applications, publicEntry }), 'tls.crt': p.tlsCert, 'tls.key': p.tlsKey, 'ca.crt': p.caCert });
  const admin = secret('mx-launcher-admin-sso', { MX_ADMIN_SSO_ENABLED: '1', MX_ADMIN_SSO_ORIGIN: origin, MX_ADMIN_SSO_ISSUER: issuer,
    MX_ADMIN_SSO_CLIENT_ID: clientId, MX_ADMIN_SSO_CLIENT_SECRET: clientSecret, MX_ADMIN_SSO_LOCAL_SUBJECTS: '1', NODE_EXTRA_CA_CERTS: '/run/mx-identity-ca/ca.crt',
    ...(publicEntry ? { MX_ADMIN_PUBLIC_SSO_CONFIG: JSON.stringify(publicAdminConfig(publicEntry)) } : {}) });
  const ca = secret('mx-identity-ca', { 'ca.crt': p.caCert });
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata('mx-identity'), spec: {
    replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { app: 'mx-identity' } },
    template: { metadata: { labels: { app: 'mx-identity' }, annotations: { 'mx.qpjoy.com/identity-version': sha([runtime.data, revision]), 'mx.qpjoy.com/identity-config-digest': sha(Object.entries(runtime.data).sort(([a], [b]) => a.localeCompare(b))) } }, spec: {
      automountServiceAccountToken: false,
      tolerations: ['node-role.kubernetes.io/control-plane', 'node-role.kubernetes.io/master'].map(key => ({ key, operator: 'Exists', effect: 'NoSchedule' })),
      containers: [{ name: 'identity', image: 'qpjoy/mx-launcher-server:shadow', imagePullPolicy: 'Never', command: ['node', 'dist/src/identity/index.js'],
        envFrom: [{ configMapRef: { name: 'mx-launcher-internal-config' } }],
        env: [{ name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'mx-launcher-db', key: 'DATABASE_URL' } } }],
        ports: [{ name: 'https', containerPort: port, hostPort: port, hostIP: url.hostname }],
        startupProbe: { httpGet: { scheme: 'HTTPS', path: '/healthz', port, httpHeaders: [{ name: 'Host', value: url.host }] }, failureThreshold: 30, periodSeconds: 2 },
        readinessProbe: { httpGet: { scheme: 'HTTPS', path: '/healthz', port, httpHeaders: [{ name: 'Host', value: url.host }] }, periodSeconds: 5 },
        livenessProbe: { tcpSocket: { port }, periodSeconds: 15, failureThreshold: 6 },
        resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '500m', memory: '384Mi' } },
        volumeMounts: [{ name: 'identity', mountPath: '/run/mx-identity', readOnly: true }],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }
      }], volumes: [{ name: 'identity', secret: { secretName: 'mx-identity-runtime', defaultMode: 256 } }]
    } }
  } };
  let publicDeployment;
  if (publicEntry) {
    publicDeployment = structuredClone(deployment);
    publicDeployment.metadata = metadata('mx-identity-public');
    publicDeployment.spec.selector.matchLabels.app = 'mx-identity-public';
    publicDeployment.spec.template.metadata.labels.app = 'mx-identity-public';
    const container = publicDeployment.spec.template.spec.containers[0];
    container.env.push({ name: 'MX_IDENTITY_ENTRY', value: 'public' });
    const transport = new URL(publicEntry.transportOrigin);
    container.ports = [{ name:'http',containerPort:18444,hostPort:18444,hostIP:transport.hostname }];
    for (const probe of [container.startupProbe,container.readinessProbe]) {
      probe.httpGet = {scheme:'HTTP',path:'/healthz',port:18444,httpHeaders:[{name:'Host',value:new URL(publicEntry.origin).host}]};
    }
    container.livenessProbe.tcpSocket.port = 18444;
  }
  return { runtime, admin, ca, deployment, ...(publicDeployment ? { publicDeployment } : {}) };
}
export function inspectIdentity(p, execute = run, initializing = false) {
  const get = (kind, name) => { const raw = execute(['-n', NS, 'get', kind, name, '--ignore-not-found', '-o', 'json']); return raw.trim() ? JSON.parse(raw) : null; };
  const previous = get('secret', 'mx-identity-runtime');
  const deployment = get('deployment', 'mx-identity');
  const publicDeployment = get('deployment', 'mx-identity-public');
  if (!p) {
    const admin = get('secret', 'mx-launcher-admin-sso');
    if (previous || deployment || publicDeployment || get('secret', 'mx-identity-ca') || admin?.metadata?.labels?.[MANAGED]) throw new Error('身份服务已存在但主机部署档案丢失；请恢复 profile.json，不能生成新密钥');
    if (initializing && admin) throw new Error('已有 SSO 配置；拒绝覆盖，请先确认原身份服务及备份');
    return { deployment, publicDeployment };
  }
  const oldAdmin = get('secret', 'mx-launcher-admin-sso');
  for (const existing of [previous, oldAdmin, get('secret', 'mx-identity-ca'), deployment, publicDeployment]) {
    if (existing && existing.metadata?.labels?.[MANAGED] !== p.installationId) throw new Error('已有 SSO 资源归属不同；拒绝覆盖现有身份配置');
  }
  if (previous) {
    let old;
    try { old = JSON.parse(Buffer.from(previous.data['config.json'], 'base64').toString()); }
    catch { throw new Error('已有身份运行配置无法解析；请核对备份（不输出凭据）'); }
    const expected = resources(p).runtime.data;
    const next = JSON.parse(Buffer.from(expected['config.json'], 'base64').toString());
    // Additive first-party registration is allowed; existing clients and core
    // credentials cannot disappear/change from a stale host backup.
    const { applications: oldApps = [], publicEntry: oldPublic, ...oldCore } = old;
    const { applications: nextApps = [], publicEntry: nextPublic, ...nextCore } = next;
    const keepsPublic = () => {
      if (!oldPublic) return true;
      if (!nextPublic) return false;
      const { applications: oldClients = [], ...before } = oldPublic;
      const { applications: nextClients = [], ...after } = nextPublic;
      return sha(before) === sha(after) && oldClients.every(app => sha(app) === sha(nextClients.find(nextApp => nextApp.clientId === app.clientId) ?? null));
    };
    if (!keepsPublic() || sha(oldCore) !== sha(nextCore) || oldApps.some(app => sha(app) !== sha(nextApps.find(nextApp => nextApp.clientId === app.clientId) ?? null))
      || Buffer.from(previous.data['ca.crt'], 'base64').toString() !== p.caCert) throw new Error('身份密钥、客户端或 issuer 与现有部署不一致；请恢复原部署档案');
  }
  return { deployment, publicDeployment };
}
export function deployIdentity({ file = PROFILE, execute = run, revision, log = console.log } = {}) {
  const p = readProfile(file);
  inspectIdentity(p, execute);
  if (!p) {
    log('统一身份未启用；保留原登录。首次可运行 bash scripts/manage.sh ops identity on（自动配置并部署）。'); return;
  }
  const renewed = renewProfile(p, file);
  if (renewed.publicEntry) log(`已同步 Internal Nginx 回源配置：${writeInternalIngress(renewed, file)}（由内网 Nginx 独立加载）`);
  const built = resources(renewed, revision);
  const apply = value => execute(['apply', '--server-side', '--field-manager=mx-identity-deploy', '-f', '-'], JSON.stringify(value));
  apply(built.runtime); apply(built.ca); apply(built.deployment);
  if (built.publicDeployment) {
    apply(built.publicDeployment);
    execute(['-n', NS, 'rollout', 'status', 'deployment/mx-identity-public', '--timeout=180s']);
    log(`公网身份回源已就绪：${p.publicEntry.transportOrigin}；外部 DNS/TLS/网关需按部署文档验收。`);
  }
  execute(['-n', NS, 'rollout', 'status', 'deployment/mx-identity', '--timeout=180s']);
  // Enable RP only after the durable provider is ready. The normal API apply /
  // restart later in deploy reads this Secret and the trusted CA volume.
  apply(built.admin);
  log(`统一身份已就绪：${p.origin}/admin/；原 HTTP 入口保留。`);
}
export function activateIdentity({ file = PROFILE, execute = run } = {}) {
  const p = readProfile(file); if (!p) return;
  const { admin, ca } = resources(p);
  execute(['-n', NS, 'patch', 'deployment', 'mx-launcher-internal', '--type=merge', '--patch',
    JSON.stringify({ spec: { template: { metadata: { annotations: { 'mx.qpjoy.com/identity-config': sha([admin.data, ca.data]) } } } } })]);
}
export async function verifyIdentity({ file = PROFILE, execute = run, log = console.log, wait = delay } = {}) {
  const p = readProfile(file); if (!p) return;
  let report;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const pods = JSON.parse(execute(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/name=mx-launcher-internal', '-o', 'json'])).items;
      const pod = pods.filter(pod => !pod.metadata.deletionTimestamp && pod.status?.phase === 'Running' &&
        pod.status.containerStatuses?.some(container => container.name === 'internal-api' && container.ready))
        .sort((a, b) => Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp))[0];
      if (!pod) report = { stage: 'pod-exec', code: 'NO_READY_POD' };
      else {
        const output = execute(['-n', NS, 'exec', pod.metadata.name, '-c', 'internal-api', '--', 'node', '--input-type=module', '-e',
          `const probe=${identityProbe.toString()}; console.log(JSON.stringify(await probe(process.argv[1],process.argv[2])));`,
          p.origin, new X509Certificate(p.caCert).fingerprint256]);
        report = JSON.parse(output.trim());
        if (report.version !== 1 || typeof report.ok !== 'boolean' || !['configuration', 'local-session', 'discovery', 'https-session', 'complete'].includes(report.stage)
          || !/^[A-Z_]{2,60}$/.test(report.code) || (report.status !== undefined && (!Number.isInteger(report.status) || report.status < 100 || report.status > 599))) throw new Error('invalid probe output');
      }
    } catch { report = { stage: 'pod-exec', code: 'KUBECTL_EXEC_FAILED' }; }
    if (report.ok) break;
    // Only read-only checks retry; never silently redeploy or rotate credentials.
    if (!['NO_READY_POD', 'KUBECTL_EXEC_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'TIMEOUT', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(report.code) || attempt === 2) break;
    await wait(1000);
  }
  if (!report.ok) throw new Error(`身份检查失败 [${report.stage}/${report.code}${report.status ? `/HTTP ${report.status}` : ''}]；工作负载可能已更新，请运行 ops identity check 复查，无需重新生成密钥。`);
  log('身份入口 HTTPS 信任、OIDC 发现和 Launcher SSO 启用检查通过。');
  log(`个人管理入口：${p.origin}/admin/；管理员首次需信任 ${dirname(file)}/ca.crt。`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, value, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('identity 命令参数过多');
    if (action === 'init') {
      const p = initializeProfile(value);
      writeFileSync(join(dirname(PROFILE), 'ca.crt'), p.caCert, { mode: 0o644 });
      console.log(JSON.stringify(publicStatus(p), null, 2));
      console.log(`配置已保存，运行原 deploy 即可。管理员首次需信任 ${dirname(PROFILE)}/ca.crt；备份 profile.json 与 Launcher 数据库。`);
    } else if (action === 'doctor') {
      const version = spawnSync('openssl', ['version'], { encoding: 'utf8', timeout: 5000 });
      console.log(JSON.stringify({ ...diagnoseProfile(), systemOpenSSL: version.status === 0 ? version.stdout.trim() : 'unavailable' }, null, 2));
    } else if (action === 'status') console.log(JSON.stringify(publicStatus(readProfile()), null, 2));
    else if (action === 'check') await verifyIdentity();
    else if (action === 'activate') activateIdentity();
    else if (action === 'export') {
      if (!value || existsSync(value)) throw new Error('请指定尚不存在的私有备份文件路径');
      const p = readProfile(); if (!p) throw new Error('尚未配置身份服务'); savePrivate(resolve(value), p, true); console.log('身份档案已导出（含私钥），数据库需同时备份。');
    } else if (action === 'restore') {
      const p = readProfile(resolve(value)); if (!p) throw new Error('未找到身份备份');
      const old = readProfile(); if (old && sha(old) !== sha(p)) throw new Error('目标已有不同身份档案；拒绝覆盖');
      if (!old) savePrivate(PROFILE, p, true); console.log('身份档案已恢复；恢复原数据库后运行 deploy。原 issuer 地址必须保持可达。');
    } else if (action === 'apply') {
      if (!value || !/^[a-f0-9]{12,64}$/.test(value)) throw new Error('identity apply 需要已构建代码版本');
      deployIdentity({ revision: value });
    } else throw new Error('Usage: ops identity on [https://内网IPv4:18443] | init <https://内网IPv4:18443> | status | doctor | check | export <file> | restore <file>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
