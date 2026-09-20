import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

const script = fs.readFileSync(new URL('./restore-confirmed-mx-data.sh', import.meta.url), 'utf8');
const block = name => script.split(`<<'${name}'\n`)[1].split(`\n${name}\n`)[0];
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mx-confirmed-cutover-'));
  const ns = 'mx-internal-shadow';
  const claimNames = ['postgres-data-mx-internal-postgres-0', 'mx-launcher-internal-ssh', 'mx-launcher-release-artifacts', 'mx-launcher-site-slots'];
  const volumeNames = ['mx-internal-postgres-local-pv', 'mx-launcher-internal-ssh-local-pv', 'mx-launcher-release-artifacts-local-pv', 'mx-launcher-site-slots-local-pv'];
  const suffixes = ['postgres', 'internal-ssh', 'release-artifacts', 'site-slots'];
  for (const name of suffixes) fs.mkdirSync(join(dir, 'latest/k8s', name), { recursive: true });
  const env = (name, key = name) => ({ name, valueFrom: { secretKeyRef: { name: 'mx-launcher-db', key } } });
  const objects = {
    api: { metadata: { uid: 'api-uid' }, spec: { replicas: 1, template: { spec: {
      containers: [{ name: 'internal-api', env: ['DATABASE_URL', 'DATABASE_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DB'].map(x => env(x)) }],
      volumes: claimNames.slice(1).map(claimName => ({ persistentVolumeClaim: { claimName } }))
    } } } },
    pg: { metadata: { uid: 'pg-uid' }, spec: { replicas: 1, template: { spec: { containers: [{
      name: 'postgres', image: 'postgres:16-alpine',
      env: [{ name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }, env('POSTGRES_USER', 'PG_USER'), env('POSTGRES_PASSWORD', 'PG_PASSWORD'), env('POSTGRES_DB', 'PG_DB')],
      volumeMounts: [{ name: 'postgres-data', mountPath: '/var/lib/postgresql/data' }],
      command: ['sh', '-ec', 'test "$(cat "$PGDATA/PG_VERSION")" = 16 && test -s "$PGDATA/global/pg_control" || exit 1; exec docker-entrypoint.sh postgres']
    }] } } } },
    jobs: { items: [] }, controllers: { items: [] }, pods: { items: [] },
    config: { data: { INTERNAL_STORE_DRIVER: 'postgres', MX_ENVIRONMENT: 'shadow' } },
    service: { spec: { clusterIP: '192.168.241.51' } },
    secrets: { items: [{ metadata: { name: 'mx-launcher-db' }, data: Object.fromEntries(Object.entries({
      PG_USER: 'app', PG_PASSWORD: 'not-a-real-password', PG_DB: 'mx_internal_shadow', DATABASE_HOST: 'mx-internal-postgres', DATABASE_URL: 'postgres://app:not-a-real-password@mx-internal-postgres:5432/mx_internal_shadow'
    }).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) }] },
    nodes: { items: [{ metadata: { name: 'mx-internal-server' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] },
    pvc: { items: claimNames.map((name, i) => ({ metadata: { name, uid: `claim-${i}` }, status: { phase: 'Bound' }, spec: { volumeName: volumeNames[i] } })) },
    pv: { items: volumeNames.map((name, i) => ({ metadata: { name }, status: { phase: 'Bound' }, spec: {
      claimRef: { uid: `claim-${i}`, name: claimNames[i], namespace: ns }, persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: `/var/lib/mx-launcher/k8s/${suffixes[i]}` }
    } })) }
  };
  return { dir, objects,
    save() { for (const [name, object] of Object.entries(objects)) fs.writeFileSync(join(dir, `${name}.before.json`), JSON.stringify(object)); },
    run(name, extra = {}) { return runInNewContext(block(name), {
      require: name => { assert.equal(name, 'node:fs'); return fs; }, Buffer, URL, console: { log() {} },
      process: { argv: ['node', '-', dir], env: { MX_RESTORE_NEW: join(dir, 'latest') } }, ...extra
    }); },
    close() { fs.rmSync(dir, { force: true, recursive: true }); }
  };
}

