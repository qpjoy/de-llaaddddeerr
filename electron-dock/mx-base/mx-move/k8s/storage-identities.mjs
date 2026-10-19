#!/usr/bin/env node
// The caller owns service quiescence and mounts. This helper changes only the
// retained mount fields; original credentials and database/volume identities
// are copied byte-for-byte into a private, resumable transaction journal.
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { localIdentity, run } from '../../../mx-launcher/scripts/k8s-recovery-state.mjs';
import { postgresIdentifier } from '../../../mx-common/scripts/storage-preflight.mjs';
import { databaseResources } from '../../mx-pay/scripts/postgres.mjs';

export const ROOTS = Object.freeze({ launcher: '/var/lib/mx-launcher', common: '/data/k8s/mx-runtime/mx-common/k8s', pay: '/data/mx-pay/mx-pay/postgres' });
const LAUNCHER_NAMESPACE = 'mx-internal-shadow';
const TARGET_KEYS = { '/var/lib/kubelet': 'kubelet', [ROOTS.launcher]: 'launcher', [ROOTS.common]: 'common', '/data/mx-rig': 'rig', [ROOTS.pay]: 'pay-postgres' };
const LAUNCHER_PATHS = [ROOTS.launcher, `${ROOTS.launcher}/k8s/postgres/pgdata`];
const FILES = ['launcherHost', 'launcherLatest', 'common', 'payHost', 'payCheckpoint'];
const DISK_KEYS = ['clusterUID', 'namespace', 'node', 'localPath', 'mountTarget', 'filesystemUUID', 'volumeMountRoot'];
const MOUNT_KEYS = ['mountTarget', 'filesystemUUID', 'volumeMountRoot'];
const same = isDeepStrictEqual;
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = message => { throw new Error(message); };
const assert = (ok, message) => { if (!ok) fail(message); };
const parse = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { return fail('invalid private identity JSON; values omitted'); } };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;
const canonical = path => string(path) && path.startsWith('/') && posix.normalize(path) === path && !/[\x00-\x20\x7f\\]/.test(path);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

export function snapshotChecksum(snapshot) {
  return digest(JSON.stringify(without(snapshot, ['checksum'])));
}

function launcherShape(value) {
  assert(object(value) && ['node', 'ca', 'pgSystemId'].every(key => string(value[key])) &&
    /^[a-f0-9]{64}$/.test(value.ca) && /^[a-f0-9]{16}$/.test(value.pgSystemId) && Array.isArray(value.mounts), 'invalid Launcher identity');
  assert(new Set(value.mounts.map(m => m?.path)).size === value.mounts.length &&
    value.mounts.every(m => object(m) && canonical(m.path) && object(m.identity) &&
      ['target', 'device', 'root', 'type'].every(k => string(m.identity[k]))) &&
    [...LAUNCHER_PATHS, '/var/lib/etcd', '/var/lib/containerd'].every(p => value.mounts.some(m => m.path === p)), 'incomplete Launcher mount identity');
}

export function assertLauncherOnlyChange(before, after) {
  launcherShape(before); launcherShape(after);
  const mask = identity => ({ ...identity, mounts: identity.mounts.map(m => LAUNCHER_PATHS.includes(m.path) ? { ...m, identity: null } : m) });
  assert(same(mask(before), mask(after)), 'Launcher node, CA, PostgreSQL, etcd, Docker or an unrelated mount changed');
}

export function assertPayMountOnlyChange(before, after) {
  assert(object(before) && object(after) && same(without(before, MOUNT_KEYS), without(after, MOUNT_KEYS)), 'payment non-mount identity changed');
}

function payIdentity(identity, context) {
  assert(object(identity) && identity.phase === 'ready' && identity.namespace === 'mx-pay' &&
    identity.clusterUID === context.clusterUid && identity.node === context.node && identity.localPath === ROOTS.pay &&
    identity.storageClass === '' && /^[a-f0-9]{32}$/.test(identity.installationID ?? '') &&
    /^\d{10,25}$/.test(identity.systemIdentifier ?? '') &&
    ['pvUID', 'pvcUID', 'pvName', ...MOUNT_KEYS].every(key => string(identity[key])), 'unsupported or incomplete payment identity');
}

