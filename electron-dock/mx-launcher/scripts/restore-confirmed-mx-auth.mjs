#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { decodeRange } from './inspect-confirmed-mx-auth.mjs';
import { localIdentity, recoverState } from './k8s-recovery-state.mjs';
import { assertRecords, databaseTarget, summarySQL } from './restore-confirmed-mx-data-finish.mjs';
import { parseEnvFile, resolveKnownEnvironment, planInternalK8sSecrets, assertRequiredLoginProviders } from '../server/scripts/internal-k8s-secret-ensure.mjs';

const NS = 'mx-internal-shadow', API = 'mx-launcher-internal', DB = 'mx-launcher-db';
const CHECKPOINT = '/var/lib/mx-launcher-recovery';
const ANNOTATION = 'mx.qpjoy.com/recovered-original-auth';
const ROOT = '/data/k8s/mx-runtime/mx-launcher', TARGET = '/var/lib/mx-launcher';
export const RESTORE_KEYS = { 'mx-internal-ops': ['token'], 'mx-feishu-oauth': ['app-id', 'app-secret', 'tenant-keys'] };
const ENV_KEYS = { MX_INTERNAL_OPS_TOKEN: ['mx-internal-ops', 'token'], MX_FEISHU_APP_ID: ['mx-feishu-oauth', 'app-id'],
  MX_FEISHU_APP_SECRET: ['mx-feishu-oauth', 'app-secret'], MX_FEISHU_ALLOWED_TENANT_KEYS: ['mx-feishu-oauth', 'tenant-keys'] };
