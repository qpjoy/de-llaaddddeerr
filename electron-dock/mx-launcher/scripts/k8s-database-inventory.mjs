#!/usr/bin/env node
// Locate retained MX databases without starting containers or changing storage.
// Running instances are queried through read-only transactions; stopped data
// directories are inventoried only, never attached to a database process.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const databaseListSql = `BEGIN READ ONLY;
SELECT coalesce(json_agg(datname ORDER BY datname), '[]'::json)
FROM pg_database WHERE datallowconn AND NOT datistemplate;
ROLLBACK;`;
export const schemaListSql = `BEGIN READ ONLY;
SELECT coalesce(json_agg(n.nspname ORDER BY n.nspname), '[]'::json)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'mx_platform_records' AND c.relkind IN ('r', 'p');
ROLLBACK;`;

export function summarySql(schema) {
  const table = `"${schema.replaceAll('"', '""')}".mx_platform_records`;
  // Account names are deliberately limited to the two user-confirmed markers.
  // Do not fetch hashes, tokens, secret-provider data, or full user records.
  return `BEGIN READ ONLY;
SELECT coalesce(json_agg(summary), '[]'::json) FROM (
  SELECT environment,
    count(*) FILTER (WHERE kind = 'iam-user') AS users,
    count(*) FILTER (WHERE kind = 'iam-user-credential') AS credentials,
    max(updated_at) AS latest_user_row,
    max(data->>'updatedAt') FILTER (WHERE kind = 'iam-user-credential') AS latest_password_change,
    coalesce(bool_or(kind = 'iam-user' AND 'smh' IN (
      lower(btrim(data->>'account')), lower(btrim(data->>'displayName')),
      lower(btrim(data->>'userId')), lower(btrim(data->>'email')),
      lower(btrim(data->'profile'->'externalIds'->>'legacyUserId')),
      lower(btrim(data->'profile'->'externalIds'->>'legacyId')))), false) AS has_smh,
    coalesce(bool_or(kind = 'iam-user' AND 'sqb' IN (
      lower(btrim(data->>'account')), lower(btrim(data->>'displayName')),
      lower(btrim(data->>'userId')), lower(btrim(data->>'email')),
      lower(btrim(data->'profile'->'externalIds'->>'legacyUserId')),
      lower(btrim(data->'profile'->'externalIds'->>'legacyId')))), false) AS has_sqb
  FROM ${table} WHERE kind IN ('iam-user', 'iam-user-credential') GROUP BY environment
) summary;
ROLLBACK;`;
}

export function databaseAddress(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return { configured: true, recognized: false };
    return { host: url.hostname, port: url.port || '5432', database: decodeURIComponent(url.pathname.slice(1)) };
  } catch { return { configured: true, recognized: false }; }
}

function environment(values = []) {
  return Object.fromEntries(values.map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
}
export function containerSummary(item) {
  const env = environment(item.Config?.Env);
  return { name: item.Name, image: item.Config?.Image, status: item.State?.Status,
    created: item.Created, started: item.State?.StartedAt,
    storeDriver: ['memory', 'postgres'].includes(env.INTERNAL_STORE_DRIVER) ? env.INTERNAL_STORE_DRIVER : 'not explicit in container env',
    database: databaseAddress(env.DATABASE_URL),
    composeFiles: item.Config?.Labels?.['com.docker.compose.project.config_files'],
    mounts: (item.Mounts || []).map(mount => ({ type: mount.Type, source: mount.Source, target: mount.Destination })) };
}

export function inventoryDirectories(roots, log = console.log, { maxDirectories = 20000, maxDepth = 7, timeoutMs = 30000 } = {}) {
  const seen = new Set();
  const started = Date.now();
  const summary = { visited: 0, pgDirectories: 0, etcdFiles: 0, unreadable: 0, bounded: false, symlinksSkipped: 0 };
  const stack = [...new Set(roots.filter(isAbsolute))].reverse().map(path => ({ path, depth: 0 }));
  while (stack.length) {
    if (summary.visited >= maxDirectories || Date.now() - started > timeoutMs) { summary.bounded = true; break; }
    const { path, depth } = stack.pop();
    if (!existsSync(path)) continue;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) { summary.symlinksSkipped++; continue; }
      if (!stat.isDirectory()) continue;
      const identity = `${stat.dev}:${stat.ino}`;
      if (seen.has(identity)) continue;
      seen.add(identity); summary.visited++;
      const marker = join(path, 'PG_VERSION');
      if (existsSync(marker)) {
        const rawVersion = statSync(marker).size <= 16 ? readFileSync(marker, 'utf8').trim() : '';
        const version = /^\d+(?:\.\d+)?$/.test(rawVersion) ? rawVersion : 'unrecognized';
        const controlPath = join(path, 'global/pg_control');
        const control = existsSync(controlPath) ? statSync(controlPath) : null;
        log({ pgdata: path, version, deviceInode: identity, controlModified: control?.mtime.toISOString(),
          systemIdHex: control?.size === 8192 ? readFileSync(controlPath).subarray(0, 8).toString('hex') : null });
        summary.pgDirectories++;
        continue; // Never walk base/pg_wal or read table data files.
      }
      if (path.endsWith('/member/snap') && existsSync(join(path, 'db'))) {
        const db = statSync(join(path, 'db'));
        log({ etcdBackend: join(path, 'db'), bytes: db.size, modified: db.mtime.toISOString() });
        summary.etcdFiles++;
      }
      const entries = readdirSync(path, { withFileTypes: true });
      summary.symlinksSkipped += entries.filter(entry => entry.isSymbolicLink()).length;
      const children = entries.filter(entry => entry.isDirectory());
      if (depth >= maxDepth) { if (children.length) summary.bounded = true; continue; }
      for (const entry of children) {
        if (['overlay2', 'overlayfs', 'io.containerd.snapshotter.v1.overlayfs', 'node_modules', '.git'].includes(entry.name)) continue;
        stack.push({ path: join(path, entry.name), depth: depth + 1 });
      }
    } catch { summary.unreadable++; }
  }
  return summary;
}

