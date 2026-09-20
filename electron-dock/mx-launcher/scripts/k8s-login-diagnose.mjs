#!/usr/bin/env node
// Read-only diagnosis on the deployment host. Never submit a login, reset a
// password, restore a Secret, or print credentials / password hashes.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from '../server/scripts/internal-k8s-secret-ensure.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fields = ['MX_FEISHU_APP_ID', 'MX_FEISHU_APP_SECRET', 'MX_FEISHU_ALLOWED_TENANT_KEYS'];
const secretKeys = ['app-id', 'app-secret', 'tenant-keys'];
const present = value => typeof value === 'string' && value.trim().length > 0;

export function feishuPresence(value) {
  if (Array.isArray(value) || Array.isArray(value?.items)) {
    return feishuPresence((Array.isArray(value) ? value : value.items)
      .find(item => item?.kind === 'Secret' && item.metadata?.name === 'mx-feishu-oauth'));
  }
  const secret = value?.secrets?.['mx-feishu-oauth']
    ?? (value?.kind === 'Secret' && value.metadata?.name === 'mx-feishu-oauth' ? value : null);
  const values = secret ? secretKeys.map(key => {
    const encoded = secret.data?.[key];
    return present(secret.stringData?.[key]) || (present(encoded) && present(Buffer.from(encoded, 'base64').toString('utf8')));
  }) : fields.map(key => present(value?.[key]));
  return { appId: values[0], appSecret: values[1], tenantKeys: values[2], complete: values.every(Boolean) };
}

// This function is serialized and run inside each currently Ready API Pod.
// Dependencies resolve from /app, so pulling this diagnostic needs no rebuild.
export async function inspectRuntime(account) {
  const { loadConfig } = await import('/app/dist/src/config.js');
  const { resolveUserCenterUserForLogin, userMatchesLogin } = await import('/app/dist/src/store/domain.js');
  const { createRequire } = await import('node:module');
  const { Client } = createRequire('/app/package.json')('pg');
  const config = loadConfig();
  const report = { store: config.storeDriver, environment: config.environment };
  report.feishu = {
    appId: Boolean(config.feishuAppId), appSecret: Boolean(config.feishuAppSecret),
    tenantKeys: config.feishuAllowedTenantKeys.length > 0,
    redirectCount: config.feishuRedirectUris.length
  };
  try {
    const response = await fetch('http://127.0.0.1:18090/internal/v1/sdk/oauth/feishu/config', { signal: AbortSignal.timeout(10000) });
    report.feishu.httpStatus = response.status;
    report.feishu.enabled = response.ok && (await response.json()).config?.enabled === true;
  } catch { report.feishu.probe = 'unavailable'; }
  if (config.storeDriver !== 'postgres' || !config.databaseUrl) {
    report.database = 'not configured as postgres';
    return report;
  }
  const url = new URL(config.databaseUrl);
  report.database = { host: url.hostname, port: url.port || '5432', name: decodeURIComponent(url.pathname.slice(1)) };
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10000,
    statement_timeout: 10000, query_timeout: 12000, options: '-c default_transaction_read_only=on',
    application_name: 'mx-login-readonly-diagnosis' });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SAVEPOINT control_info');
    try {
      report.systemIdentifier = (await client.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT control_info');
      report.systemIdentifier = 'unavailable';
    }
    report.recordSummary = (await client.query(`SELECT environment, kind, count(*)::int AS count,
      max(updated_at) AS row_updated_at, max(data->>'updatedAt') AS business_updated_at
      FROM mx_platform_records WHERE kind IN ('iam-user', 'iam-user-credential')
      GROUP BY environment, kind ORDER BY environment, kind`)).rows;
    // Read only login aliases/status. Do not select passwordHash or salt.
    const users = (await client.query(`SELECT environment, jsonb_build_object(
      'userId', data->>'userId', 'account', data->>'account', 'email', data->>'email',
      'displayName', data->>'displayName', 'status', data->>'status',
      'profile', jsonb_build_object('externalIds', data->'profile'->'externalIds'),
      'createdAt', data->>'createdAt', 'updatedAt', data->>'updatedAt') AS user
      FROM mx_platform_records WHERE kind = 'iam-user'`)).rows;
    const active = users.filter(row => row.environment === config.environment).map(row => row.user);
    const exact = active.filter(user => resolveUserCenterUserForLogin([user], account));
    const resolved = resolveUserCenterUserForLogin(active, account);
    report.login = { exactMatches: exact.length, unambiguous: Boolean(resolved),
      caseInsensitiveMatches: active.filter(user => userMatchesLogin(user, account)).length };
    report.candidates = [];
    for (const row of users.filter(row => userMatchesLogin(row.user, account))) {
      const credential = (await client.query(`SELECT data->>'kind' AS kind,
        data->>'createdAt' AS created_at, data->>'updatedAt' AS updated_at,
        coalesce(length(data->>'passwordHash'), 0) > 0 AS password_hash_present
        FROM mx_platform_records WHERE environment = $1 AND kind = 'iam-user-credential' AND id = $2`,
      [row.environment, row.user.userId])).rows[0];
      report.candidates.push({ environment: row.environment, account: row.user.account,
        exact: Boolean(resolveUserCenterUserForLogin([row.user], account)), status: row.user.status,
        createdAt: row.user.createdAt, updatedAt: row.user.updatedAt,
        credential: credential ?? null });
    }
    await client.query('ROLLBACK');
    report.databaseCheck = 'complete';
  } catch {
    report.databaseCheck = 'failed: connection, schema or read permission; raw error suppressed';
  } finally { await client.end(); }
  return report;
}

