#!/usr/bin/env node
// Called under restore-confirmed-mx-data.sh's host lock. Never change DB/HBA,
// mounts, PVCs or Secrets. A temporary client verifies the existing Service.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const NS = 'mx-internal-shadow';
const ROOT = '/data/k8s/mx-runtime/mx-launcher';
const TARGET = '/var/lib/mx-launcher';
const same = isDeepStrictEqual;
const fail = message => { throw new Error(message); };
export const summarySQL = `BEGIN READ ONLY;
SELECT json_build_object('server_address', inet_server_addr()::text, 'database', current_database(),
 'records', (SELECT coalesce(json_agg(s), '[]'::json) FROM (
  SELECT u.environment, count(*) AS users, max(u.updated_at) AS latest_user_row,
    bool_or(lower(u.data->>'account')='smh' OR lower(u.data->>'displayName')='smh') AS has_smh,
    bool_or(lower(u.data->>'account')='sqb' OR lower(u.data->>'displayName')='sqb') AS has_sqb,
    bool_or((lower(u.data->>'account')='smh' OR lower(u.data->>'displayName')='smh') AND c.id IS NOT NULL) AS smh_has_credential,
    bool_or((lower(u.data->>'account')='sqb' OR lower(u.data->>'displayName')='sqb') AND c.id IS NOT NULL) AS sqb_has_credential,
    count(*) FILTER (WHERE c.id IS NOT NULL) AS users_with_credentials
  FROM mx_platform_records u
  LEFT JOIN mx_platform_records c ON c.kind='iam-user-credential' AND c.environment=u.environment AND c.id=u.id
  WHERE u.kind='iam-user' GROUP BY u.environment
 ) s));
ROLLBACK;`;

export function assertWorkloads(saved, current) {
  for (const key of ['api', 'pg']) {
    const before = saved[key], live = current[key];
    const expected = structuredClone(before.spec);
    expected.replicas = key === 'api' ? 0 : 1;
    if (before.metadata.uid !== live.metadata.uid || live.metadata.deletionTimestamp || !same(expected, live.spec)) {
      fail(`${key} 工作负载与此次切换记录不符；不自动覆盖或再次停库`);
    }
  }
  if (!same(saved.config.data, current.config.data) || !same(saved.secret.data, current.secret.data) ||
      !same(saved.service.spec, current.service.spec) || saved.service.metadata.uid !== current.service.metadata.uid) {
    fail('API 配置、数据库 Secret 或 Service 已变化；不自动覆盖');
  }
  const pod = current.pod;
  if (pod.metadata.deletionTimestamp || pod.spec.nodeName !== 'mx-internal-server' ||
      !pod.metadata.ownerReferences?.some(o => o.uid === current.pg.metadata.uid) ||
      !pod.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) fail('最新 PostgreSQL Pod 尚未就绪');
  const endpoints = current.slices.items.flatMap(s => s.endpoints || []);
  if (!endpoints.length || endpoints.some(e => e.conditions?.ready !== true || e.conditions?.terminating ||
      e.targetRef?.uid !== pod.metadata.uid || !e.addresses?.includes(pod.status.podIP))) fail('数据库 Service 没有唯一指向本次 PostgreSQL Pod');
  const pvc = current.pvc, pv = current.pv;
  if (pvc.metadata.uid !== saved.pvc.metadata.uid || pv.metadata.uid !== saved.pv.metadata.uid ||
      pvc.status.phase !== 'Bound' || pv.status.phase !== 'Bound' || pvc.metadata.deletionTimestamp || pv.metadata.deletionTimestamp ||
      pvc.spec.volumeName !== pv.metadata.name || pv.spec.claimRef?.uid !== pvc.metadata.uid ||
      pv.spec.hostPath?.path !== TARGET + '/k8s/postgres' || pv.spec.persistentVolumeReclaimPolicy !== 'Retain' ||
      !pod.spec.volumes?.some(v => v.name === 'postgres-data' && v.persistentVolumeClaim?.claimName === pvc.metadata.name)) fail('PostgreSQL 数据卷绑定已变化');
}

export function databaseTarget(secret, service) {
  const value = key => Buffer.from(secret.data?.[key] || '', 'base64').toString('utf8');
  let url;
  try { url = new URL(value('DATABASE_URL')); } catch { fail('数据库地址格式无法验证；未输出值'); }
  const hosts = ['mx-internal-postgres', `mx-internal-postgres.${NS}`, `mx-internal-postgres.${NS}.svc`, `mx-internal-postgres.${NS}.svc.cluster.local`, service.spec.clusterIP];
  if (!hosts.includes(url.hostname) || !hosts.includes(value('DATABASE_HOST')) ||
      !['postgres:', 'postgresql:'].includes(url.protocol) || (url.port && url.port !== '5432') || url.search ||
      decodeURIComponent(url.username) !== value('PG_USER') || decodeURIComponent(url.password) !== value('PG_PASSWORD') ||
      decodeURIComponent(url.pathname.slice(1)) !== value('PG_DB') || !/^[\w.-]+$/.test(value('PG_DB'))) fail('API 数据库连接参数与本次数据库不符');
  return { host: url.hostname, database: value('PG_DB') };
}

