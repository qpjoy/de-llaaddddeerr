import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

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
    image: { Entrypoint: ['docker-entrypoint.sh'], Cmd: ['postgres'] },
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

test('cutover accepts matching bindings; rejects wrong PV path, lost binding, other writers and remote DB', () => {
  const mutations = [
    [f => { f.objects.pv.items[0].spec.hostPath.path = '/wrong'; }, /PV\/PVC/],
    [f => { f.objects.pv.items[0].spec.claimRef.uid = 'different'; }, /PV\/PVC/],
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

test('missing guard passes preflight; planned guard preserves default, custom and split command arguments', () => {
  for (const [override, expected] of [
    [{}, ['docker-entrypoint.sh', 'postgres']],
    [{ args: ['postgres', '-c', 'shared_buffers=128MB'] }, ['docker-entrypoint.sh', 'postgres', '-c', 'shared_buffers=128MB']],
    [{ command: ['sh', '-ec', 'exec docker-entrypoint.sh postgres'] }, ['sh', '-ec', 'exec docker-entrypoint.sh postgres']],
    [{ command: ['sh'], args: ['-ec', 'test -d "$PGDATA/base"; exec docker-entrypoint.sh postgres'] }, ['sh', '-ec', 'test -d "$PGDATA/base"; exec docker-entrypoint.sh postgres']]
  ]) {
    const f = fixture();
    try {
      const p = f.objects.pg.spec.template.spec.containers[0];
      delete p.command;
      Object.assign(p, override);
      f.save();
      f.run('CHECK_WORKLOADS');
      f.run('PLAN_GUARD');
      const guard = JSON.parse(fs.readFileSync(join(f.dir, 'pg-guard.plan.json')));
      assert.deepEqual(guard.args, expected);
      assert.match(guard.command[2], /initialization refused/);
      assert.deepEqual(JSON.parse(fs.readFileSync(join(f.dir, 'pg.before.json'))), f.objects.pg);
    } finally { f.close(); }
  }
});

test('actual shell guard rejects incomplete PGDATA before executing original argv, preserving argument boundaries', () => {
  const f = fixture();
  try {
    const p = f.objects.pg.spec.template.spec.containers[0];
    p.command = [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'];
    p.args = ['--', 'a value with spaces', '$(not-a-shell-command)', '"quotes"'];
    f.save(); f.run('PLAN_GUARD');
    const guard = JSON.parse(fs.readFileSync(join(f.dir, 'pg-guard.plan.json')));
    const pg = join(f.dir, 'pgdata');
    fs.mkdirSync(join(pg, 'global'), { recursive: true });
    const run = () => spawnSync(guard.command[0], [...guard.command.slice(1), ...guard.args], { encoding: 'utf8', env: { ...process.env, PGDATA: pg } });
    for (const version of ['', '15\n', '16\n']) {
      fs.writeFileSync(join(pg, 'PG_VERSION'), version);
      const result = run();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
    }
    fs.writeFileSync(join(pg, 'global/pg_control'), 'control fixture');
    fs.mkdirSync(join(pg, 'base'));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), p.args.slice(1));
  } finally { f.close(); }
});

test('guard patch requires zero replicas, no Pod, unchanged workload and checks the returned spec', () => {
  for (const scenario of ['success', 'running', 'changed', 'replaced', 'pod', 'conflict', 'bad-response']) {
    const f = fixture();
    try {
      f.save(); f.run('PLAN_GUARD');
      const current = structuredClone(f.objects.pg);
      current.spec.replicas = scenario === 'running' ? 1 : 0;
      current.metadata.resourceVersion = '42';
      if (scenario === 'changed') current.spec.template.spec.containers[0].image = 'unexpected:17';
      if (scenario === 'replaced') current.metadata.uid = 'other';
      let mutations = 0;
      const exec = (command, args) => {
        assert.equal(command, 'kubectl');
        let output;
        if (args.includes('patch')) {
          mutations++;
          const patch = JSON.parse(fs.readFileSync(args[args.indexOf('--patch-file') + 1], 'utf8'));
          assert.deepEqual(patch.slice(0, 3), [
            { op: 'test', path: '/metadata/uid', value: 'pg-uid' },
            { op: 'test', path: '/metadata/resourceVersion', value: '42' },
            { op: 'test', path: '/spec/replicas', value: 0 }
          ]);
          assert.ok(patch.slice(3).every(op => /^\/spec\/template\/spec\/containers\/0\/(command|args)$/.test(op.path)));
          if (scenario === 'conflict') return { status: 1, stderr: 'conflict' };
          output = structuredClone(current);
          for (const op of patch.slice(3)) output.spec.template.spec.containers[0][op.path.split('/').at(-1)] = op.value;
          if (scenario === 'bad-response') output.spec.replicas = 1;
        } else if (args.includes('pods')) {
          output = { items: scenario === 'pod' ? [{ metadata: { ownerReferences: [{ uid: 'pg-uid' }] } }] : [] };
        } else { output = current; }
        return { status: 0, stdout: JSON.stringify(output) };
      };
      const run = () => f.run('INSTALL_GUARD', { require: name => ({ 'node:fs': fs, 'node:child_process': { spawnSync: exec }, 'node:util': { isDeepStrictEqual } })[name] });
      if (scenario === 'success') { run(); assert.equal(mutations, 1); }
      else { assert.throws(run); assert.equal(mutations, ['conflict', 'bad-response'].includes(scenario) ? 1 : 0); }
    } finally { f.close(); }
  }
  assert.ok(script.indexOf('mx_backup_tree "$MX_RESTORE_OLD" previous-mx-launcher') < script.indexOf('MX_RESTORE_PHASE=install-postgres-guard'));
  assert.ok(script.indexOf('\nINSTALL_GUARD\n') < script.indexOf('MX_RESTORE_PHASE=change-mount'));
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