export function runtimeProgram(account) {
  return `(${inspectRuntime.toString()})(${JSON.stringify(account)})
    .then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(() => { console.error('Runtime/database check failed; no raw error or credentials printed'); process.exitCode = 1; });`;
}

export function scanPrivateSources(directories, log = console.log) {
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    let entries;
    try { entries = readdirSync(directory); } catch { log(`${directory}: unreadable`); continue; }
    for (const name of entries) {
      if (!/^\.env(?:\.|$)/.test(name) && !name.endsWith('.json')) continue;
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
        const raw = readFileSync(path, 'utf8');
        const value = name.startsWith('.env') ? parseEnvFile(raw) : JSON.parse(raw);
        log(`${path}: ${JSON.stringify(feishuPresence(value))}`);
      } catch { log(`${path}: unreadable/unrecognized (no contents printed)`); }
    }
  }
}

function command(args, input) {
  const result = spawnSync('kubectl', ['--request-timeout=20s', ...args], {
    input, encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error('kubectl read/exec failed (raw output suppressed)');
  return result.stdout;
}

function main() {
  const account = process.argv[2]?.trim();
  if (!account || account.length > 256 || /[\r\n\0]/.test(account) || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/k8s-login-diagnose.mjs ACCOUNT');
  }
  const namespace = process.env.MX_INTERNAL_NAMESPACE || 'mx-internal-shadow';
  const get = (kind, name, namespaced = true) => JSON.parse(command([
    ...(namespaced ? ['-n', namespace] : []), 'get', kind, name, '--ignore-not-found', '-o', 'json'
  ]).trim() || 'null');
  const show = (title, value) => console.log(`${title}: ${JSON.stringify(value)}`);
  console.log('只读登录诊断：不登录、不重置密码、不修改数据库/Secret/PVC。');
  for (const [kind, name, namespaced] of [
    ['pv', 'mx-internal-postgres-local-pv', false],
    ['pvc', 'postgres-data-mx-internal-postgres-0', true]
  ]) {
    const value = get(kind, name, namespaced);
    show(`${kind}/${name}`, value ? { uid: value.metadata.uid, phase: value.status?.phase,
      path: value.spec.hostPath?.path || value.spec.local?.path, volumeName: value.spec.volumeName,
      claim: value.spec.claimRef?.name } : 'missing');
  }
  show('mx-feishu-oauth fields', feishuPresence(get('secret', 'mx-feishu-oauth')));
  const pods = JSON.parse(command(['-n', namespace, 'get', 'pods', '-l', 'app.kubernetes.io/name=mx-launcher-internal', '-o', 'json'])).items;
  const ready = pods.filter(pod => !pod.metadata.deletionTimestamp &&
    pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'));
  if (!ready.length || ready.length > 5) throw new Error('expected 1–5 Ready Internal API Pods; inspect rollout first');
  let failed = false;
  for (const pod of ready) {
    const container = pod.spec.containers.find(item => item.name === 'internal-api');
    if (!container) throw new Error('Internal API container not recognized');
    show('API Pod', { name: pod.metadata.name, node: pod.spec.nodeName, image: container.image });
    try {
      // Parse and re-serialize only structured results, never raw exec warnings.
      const report = JSON.parse(command(['-n', namespace, 'exec', '-i', pod.metadata.name, '-c', container.name,
        '--', 'node', '--input-type=module', '-'], runtimeProgram(account)));
      console.log(JSON.stringify(report, null, 2));
      if (report.databaseCheck !== 'complete') failed = true;
    } catch { console.log('API/数据库检查未完成；未输出原始错误或凭据。'); failed = true; }
  }
  console.log('飞书恢复来源：仅检查 server/.env*、私有 Secret 快照和已知恢复目录中的 JSON；不代表全盘搜索。');
  const directories = [join(root, 'server'), '/var/lib/mx-launcher-recovery'];
  if (existsSync('/data/mx-recovery')) {
    for (const entry of readdirSync('/data/mx-recovery', { withFileTypes: true })) {
      if (entry.isDirectory() && /^(secret-|sources-|pgcheck-)/.test(entry.name)) directories.push(join('/data/mx-recovery', entry.name));
    }
  }
  scanPrivateSources(directories);
  console.log('PVC UID 不是密码密钥；同一数据库实例也不保证记录是最新的。请贴本诊断输出，不要贴私有文件。');
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof SyntaxError || error.code ? '检查失败：不能读取/解析诊断来源；未输出原始内容。' : error.message);
    process.exitCode = 1;
  }
}