test('one-time script passes Bash syntax checking', () => {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('cutover accepts matching bindings; rejects wrong PV path, lost binding, missing guard, other writers and remote DB', () => {
  const mutations = [
    [f => { f.objects.pv.items[0].spec.hostPath.path = '/wrong'; }, /PV\/PVC/],
    [f => { f.objects.pv.items[0].spec.claimRef.uid = 'different'; }, /PV\/PVC/],
    [f => { delete f.objects.pg.spec.template.spec.containers[0].command; }, /启动保护/],
    [f => { f.objects.controllers.items.push({ kind: 'CronJob', spec: { suspend: false } }); }, /CronJob/],
    [f => { f.objects.secrets.items[0].data.DATABASE_URL = Buffer.from('postgres://app:not-a-real-password@unrelated:5432/mx_internal_shadow').toString('base64'); }, /指向\/凭据/],
    [f => { f.objects.pods.items.push({ metadata: { namespace: 'other', name: 'writer' }, status: { phase: 'Running' }, spec: { volumes: [{ hostPath: { path: '/data/k8s/mx-runtime/mx-launcher/k8s/postgres' } }] } }); }, /其它数据卷使用者/]
  ];
  const good = fixture();
  try { good.save(); good.run('CHECK_WORKLOADS'); } finally { good.close(); }
  for (const [mutate, expected] of mutations) {
    const f = fixture();
    try { mutate(f); f.save(); assert.throws(() => f.run('CHECK_WORKLOADS'), expected); } finally { f.close(); }
  }
});

test('business validation requires both known users and credentials in the actual API environment', () => {
  const f = fixture();
  try {
    f.save();
    const row = { environment: 'shadow', has_smh: true, has_sqb: true, smh_has_credential: true, sqb_has_credential: true };
    const run = rows => { fs.writeFileSync(join(f.dir, 'records.json'), JSON.stringify(rows)); return f.run('CHECK_MARKERS'); };
    run([row]);
    assert.throws(() => run([{ ...row, environment: 'other' }]), /API 保持停止/);
    assert.throws(() => run([{ ...row, sqb_has_credential: false }]), /API 保持停止/);
    assert.throws(() => run([]), /API 保持停止/);
  } finally { f.close(); }
});

test('fstab update changes only the confirmed bind source and refuses a concurrent edit', () => {
  const f = fixture();
  try {
    const original = '# preserved\n/data/mx-runtime/etcd /var/lib/etcd none bind 0 0\n  /data/mx-runtime/mx-launcher\t/var/lib/mx-launcher none bind,nofail 0 0\n';
    const path = join(f.dir, 'fstab');
    fs.writeFileSync(path, original, { mode: 0o640 });
    fs.writeFileSync(join(f.dir, 'fstab.before'), original);
    const mapped = p => typeof p !== 'string' ? p : p === '/etc' ? f.dir : p.startsWith('/etc/fstab') ? join(f.dir, p.slice('/etc/'.length)) : p;
    const proxy = Object.fromEntries(Object.entries(fs).map(([key, value]) => [key, typeof value !== 'function' ? value : (...args) => {
      if (['statSync', 'readFileSync', 'openSync'].includes(key)) args[0] = mapped(args[0]);
      if (key === 'renameSync') args = args.map(mapped);
      return value(...args);
    }]));
    // Use the actual target in fstab but map stat to the fixture's target.
    proxy.statSync = p => fs.statSync(p === '/var/lib/mx-launcher' ? join(f.dir, 'latest') : mapped(p));
    const runActual = () => f.run('UPDATE_FSTAB', { require: () => proxy,
      process: { pid: process.pid, env: { MX_RESTORE_NEW: join(f.dir, 'latest'), MX_RESTORE_TARGET: '/var/lib/mx-launcher', MX_RESTORE_WORK: f.dir } }
    });
    runActual();
    assert.equal(fs.readFileSync(path, 'utf8'), original.replace('  /data/mx-runtime/mx-launcher\t', `  ${join(f.dir, 'latest')}\t`));
    assert.equal(fs.statSync(path).mode & 0o777, 0o640);
    fs.writeFileSync(path, original + '# concurrent change\n');
    assert.throws(runActual, /并发修改/);
    assert.equal(fs.readFileSync(path, 'utf8'), original + '# concurrent change\n');
  } finally { f.close(); }
});