function resource(obj, kind, name, namespace) {
  assert(object(obj) && obj.kind === kind && obj.metadata?.name === name &&
    (!namespace || obj.metadata.namespace === namespace) && string(obj.metadata?.uid) &&
    string(obj.metadata?.resourceVersion) && !obj.metadata.deletionTimestamp, 'missing, replaced or terminating payment resource');
}

function payContainer(statefulSet) {
  resource(statefulSet, 'StatefulSet', 'mx-pay-postgres', 'mx-pay');
  assert(statefulSet.spec?.updateStrategy?.type === 'OnDelete', 'unsupported payment StatefulSet update strategy');
  const containers = statefulSet.spec?.template?.spec?.containers;
  assert(Array.isArray(containers) && containers.length === 1 && containers[0].name === 'postgres' &&
    !statefulSet.spec.template.spec.initContainers?.length, 'expected the single payment PostgreSQL container without init containers');
  const index = containers.findIndex(c => c.name === 'postgres');
  const container = containers[index];
  assert(Array.isArray(container.env) && container.env.filter(e => e.name === 'MX_PAY_EXPECTED_MOUNT_ROOT').length === 1, 'payment mount guard missing or ambiguous');
  const envIndex = container.env.findIndex(e => e.name === 'MX_PAY_EXPECTED_MOUNT_ROOT');
  assert(typeof container.env[envIndex].value === 'string' && !container.env[envIndex].valueFrom &&
    Array.isArray(container.command) && container.command.join(' ').includes('MX_PAY_EXPECTED_MOUNT_ROOT') &&
    container.command.join(' ').includes('pg_controldata'), 'payment startup mount/database guard missing');
  return { container, index, envIndex, mountRoot: container.env[envIndex].value };
}

export function validatePayResources(resources, identity, context) {
  payIdentity(identity, context);
  const { configMap, statefulSet, pv, pvc } = resources;
  resource(configMap, 'ConfigMap', 'mx-pay-database', 'mx-pay');
  assert(!configMap.immutable && string(configMap.data?.identity) && same(parse(Buffer.from(configMap.data.identity)), identity), 'payment ConfigMap is immutable or differs from retained identity');
  resource(pv, 'PersistentVolume', identity.pvName);
  resource(pvc, 'PersistentVolumeClaim', 'mx-pay-postgres-data', 'mx-pay');
  assert(pv.metadata.uid === identity.pvUID && pvc.metadata.uid === identity.pvcUID && pvc.spec?.volumeName === identity.pvName &&
    pv.spec?.claimRef?.uid === identity.pvcUID && pv.spec.claimRef.name === 'mx-pay-postgres-data' && pv.spec.claimRef.namespace === 'mx-pay' &&
    pv.spec?.local?.path === ROOTS.pay && pv.spec.persistentVolumeReclaimPolicy === 'Retain' &&
    pv.status?.phase === 'Bound' && pvc.status?.phase === 'Bound', 'payment PV/PVC binding or local path changed');
  const { container, mountRoot } = payContainer(statefulSet);
  const spec = statefulSet.spec.template.spec;
  const known = databaseResources(identity, { installationID: identity.installationID }).items.find(item => item.kind === 'StatefulSet').spec.template.spec.containers[0].command;
  const legacy = [...known.slice(0, 2), known[2].replace(' chmod -- 00700 "$PGDATA";', '')];
  assert(mountRoot === identity.volumeMountRoot && (same(container.command, known) || same(container.command, legacy)) &&
    container.image === identity.image && (!container.args || container.args.length === 0), 'payment StatefulSet database/installation/mount command or image changed');
  assert(container.env.filter(e => e.name === 'PGDATA').length === 1 &&
    container.env.find(e => e.name === 'PGDATA')?.value === '/var/lib/postgresql/data/pgdata' &&
    !container.env.find(e => e.name === 'PGDATA')?.valueFrom &&
    (container.securityContext?.runAsUser ?? spec.securityContext?.runAsUser) === 999 &&
    (container.securityContext?.runAsGroup ?? spec.securityContext?.runAsGroup) === 999, 'payment PGDATA or database owner changed');
  const data = spec.volumes?.find(v => v.name === 'data'), dataMount = container.volumeMounts?.find(v => v.name === 'data');
  assert(data?.persistentVolumeClaim?.claimName === 'mx-pay-postgres-data' && !data.persistentVolumeClaim.readOnly &&
    dataMount?.mountPath === '/var/lib/postgresql/data' && !dataMount.readOnly && !dataMount.subPath && !dataMount.subPathExpr &&
    spec.volumes?.find(v => v.name === 'bootstrap')?.secret?.secretName === 'mx-pay-postgres-bootstrap' &&
    container.volumeMounts?.find(v => v.name === 'bootstrap')?.mountPath === '/bootstrap', 'payment data volume or bootstrap Secret mount changed');
}

