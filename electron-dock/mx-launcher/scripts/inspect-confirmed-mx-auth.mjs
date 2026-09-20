#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { localIdentity } from './k8s-recovery-state.mjs';
import { parseEnvFile } from '../server/scripts/internal-k8s-secret-ensure.mjs';

const NS = 'mx-internal-shadow';
const IMAGE = 'registry.k8s.io/etcd:3.6.8-0';
export const AUTH_KEYS = Object.freeze({
  'mx-internal-ops': ['token'],
  'mx-feishu-oauth': ['app-id', 'app-secret', 'tenant-keys'],
  'mx-sdk-service-account-secrets': ['secrets.json'],
  'mx-launcher-db': ['PG_USER', 'PG_PASSWORD', 'PG_DB']
});
const fail = message => { throw new Error(message); };
const text = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer);
const base64 = value => {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value) fail('非法 base64；未输出内容');
  return Buffer.from(value, 'base64');
};

// Kubernetes runtime.Unknown and core/v1.Secret protobuf wire format. Decode
// only this allowlisted object type; never scrape printable strings from bbolt.
export function fields(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 4 * 1024 * 1024) fail('protobuf 大小不合法');
  let pos = 0;
  const integer = () => {
    let value = 0n;
    for (let n = 0; n < 10; n++) {
      if (pos >= buffer.length) fail('protobuf 数据截断');
      const byte = buffer[pos++];
      value |= BigInt(byte & 127) << BigInt(7 * n);
      if (!(byte & 128)) {
        if (n === 9 && byte > 1) fail('protobuf 整数越界');
        return value;
      }
    }
    fail('protobuf 整数越界');
  };
  const result = [];
  while (pos < buffer.length) {
    const tag = integer(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!number || number > 536870911) fail('protobuf 字段号不合法');
    if (wire === 0) { result.push({ number, wire, value: integer() }); continue; }
    let size;
    if (wire === 2) { const n = integer(); if (n > BigInt(buffer.length)) fail('protobuf 长度越界'); size = Number(n); }
    else if (wire === 1) size = 8;
    else if (wire === 5) size = 4;
    else fail('不支持的 protobuf wire type');
    if (pos + size > buffer.length) fail('protobuf 数据截断');
    result.push({ number, wire, value: buffer.subarray(pos, pos + size) }); pos += size;
  }
  return result;
}
function one(list, number, wire = 2, required = true) {
  const matches = list.filter(field => field.number === number);
  if (matches.length > 1 || (required && !matches.length) || matches.some(field => field.wire !== wire)) fail('protobuf 字段缺失、重复或类型错误');
  return matches[0]?.value;
}
function cleanSecret(object, name) {
  if (!Object.hasOwn(AUTH_KEYS, name) || object?.apiVersion !== 'v1' || object.kind !== 'Secret' ||
      object.metadata?.name !== name || object.metadata?.namespace !== NS || object.metadata.deletionTimestamp ||
      (object.type && object.type !== 'Opaque') || (object.immutable != null && typeof object.immutable !== 'boolean') ||
      !object.data || typeof object.data !== 'object' || Array.isArray(object.data) || Object.keys(object.stringData || {}).length) fail('备份 Secret 类型、名称、命名空间或结构不符');
  for (const [key, value] of Object.entries(object.data)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) fail('Secret 字段名不合法');
    base64(value);
  }
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: NS }, type: 'Opaque',
    ...(object.immutable ? { immutable: true } : {}), data: object.data };
}
export function decodeSecret(buffer, name) {
  if (!Object.hasOwn(AUTH_KEYS, name)) fail('Secret 不在提取名单');
  if (buffer.subarray(0, 8).toString() === 'k8s:enc:') fail('原 Secret 使用存储加密，需要原 EncryptionConfiguration；不猜测或绕过加密');
  if (!buffer.subarray(0, 4).equals(Buffer.from('k8s\0'))) return cleanSecret(JSON.parse(text(buffer)), name);
  const envelope = fields(buffer.subarray(4)), meta = fields(one(envelope, 1));
  const apiVersion = text(one(meta, 1)), kind = text(one(meta, 2));
  if (text(one(envelope, 3, 2, false) || Buffer.alloc(0))) fail('不支持压缩的 Kubernetes protobuf');
  const contentType = text(one(envelope, 4, 2, false) || Buffer.alloc(0));
  if (contentType && contentType !== 'application/vnd.kubernetes.protobuf') fail('不支持的 Kubernetes 内容类型');
  const secret = fields(one(envelope, 2)), metadata = fields(one(secret, 1));
  if (one(metadata, 9, 2, false)?.length) fail('备份 Secret 有删除标记');
  if (secret.some(field => field.number === 4)) fail('备份 Secret 包含意外 stringData');
  const data = Object.create(null);
  for (const field of secret.filter(field => field.number === 2)) {
    if (field.wire !== 2) fail('Secret data 格式不合法');
    const entry = fields(field.value), key = text(one(entry, 1));
    if (Object.hasOwn(data, key)) fail('Secret data 字段重复');
    data[key] = one(entry, 2).toString('base64');
  }
  const immutable = one(secret, 5, 0, false);
  if (immutable != null && immutable !== 0n && immutable !== 1n) fail('Secret immutable 值不合法');
  return cleanSecret({ apiVersion, kind, metadata: { name: text(one(metadata, 1)), namespace: text(one(metadata, 3)) },
    type: text(one(secret, 3, 2, false) || Buffer.alloc(0)), immutable: immutable === 1n, data }, name);
}
export function decodeRange(response, name) {
  const kvs = response?.kvs || [];
  if (!response?.header?.revision || !Array.isArray(kvs) || Number(response.count || 0) !== kvs.length || kvs.length > 1) fail('etcd 查询返回结构异常');
  if (!kvs.length) return null;
  if (text(base64(kvs[0].key)) !== `/registry/secrets/${NS}/${name}`) fail('etcd 返回了其它资源');
  return decodeSecret(base64(kvs[0].value), name);
}
export function secretSummary(original, current, name) {
  const present = AUTH_KEYS[name].filter(key => original?.data?.[key] && text(base64(original.data[key])).trim());
  return { name, original_found: Boolean(original), required_fields_present: present,
    required_fields_complete: present.length === AUTH_KEYS[name].length,
    current: !current ? 'missing' : !original ? 'original_missing' :
      AUTH_KEYS[name].every(key => current.data?.[key] === original.data?.[key]) ? 'matches_original' : 'differs_from_original' };
}
export function isolatedContainerArgs({ name, data, image }) {
  return ['create', '--name', name, '--pull=never', '--network=none', '--restart=no', '--read-only',
    '--user=0:0', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=label=disable',
    '--pids-limit=128', '--memory=1g', '--cpus=1', '--log-opt=max-size=10m', '--log-opt=max-file=1',
    '--mount', `type=bind,src=${data},dst=/recovery`, '--entrypoint=etcd', image,
    '--name=mx-auth-offline', '--data-dir=/recovery', '--force-new-cluster',
    '--listen-client-urls=http://127.0.0.1:2379', '--advertise-client-urls=http://127.0.0.1:2379',
    '--listen-peer-urls=http://127.0.0.1:2380', '--initial-advertise-peer-urls=http://127.0.0.1:2380',
    '--initial-cluster=mx-auth-offline=http://127.0.0.1:2380'];
}
export async function extractFromWorkingCopy({ data, image, command, save, log = console.log, sleep = setTimeout, now = Date.now }) {
  let container;
  const originals = {};
  try {
    container = command('docker', isolatedContainerArgs({ name: `mx-auth-offline-${randomUUID()}`, data, image })).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) fail('临时容器 ID 无法核验');
    save('container-id', container);
    command('docker', ['start', container]);
    log('只启动工作副本：无外部网络、无宿主机端口，不连接当前 Kubernetes。');
    const ctl = ['exec', container, 'etcdctl', '--endpoints=http://127.0.0.1:2379', '--dial-timeout=2s', '--command-timeout=3s'];
    let healthy = false;
    const deadline = now() + 60000;
    while (now() < deadline) {
      if (command('docker', [...ctl, 'endpoint', 'health'], { allowFailure: true, timeout: 5000 }).status === 0) { healthy = true; break; }
      await sleep(1000);
    }
    if (!healthy) fail('隔离副本未在 60 秒内就绪；保留副本和私有日志，不修改在线集群');
    for (const name of Object.keys(AUTH_KEYS)) {
      const response = JSON.parse(command('docker', [...ctl, 'get', `/registry/secrets/${NS}/${name}`, '--write-out=json']).stdout);
      save(`${name}.etcd.private.json`, response);
      const secret = decodeRange(response, name);
      if (secret) { originals[name] = secret; save(`${name}.original.private.json`, secret); }
    }
    return originals;
  } finally {
    if (/^[a-f0-9]{64}$/.test(container || '')) {
      const logs = command('docker', ['logs', container], { allowFailure: true });
      save('etcd.private.log', (logs.stdout || '') + (logs.stderr || ''));
      const stopped = command('docker', ['stop', '--time=10', container], { allowFailure: true });
      if (stopped.status === 0) command('docker', ['rm', container]);
      else fail('临时副本容器未正常停止；容器 ID 已保存，当前业务服务未修改');
    }
  }
}
function assertPrivateDirectory(path) {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o077)) fail('恢复目录必须由 root 拥有、权限 0700 且非符号链接');
}
function treeBytes(path) {
  const st = lstatSync(path);
  if (st.isFile()) return st.size;
  if (!st.isDirectory() || st.isSymbolicLink()) fail('etcd 备份含链接或特殊文件；不启动');
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}

