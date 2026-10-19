#!/usr/bin/env node
// Update only the recorded etcd mount identity after a verified storage move.
// Launcher credentials, cluster identity and every other mount stay unchanged.
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { localIdentity } from '../../../mx-launcher/scripts/k8s-recovery-state.mjs';

const FILES = ['host', 'latest'];
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const same = (left, right) => isDeepStrictEqual(left, right);
const fail = message => { throw new Error(message); };
const parse = bytes => {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { return fail('invalid private JSON; contents omitted'); }
};

// Exactly the checksum contract used by Launcher recoverState().
export function snapshotChecksum(snapshot) {
  const { checksum, ...payload } = snapshot;
  return digest(JSON.stringify(payload));
}

function assertIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      !['node', 'ca', 'pgSystemId'].every(key => typeof identity[key] === 'string' && identity[key]) ||
      !Array.isArray(identity.mounts) ||
      identity.mounts.filter(entry => entry?.path === '/var/lib/etcd').length !== 1 ||
      new Set(identity.mounts.map(entry => entry?.path)).size !== identity.mounts.length ||
      identity.mounts.some(entry => !entry || typeof entry.path !== 'string' || !entry.identity ||
        !['target', 'device', 'root', 'type'].every(key => typeof entry.identity[key] === 'string' && entry.identity[key]))) {
    fail('invalid Launcher host identity');
  }
}

export function assertEtcdOnlyChange(original, current) {
  assertIdentity(original);
  assertIdentity(current);
  const withoutEtcd = identity => ({ ...identity, mounts: identity.mounts.map(entry =>
    entry.path === '/var/lib/etcd' ? { ...entry, identity: null } : entry) });
  if (!same(withoutEtcd(original), withoutEtcd(current))) {
    fail('node, CA, PostgreSQL or another mount changed; Launcher recovery identity retained');
  }
}

function privateDirectory(path, ownerUid, optional = false) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid || (stat.mode & 0o077)) {
    fail('expected a private real recovery directory owned by the required user');
  }
  return true;
}