// Pure JSON Patch builders. Every mutation carries Kubernetes UID, resourceVersion
// and exact previous-value tests. The executor must fetch fresh objects and apply
// these separately; this helper never contacts a cluster to write resources.
export function payPatches(resources, original, desired, context, expectedUIDs) {
  assertPayMountOnlyChange(original, desired);
  payIdentity(original, context); payIdentity(desired, context);
  const { configMap, statefulSet, pv, pvc } = resources;
  const current = parse(Buffer.from(configMap?.data?.identity ?? ''));
  assert(same(current, original) || same(current, desired), 'payment ConfigMap changed outside this migration');
  const liveMount = payContainer(statefulSet).mountRoot;
  assert([original.volumeMountRoot, desired.volumeMountRoot].includes(liveMount), 'payment StatefulSet mount changed outside this migration');
  // A partially applied pair is a supported retry state, but both anchors and
  // the entire PostgreSQL guard must still identify the original database.
  const normalized = structuredClone(statefulSet);
  const selected = payContainer(normalized);
  selected.container.env[selected.envIndex].value = current.volumeMountRoot;
  validatePayResources({ configMap, statefulSet: normalized, pv, pvc }, current, context);
  if (expectedUIDs) assert(configMap.metadata.uid === expectedUIDs.configMap && statefulSet.metadata.uid === expectedUIDs.statefulSet,
    'payment ConfigMap or StatefulSet was replaced');
  const tests = obj => [
    { op: 'test', path: '/metadata/uid', value: obj.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: obj.metadata.resourceVersion },
  ];
  const cfg = same(current, desired) ? [] : [...tests(configMap),
    { op: 'test', path: '/data/identity', value: configMap.data.identity },
    { op: 'replace', path: '/data/identity', value: JSON.stringify(desired) }];
  const { container, index, envIndex } = payContainer(statefulSet);
  const envPath = `/spec/template/spec/containers/${index}/env`;
  const sts = liveMount === desired.volumeMountRoot ? [] : [...tests(statefulSet),
    { op: 'test', path: `/spec/template/spec/containers/${index}/command`, value: container.command },
    { op: 'test', path: envPath, value: container.env },
    { op: 'replace', path: `${envPath}/${envIndex}/value`, value: desired.volumeMountRoot }];
  return { schema_version: 1, namespace: 'mx-pay', configMap: { name: 'mx-pay-database', patch: cfg },
    statefulSet: { name: 'mx-pay-postgres', patch: sts } };
}

function privateDirectory(path, ownerUid) {
  const value = lstatSync(path);
  assert(value.isDirectory() && !value.isSymbolicLink() && value.uid === ownerUid && !(value.mode & 0o077), 'identity directory must be private and owned by the required user');
}