const fail = message => { throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const decode = value => Buffer.from(value, 'base64').toString('utf8');
const fieldsMatch = (a, b, keys) => keys.every(key => a?.data?.[key] === b?.data?.[key]);
function privateStat(path, directory = false) {
  const st = lstatSync(path);
  if (st.uid !== process.getuid() || (st.mode & 0o077) || st.isSymbolicLink() || !(directory ? st.isDirectory() : st.isFile())) fail('恢复文件必须为当前用户私有的普通文件/目录');
}
function readPrivate(path) { privateStat(path); return JSON.parse(readFileSync(path, 'utf8')); }
function durableSave(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}

export function planAuth(originals, inspected, live) {
  if (!live[DB] || live[DB].metadata?.uid !== inspected[DB]?.metadata?.uid || !same(live[DB].data, inspected[DB].data) ||
      !fieldsMatch(originals[DB], live[DB], ['PG_USER', 'PG_PASSWORD', 'PG_DB'])) fail('数据库 Secret 与已验证原值/当前连接不一致；不改数据库凭据');
  const changes = [], desired = { ...live };
  for (const [name, keys] of Object.entries(RESTORE_KEYS)) {
    const original = originals[name], current = live[name], before = inspected[name];
    if (original?.kind !== 'Secret' || original.metadata?.name !== name || original.metadata?.namespace !== NS ||
        keys.some(key => typeof original.data?.[key] !== 'string' || !decode(original.data[key]).trim())) fail(`${name} 原凭据不齐全`);
    if (current && (current.metadata?.deletionTimestamp || (current.type && current.type !== 'Opaque'))) fail(`${name} 当前资源状态不适合恢复`);
    if (current && fieldsMatch(current, original, keys)) continue;
    if (current ? (!before || current.metadata.uid !== before.metadata.uid || !same(current.data, before.data)) : Boolean(before)) {
      fail(`${name} 在提取后被其它操作修改；不覆盖新的凭据`);
    }
    if (current?.immutable) fail(`${name} 不可修改；不会删除重建`);
    const resource = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: NS }, type: 'Opaque',
      data: { ...current?.data, ...Object.fromEntries(keys.map(key => [key, original.data[key]])) } };
    desired[name] = resource;
    changes.push({ name, resource, before: current });
  }
  // No SDK credential is invented when neither the latest backup nor cluster has one.
  return { changes, desired };
}
export function validateDeployEnvironment(desired, file, shell, service) {
  let plan;
  try {
    plan = planInternalK8sSecrets({ namespace: NS, existingSecrets: desired,
      environment: resolveKnownEnvironment(file, shell), randomSecret: () => fail('禁止生成新凭据') });
    assertRequiredLoginProviders(plan, 'local-password,feishu');
  } catch { fail('恢复凭据或私有 env 未通过部署校验；未输出原值，请检查显式覆盖配置'); }
  for (const [name, keys] of Object.entries(RESTORE_KEYS)) {
    if (!fieldsMatch(plan.resources.find(item => item.metadata.name === name), desired[name], keys)) fail(`${name} 会被私有 env 覆盖；先处理原值冲突`);
  }
  const sdk = 'mx-sdk-service-account-secrets';
  if (!same(plan.resources.find(item => item.metadata.name === sdk)?.data, desired[sdk]?.data)) fail('SDK 凭据有额外 env 变更；本次仅恢复原 Ops/飞书凭据');
  databaseTarget(plan.resources.find(item => item.metadata.name === DB), service);
}
export function secretPatch(change, current) {
  if (!current || current.metadata.uid !== change.before?.metadata.uid || !same(current.data, change.before.data) || current.metadata.deletionTimestamp || current.immutable) fail(`${change.name} 写入前状态发生变化`);
  return [{ op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    { op: 'test', path: '/data', value: current.data }, { op: 'replace', path: '/data', value: change.resource.data }];
}
export function validateExtractedOriginals(originals, responses) {
  for (const name of [...Object.keys(RESTORE_KEYS), DB]) {
    // Protobuf maps use a null prototype in the decoder; disk JSON uses Object.
    const decoded = JSON.parse(JSON.stringify(decodeRange(responses[name], name)));
    if (!originals[name] || !same(originals[name], decoded)) fail('提取文件与原 etcd 记录不一致');
  }
}
export function applyAuthSecrets(plan, { get, kubectl, savePatch, log = console.log }) {
  for (const change of plan.changes) {
    const now = get('secret', change.name);
    if (now && fieldsMatch(now, change.resource, RESTORE_KEYS[change.name])) continue;
    let applied;
    if (change.before) {
      const patch = secretPatch(change, now), path = savePatch(`${change.name}.patch.private.json`, patch);
      applied = JSON.parse(kubectl(['patch', 'secret', change.name, '--type=json', '--patch-file', path, '-o', 'json']));
    } else {
      if (now) fail(`${change.name} 已被其它操作创建；不覆盖`);
      applied = JSON.parse(kubectl(['create', '-f', '-', '-o', 'json'], JSON.stringify(change.resource)));
    }
    if (!fieldsMatch(applied, change.resource, RESTORE_KEYS[change.name])) fail('Secret 写后核验不符；不继续滚动 API');
    log(`${change.name}：原凭据已恢复（未输出值）`);
  }
}
export function rolloutPatch(api, digest, changed, now = Date.now()) {
  const annotations = api.spec.template.metadata.annotations || {};
  if (!changed && String(annotations[ANNOTATION] || '').startsWith(`${digest}:`)) return null;
  return [{ op: 'test', path: '/metadata/uid', value: api.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: api.metadata.resourceVersion },
    { op: 'test', path: '/spec/replicas', value: 1 },
    { op: 'add', path: '/spec/template/metadata/annotations', value: { ...annotations, [ANNOTATION]: `${digest}:${now}` } }];
}
export function assertRuntimeLayout(saved, state) {
  const { api, pg, pod, pv, pvc, config, service, slices } = state;
  if (api.metadata.uid !== saved.api.metadata.uid || pg.metadata.uid !== saved.pg.metadata.uid || api.spec.replicas !== 1 || pg.spec.replicas !== 1 ||
      api.metadata.deletionTimestamp || pg.metadata.deletionTimestamp) fail('API/数据库身份或副本数变化；不自动重建工作负载');
  if (pod.metadata.deletionTimestamp || !pod.metadata.ownerReferences?.some(o => o.uid === pg.metadata.uid) ||
      pod.spec.nodeName !== 'mx-internal-server' || !pod.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) fail('已恢复的 PostgreSQL 尚未就绪');
  if (pv.metadata.uid !== saved.pv.metadata.uid || pvc.metadata.uid !== saved.pvc.metadata.uid || pv.metadata.deletionTimestamp || pvc.metadata.deletionTimestamp ||
      pv.status.phase !== 'Bound' || pvc.status.phase !== 'Bound' || pvc.spec.volumeName !== pv.metadata.name || pv.spec.claimRef?.uid !== pvc.metadata.uid ||
      pv.spec.hostPath?.path !== `${TARGET}/k8s/postgres` || pv.spec.persistentVolumeReclaimPolicy !== 'Retain' ||
      !pod.spec.volumes?.some(v => v.persistentVolumeClaim?.claimName === pvc.metadata.name)) fail('已恢复数据库的原 PV/PVC 绑定不一致');
  const endpoints = slices.items.flatMap(item => item.endpoints || []);
  if (service.metadata.uid !== saved.service.metadata.uid || !same(service.spec, saved.service.spec) || !endpoints.length ||
      endpoints.some(e => e.targetRef?.uid !== pod.metadata.uid || e.conditions?.ready !== true || e.conditions?.terminating || !e.addresses?.includes(pod.status.podIP))) fail('数据库 Service 未指向已核实的 PostgreSQL Pod');
  if (!same(config.data, saved.config.data) || config.data.INTERNAL_STORE_DRIVER !== 'postgres' || (config.data.MX_ENVIRONMENT || 'shadow') !== 'shadow') fail('Internal 数据环境配置发生变化；不覆盖');
  const app = api.spec.template.spec.containers.find(c => c.name === 'internal-api');
  const refs = { ...ENV_KEYS, ...Object.fromEntries(['DATABASE_URL', 'DATABASE_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DB'].map(key => [key, [DB, key]])) };
  for (const [key, [name, field]] of Object.entries(refs)) {
    const items = app?.env?.filter(e => e.name === key) || [], ref = items[0]?.valueFrom?.secretKeyRef;
    if (items.length !== 1 || items[0].value != null || ref?.name !== name || ref.key !== field) fail('API 未通过原 Secret 引用加载认证/数据库配置');
  }
  databaseTarget(state.secrets[DB], service);
}

// Sent to the running API via stdin. Expected secrets never occur in argv or output.
export async function probeRuntime(expected) {
  const { loadConfig } = await import('/app/dist/src/config.js');
  const { createRequire } = await import('node:module');
  const { Client } = createRequire('/app/package.json')('pg');
  const config = loadConfig();
  const result = { environment_matches: config.environment === 'shadow', store_matches: config.storeDriver === 'postgres',
    credentials_loaded: Object.entries(expected.env).every(([key, value]) => process.env[key] === value),
    database_url_matches: config.databaseUrl === expected.databaseUrl };
  if (!Object.values(result).every(value => value === true)) return result;
  const response = await fetch('http://127.0.0.1:18090/internal/v1/user-center/roles', {
    headers: { 'x-mx-ops-token': expected.env.MX_INTERNAL_OPS_TOKEN }, signal: AbortSignal.timeout(10000) });
  result.original_ops_accepted = response.status === 200; await response.body?.cancel();
  const feishu = await fetch('http://127.0.0.1:18090/internal/v1/sdk/oauth/feishu/config', { signal: AbortSignal.timeout(10000) });
  result.feishu_enabled = feishu.ok && (await feishu.json()).config?.enabled === true;
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10000,
    statement_timeout: 10000, query_timeout: 12000, options: '-c default_transaction_read_only=on', application_name: 'mx-auth-recovery-readonly' });
  try {
    await client.connect();
    const responses = await client.query(expected.sql);
    result.database = (Array.isArray(responses) ? responses : [responses]).flatMap(r => r.rows || []).find(row => row.json_build_object)?.json_build_object;
  } finally { await client.end(); }
  return result;
}
export function assertRuntimeReport(report, podIP, database) {
  for (const key of ['environment_matches', 'store_matches', 'credentials_loaded', 'database_url_matches', 'original_ops_accepted', 'feishu_enabled']) {
    if (report?.[key] !== true) fail(`API 恢复检查未通过：${key}；不会改数据库或盲目回滚凭据`);
  }
  // Validation only: it does not pause the already running API on failure.
  try { assertRecords(report.database, 'shadow', podIP, database); }
  catch { fail('API 实际连接未通过最新业务库/SMH/SQB 凭据核验；保留当前服务，未写恢复检查点'); }
}