function privateRead(path, ownerUid, optional = false) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd);
    const link = lstatSync(path);
    if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o077) || stat.nlink !== 1 ||
        link.isSymbolicLink() || stat.ino !== link.ino || stat.dev !== link.dev) {
      fail('expected a private regular recovery file owned by the required user');
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function createPrivate(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

function replacePrivate(path, bytes, beforeRename) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  createPrivate(temporary, bytes);
  beforeRename?.();
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function context(options) {
  const { runDirectory, node, clusterUid, recoveryDirectory = '/var/lib/mx-launcher-recovery', ownerUid = 0 } = options;
  if (!runDirectory || !node || !clusterUid || typeof node !== 'string' || typeof clusterUid !== 'string') {
    fail('run directory, node name and cluster UID are required');
  }
  privateDirectory(runDirectory, ownerUid);
  return { ...options, runDirectory, node, clusterUid, recoveryDirectory, ownerUid,
    directory: join(runDirectory, 'launcher-identity') };
}

function readSources(ctx) {
  if (!privateDirectory(ctx.recoveryDirectory, ctx.ownerUid, true)) return { host: null, latest: null };
  return Object.fromEntries(FILES.map(name => [name,
    privateRead(join(ctx.recoveryDirectory, `${name}.json`), ctx.ownerUid, true)]));
}

function pairOf(files) {
  return Object.fromEntries(FILES.map(name => [name, files[name] === null ? null : digest(files[name])]));
}

function validateDocuments(files, node, clusterUid, expectedIdentity) {
  const host = files.host === null ? null : parse(files.host);
  const latest = files.latest === null ? null : parse(files.latest);
  if (files.latest !== null && files.host === null) fail('latest recovery snapshot exists without its original host identity');
  if (files.host !== null) {
    assertIdentity(host);
    if (host.node !== node || (expectedIdentity && !same(host, expectedIdentity))) {
      fail('Launcher recovery host identity does not match the current host');
    }
  }
  if (files.latest !== null && (!latest || latest.version !== 1 || typeof latest.namespace !== 'string' ||
      latest.clusterUid !== clusterUid || !same(latest.identity, host) ||
      latest.checksum !== snapshotChecksum(latest))) {
    fail('Launcher recovery snapshot identity, cluster UID or checksum differs');
  }
  return { host, latest };
}

function saveJournal(ctx, journal) {
  const { checksum, ...payload } = journal;
  replacePrivate(join(ctx.directory, 'journal.json'), encode({ ...payload, checksum: digest(JSON.stringify(payload)) }));
}

function loadJournal(ctx) {
  privateDirectory(ctx.directory, ctx.ownerUid);
  const journal = parse(privateRead(join(ctx.directory, 'journal.json'), ctx.ownerUid));
  const { checksum, ...payload } = journal;
  if (checksum !== digest(JSON.stringify(payload)) || journal.version !== 1 ||
      journal.node !== ctx.node || journal.clusterUid !== ctx.clusterUid ||
      journal.recoveryDirectory !== ctx.recoveryDirectory || !Array.isArray(journal.transitions) ||
      !journal.original || !same(Object.keys(journal.original).sort(), [...FILES].sort()) ||
      FILES.some(name => journal.original[name] !== null && !/^[a-f0-9]{64}$/.test(journal.original[name]))) {
    fail('invalid migration identity journal or different cluster/run context');
  }
  const originals = Object.fromEntries(FILES.map(name => [name, journal.original[name] === null ? null :
    privateRead(join(ctx.directory, `${name}.original.json`), ctx.ownerUid)]));
  if (!same(pairOf(originals), journal.original)) fail('original recovery backup checksum differs');
  const documents = validateDocuments(originals, ctx.node, ctx.clusterUid);
  const reachable = [journal.original];
  for (const transition of journal.transitions) {
    if (!FILES.includes(transition.file) || !/^(host|latest)-[a-f0-9-]+\.json$/.test(transition.snapshot) ||
        !reachable.some(state => same(state, transition.before))) fail('invalid migration identity transition');
    const bytes = privateRead(join(ctx.directory, transition.snapshot), ctx.ownerUid);
    const expected = { ...transition.before, [transition.file]: digest(bytes) };
    if (!same(expected, transition.after) || transition.before[transition.file] === null) {
      fail('invalid migration identity transition checksum');
    }
    reachable.push(transition.after);
  }
  return { journal, originals, documents, reachable };
}

function assertReachable(ctx, reachable, expected) {
  const current = pairOf(readSources(ctx));
  if (!reachable.some(state => same(state, current)) || (expected && !same(expected, current))) {
    fail('Launcher recovery files changed outside this migration; no overwrite allowed');
  }
  return current;
}

function currentIdentity(ctx) {
  const identity = ctx.identity ?? (ctx.identityProvider ?? localIdentity)(ctx.node);
  assertIdentity(identity);
  if (identity.node !== ctx.node) fail('current host node does not match the migration');
  return identity;
}

export function prepare(options) {
  const ctx = context(options);
  if (existsSync(ctx.directory)) {
    const state = loadJournal(ctx);
    assertReachable(ctx, state.reachable);
    if (state.documents.host) assertEtcdOnlyChange(state.documents.host, currentIdentity(ctx));
    return { status: state.documents.host ? 'prepared' : 'absent', files: FILES.filter(name => state.originals[name] !== null) };
  }
  const sources = readSources(ctx);
  const identity = sources.host === null && sources.latest === null ? null : currentIdentity(ctx);
  const documents = validateDocuments(sources, ctx.node, ctx.clusterUid, identity);
  mkdirSync(ctx.directory, { mode: 0o700 });
  syncDirectory(ctx.runDirectory);
  for (const name of FILES) if (sources[name] !== null) {
    createPrivate(join(ctx.directory, `${name}.original.json`), sources[name]);
  }
  const original = pairOf(sources);
  // Never bless a concurrent Launcher checkpoint taken during the copy.
  if (!same(original, pairOf(readSources(ctx)))) fail('Launcher recovery files changed while preparing migration');
  saveJournal(ctx, { version: 1, node: ctx.node, clusterUid: ctx.clusterUid,
    recoveryDirectory: ctx.recoveryDirectory, original, transitions: [] });
  return { status: documents.host ? 'prepared' : 'absent', files: FILES.filter(name => sources[name] !== null) };
}

export function reconcile(options) {
  const ctx = context(options);
  const { journal, originals, documents, reachable } = loadJournal(ctx);
  let current = assertReachable(ctx, reachable);
  if (!documents.host) return { status: 'absent', files: [] };
  const identity = currentIdentity(ctx);
  assertEtcdOnlyChange(documents.host, identity);
  const desired = { host: encode(identity), latest: null };
  if (documents.latest) {
    const latest = { ...documents.latest, identity };
    latest.checksum = snapshotChecksum(latest);
    desired.latest = encode(latest);
  }
  // Preserve the exact initial bytes on rollback, including original formatting.
  if (same(identity, documents.host)) for (const name of FILES) desired[name] = originals[name];
  const changed = [];
  for (const name of FILES) {
    if (desired[name] === null || current[name] === digest(desired[name])) continue;
    const snapshot = `${name}-${randomUUID()}.json`;
    createPrivate(join(ctx.directory, snapshot), desired[name]);
    const next = { ...current, [name]: digest(desired[name]) };
    journal.transitions.push({ file: name, snapshot, before: current, after: next });
    // Persist both allowed states and their complete bytes before changing source.
    saveJournal(ctx, journal);
    reachable.push(next);
    ctx.beforeReplace?.(name);
    replacePrivate(join(ctx.recoveryDirectory, `${name}.json`), desired[name],
      () => assertReachable(ctx, reachable, current));
    current = assertReachable(ctx, reachable, next);
    changed.push(name);
    ctx.afterReplace?.(name);
  }
  return { status: changed.length ? 'reconciled' : 'unchanged', files: changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0) fail('run as root on the Linux Kubernetes host');
    const [action, runDirectory, node, clusterUid, ...extra] = process.argv.slice(2);
    if (!['prepare', 'reconcile'].includes(action) || extra.length) fail('usage: launcher-identity.mjs prepare|reconcile RUN_DIR NODE CLUSTER_UID');
    console.log(JSON.stringify((action === 'prepare' ? prepare : reconcile)({ runDirectory, node, clusterUid })));
  } catch (error) {
    console.error(`Launcher identity update stopped: ${error.code || error instanceof SyntaxError ?
      'cannot safely read/write private recovery files; no credential values printed' : error.message}`);
    process.exitCode = 1;
  }
}
