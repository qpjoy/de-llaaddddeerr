import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { VOLUMES, validateReport, replacementVolumes, databaseCredential, postgresGuard, HUB_DEPLOYMENTS } from '../scripts/recover-retained-storage.mjs'

const retained = '/data/k8s/mx-runtime/mx-common/k8s'
const report = { source: retained, control: ['Database system identifier: 7671038612254789664'],
  pepper: { verdict: 'MATCHED_SAMPLES', matched: 4 }, originalControlFileUnchanged: true,
  database: { hasStoredRecords: true, hasRequestHistory: true } }

function resources() {
  return {
    pvs: VOLUMES.map(([name, claim, suffix]) => ({ metadata: { name }, spec: {
      hostPath: { path: `/var/lib/mx-common/k8s/${suffix}`, type: 'DirectoryOrCreate' },
      claimRef: { namespace: 'mx-common', name: claim, uid: 'old-claim-uid' },
      persistentVolumeReclaimPolicy: 'Retain', capacity: { storage: '50Gi' }, accessModes: ['ReadWriteOnce'],
    } })),
    claims: VOLUMES.map(([name, claim]) => ({ metadata: { name: claim, uid: 'old-claim-uid' }, spec: {
      volumeName: name, storageClassName: '', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '50Gi' } },
    } })),
  }
}

test('recovery requires positive stored-data and matching-pepper evidence for this original directory', () => {
  assert.equal(validateReport(report), '7671038612254789664')
  for (const change of [{ source: '/data/mx-launcher' }, { control: ['Database system identifier: $(bad)'] },
    { pepper: { verdict: 'UNVERIFIED_NO_VAULT_SAMPLES' } }, { originalControlFileUnchanged: false }, { database: {} }]) {
    assert.throws(() => validateReport({ ...report, ...change }))
  }
})

test('replacement volumes retain exact claims, preserve data, pin the original node, and never create absent directories', () => {
  const { pvs, claims } = resources()
  const replacements = replacementVolumes(pvs, claims, retained, 'original-node')
  replacements.forEach(([pv, pvc], i) => {
    assert.equal(pv.spec.hostPath.path, `${retained}/${VOLUMES[i][2]}`)
    assert.equal(pv.spec.hostPath.type, 'Directory')
    assert.equal(pv.spec.persistentVolumeReclaimPolicy, 'Retain')
    assert.equal(pv.spec.claimRef.uid, undefined)
    assert.equal(pv.spec.claimRef.name, pvc.metadata.name)
    assert.equal(pvc.spec.volumeName, pv.metadata.name)
    assert.deepEqual(pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values, ['original-node'])
  })
})

test('dynamic, foreign, already-rebound or misbound storage is refused before deleting any binding', () => {
  for (const mutate of [r => { r.pvs[0].spec.persistentVolumeReclaimPolicy = 'Delete' },
    r => { r.pvs[0].spec.claimRef.namespace = 'mx-internal-shadow' },
    r => { r.pvs[0].spec.hostPath.path = `${retained}/postgres/data` },
    r => { r.claims[0].spec.volumeName = 'other-pv' },
    r => { r.claims[0].spec.storageClassName = 'dynamic' }]) {
    const r = resources(); mutate(r)
    assert.throws(() => replacementVolumes(r.pvs, r.claims, retained, 'node'))
  }
})

test('only the dedicated Hub database password can be aligned and invalid credentials are never exposed', () => {
  const password = 'SyntheticPassword1234567890'
  const url = `postgres://mx_insight_hub:${password}@mx-common-postgres.mx-common.svc.cluster.local:5432/mx_insight_hub`
  const encode = value => Buffer.from(value).toString('base64')
  const secret = value => ({ data: { DATABASE_URL: encode(value) } })
  const product = { data: { password: encode(password) } }
  assert.equal(databaseCredential(secret(url), product), password)
  for (const value of [url.replace('mx_insight_hub:', 'mx_launcher:'), url.replace('/mx_insight_hub', '/mx_launcher'),
    url.replace(password, "quoted'Password123456789"), url.replace('.cluster.local', '.elsewhere.local')]) {
    assert.throws(() => databaseCredential(secret(value), product), error => !error.message.includes(password) && !error.message.includes(value))
  }
})