export function standardRunnerUnit(content, properties, root) {
  if (properties.LoadState !== 'loaded' || properties.UnitFileState !== 'enabled' || properties.DropInPaths || properties.EnvironmentFiles ||
      properties.NeedDaemonReload !== 'no' || properties.ExecStartPre || properties.ExecStartPost || properties.ExecStop || properties.ExecStopPost || properties.WorkingDirectory !== root) return false;
  const entries = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('['));
  const allowed = new Set(['Description', 'After', 'Wants', 'Type', 'WorkingDirectory', 'Environment', 'ExecStart', 'Restart', 'RestartSec', 'WantedBy']);
  if (entries.some(line => !allowed.has(line.split('=')[0]))) return false;
  const values = key => entries.filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1));
  if (!same(values('WorkingDirectory'), [root]) || values('ExecStart').length !== 1 ||
      !/^\/[A-Za-z0-9_./-]+\/node server\/scripts\/internal-service-peer-host-runner\.mjs 19190$/.test(values('ExecStart')[0])) return false;
  const env = values('Environment');
  return env.length === 5 && new Set(env.map(line => line.split('=')[0])).size === 5 &&
    env.includes('MX_INTERNAL_HOST_RUNNER_HOST=0.0.0.0') && env.includes('MX_INTERNAL_HOST_RUNNER_PORT=19190') &&
    env.every(line => /^(MX_INTERNAL_HOST_RUNNER_HOST|MX_INTERNAL_HOST_RUNNER_PORT|MX_INTERNAL_SERVICE_ARTIFACT_DIR|MX_QP_TUNNEL_CLI_BUNDLE_DIR|PATH)=/.test(line));
}

