#!/usr/bin/env node
// Read-only storage checks, followed by a non-secret identity receipt. No volume
// creation, rebinding, database startup or credential mutation belongs here.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const volumes = [
  ['mx-common-postgres-data', 'data-mx-common-postgres-0', 'postgres/data'],
  ['mx-common-elasticsearch-data', 'data-mx-common-elasticsearch-0', 'elasticsearch/data'],
  ['mx-common-elasticsearch-snapshots', 'mx-common-elasticsearch-snapshots', 'elasticsearch/snapshots'],
];
const assert = (ok, message) => { if (!ok) throw new Error(message); };

export function postgresIdentifier(control, version, endian = os.endianness()) {
  // PG16 ControlFileData: uint64 system_identifier at 0, uint32 version at 8.
  // Identity only, NOT a CRC/page/WAL integrity check. The PG startup guard uses
  // the image's pg_controldata as an independent check before its entrypoint.
  assert(version.trim() === '16' && control.length === 8192, 'expected an existing PG16 control file');
  const format = endian === 'LE' ? control.readUInt32LE(8) : control.readUInt32BE(8);
  assert(format === 1300, 'unsupported PostgreSQL control format or byte order');
  const id = (endian === 'LE' ? control.readBigUInt64LE(0) : control.readBigUInt64BE(0)).toString();
  assert(id !== '0', 'invalid PostgreSQL system identifier');
  return id;
}

export function validateBindings(pvs, pvcs, root, node) {
  for (const [name, claim, suffix] of volumes) {
    const pv = pvs.find(p => p.metadata?.name === name);
    const pvc = pvcs.find(p => p.metadata?.name === claim);
    assert(pv && pvc, `${name}: retained PV/PVC metadata missing; use explicit recovery, never initialize another database`);
    assert(!pv.metadata.deletionTimestamp && !pvc.metadata.deletionTimestamp, `${name}: volume is terminating`);
    assert(pv.status?.phase === 'Bound' && pvc.status?.phase === 'Bound', `${name}: retained binding is not Bound`);
    assert(pv.spec.hostPath?.path === `${root}/${suffix}`, `${name}: host path differs from the selected data root`);
    assert(['Directory', 'DirectoryOrCreate'].includes(pv.spec.hostPath?.type), `${name}: unsupported hostPath type`);
    assert(pv.spec.persistentVolumeReclaimPolicy === 'Retain', `${name}: reclaim policy must be Retain`);
    assert((pv.spec.storageClassName ?? '') === '' && pvc.spec.storageClassName === '', `${name}: expected explicit static storage`);
    assert(pv.spec.claimRef?.namespace === 'mx-common' && pv.spec.claimRef?.name === claim
      && pv.spec.claimRef?.uid === pvc.metadata.uid && pvc.spec.volumeName === name, `${name}: claim identity changed`);
    assert(pvc.metadata.namespace === 'mx-common', `${name}: wrong claim namespace`);
    const terms = pv.spec.nodeAffinity?.required?.nodeSelectorTerms;
    if (terms) assert(terms.some(t => (t.matchExpressions ?? []).every(e => e.key === 'kubernetes.io/hostname'
      && e.operator === 'In' && e.values?.includes(node)) && !t.matchFields?.length), `${name}: volume belongs to another node`);
  }
}

export function verifyReceipt(previous, current) {
  if (!previous) return;
  for (const key of ['version', 'root', 'node', 'identifier', 'mountTarget', 'filesystemUUID']) {
    assert(previous[key] === current[key], `recorded storage identity differs: ${key}; restore the original disk/binding before deploying`);
  }
}

function run(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`${command} storage inspection failed; no fallback to an empty directory`); }
}
function getResource(command, kind, name, namespace) {
  const raw = command('kubectl', ['--request-timeout=20s', ...(namespace ? ['-n', namespace] : []), 'get', kind, name, '--ignore-not-found', '-o', 'json']);
  return raw ? JSON.parse(raw) : null;
}