test('PostgreSQL identity guard refuses missing/wrong data and preserves runtime postgres arguments on success', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-recovery-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'base'))
  writeFileSync(join(root, 'PG_VERSION'), '16\n')
  writeFileSync(join(root, 'pg_controldata'), '#!/bin/sh\nprintf "Database system identifier: 7671038612254789664\\n"\n', { mode: 0o755 })
  writeFileSync(join(root, 'docker-entrypoint.sh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$GUARD_OUTPUT"\n', { mode: 0o755 })
  const guard = postgresGuard('7671038612254789664')
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, PGDATA: root, GUARD_OUTPUT: join(root, 'output') }
  assert.equal(spawnSync(guard[0], [...guard.slice(1), '-c', 'max_connections=200'], { env }).status, 0)
  assert.equal(readFileSync(join(root, 'output'), 'utf8'), 'postgres\n-c\nmax_connections=200\n')
  rmSync(join(root, 'output'))
  writeFileSync(join(root, 'PG_VERSION'), '17\n')
  assert.notEqual(spawnSync(guard[0], guard.slice(1), { env }).status, 0)
  writeFileSync(join(root, 'PG_VERSION'), '16\n')
  const wrong = postgresGuard('1111111111111111111')
  assert.notEqual(spawnSync(wrong[0], wrong.slice(1), { env }).status, 0)
  assert.throws(() => readFileSync(join(root, 'output')))
})

test('Hub down stops all six workloads and waits for workers without mutating shared or Launcher services', () => {
  const script = resolve('scripts/manage.sh')
  const shell = `source "$1"
kubectl() {
  printf '%s\\n' "$*" >&2
  case "$*" in
    *'get deployments -o name') printf '%s\\n' ${HUB_DEPLOYMENTS.map(n => `deployment.apps/${n}`).join(' ')} ;;
    *'get pods '*) printf 'pod/mx-insight-hub-ingest-test\\n' ;;
  esac
}
stop_hub_workloads`
  const result = spawnSync('bash', ['-c', shell, '_', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  for (const name of HUB_DEPLOYMENTS) assert.ok(result.stderr.includes(`scale deployment.apps/${name} --replicas=0`))
  assert.match(result.stderr, /wait --for=delete pods/)
  assert.doesNotMatch(result.stderr, /-n mx-common|-n mx-internal-shadow| delete (pvc|pv)/)
  const failure = spawnSync('bash', ['-c', shell.replace("case \"$*\" in", "case \"$*\" in\n *'wait --for=delete'*) return 1 ;;"), '_', script], { encoding: 'utf8' })
  assert.notEqual(failure.status, 0)
  assert.doesNotMatch(failure.stdout, /background workers stopped/)
})

test('storage lookup fails closed on API failure and uses the existing PV after successful recovery', () => {
  const script = resolve('../mx-common/scripts/manage.sh')
  const failed = spawnSync('bash', ['-c', 'source "$1"; kubectl() { return 1; }; resolve_host_data_root', '_', script], { encoding: 'utf8' })
  assert.equal(failed.status, 78)
  assert.match(failed.stderr, /refusing a default-path fallback/)
  const restored = spawnSync('bash', ['-c', `source "$1"; kubectl() { printf '%s' '${retained}/postgres/data'; }; resolve_host_data_root; printf '%s' "$HOST_DATA_ROOT"`, '_', script], { encoding: 'utf8' })
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal(restored.stdout, retained)
})

test('Hub deployment must not treat a storage guard rejection as optional search degradation', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-storage-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts/manage.sh'), '#!/bin/bash\nexit 78\n')
  const result = spawnSync('bash', ['-c', `source "$1"
MX_COMMON_DIR="$2"
ensure_hub_database() { printf 'UNSAFE_DATABASE_PROVISION'; }
discover_launcher_url() { :; }
ensure_shared_data_plane`, '_', resolve('scripts/manage.sh'), root], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /UNSAFE_DATABASE_PROVISION/)
  assert.match(result.stderr, /refusing database provisioning/)
})

test('retained-directory detection distinguishes a separate old database from the same mounted files', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-old-pg-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = join(root, 'old'), current = join(root, 'current')
  for (const path of [old, current]) mkdirSync(join(path, 'postgres/data/pgdata/global'), { recursive: true })
  const file = join(old, 'postgres/data/pgdata/global/pg_control')
  const target = join(current, 'postgres/data/pgdata/global/pg_control')
  writeFileSync(join(old, 'postgres/data/pgdata/PG_VERSION'), '16')
  writeFileSync(file, 'retained-control')
  writeFileSync(target, 'new-control')
  const check = () => spawnSync('bash', ['-c', 'source "$1"; retained_postgres_conflicts "$2" "$3"', '_', resolve('../mx-common/scripts/manage.sh'), old, current], { encoding: 'utf8' })
  assert.equal(check().status, 0, 'separate retained data must stop default initialization')
  rmSync(target); linkSync(file, target)
  assert.equal(check().status, 1, 'same files through an alias must not be mistaken for a second database')
})
