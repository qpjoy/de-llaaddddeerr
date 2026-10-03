import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresSsoRepository } from './repository.js';
import { createPlatformDataSource } from '../db/data-source.js';
import { loadConfig } from '../config.js';

// Explicit test database only: never fall back to the application's DATABASE_URL.
const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;
test('Postgres replicas atomically consume callbacks, bind once and preserve/revoke sessions across restart', { skip: !databaseUrl }, async () => {
  const target = new URL(databaseUrl!);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
  assert.ok(target.pathname.includes('sso_test'), 'Use an isolated sso_test database');
  const environment = `sso-test-${randomUUID()}`;
  const db = createPlatformDataSource({ ...loadConfig(), databaseUrl: databaseUrl!, environment, storeDriver: 'postgres' });
  const a = new PostgresSsoRepository(databaseUrl!, environment);
  const b = new PostgresSsoRepository(databaseUrl!, environment);
  await db.initialize();
  try {
    await db.runMigrations();
    const expiresAt = new Date(Date.now() + 300000).toISOString();
    assert.equal(await a.insert('admin-sso-transaction', 'transaction', { expiresAt, nonce: 'fixture' }), true);
    const consumes = await Promise.all([a.take('admin-sso-transaction', 'transaction'), b.take('admin-sso-transaction', 'transaction')]);
    assert.equal(consumes.filter(Boolean).length, 1);
    const bindings = await Promise.all([
      a.insert('admin-sso-binding', 'subject', { userId: 'a' }),
      b.insert('admin-sso-binding', 'subject', { userId: 'b' })
    ]);
    assert.deepEqual(bindings.sort(), [false, true]);
    assert.deepEqual(await a.read('admin-sso-binding', 'subject'), await b.read('admin-sso-binding', 'subject'));
    await a.insert('admin-sso-session', 'session', { expiresAt, bindingId: 'binding' });
    await a.close();
    assert.equal((await b.touchSession('session'))?.bindingId, 'binding');
    await db.query("UPDATE mx_platform_records SET updated_at=now()-interval '20 days' WHERE environment=$1 AND kind='admin-sso-session'", [environment]);
    assert.equal((await b.touchSession('session'))?.bindingId, 'binding');
    await db.query("UPDATE mx_platform_records SET updated_at=now(), data=jsonb_set(data,'{expiresAt}',to_jsonb((now()-interval '1 minute')::text)) WHERE environment=$1 AND kind='admin-sso-session'", [environment]);
    assert.equal(await b.touchSession('session'), null);
    await b.remove('admin-sso-session', 'session');
    assert.equal(await b.touchSession('session'), null);
    await b.insert('admin-sso-session', 'fresh', { expiresAt });
    await Promise.all([b.remove('admin-sso-session', 'fresh'), b.touchSession('fresh')]);
    assert.equal(await b.touchSession('fresh'), null);
  } finally {
    await a.close(); await b.close();
    await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]);
    await db.destroy();
  }
});