export function probeManifest(name, pg, host) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS, labels: { 'mx-recovery-purpose': 'postgres-readonly' } }, spec: {
    restartPolicy: 'Never', activeDeadlineSeconds: 240, automountServiceAccountToken: false,
    nodeSelector: pg.spec.nodeSelector, affinity: pg.spec.affinity,
    tolerations: pg.spec.tolerations, imagePullSecrets: pg.spec.imagePullSecrets,
    containers: [{ name: 'client', image: pg.spec.containers.find(c => c.name === 'postgres').image,
      imagePullPolicy: 'Never', command: ['sleep', '240'],
      securityContext: { runAsUser: 65534, runAsGroup: 65534, runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
      env: [{ name: 'PGHOST', value: host }, { name: 'PGPORT', value: '5432' },
        ...[['PGUSER', 'PG_USER'], ['PGPASSWORD', 'PG_PASSWORD'], ['PGDATABASE', 'PG_DB']].map(([name, key]) => ({ name, valueFrom: { secretKeyRef: { name: 'mx-launcher-db', key } } }))]
    }]
  } };
}

export function psqlScript(negative = false) {
  return `unset PGHOSTADDR PGSERVICE PGSERVICEFILE
export PGCONNECT_TIMEOUT=5 PGSSLMODE=disable LC_ALL=C PGPASSFILE=/dev/null
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000"
${negative ? 'export PGPASSWORD="mx-cutover-intentionally-invalid-${PGPASSWORD}"' : ''}
exec psql -X -qAt -w -v ON_ERROR_STOP=1`;
}

export function assertRecords(report, environment, podIP, database) {
  if (report.server_address !== podIP || report.database !== database || !Array.isArray(report.records)) fail('查询没有连接到已核实的 PostgreSQL Pod/数据库');
  if (!report.records.some(row => row.environment === environment && row.has_smh === true && row.has_sqb === true &&
      row.smh_has_credential === true && row.sqb_has_credential === true)) fail('实际 API 环境未同时找到 SMH/SQB 及凭据；API 保持停止');
}

export function authenticationSummary(negative) {
  if (negative.status === 0) return 'Service 连接接受错误密码：该链路未证明密码校验生效；保留现有认证规则，仅核实连接与业务数据。';
  if (/password authentication failed/i.test(negative.stderr || '')) return 'Service 连接已拒绝错误密码。';
  return '错误密码探测未完成或被其它规则拒绝，不能据此判断密码校验；继续检查实际连接。';
}