function readPrivate(path, ownerUid) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = fstatSync(fd), link = lstatSync(path);
    assert(value.isFile() && value.uid === ownerUid && !(value.mode & 0o077) && value.nlink === 1 &&
      !link.isSymbolicLink() && link.dev === value.dev && link.ino === value.ino, 'identity file must be a private regular file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function createPrivate(path, bytes) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

function replacePrivate(path, bytes, check) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  createPrivate(temporary, bytes);
  check?.();
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function context(options, requireRunDirectory = true) {
  const { runDirectory, node, clusterUid, targetUUID, payCheckpointPath, ownerUid = 0 } = options;
  assert(canonical(runDirectory) && string(node) && uuid(clusterUid) && uuid(targetUUID), 'invalid storage migration context');
  assert(canonical(payCheckpointPath) && payCheckpointPath.endsWith('/.deploy/database.json'), 'explicit payment deployment checkpoint path is required');
  const targets = options.targets;
  const targetBase = options.targetBase ?? `/var/lib/mx-move/k8s-data/${posix.basename(runDirectory)}`;
  assert(canonical(targetBase) && object(targets) && same(Object.keys(targets).sort(), Object.keys(TARGET_KEYS).sort()) &&
    Object.entries(TARGET_KEYS).every(([logical, key]) => targets[logical] === `${targetBase}/${key}`) &&
    new Set(Object.values(targets)).size === Object.values(targets).length, 'invalid transaction storage targets');
  if (requireRunDirectory) privateDirectory(runDirectory, ownerUid);
  const paths = options.paths ?? {
    launcherHost: '/var/lib/mx-launcher-recovery/host.json', launcherLatest: '/var/lib/mx-launcher-recovery/latest.json',
    common: '/var/lib/mx-common/storage-identity.json', payHost: '/var/lib/mx-pay/mx-pay/storage-identity.json',
    payCheckpoint: payCheckpointPath,
  };
  assert(same(Object.keys(paths).sort(), [...FILES].sort()) && FILES.every(name => canonical(paths[name])), 'invalid identity file map');
  return { ...options, runDirectory, node, clusterUid, targetUUID, targets, ownerUid, paths, directory: join(runDirectory, 'storage-identities') };
}

function sourceFiles(ctx) {
  return Object.fromEntries(FILES.map(name => {
    privateDirectory(dirname(ctx.paths[name]), ctx.ownerUid);
    return [name, readPrivate(ctx.paths[name], ctx.ownerUid)];
  }));
}
const hashes = files => Object.fromEntries(FILES.map(name => [name, digest(files[name])]));

export function inspectLocal(node, command = run) {
  const mountFor = path => {
    const result = parse(Buffer.from(command('findmnt', ['--json', '--target', path, '--output', 'TARGET,UUID,FSROOT,FSTYPE,OPTIONS']))).filesystems;
    assert(Array.isArray(result) && result.length === 1 && uuid(result[0].uuid) && canonical(result[0].target) &&
      canonical(result[0].fsroot) && ['xfs', 'ext4'].includes(result[0].fstype) && String(result[0].options).split(',').includes('rw'), 'invalid or read-only storage mount');
    return result[0];
  };
  const commonPG = `${ROOTS.common}/postgres/data/pgdata`, payPG = `${ROOTS.pay}/pgdata`;
  const identifier = root => postgresIdentifier(readFileSync(`${root}/global/pg_control`), readFileSync(`${root}/PG_VERSION`, 'utf8'));
  const common = mountFor(ROOTS.common), pay = mountFor(ROOTS.pay);
  for (const suffix of ['postgres/data', 'postgres/data/pgdata', 'elasticsearch/data', 'elasticsearch/snapshots']) {
    const nested = mountFor(`${ROOTS.common}/${suffix}`);
    assert(same(nested, common), 'mx-common data has a separate nested mount');
  }
  assert(same(mountFor(payPG), pay), 'payment PGDATA has a separate mount');
  return { launcher: localIdentity(node, command), common: { identifier: identifier(commonPG), mountTarget: common.target, filesystemUUID: common.uuid, fsroot: common.fsroot },
    pay: { systemIdentifier: identifier(payPG), installationID: readFileSync(`${ROOTS.pay}/.installation-id`, 'utf8').trim(),
      mountTarget: pay.target, filesystemUUID: pay.uuid, volumeMountRoot: posix.join(pay.fsroot, posix.relative(pay.target, ROOTS.pay)), fsroot: pay.fsroot } };
}

function validateOriginal(files, observation, resources, ctx) {
  const documents = Object.fromEntries(FILES.map(name => [name, parse(files[name])]));
  const { launcherHost: host, launcherLatest: latest, common, payHost, payCheckpoint: pay } = documents;
  launcherShape(host);
  assert(host.node === ctx.node && same(host, observation.launcher), 'Launcher host identity does not match original storage');
  assert(latest?.version === 1 && latest.namespace === LAUNCHER_NAMESPACE && latest.clusterUid === ctx.clusterUid &&
    same(latest.identity, host) && latest.checksum === snapshotChecksum(latest), 'Launcher recovery snapshot identity or checksum differs');
  assert(common?.version === 1 && common.mode === 'local' && common.root === ROOTS.common && common.node === ctx.node &&
    common.identifier === observation.common.identifier && common.mountTarget === observation.common.mountTarget &&
    common.filesystemUUID === observation.common.filesystemUUID, 'mx-common retained identity differs');
  validatePayResources(resources, pay, ctx);
  assert(DISK_KEYS.every(key => payHost?.[key] === pay[key]) && pay.systemIdentifier === observation.pay.systemIdentifier &&
    pay.installationID === observation.pay.installationID && MOUNT_KEYS.every(key => pay[key] === observation.pay[key]), 'payment disk, installation or PostgreSQL identity differs');
  return documents;
}

function journalWrite(ctx, journal) {
  const payload = without(journal, ['checksum']);
  replacePrivate(join(ctx.directory, 'journal.json'), encode({ ...payload, checksum: digest(JSON.stringify(payload)) }));
}

function load(ctx) {
  privateDirectory(ctx.directory, ctx.ownerUid);
  const journal = parse(readPrivate(join(ctx.directory, 'journal.json'), ctx.ownerUid));
  assert(journal.version === 1 && journal.checksum === digest(JSON.stringify(without(journal, ['checksum']))) &&
    same(journal.context, { node: ctx.node, clusterUid: ctx.clusterUid, targetUUID: ctx.targetUUID, targets: ctx.targets, paths: ctx.paths }) &&
    Array.isArray(journal.transitions), 'invalid identity journal or changed migration context');
  const originals = Object.fromEntries(FILES.map(name => [name, readPrivate(join(ctx.directory, `${name}.original.json`), ctx.ownerUid)]));
  assert(same(hashes(originals), journal.original), 'original identity backup checksum differs');
  validateOriginal(originals, journal.observation, journal.resources, ctx);
  const reachable = [journal.original];
  for (const transition of journal.transitions) {
    assert(FILES.includes(transition.file) && /^(launcherHost|launcherLatest|common|payHost|payCheckpoint)-[a-f0-9-]+\.json$/.test(transition.snapshot) &&
      reachable.some(state => same(state, transition.before)), 'invalid identity journal transition');
    const bytes = readPrivate(join(ctx.directory, transition.snapshot), ctx.ownerUid);
    assert(same(transition.after, { ...transition.before, [transition.file]: digest(bytes) }), 'identity transition checksum differs');
    reachable.push(transition.after);
  }
  return { journal, originals, reachable };
}

function reachableFiles(ctx, reachable, expected) {
  const current = hashes(sourceFiles(ctx));
  assert(reachable.some(state => same(state, current)) && (!expected || same(expected, current)), 'identity files changed outside this migration; no overwrite allowed');
  return current;
}

export function prepare(options) {
  const ctx = context(options);
  if (existsSync(ctx.directory)) {
    const state = load(ctx); reachableFiles(ctx, state.reachable);
    return { phase: 'identities-prepared', files: FILES.length };
  }
  const files = sourceFiles(ctx), observation = options.observation ?? inspectLocal(ctx.node);
  validateOriginal(files, observation, ctx.resources, ctx);
  mkdirSync(ctx.directory, { mode: 0o700 }); syncDirectory(ctx.runDirectory);
  for (const name of FILES) createPrivate(join(ctx.directory, `${name}.original.json`), files[name]);
  const original = hashes(files);
  assert(same(original, hashes(sourceFiles(ctx))), 'identity files changed while preparing migration');
  journalWrite(ctx, { version: 1, context: { node: ctx.node, clusterUid: ctx.clusterUid, targetUUID: ctx.targetUUID, targets: ctx.targets, paths: ctx.paths },
    original, observation, resources: ctx.resources, transitions: [] });
  return { phase: 'identities-prepared', files: FILES.length };
}

export function check(options) {
  const ctx = context(options, false);
  validateOriginal(sourceFiles(ctx), options.observation ?? inspectLocal(ctx.node), ctx.resources, ctx);
  return { phase: 'identities-checked', files: FILES.length, writes_performed: false };
}

function desiredDocuments(ctx, state, observation, restore) {
  const original = Object.fromEntries(FILES.map(name => [name, parse(state.originals[name])]));
  const originalObservation = state.journal.observation;
  assertLauncherOnlyChange(originalObservation.launcher, observation.launcher);
  assert(observation.common.identifier === originalObservation.common.identifier &&
    observation.pay.systemIdentifier === originalObservation.pay.systemIdentifier &&
    observation.pay.installationID === originalObservation.pay.installationID, 'database or payment installation changed during storage migration');
  if (restore) {
    assert(same(observation, originalObservation), 'restore original mounts before restoring identity files');
    return { files: state.originals, original: original.payCheckpoint, desired: original.payCheckpoint };
  }
  for (const item of observation.launcher.mounts.filter(m => LAUNCHER_PATHS.includes(m.path))) {
    assert(item.identity.target === ROOTS.launcher && item.identity.device === ctx.targetUUID &&
      item.identity.root === ctx.targets[ROOTS.launcher] && ['xfs', 'ext4'].includes(item.identity.type), 'Launcher destination mount does not match this transaction');
  }
  for (const name of ['common', 'pay']) assert(observation[name].mountTarget === ROOTS[name] &&
    observation[name].filesystemUUID === ctx.targetUUID && observation[name].fsroot === ctx.targets[ROOTS[name]], 'destination mount does not match this transaction');
  assert(observation.pay.volumeMountRoot === ctx.targets[ROOTS.pay], 'payment destination container mount root differs');
  const latest = { ...original.launcherLatest, identity: observation.launcher };
  latest.checksum = snapshotChecksum(latest);
  const common = { ...original.common, mountTarget: observation.common.mountTarget, filesystemUUID: observation.common.filesystemUUID };
  const changedPayMount = Object.fromEntries(MOUNT_KEYS.map(key => [key, observation.pay[key]]));
  const payHost = { ...original.payHost, ...changedPayMount }, pay = { ...original.payCheckpoint, ...changedPayMount };
  assertPayMountOnlyChange(original.payHost, payHost); assertPayMountOnlyChange(original.payCheckpoint, pay);
  return { files: Object.fromEntries(Object.entries({ launcherHost: observation.launcher, launcherLatest: latest, common, payHost, payCheckpoint: pay }).map(([k, v]) => [k, encode(v)])),
    original: original.payCheckpoint, desired: pay };
}

function retainedResourceShape(resources) {
  const spec = structuredClone(resources.statefulSet.spec);
  delete spec.replicas;
  const selected = payContainer({ ...resources.statefulSet, spec });
  selected.container.env[selected.envIndex].value = null;
  return { configData: without(resources.configMap.data, ['identity']), configImmutable: resources.configMap.immutable ?? false, statefulSetSpec: spec };
}

function buildPatches(ctx, state, desired, restore) {
  assert(same(retainedResourceShape(ctx.resources), retainedResourceShape(state.journal.resources)),
    'payment workload or non-identity ConfigMap fields changed outside this migration');
  const migrated = { ...desired.original, mountTarget: ROOTS.pay, filesystemUUID: ctx.targetUUID, volumeMountRoot: ctx.targets[ROOTS.pay] };
  return payPatches(ctx.resources, restore ? migrated : desired.original, desired.desired, ctx,
    { configMap: state.journal.resources.configMap.metadata.uid, statefulSet: state.journal.resources.statefulSet.metadata.uid });
}

export function inspect(options, { restore = false, writePatches = false, requireApplied = false, localOnly = false } = {}) {
  const ctx = context(options), state = load(ctx);
  reachableFiles(ctx, state.reachable);
  const desired = desiredDocuments(ctx, state, options.observation ?? inspectLocal(ctx.node), restore);
  assert(same(hashes(sourceFiles(ctx)), hashes(desired.files)), 'local storage identity files have not reached the selected migration state');
  if (localOnly) return { phase: 'identities-local-verified', direction: restore ? 'original' : 'target', writes_performed: false };
  const patches = buildPatches(ctx, state, desired, restore);
  if (requireApplied) assert(!patches.configMap.patch.length && !patches.statefulSet.patch.length, 'payment API mount identities have not reached the selected migration state');
  if (writePatches) replacePrivate(join(ctx.directory, 'pay-patches.json'), encode(patches));
  return { phase: requireApplied ? 'identities-verified' : 'identity-patches-prepared', direction: restore ? 'original' : 'target',
    ...(writePatches ? { pay_patches_file: join(ctx.directory, 'pay-patches.json') } : {}), api_changes_applied: false };
}

export function reconcile(options, restore = false) {
  const ctx = context(options), state = load(ctx);
  let current = reachableFiles(ctx, state.reachable);
  const observation = options.observation ?? inspectLocal(ctx.node);
  const desired = desiredDocuments(ctx, state, observation, restore);
  // On rollback the live API might still hold either permitted mount identity.
  const patches = buildPatches(ctx, state, desired, restore);
  const changed = [];
  for (const name of FILES) {
    if (current[name] === digest(desired.files[name])) continue;
    const snapshot = `${name}-${randomUUID()}.json`;
    createPrivate(join(ctx.directory, snapshot), desired.files[name]);
    const next = { ...current, [name]: digest(desired.files[name]) };
    state.journal.transitions.push({ file: name, snapshot, before: current, after: next });
    journalWrite(ctx, state.journal); state.reachable.push(next);
    ctx.beforeReplace?.(name);
    replacePrivate(ctx.paths[name], desired.files[name], () => reachableFiles(ctx, state.reachable, current));
    current = reachableFiles(ctx, state.reachable, next); changed.push(name); ctx.afterReplace?.(name);
  }
  assert(same(hashes(sourceFiles(ctx)), hashes(desired.files)), 'local storage identity update did not reach its complete state');
  replacePrivate(join(ctx.directory, 'pay-patches.json'), encode(patches));
  return { phase: restore ? 'identities-restored' : 'identities-updated', files: changed,
    pay_patches_file: join(ctx.directory, 'pay-patches.json'), local_identities_verified: true, api_changes_applied: false };
}

// CLI requests cannot redirect a privileged write through a symlink or a
// writable repository ancestor. Ancestors need not be private (0755 is fine).
function protectedAncestors(path, allowMissing = false, allowStickyTemporary = false) {
  for (let current = path; ; current = dirname(current)) {
    let info;
    try { info = lstatSync(current); } catch (error) { if (allowMissing && error.code === 'ENOENT') continue; throw error; }
    const stickyTemporary = allowStickyTemporary && ['/tmp', '/var/tmp'].includes(current) && info.isDirectory() && Boolean(info.mode & 0o1000);
    assert(!info.isSymbolicLink() && info.uid === 0 && (!(info.mode & 0o022) || stickyTemporary) &&
      (current === path ? info.isFile() || info.isDirectory() : info.isDirectory()), 'identity path has an unprotected or symbolic-link ancestor');
    if (current === '/') break;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.platform === 'linux' && process.getuid() === 0, 'run as root on the Linux Kubernetes host');
    const [action, requestFile, ...extra] = process.argv.slice(2);
    assert(['check', 'prepare', 'update', 'restore', 'patches', 'restore-patches', 'verify', 'verify-restored', 'verify-local', 'verify-local-restored'].includes(action) && canonical(requestFile) && !extra.length,
      'usage: storage-identities.mjs check|prepare|update|restore|patches|restore-patches|verify|verify-restored|verify-local|verify-local-restored PRIVATE_REQUEST.json');
    const options = parse(readPrivate(requestFile, 0));
    assert(!['paths', 'observation', 'ownerUid', 'targetBase'].some(k => Object.hasOwn(options, k)), 'production identity request cannot override observation or fixed receipt paths');
    assert(/^\/var\/lib\/mx-move\/k8s-transactions\/mx-k8s-\d{8}-\d{6}-[a-f0-9]{8}$/.test(options.runDirectory), 'invalid production transaction directory');
    const checked = context(options, false);
    // A preflight request can live in a root-owned 0700 mkdtemp directory under
    // sticky /tmp. No formal transaction directory is needed by `check`.
    privateDirectory(dirname(requestFile), 0);
    protectedAncestors(requestFile, false, true);
    for (const path of Object.values(checked.paths)) protectedAncestors(path);
    protectedAncestors(checked.runDirectory, action === 'check');
    const result = action === 'check' ? check(options) : action === 'prepare' ? prepare(options) : ['update', 'restore'].includes(action) ? reconcile(options, action === 'restore') :
      inspect(options, { restore: ['restore-patches', 'verify-restored', 'verify-local-restored'].includes(action), writePatches: action.endsWith('patches'), requireApplied: action.startsWith('verify'), localOnly: action.startsWith('verify-local') });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Storage identity update stopped: ${error.code || error instanceof SyntaxError ? 'cannot safely read/write private identity files; values omitted' : error.message}`);
    process.exitCode = 1;
  }
}
