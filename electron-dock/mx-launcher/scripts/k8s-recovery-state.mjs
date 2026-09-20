#!/usr/bin/env node
// Local, single-node production recovery. Never infer an empty data directory
// is a new installation, and never overwrite a live Secret from a backup.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_NAMES = [
  'mx-launcher-db', 'mx-internal-ops', 'mx-feishu-oauth',
  'mx-sdk-service-account-secrets', 'mx-release-oss', 'mx-insight-hub-admin'
];
const PG = '/var/lib/mx-launcher/k8s/postgres/pgdata';
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  // Do not include command output: errors can contain credentials or manifests.
  if (result.error || result.status !== 0) throw new Error(`${command} failed; check local service/API access (no credentials printed)`);
  return result.stdout;
}
export function mountIdentity(entry) {
  if (!entry?.target || !entry.source || !entry.fstype || !entry.fsroot) throw new Error('incomplete findmnt identity');
  if (!String(entry.options).split(',').includes('rw')) throw new Error(`read-only filesystem at ${entry.target}`);
  return { target: entry.target, device: entry.uuid || entry.source.split('[')[0], root: entry.fsroot, type: entry.fstype };
}
export function assertFstabMounted(targets, mounts) {
  for (const target of targets) {
    if (mounts.some(({ path }) => path === target || path.startsWith(`${target}/`)) &&
        !mounts.some(({ identity }) => identity.target === target)) {
      // A separate parent mount may be hidden by a bind mount: callers pass all
      // relevant fstab targets as paths too, so it is checked independently.
      throw new Error(`required fstab mount is absent: ${target}; restore the original mount before deploy`);
    }
  }
}
export function localIdentity(node, execute = run) {
  if (readFileSync(join(PG, 'PG_VERSION'), 'utf8').trim() !== '16' ||
      !statSync(join(PG, 'base')).isDirectory()) throw new Error('expected existing PostgreSQL 16 data; empty database initialization is forbidden during recovery');
  const control = readFileSync(join(PG, 'global/pg_control'));
  if (control.length !== 8192) throw new Error('invalid PostgreSQL control file');
  let dockerRoot = '/var/lib/docker';
  if (existsSync('/etc/docker/daemon.json')) dockerRoot = JSON.parse(readFileSync('/etc/docker/daemon.json', 'utf8'))['data-root'] || dockerRoot;
  const paths = ['/var/lib/mx-launcher', PG, '/var/lib/etcd', '/var/lib/containerd', dockerRoot];
  const fstab = readFileSync('/etc/fstab', 'utf8').split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => line.trim().split(/\s+/)[1]?.replace(/\\040/g, ' ')).filter(Boolean);
  const required = fstab.filter(target => paths.some(path => path === target || path.startsWith(`${target}/`)));
  const mounts = [...new Set([...paths, ...required])].sort().map(path => {
    if (!statSync(path).isDirectory()) throw new Error(`required data directory missing: ${path}`);
    const result = JSON.parse(execute('findmnt', ['--json', '--target', path, '--output', 'TARGET,SOURCE,UUID,FSROOT,FSTYPE,OPTIONS']));
    return { path, identity: mountIdentity(result.filesystems?.[0]) };
  });
  assertFstabMounted(required, mounts);
  if (!existsSync('/var/lib/etcd/member/snap/db')) throw new Error('existing etcd data missing; cluster initialization is forbidden during recovery');
  return { node, ca: hash(readFileSync('/etc/kubernetes/pki/ca.crt')), pgSystemId: control.subarray(0, 8).toString('hex'), mounts };
}
function privateDir(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('recovery directory must be owned by the current user with mode 700 and not be a symlink');
  } else {
    // The production wrapper runs as root and uses a fixed /var/lib parent.
    mkdirSync(path, { mode: 0o700 });
  }
}
function readPrivate(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('recovery file must be a private regular file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function cleanSecret(secret, namespace, name) {
  if (secret?.kind !== 'Secret' || secret.metadata?.name !== name || secret.metadata?.namespace !== namespace ||
      secret.metadata.deletionTimestamp || (secret.type && secret.type !== 'Opaque') ||
      !secret.data || typeof secret.data !== 'object' || Array.isArray(secret.data) ||
      !Object.values(secret.data).every(value => typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value)) {
    throw new Error(`invalid recovery Secret ${name}`);
  }
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: 'Opaque',
    ...(secret.immutable ? { immutable: true } : {}), data: secret.data };
}
export function recoverState(action, { directory, namespace, identity, execute = run, log = console.log }) {
  if (!['host', 'restore', 'checkpoint'].includes(action) || !/^[a-z0-9][a-z0-9-]*$/.test(namespace)) throw new Error('invalid recovery action or namespace');
  privateDir(directory);
  const hostFile = join(directory, 'host.json');
  if (existsSync(hostFile)) {
    if (!same(readPrivate(hostFile), identity)) throw new Error('host mount, CA, node or PostgreSQL identity changed; automatic recovery stopped; inspect host.json without deleting it');
  } else save(hostFile, identity);
  if (action === 'host') { log('original mounts and PostgreSQL identity verified'); return; }
  const kubectl = (args, input) => execute('kubectl', ['--request-timeout=15s', ...args], input);
  const get = (kind, name, ns) => {
    const raw = kubectl([...(ns ? ['-n', ns] : []), 'get', kind, name, '--ignore-not-found', '-o', 'json']);
    return raw.trim() ? JSON.parse(raw) : null;
  };
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'])).items;
  if (nodes?.length !== 1 || nodes[0].metadata?.name !== identity.node) throw new Error('automatic recovery supports only the original single-node cluster');
  const clusterUid = get('namespace', 'kube-system')?.metadata?.uid;
  if (!clusterUid) throw new Error('cannot identify the existing Kubernetes cluster');
  const latest = join(directory, 'latest.json');
  const backup = existsSync(latest) ? readPrivate(latest) : null;
  if (backup && (backup.version !== 1 || backup.namespace !== namespace || !same(backup.identity, identity) || backup.clusterUid !== clusterUid)) {
    throw new Error('recovery snapshot belongs to another cluster/storage identity; no Secrets restored');
  }
  if (backup) {
    const { checksum, ...payload } = backup;
    if (checksum !== hash(JSON.stringify(payload))) throw new Error('recovery snapshot checksum mismatch; no Secrets restored');
  }
  const stored = {};
  if (backup) for (const [name, secret] of Object.entries(backup.secrets)) {
    if (!SECRET_NAMES.includes(name)) throw new Error('unexpected Secret in recovery snapshot');
    stored[name] = cleanSecret(secret, namespace, name);
  }
  // Read the complete set before any mutation; an API failure is never NotFound.
  const live = {};
  for (const name of SECRET_NAMES) {
    const secret = get('secret', name, namespace);
    if (secret) live[name] = cleanSecret(secret, namespace, name);
  }
  const missing = Object.keys(stored).filter(name => !live[name]);
  if (action === 'restore') {
    if (!backup) {
      // An existing DB with no ops credential must not silently receive a new token.
      if (!live['mx-launcher-db'] || !live['mx-internal-ops']) throw new Error('existing database requires original mx-launcher-db and mx-internal-ops; no recovery snapshot yet; restore original Secrets first');
      log('no prior recovery snapshot; existing database and ops Secrets found');
    }
    if (missing.length && !get('namespace', namespace)) kubectl(['create', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } }));
    for (const name of missing) {
      kubectl(['create', '-f', '-'], JSON.stringify(stored[name]));
      if (!same(cleanSecret(get('secret', name, namespace), namespace, name), stored[name])) throw new Error(`restored Secret ${name} could not be verified`);
      log(`restored missing Secret ${name}; original credential retained`);
    }
    if (!missing.length) log('existing Secrets retained; no credential restored or rotated');
    if (!(live['mx-feishu-oauth'] || stored['mx-feishu-oauth'])) log('WARNING: no Feishu Secret or snapshot; verify Feishu login configuration separately');
    return;
  }
  if (missing.length) throw new Error(`refusing to replace recovery snapshot while Secrets are missing: ${missing.join(', ')}`);
  if (!live['mx-launcher-db'] || !live['mx-internal-ops']) throw new Error('database and ops Secrets required before checkpoint');
  const payload = { version: 1, namespace, clusterUid, identity, secrets: live };
  const snapshot = { ...payload, checksum: hash(JSON.stringify(payload)) };
  if (!backup || !same(backup, snapshot)) {
    // Retain prior generations; never overwrite the sole copy after a rotation.
    save(join(directory, `secrets-${Date.now()}-${randomUUID()}.json`), snapshot);
    save(latest, snapshot);
  }
  log(`private recovery checkpoint ready: ${directory} (credential values omitted)`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('production recovery must run as root on the Linux Kubernetes host');
    const [action, namespace, node] = process.argv.slice(2);
    if (!node) throw new Error('node name required');
    const directory = '/var/lib/mx-launcher-recovery';
    recoverState(action, { directory, namespace, identity: localIdentity(node) });
  } catch (error) {
    // JSON / fs errors can include private fragments. Only our own errors are safe.
    console.error(`production recovery stopped: ${error instanceof SyntaxError || error.code ? 'cannot read/validate local recovery data or required data directories; check mounts and private file permissions' : error.message}`);
    process.exitCode = 1;
  }
}