function main(work) {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !/^\/data\/mx-recovery\/confirmed-cutover\.[A-Za-z0-9]+$/.test(work || '')) fail('请通过恢复脚本的 --finish 入口指定此次私有备份目录');
  const st = lstatSync(work);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o077)) fail('恢复目录权限或类型不符');
  const read = name => JSON.parse(readFileSync(`${work}/${name}.json`, 'utf8'));
  const id = path => { const s = statSync(path); return `${s.dev}:${s.ino}`; };
  if (id(ROOT) !== id(TARGET) || id(TARGET + '/k8s/postgres/pgdata') !== '66309:1084247412') fail('当前挂载不是已确认的最新数据；不重新挂载');
  const rows = readFileSync('/etc/fstab', 'utf8').split('\n').filter(x => x.trim() && !x.trim().startsWith('#')).map(x => x.trim().split(/\s+/)).filter(x => x[1] === TARGET);
  if (rows.length !== 1 || rows[0][0] !== ROOT || !rows[0][3].split(',').includes('bind')) fail('开机挂载尚未指向最新目录');
  for (const label of ['latest-mx-launcher', 'latest-etcd', 'previous-mx-launcher']) {
    const before = readFileSync(`${work}/${label}.before.sha256`, 'utf8');
    if (!before || before !== readFileSync(`${work}/${label}.copy.sha256`, 'utf8') || before !== readFileSync(`${work}/${label}.after.sha256`, 'utf8') || !statSync(`${work}/${label}`).isDirectory()) fail('此次完整备份/校验记录不齐');
  }
  const run = (args, input, timeout = 30000) => spawnSync('kubectl', [`--request-timeout=${Math.ceil(timeout / 1000)}s`, '-n', NS, ...args], { input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const checked = (args, input, label = 'kubectl', timeout) => {
    const r = run(args, input, timeout);
    if (r.error || r.status !== 0) {
      writeFileSync(`${work}/finish-${label}.private.log`, r.stderr || '', { mode: 0o600 });
      fail(`${label} 失败，原始错误仅保存在私有目录；未改密码或认证规则`);
    }
    return r.stdout;
  };
  const get = (kind, name, extra = []) => JSON.parse(checked(['get', kind, ...(name ? [name] : []), ...extra, '-o', 'json']));
  const saved = { api: read('api.before'), pg: read('pg.guarded'), config: read('config.before'), service: read('service.before'),
    secret: read('secrets.before').items.find(s => s.metadata.name === 'mx-launcher-db'),
    pvc: read('pvc.before').items.find(s => s.metadata.name === 'postgres-data-mx-internal-postgres-0'),
    pv: read('pv.before').items.find(s => s.metadata.name === 'mx-internal-postgres-local-pv') };
  const load = () => ({ api: get('deployment', 'mx-launcher-internal'), pg: get('statefulset', 'mx-internal-postgres'),
    config: get('configmap', 'mx-launcher-internal-config'), secret: get('secret', 'mx-launcher-db'), service: get('service', 'mx-internal-postgres'),
    pod: get('pod', 'mx-internal-postgres-0'), slices: get('endpointslices', '', ['-l', 'kubernetes.io/service-name=mx-internal-postgres']),
    pvc: get('pvc', 'postgres-data-mx-internal-postgres-0'), pv: get('pv', 'mx-internal-postgres-local-pv') });
  const current = load(); assertWorkloads(saved, current);
  const target = databaseTarget(current.secret, current.service);
  console.log('已确认最新挂载、完整备份记录、原 PV/PVC 和就绪的 PostgreSQL；不再次复制或停库。');
  const name = `mx-pg-recovery-${randomBytes(6).toString('hex')}`;
  let created;
  try {
    created = JSON.parse(checked(['create', '-f', '-', '-o', 'json'], JSON.stringify(probeManifest(name, current.pod, target.host)), 'probe-create'));
    writeFileSync(`${work}/${name}.json`, JSON.stringify(created), { mode: 0o600 });
    checked(['wait', '--for=condition=Ready', `pod/${name}`, '--timeout=90s'], undefined, 'probe-ready', 110000);
    const negative = run(['exec', '-i', name, '-c', 'client', '--', 'sh', '-ec', psqlScript(true)], 'SELECT 1;\n');
    writeFileSync(`${work}/finish-negative-auth.private.log`, negative.stderr || '', { mode: 0o600 });
    console.log(authenticationSummary(negative));
    const output = checked(['exec', '-i', name, '-c', 'client', '--', 'sh', '-ec', psqlScript()], summarySQL, 'database-read');
    const report = JSON.parse(output);
    writeFileSync(`${work}/records.json`, JSON.stringify(report.records), { mode: 0o600 });
    assertRecords(report, current.config.data.MX_ENVIRONMENT || 'shadow', current.pod.status.podIP, target.database);
    console.log(JSON.stringify(report.records, null, 2));
    const latest = load(); assertWorkloads(saved, latest);
    if (latest.pod.metadata.uid !== current.pod.metadata.uid) fail('校验期间 PostgreSQL Pod 已更换；请重新执行续接检查');
    const patch = [{ op: 'test', path: '/metadata/uid', value: latest.api.metadata.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: latest.api.metadata.resourceVersion },
      { op: 'test', path: '/spec/replicas', value: 0 }, { op: 'replace', path: '/spec/replicas', value: 1 }];
    const patchFile = `${work}/finish-start-api.patch.json`;
    writeFileSync(patchFile, JSON.stringify(patch), { mode: 0o600 });
    checked(['patch', 'deployment', 'mx-launcher-internal', '--type=json', '--patch-file', patchFile], undefined, 'start-api');
    checked(['rollout', 'status', 'deployment/mx-launcher-internal', '--timeout=240s'], undefined, 'api-ready', 260000);
    console.log('最新业务库及 SMH/SQB 凭据记录已核实，Internal API 已启动并就绪；请实际验收员工登录。');
  } finally {
    // No data volumes are attached. Remove only the temporary Pod we created.
    if (created?.metadata.uid) {
      const result = run(['get', 'pod', name, '--ignore-not-found', '-o', 'json']);
      if (result.status === 0 && result.stdout.trim()) {
        const pod = JSON.parse(result.stdout);
        if (pod.metadata.uid === created.metadata.uid) run(['delete', 'pod', name, '--wait=false']);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); } catch (error) {
    console.error(error instanceof SyntaxError || error.code ? '续接检查失败：无法读取或解析所需数据；未输出私有内容。' : error.message);
    process.exitCode = 1;
  }
}