async function main(inspect) {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !/^\/data\/mx-recovery\/confirmed-cutover\.[A-Za-z0-9]+\/auth-inspect\.[A-Za-z0-9]+$/.test(inspect || '')) fail('请指定此次已完成的私有 auth-inspect 目录');
  privateStat(inspect, true);
  const work = dirname(inspect); privateStat(work, true);
  const report = readPrivate(join(inspect, 'report.json'));
  if (report.source !== 'verified-full-latest-etcd-copy-with-wal') fail('提取尚未完成或来源不符');
  const originals = readPrivate(join(inspect, 'originals.private.json')), inspected = readPrivate(join(inspect, 'current-secrets.private.json'));
  validateExtractedOriginals(originals, Object.fromEntries([...Object.keys(RESTORE_KEYS), DB].map(name => [name, readPrivate(join(inspect, `${name}.etcd.private.json`))])));
  const id = path => { const st = statSync(path); return `${st.dev}:${st.ino}`; };
  if (id(ROOT) !== id(TARGET)) fail('当前挂载不是已确认的最新数据；不重新挂载');
  const rows = readFileSync('/etc/fstab', 'utf8').split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => line.trim().split(/\s+/)).filter(row => row[1] === TARGET);
  if (rows.length !== 1 || rows[0][0] !== ROOT || !rows[0][3].split(',').includes('bind')) fail('开机挂载未指向最新数据目录');
  const output = mkdtempSync(join(work, 'auth-restore.'));
  console.log(`本次私有配置备份：${output}`);
  let commandId = 0;
  const execute = (command, args, input, timeout = 30000, optional = false) => {
    const r = spawnSync(command, args, { input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(join(output, `command-${++commandId}.private.log`), r.stderr || '', { mode: 0o600 });
    if ((r.status !== 0 || r.error) && !optional) fail(`${command} 操作未完成；私有错误留在备份目录，可用同一命令续跑`);
    return optional ? r : r.stdout;
  };
  const kubectl = (args, input, timeout = 30000) => execute('kubectl', [`--request-timeout=${Math.ceil(timeout / 1000)}s`, '-n', NS, ...args], input, timeout);
  const get = (kind, name, extra = []) => {
    const raw = kubectl(['get', kind, ...(name ? [name] : []), '--ignore-not-found', ...extra, '-o', 'json']);
    return raw.trim() ? JSON.parse(raw) : null;
  };
  const load = () => ({ api: get('deployment', API), pg: get('statefulset', 'mx-internal-postgres'), pod: get('pod', 'mx-internal-postgres-0'),
    config: get('configmap', 'mx-launcher-internal-config'), service: get('service', 'mx-internal-postgres'),
    pv: get('pv', 'mx-internal-postgres-local-pv'), pvc: get('pvc', 'postgres-data-mx-internal-postgres-0'),
    slices: get('endpointslices', '', ['-l', 'kubernetes.io/service-name=mx-internal-postgres']),
    secrets: Object.fromEntries([...Object.keys(RESTORE_KEYS), DB, 'mx-sdk-service-account-secrets'].map(name => [name, get('secret', name)])) });
  const identity = localIdentity('mx-internal-server', execute);
  if (!same(identity, readPrivate(join(inspect, 'current-host-identity.private.json')))) fail('提取后主机/挂载/数据库身份改变；不自动迁移身份');
  const nodes = get('nodes', '')?.items;
  if (nodes?.length !== 1 || nodes[0].metadata.name !== identity.node) fail('不是已确认的原单节点');
  const clusterUid = get('namespace', 'kube-system')?.metadata?.uid;
  if (!clusterUid) fail('无法确认当前集群身份');
  if (existsSync(CHECKPOINT)) {
    privateStat(CHECKPOINT, true);
    for (const name of ['host', 'latest']) if (existsSync(join(CHECKPOINT, `${name}.json`))) {
      const value = readPrivate(join(CHECKPOINT, `${name}.json`));
      durableSave(join(output, `checkpoint-${name}.before.private.json`), value);
      if (name === 'host' && !same(value, identity)) fail('已有恢复身份不一致；不删除或覆盖');
      if (name === 'latest') {
        const { checksum, ...payload } = value;
        if (value.version !== 1 || value.namespace !== NS || value.clusterUid !== clusterUid || !same(value.identity, identity) || checksum !== hash(JSON.stringify(payload))) fail('已有恢复快照校验或身份不符；不覆盖');
      }
    }
  }
  const read = name => readPrivate(join(work, `${name}.json`));
  const saved = { api: read('api.before'), pg: read('pg.before'), service: read('service.before'), config: read('config.before'),
    pv: read('pv.before').items.find(item => item.metadata.name === 'mx-internal-postgres-local-pv'),
    pvc: read('pvc.before').items.find(item => item.metadata.name === 'postgres-data-mx-internal-postgres-0') };
  const current = load(); assertRuntimeLayout(saved, current);
  const plan = planAuth(originals, inspected, current.secrets);
  const envPath = process.env.MX_SERVER_ENV_FILE || fileURLToPath(new URL('../server/.env', import.meta.url));
  validateDeployEnvironment(plan.desired, existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {}, process.env, current.service);
  durableSave(join(output, 'before.private.json'), { identity, clusterUid, state: current });
  durableSave(join(output, 'plan.private.json'), plan);
  console.log(`最新挂载和原数据库连接保持不变；计划恢复 ${plan.changes.length} 个认证 Secret。`);
  applyAuthSecrets(plan, { get, kubectl, savePatch: (name, patch) => { const path = join(output, name); durableSave(path, patch); return path; } });
  let state = load(); assertRuntimeLayout(saved, state);
  const verifySecrets = state => {
    if (!same(state.secrets[DB].data, current.secrets[DB].data)) fail('数据库 Secret 被并发修改；不覆盖');
    for (const [name, keys] of Object.entries(RESTORE_KEYS)) if (!fieldsMatch(state.secrets[name], originals[name], keys)) fail('认证 Secret 被并发修改；不覆盖');
  };
  verifySecrets(state);
  const digest = hash(JSON.stringify(Object.fromEntries(Object.entries(RESTORE_KEYS).map(([name, keys]) => [name, keys.map(key => originals[name].data[key])]))));
  const patch = rolloutPatch(state.api, digest, plan.changes.length > 0);
  if (patch) {
    const path = join(output, 'api-reload.patch.json'); durableSave(path, patch);
    kubectl(['patch', 'deployment', API, '--type=json', '--patch-file', path, '-o', 'json']);
  }
  console.log('等待 Internal API 加载原凭据；PostgreSQL 保持运行。');
  kubectl(['rollout', 'status', `deployment/${API}`, '--timeout=240s'], undefined, 260000);
  state = load(); assertRuntimeLayout(saved, state); verifySecrets(state);
  const expected = { env: Object.fromEntries(Object.entries(ENV_KEYS).map(([key, [name, field]]) => [key, decode(originals[name].data[field])])),
    databaseUrl: decode(state.secrets[DB].data.DATABASE_URL), sql: summarySQL };
  const program = `let body=''; process.stdin.on('data', c=>body+=c); process.stdin.on('end', async()=>{try {
    const result=await (${probeRuntime.toString()})(JSON.parse(body)); console.log(JSON.stringify(result));
  } catch { console.error('API read-only verification failed; private values omitted'); process.exitCode=1; }});`;
  const runtime = JSON.parse(kubectl(['exec', '-i', `deployment/${API}`, '-c', 'internal-api', '--', 'node', '-e', program], JSON.stringify(expected), 60000));
  durableSave(join(output, 'runtime-report.json'), runtime);
  assertRuntimeReport(runtime, state.pod.status.podIP, databaseTarget(state.secrets[DB], state.service).database);
  const final = load(); assertRuntimeLayout(saved, final); verifySecrets(final);
  if (state.pod.metadata.uid !== final.pod.metadata.uid || !same(identity, localIdentity('mx-internal-server', execute))) fail('验收期间数据库或挂载变化；不写恢复检查点');
  recoverState('checkpoint', { directory: CHECKPOINT, namespace: NS, identity, execute });
  const checkpoint = readPrivate(join(CHECKPOINT, 'latest.json'));
  if (!same(checkpoint.secrets[DB].data, final.secrets[DB].data) || Object.entries(RESTORE_KEYS).some(([name, keys]) => !fieldsMatch(checkpoint.secrets[name], originals[name], keys))) fail('恢复检查点与已核实凭据不一致');
  console.log('原 Ops Token 已通过管理接口验证；飞书配置 enabled；API 仍连接最新业务库，SMH/SQB 凭据存在。');
  console.log('最新挂载身份和原凭据检查点已落盘；后续正常 deploy/重启复用原值，不生成替代凭据。');

  // Restore an enabled native runner only when it matches this repository's
  // standard listener-only unit. Never reinstall it or call a network apply API.
  const unit = 'mx-internal-host-runner.service';
  const shown = execute('systemctl', ['show', unit, '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,DropInPaths,EnvironmentFiles,WorkingDirectory,NeedDaemonReload,ExecStartPre,ExecStartPost,ExecStop,ExecStopPost'], undefined, 30000, true);
  const props = Object.fromEntries((shown.stdout || '').trim().split('\n').filter(Boolean).map(line => { const p = line.indexOf('='); return [line.slice(0, p), line.slice(p + 1)]; }));
  durableSave(join(output, 'runner-properties.private.json'), props);
  let runner = { active: props.ActiveState === 'active', action: 'unchanged' };
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
  if (shown.status === 0 && props.ActiveState === 'inactive' && props.FragmentPath === `/etc/systemd/system/${unit}`) {
    const unitText = readFileSync(props.FragmentPath, 'utf8');
    durableSave(join(output, 'runner-unit.before.private.json'), unitText);
    const listening = execute('ss', ['-H', '-ltn', 'sport = :19190'], undefined, 10000, true);
    if (standardRunnerUnit(unitText, props, root) && listening.status === 0 && !listening.stdout.trim()) {
      console.log('host runner 为已启用的标准原服务，19190 未被占用；只恢复监听进程。');
      const started = execute('systemctl', ['start', unit], undefined, 30000, true);
      runner.action = started.status === 0 ? 'started' : 'start_failed';
    } else runner.action = 'needs_review';
  }
  let health = false;
  for (let i = 0; i < (runner.action === 'started' ? 10 : 1); i++) {
    try { const r = await fetch('http://127.0.0.1:19190/healthz', { signal: AbortSignal.timeout(2000) }); health = r.ok && (await r.json()).mode === 'internal-service-peer-host-runner'; } catch { /* no raw error */ }
    if (health) break;
    if (runner.action === 'started') await setTimeout(1000);
  }
  const active = execute('systemctl', ['is-active', '--quiet', unit], undefined, 10000, true);
  runner = { ...runner, active: active.status === 0, health_reachable: health };
  console.log(`host runner：${JSON.stringify(runner)}`);
  durableSave(join(output, 'result.json'), { authentication_restored: true, checkpoint_ready: true, runner });
  console.log('请实际验收原员工密码登录、飞书登录及原 Ops Token；本脚本未提交真实用户登录。');
  if (!runner.active || !health) console.log('host runner 尚待核实，保持当前配置；请贴本次摘要。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => {
    console.error(error instanceof SyntaxError || error.code ? '认证恢复检查未完成：无法读取或解析数据，未输出私有内容。' : error.message);
    console.error('保留当前数据库和全部备份；可用相同认证恢复命令续跑，不要重跑数据切换或重置密码。');
    process.exitCode = 1;
  });
}
