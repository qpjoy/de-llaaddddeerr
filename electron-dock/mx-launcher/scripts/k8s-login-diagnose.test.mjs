import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feishuPresence, inspectRuntime, runtimeProgram, scanPrivateSources } from './k8s-login-diagnose.mjs';

test('private source scan reports only field presence, including historic snapshots and exported Secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mx-login-sources-'));
  const secretValue = 'never-print-original-feishu-secret';
  const secret = { kind: 'Secret', metadata: { name: 'mx-feishu-oauth' }, data: Object.fromEntries(
    ['app-id', 'app-secret', 'tenant-keys'].map(key => [key, Buffer.from(secretValue).toString('base64')])
  ) };
  try {
    writeFileSync(join(directory, '.env.backup'), `MX_FEISHU_APP_ID=cli_old\nMX_FEISHU_APP_SECRET=${secretValue}\nMX_FEISHU_ALLOWED_TENANT_KEYS=old-tenant\n`);
    writeFileSync(join(directory, 'latest.json'), JSON.stringify({ secrets: { 'mx-feishu-oauth': secret } }));
    writeFileSync(join(directory, 'mx-feishu-oauth.json'), JSON.stringify(secret));
    writeFileSync(join(directory, 'bad.json'), secretValue);
    const output = [];
    scanPrivateSources([directory], line => output.push(line));
    assert.equal(output.filter(line => line.includes('"complete":true')).length, 3);
    assert.equal(output.length, 4);
    assert.doesNotMatch(output.join('\n'), new RegExp(secretValue));
    assert.doesNotMatch(output.join('\n'), new RegExp(Buffer.from(secretValue).toString('base64')));
    assert.equal(feishuPresence({ kind: 'List', items: [secret] }).complete, true);
    assert.equal(feishuPresence({ MX_FEISHU_APP_ID: 'only-app-id' }).complete, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('runtime diagnostic queries the actual API database in a read-only transaction without leaking hashes or aliases', async t => {
  const queries = [];
  let connection;
  let ended = false;
  class Client {
    constructor(options) { connection = options; }
    async connect() {}
    async end() { ended = true; }
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('pg_control_system')) throw new Error('permission denied');
      if (sql.includes('GROUP BY')) return { rows: [{ environment: 'shadow', kind: 'iam-user', count: 18 }] };
      if (sql.includes('jsonb_build_object')) return { rows: [
        { environment: 'shadow', user: { userId: 'u1', account: 'SMH', status: 'active', email: 'private@example.test' } },
        { environment: 'other', user: { userId: 'u2', account: 'SMH', status: 'disabled' } }
      ] };
      if (sql.includes("data->>'kind' AS kind")) return { rows: [{ kind: 'local-password', updated_at: '2026-07-01', password_hash_present: true }] };
      assert.match(sql, /^(BEGIN .*READ ONLY|SAVEPOINT control_info|ROLLBACK(?: TO SAVEPOINT control_info)?)$/);
      return { rows: [] };
    }
  }
  const config = { storeDriver: 'postgres', environment: 'shadow', databaseUrl: 'postgres://private-user:private-password@actual-db:55432/mx_test',
    feishuAppId: null, feishuAppSecret: null, feishuAllowedTenantKeys: [], feishuRedirectUris: ['callback'] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18090/internal/v1/sdk/oauth/feishu/config');
    assert.equal(options.method, undefined); // GET only; never submit a login.
    return { ok: true, status: 200, json: async () => ({ config: { enabled: false } }) };
  });
  const load = async name => {
    if (name.endsWith('/config.js')) return { loadConfig: () => config };
    if (name.endsWith('/domain.js')) return {
      resolveUserCenterUserForLogin: (users, account) => users.filter(user => user.account === account).length === 1 ? users.find(user => user.account === account) : null,
      userMatchesLogin: (user, account) => user.account.toLowerCase() === account.toLowerCase()
    };
    assert.equal(name, 'node:module');
    return { createRequire: () => () => ({ Client }) };
  };
  // Substitute only module loading; execute the same function sent to the Pod.
  const run = new Function('load', `return (${inspectRuntime.toString().replaceAll('import(', 'load(')})`)(load);
  const result = await run('SMH');
  assert.equal(connection.connectionString, config.databaseUrl);
  assert.equal(connection.options, '-c default_transaction_read_only=on');
  assert.equal(queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(queries.some(query => query.sql === 'ROLLBACK TO SAVEPOINT control_info'));
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.equal(ended, true);
  assert.deepEqual(result.database, { host: 'actual-db', port: '55432', name: 'mx_test' });
  assert.deepEqual(result.login, { exactMatches: 1, unambiguous: true, caseInsensitiveMatches: 1 });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.feishu.enabled, false);
  assert.doesNotMatch(JSON.stringify(result), /private-user|private-password|private@example/);
  assert.doesNotMatch(queries.map(query => query.sql).join('\n'), /\b(?:UPDATE|DELETE|INSERT|ALTER|CREATE)\b/);
  assert.doesNotThrow(() => new Function(runtimeProgram('SMH\"; throw new Error("bad")')));
});