export function preflight(root, receiptFile, { platform = process.platform, command = run } = {}) {
  const get = (...args) => getResource(command, ...args);
  assert(platform === 'linux', 'local storage preflight must run on the Linux Kubernetes node');
  assert(path.isAbsolute(root) && path.normalize(root) === root && root !== '/', 'invalid data root');
  const previous = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  const pvs = volumes.map(([name]) => get('pv', name)).filter(Boolean);
  const pvcs = volumes.map(([, claim]) => get('pvc', claim, 'mx-common')).filter(Boolean);
  if (!pvs.length && !previous) {
    // A dynamic installation is outside the local-disk guard, but must never
    // accidentally be selected for an existing local database or Hub.
    assert(!fs.existsSync(`${root}/postgres/data/pgdata/PG_VERSION`), 'retained PostgreSQL exists without its PVs; explicit recovery required');
    if (pvcs.length) {
      assert(pvcs.length === 3 && pvcs.every(c => c.status?.phase === 'Bound' && c.spec.storageClassName), 'partial or unresolved storage metadata');
      for (const claim of pvcs) {
        const pv = get('pv', claim.spec.volumeName);
        assert(pv && !pv.spec.hostPath && !pv.spec.local, 'local data cannot fall back to dynamic provisioning');
      }
      return { mode: 'dynamic' };
    }
    const pgdata = `${root}/postgres/data/pgdata`;
    assert(!fs.existsSync(pgdata) || fs.readdirSync(pgdata).length === 0, 'partial retained PostgreSQL files exist without PV metadata');
    assert(!fs.existsSync(`${root}/elasticsearch/data/_state`) && !fs.existsSync(`${root}/elasticsearch/data/nodes/0/_state`), 'retained Elasticsearch exists without PV metadata');
    assert(!get('secret', 'mx-insight-hub-secrets', 'mx-insight-hub'), 'retained Hub credentials exist but data volumes are missing; explicit storage recovery required');
    assert(!get('secret', 'mx-common-secrets', 'mx-common'), 'retained database credentials exist but volumes are missing');
    return { mode: 'fresh' };
  }
  const nodes = JSON.parse(command('kubectl', ['--request-timeout=20s', 'get', 'nodes', '-o', 'json'])).items;
  assert(nodes.length === 1, 'local hostPath management requires one local Kubernetes node');
  const node = nodes[0].metadata.labels['kubernetes.io/hostname'];
  const addresses = Object.values(os.networkInterfaces()).flat().map(a => a.address);
  assert(node === os.hostname() || nodes[0].status.addresses.some(a => a.type === 'InternalIP' && addresses.includes(a.address)), 'kubectl points to another host');
  validateBindings(pvs, pvcs, root, node);
  assert(fs.realpathSync(root) === root, 'data root must be canonical; refusing a changed symlink');
  const mountFor = dir => {
    const result = JSON.parse(command('findmnt', ['--json', '--target', dir, '--output', 'TARGET,UUID'])).filesystems;
    assert(result.length === 1 && result[0].uuid, 'cannot identify data filesystem UUID');
    return result[0];
  };
  const mount = mountFor(root);
  assert(!root.startsWith('/data/') || mount.target !== '/', '/data is not mounted; refusing the root filesystem');
  for (const [, , suffix] of volumes) {
    const dir = `${root}/${suffix}`;
    assert(fs.realpathSync(dir) === dir, `${suffix}: changed symlink`);
    const actual = mountFor(dir);
    assert(actual.uuid === mount.uuid && actual.target === mount.target, `${suffix}: unexpected separate mount`);
  }
  const pgdata = `${root}/postgres/data/pgdata`;
  assert(fs.realpathSync(pgdata) === pgdata, 'PGDATA must not be a symlink');
  const identifier = postgresIdentifier(fs.readFileSync(`${pgdata}/global/pg_control`), fs.readFileSync(`${pgdata}/PG_VERSION`, 'utf8'));
  assert(fs.statSync(`${pgdata}/base`).isDirectory(), 'PostgreSQL base directory missing');
  assert(fs.existsSync(`${root}/elasticsearch/data/_state`) || fs.existsSync(`${root}/elasticsearch/data/nodes/0/_state`), 'retained Elasticsearch metadata missing');
  const pg = get('statefulset', 'mx-common-postgres', 'mx-common');
  const startupCommand = pg?.spec.template.spec.containers.find(c => c.name === 'postgres')?.command?.join(' ') ?? '';
  // Preserve the stronger identity already installed by incident recovery.
  if (startupCommand.includes('pg_controldata')) assert(startupCommand.includes(identifier), 'existing PostgreSQL startup guard identifies a different database');
  assert(get('secret', 'mx-common-secrets', 'mx-common')?.data?.['postgres-password'], 'retained database superuser Secret missing; automatic generation refused');
  const current = { version: 1, mode: 'local', root, node, identifier, mountTarget: mount.target, filesystemUUID: mount.uuid };
  verifyReceipt(previous, current);
  if (!previous) {
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(receiptFile, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return current;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(preflight(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(`[mx-common] STORAGE GUARD: ${error.message}`); process.exitCode = 78; }
}