async function main(work) {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !/^\/data\/mx-recovery\/confirmed-cutover\.[A-Za-z0-9]+$/.test(work || '')) fail('请通过 inspect-confirmed-mx-auth.sh 指定此次恢复目录');
  assertPrivateDirectory(work);
  const source = join(work, 'latest-etcd');
  const expected = readFileSync(join(work, 'latest-etcd.copy.sha256'), 'utf8');
  if (!expected.trim() || expected !== readFileSync(join(work, 'latest-etcd.before.sha256'), 'utf8') ||
      expected !== readFileSync(join(work, 'latest-etcd.after.sha256'), 'utf8')) fail('最新 etcd 冷备校验记录不完整');
  const bytes = treeBytes(source);
  if (!statSync(join(source, 'member/snap/db')).isFile() || !readdirSync(join(source, 'member/wal')).some(name => name.endsWith('.wal'))) fail('最新 etcd 完整备份缺少 backend/WAL；不新建空实例');
  const space = statfsSync(work, { bigint: true });
  if (space.bavail * space.bsize < BigInt(bytes) + 1073741824n) fail('etcd 工作副本空间不足；不会清理数据');
  const output = mkdtempSync(join(work, 'auth-inspect.'));
  console.log(`私有提取目录：${output}`);
  const save = (name, value) => writeFileSync(join(output, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  let sequence = 0;
  const command = (executable, args, options = {}) => {
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
    save(`command-${++sequence}.private.log`, (result.stderr || '') + (result.error ? '\ncommand failed or timed out\n' : ''));
    if ((result.error || result.status !== 0) && !options.allowFailure) fail(`${executable} 执行失败；私有诊断留在提取目录，未输出凭据`);
    return result;
  };
  const hashTree = path => command('bash', ['-o', 'pipefail', '-c',
    'cd -- "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum', 'mx-etcd-hash', path], { timeout: 120000 }).stdout;
  console.log('核验最新 etcd 完整备份，然后复制到独立工作目录（包括 WAL）。');
  if (hashTree(source) !== expected) fail('最新 etcd 冷备内容与校验记录不符');
  const image = command('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']).stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) fail('本地 etcd 镜像标识无效；不会联网拉取');
  const data = join(output, 'etcd-working');
  command('cp', ['-a', '--reflink=auto', '--', source, data], { timeout: 120000 });
  if (hashTree(data) !== expected || hashTree(source) !== expected) fail('etcd 工作副本与原备份不一致');
  const a = statSync(join(source, 'member/snap/db')), b = statSync(join(data, 'member/snap/db'));
  if (a.dev === b.dev && a.ino === b.ino) fail('工作副本不是独立文件；不启动');
  const originals = await extractFromWorkingCopy({ data, image, command, save });
  if (hashTree(source) !== expected) fail('检查后原备份校验不符；不提供自动恢复结果');
  save('originals.private.json', originals);
  const report = { source: 'verified-full-latest-etcd-copy-with-wal', secrets: [], environment: {}, runner: {}, recovery_identity: {} };
  const current = {};
  for (const name of Object.keys(AUTH_KEYS)) {
    const raw = command('kubectl', ['--request-timeout=15s', '-n', NS, 'get', 'secret', name, '--ignore-not-found', '-o', 'json']).stdout;
    current[name] = raw.trim() ? JSON.parse(raw) : null;
    report.secrets.push(secretSummary(originals[name], current[name], name));
  }
  save('current-secrets.private.json', current);
  const envPath = process.env.MX_SERVER_ENV_FILE || fileURLToPath(new URL('../server/.env', import.meta.url));
  const env = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  for (const [key, name, field] of [
    ['MX_INTERNAL_OPS_TOKEN', 'mx-internal-ops', 'token'], ['MX_FEISHU_APP_ID', 'mx-feishu-oauth', 'app-id'],
    ['MX_FEISHU_APP_SECRET', 'mx-feishu-oauth', 'app-secret'], ['MX_FEISHU_ALLOWED_TENANT_KEYS', 'mx-feishu-oauth', 'tenant-keys'],
    ['MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON', 'mx-sdk-service-account-secrets', 'secrets.json']
  ]) {
    // Report both explicit sources; even an empty explicit override matters to deploy.
    report.environment[key] = Object.fromEntries([['file', env], ['shell', process.env]].map(([label, values]) => [label,
      !Object.hasOwn(values, key) ? 'unset' : !values[key]?.trim() ? 'empty_override' :
        !originals[name]?.data[field] ? 'set_original_missing' : Buffer.from(values[key]).toString('base64') === originals[name].data[field] ? 'matches_original' : 'differs_from_original']));
  }
  const runner = command('systemctl', ['show', 'mx-internal-host-runner.service', '--property=LoadState,ActiveState,SubState,UnitFileState,Result'], { allowFailure: true });
  report.runner = runner.status === 0 ? Object.fromEntries(runner.stdout.trim().split('\n').filter(Boolean).map(line => line.split('='))) : { status: 'unverified' };
  report.runner.previous_state_recorded = existsSync(join(work, 'runner-was-active'));
  try {
    const identity = localIdentity('mx-internal-server', (exe, args) => command(exe, args).stdout);
    save('current-host-identity.private.json', identity);
    const hostFile = '/var/lib/mx-launcher-recovery/host.json';
    if (existsSync(hostFile)) {
      const old = JSON.parse(readFileSync(hostFile, 'utf8'));
      save('checkpoint-host.before.private.json', old);
      report.recovery_identity = { exists: true, matches_current: isDeepStrictEqual(old, identity),
        node_matches: old.node === identity.node, ca_matches: old.ca === identity.ca, pg_system_id_matches: old.pgSystemId === identity.pgSystemId,
        changed_mount_paths: identity.mounts.filter(entry => !isDeepStrictEqual(entry, old.mounts?.find(previous => previous.path === entry.path))).map(entry => entry.path) };
    } else report.recovery_identity = { exists: false };
  } catch {
    report.recovery_identity = { status: 'unverified' };
  }
  save('report.json', report);
  console.log(JSON.stringify(report, null, 2));
  console.log('原凭据已提取到私有文件，尚未写回 Secret；未重启 API/数据库、未改挂载或恢复身份。');
  console.log('请贴本次终端摘要；不要贴 private 文件、Secret 或 .env。暂不运行 deploy 或再次 --finish。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => {
    console.error(error instanceof SyntaxError || error.code ? '提取检查失败：无法读取或解析所需数据；未输出私有内容。' : error.message);
    process.exitCode = 1;
  });
}