function run(command, args, input, timeout = 15000) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout, maxBuffer: 24 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('read-only command failed; raw output suppressed');
  return result.stdout.trim();
}
export function psqlArguments(database) {
  // libpq interprets URI/conninfo-like database names as connection options.
  // Do not let a catalog entry redirect this local inspection to another host.
  if (typeof database !== 'string' || database.includes('=') || /^postgres(?:ql)?:\/\//.test(database)) throw new Error('unsupported database name');
  return ['env', 'PGCONNECT_TIMEOUT=5', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
    'sh', '-c', 'unset PGHOSTADDR PGSERVICE PGSERVICEFILE; exec psql -X -qAt -w --set=ON_ERROR_STOP=1 --host=/var/run/postgresql --port="${PGPORT:-5432}" --username="${POSTGRES_USER:-postgres}" --dbname="$1"', 'mx-readonly', database];
}

export function inspectDatabases(query, log = console.log) {
  const summary = { databases: 0, mxSchemas: 0, unverified: 0, limited: false };
  const started = Date.now();
  let databases;
  try {
    databases = JSON.parse(query('postgres', databaseListSql));
    if (!Array.isArray(databases) || databases.some(name => typeof name !== 'string')) throw new Error();
  } catch { summary.unverified++; log({ catalog: 'unverified: socket authentication/access/timeout' }); return summary; }
  if (databases.length > 100) { summary.limited = true; databases = databases.slice(0, 100); }
  for (const database of databases) {
    if (Date.now() - started > 60000) { summary.limited = true; break; }
    summary.databases++;
    try {
      const schemas = JSON.parse(query(database, schemaListSql));
      if (!Array.isArray(schemas) || schemas.some(name => typeof name !== 'string')) throw new Error();
      if (!schemas.length) { log({ database, mxTable: false }); continue; }
      for (const schema of schemas) {
        if (Date.now() - started > 60000) { summary.limited = true; break; }
        summary.mxSchemas++;
        const records = JSON.parse(query(database, summarySql(schema)));
        log({ database, schema, records });
      }
    } catch { summary.unverified++; log({ database, check: 'unverified: permissions/schema/timeout; not a negative finding' }); }
  }
  return summary;
}

function main() {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/k8s-database-inventory.mjs');
  const log = value => console.log(JSON.stringify(value));
  const roots = ['/data/k8s', '/data/mx-runtime/mx-launcher', '/var/lib/mx-launcher',
    '/data/docker/volumes', '/var/lib/docker/volumes'];
  let unavailable = 0;
  console.log('只读定位：不启动/停止容器，不导入备份，不清理、不挂载卷、不修改 Secret/PV/PVC。');
  console.log('===== Docker 当前及停止容器：数据库地址已去除凭据 =====');
  try {
    const ids = run('docker', ['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean);
    for (const id of ids) {
      const item = JSON.parse(run('docker', ['inspect', id]))[0];
      const env = environment(item.Config?.Env);
      const pg = /postgres/i.test(item.Config?.Image || '') || Boolean(env.PGDATA || env.POSTGRES_DB);
      const launcher = /mx[-_]launcher|internal[-_]shadow|mx[-_]h2i/i.test(`${item.Name} ${item.Config?.Image}`) || env.MX_SITE_ROLE === 'internal';
      if (!pg && !launcher) continue;
      log(containerSummary(item));
      for (const mount of item.Mounts || []) {
        if (pg || mount.Type === 'volume' || /postgres|pgdata|\/data$/.test(mount.Destination)) roots.push(mount.Source);
      }
      if (pg && item.State?.Running) {
        log({ instance: item.Name, summary: inspectDatabases((db, sql) => run('docker', ['exec', '-i', id, ...psqlArguments(db)], sql), log) });
      }
      // A stopped container may have put PGDATA in its writable layer. Inspect
      // only its known PGDATA path, not the whole Docker overlay directory.
      if (pg && item.GraphDriver?.Data?.UpperDir && isAbsolute(env.PGDATA || '')) {
        roots.push(join(item.GraphDriver.Data.UpperDir, env.PGDATA));
      }
    }
  } catch { unavailable++; console.log('Docker 清单未完成；不能据此判断数据不存在。'); }
  console.log('===== K8s 保留卷与运行中的 PostgreSQL（所有 namespace） =====');
  const kubectl = args => run('kubectl', ['--request-timeout=15s', ...args]);
  try {
    for (const pv of JSON.parse(kubectl(['get', 'pv', '-o', 'json'])).items) {
      const path = pv.spec.hostPath?.path || pv.spec.local?.path;
      log({ pv: pv.metadata.name, phase: pv.status?.phase, path, claim: pv.spec.claimRef?.name,
        namespace: pv.spec.claimRef?.namespace, driver: pv.spec.csi?.driver });
      if (path) roots.push(path);
    }
    for (const pod of JSON.parse(kubectl(['get', 'pods', '-A', '-o', 'json'])).items) {
      for (const container of pod.spec.containers || []) {
        if (!/postgres/i.test(container.image) || !pod.status?.containerStatuses?.some(status => status.name === container.name && status.ready)) continue;
        const prefix = ['--request-timeout=15s', '-n', pod.metadata.namespace, 'exec', '-i', pod.metadata.name, '-c', container.name, '--'];
        log({ checkingPod: `${pod.metadata.namespace}/${pod.metadata.name}`, container: container.name });
        log({ pod: `${pod.metadata.namespace}/${pod.metadata.name}`, container: container.name,
          summary: inspectDatabases((db, sql) => run('kubectl', [...prefix, ...psqlArguments(db)], sql), log) });
      }
    }
  } catch { unavailable++; console.log('K8s 清单未完成；不能据此判断数据不存在。'); }
  console.log('===== 未启动的数据目录、匿名卷及 /data/k8s：仅文件元数据 =====');
  // Also inspect the conventional PostgreSQL path in retained containerd
  // snapshots. Never traverse arbitrary image layers or mount a snapshot.
  let snapshotCandidates = 0;
  let snapshotScanLimited = false;
  for (const base of ['/var/lib/containerd', '/data/k8s/containerd', '/data/mx-runtime/containerd']) {
    const snapshots = join(base, 'io.containerd.snapshotter.v1.overlayfs/snapshots');
    if (!existsSync(snapshots)) continue;
    try {
      const entries = readdirSync(snapshots, { withFileTypes: true }).filter(entry => entry.isDirectory());
      if (entries.length > 5000) snapshotScanLimited = true;
      for (const entry of entries.slice(0, 5000)) {
        const candidate = join(snapshots, entry.name, 'fs/var/lib/postgresql');
        if (existsSync(candidate)) { roots.push(candidate); snapshotCandidates++; }
      }
    } catch { unavailable++; }
  }
  log({ snapshotCandidates, snapshotScanLimited });
  log({ filesystemScan: inventoryDirectories(roots, log), unavailable });
  console.log('时间戳/相同 systemId 不能证明副本最新；SMH/SQB 命中也需结合业务记录核实。');
  console.log('停止容器/匿名卷本轮没有启动或查询内容；未命中不代表丢失。请贴本输出，不要贴私有配置。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error('定位检查未完成，未输出原始错误或凭据。'); process.exitCode = 1; }
}
