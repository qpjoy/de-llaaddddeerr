import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { containerSummary, databaseAddress, databaseListSql, schemaListSql, summarySql,
  inventoryDirectories, inspectDatabases, psqlArguments } from './k8s-database-inventory.mjs';

test('container evidence retains storage/driver/database identity but never prints environment credentials', () => {
  const item = { Name: '/previous-internal', Config: { Image: 'mx-launcher:old', Env: [
    'INTERNAL_STORE_DRIVER=postgres', 'DATABASE_URL=postgres://sensitive-user:sensitive-password@database:55432/app_prod?sslpassword=hidden',
    'MX_INTERNAL_OPS_TOKEN=private-token', 'MX_FEISHU_APP_SECRET=private-feishu'
  ] }, State: { Status: 'exited' }, Mounts: [{ Type: 'volume', Source: '/data/old/_data', Destination: '/db' }] };
  const summary = containerSummary(item);
  assert.equal(summary.storeDriver, 'postgres');
  assert.deepEqual(summary.database, { host: 'database', port: '55432', database: 'app_prod' });
  assert.equal(summary.mounts[0].source, '/data/old/_data');
  assert.doesNotMatch(JSON.stringify(summary), /sensitive|hidden|private-/);
  assert.deepEqual(databaseAddress('invalid secret text'), { configured: true, recognized: false });
  assert.equal(containerSummary({}).storeDriver, 'not explicit in container env');
});

test('inventory finds anonymous/retained directories without walking or changing PG relation files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-db-inventory-'));
  try {
    const pg = join(directory, 'anonymous/_data');
    mkdirSync(join(pg, 'global'), { recursive: true });
    mkdirSync(join(pg, 'base/hidden'), { recursive: true });
    writeFileSync(join(pg, 'PG_VERSION'), '16\n');
    writeFileSync(join(pg, 'base/hidden/PG_VERSION'), 'must-not-read');
    const control = Buffer.alloc(8192); control.writeBigUInt64LE(12345n);
    writeFileSync(join(pg, 'global/pg_control'), control);
    mkdirSync(join(directory, 'old-etcd/member/snap'), { recursive: true });
    writeFileSync(join(directory, 'old-etcd/member/snap/db'), 'do-not-dump-etcd-contents');
    symlinkSync(pg, join(directory, 'alias'));
    const output = [];
    const result = inventoryDirectories([directory, pg], value => output.push(value));
    assert.equal(result.pgDirectories, 1);
    assert.equal(result.etcdFiles, 1);
    assert.equal(result.unreadable, 0);
    assert.equal(result.bounded, false);
    assert.equal(output.find(value => value.pgdata).systemIdHex, control.subarray(0, 8).toString('hex'));
    assert.doesNotMatch(JSON.stringify(output), /do-not-dump|must-not-read/);
    assert.deepEqual(readFileSync(join(pg, 'global/pg_control')), control);
    assert.equal(inventoryDirectories([directory], () => {}, { maxDirectories: 1 }).bounded, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('catalog scan includes non-MX database names and distinguishes denied reads from absent data', () => {
  const calls = [];
  const output = [];
  const result = inspectDatabases((database, sql) => {
    calls.push({ database, sql });
    if (sql === databaseListSql) return JSON.stringify(['postgres', 'app_prod', 'restricted']);
    if (database === 'restricted') throw new Error('authentication error containing private text');
    if (sql === schemaListSql) return JSON.stringify(database === 'app_prod' ? ['custom_schema'] : []);
    assert.equal(sql, summarySql('custom_schema'));
    return JSON.stringify([{ environment: 'production', users: 21, has_smh: true, has_sqb: true }]);
  }, value => output.push(value));
  assert.deepEqual(result, { databases: 3, mxSchemas: 1, unverified: 1, limited: false });
  assert.ok(output.some(item => item.database === 'app_prod' && item.records[0].has_smh));
  assert.ok(output.some(item => item.database === 'restricted' && item.check.startsWith('unverified')));
  assert.doesNotMatch(JSON.stringify(output), /private text/);
  assert.ok(calls.every(call => call.sql.startsWith('BEGIN READ ONLY;') && call.sql.endsWith('ROLLBACK;')));
  const failed = inspectDatabases(() => { throw new Error(); }, () => {});
  assert.equal(failed.unverified, 1);
  assert.equal(failed.databases, 0);
});

test('inspection uses local socket, no psqlrc, no prompt, read-only transactions and bounded queries', () => {
  const args = psqlArguments('ordinary_app');
  assert.equal(args.at(-1), 'ordinary_app');
  assert.match(args.join(' '), /default_transaction_read_only=on/);
  assert.match(args.join(' '), /statement_timeout=5000/);
  assert.match(args.join(' '), /psql -X -qAt -w/);
  assert.match(args.join(' '), /--host=\/var\/run\/postgresql/);
  for (const name of ['host=remote dbname=other', 'postgres://remote/other']) assert.throws(() => psqlArguments(name));
  assert.match(summarySql('quoted"schema'), /"quoted""schema"\.mx_platform_records/);
  assert.doesNotMatch(summarySql('public'), /passwordHash|SELECT \*|INSERT|UPDATE|DELETE|CREATE|ALTER/);
});

test('CLI uses only inventory and read-only exec operations, and never starts a stopped instance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-db-inventory-cli-'));
  try {
    const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = require('node:path').basename(process.argv[1]);
fs.appendFileSync(process.env.INVENTORY_CALLS, JSON.stringify({command,args})+'\\n');
if (command === 'docker' && args[0] === 'ps') { console.log('running\\nstopped'); }
else if (command === 'docker' && args[0] === 'inspect') {
  console.log(JSON.stringify([{Name:args[1],Config:{Image:'postgres:16',Env:[]},State:{Running:args[1]==='running'}}]));
} else if (command === 'docker' && args[0] === 'exec' && args[2] === 'running') {
  const sql = fs.readFileSync(0,'utf8');
  if (!sql.startsWith('BEGIN READ ONLY;') || !sql.endsWith('ROLLBACK;')) process.exit(2);
  if (sql.includes('FROM pg_database')) console.log('["normal_app"]');
  else if (sql.includes('FROM pg_class')) console.log('["public"]');
  else console.log('[{"environment":"shadow","has_smh":true,"has_sqb":true}]');
} else if (command === 'kubectl' && args.includes('get')) console.log('{"items":[]}');
else { console.error('UNEXPECTED_MUTATION'); process.exit(2); }
`;
    for (const name of ['docker', 'kubectl']) writeFileSync(join(directory, name), mock, { mode: 0o700 });
    const result = spawnSync(process.execPath, [new URL('./k8s-database-inventory.mjs', import.meta.url).pathname], {
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, INVENTORY_CALLS: join(directory, 'calls') },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"has_smh":true,"has_sqb":true/);
    assert.doesNotMatch(result.stdout + result.stderr, /未完成|UNEXPECTED/);
    const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(call => call.command === 'docker' && call.args[0] === 'exec').length, 3);
    assert.ok(calls.every(call => call.command === 'docker' ? ['ps', 'inspect', 'exec'].includes(call.args[0]) : call.args.includes('get')));
    assert.ok(!calls.some(call => call.args[0] === 'exec' && call.args.includes('stopped')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
