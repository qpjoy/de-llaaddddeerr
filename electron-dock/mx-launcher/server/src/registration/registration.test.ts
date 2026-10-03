import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { createPlatformDataSource } from '../db/data-source.js';
import { loadConfig } from '../config.js';
import { PostgresStore } from '../store/postgres.js';
import { IdentityRepository } from '../identity/repository.js';
import { RUNTIME_CONFIG } from '../tokens.js';
import { RegistrationController } from './controller.js';
import { RegistrationRepository, type RegistrationInput } from './repository.js';
import { registrationSignature, verifyRegistrationSignature } from './backchannel.js';

test('registration backchannel signature binds timestamp, action, client and entire input', () => {
  const body = { timestamp: Date.now(), action: 'register', clientId: 'launcher', input: { account: 'Alice' } };
  const signature = registrationSignature('fixture-secret', body);
  assert.ok(verifyRegistrationSignature('fixture-secret', body, signature));
  assert.equal(verifyRegistrationSignature('fixture-secret', { ...body, timestamp: 0 }, signature), false);
  assert.equal(verifyRegistrationSignature('fixture-secret', { ...body, action: 'policy' }, signature), false);
  assert.equal(verifyRegistrationSignature('fixture-secret', body, 'bad'), false);
  assert.equal(verifyRegistrationSignature('other-secret', body, signature), false);
});

const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;
test('real PG registration: atomic last slot, replay, closure, revoke, account preservation, admin concurrency and rollback', { skip: !databaseUrl }, async () => {
  const target = new URL(databaseUrl!);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.includes('sso_test'));
  const environment = `signup-test-${randomUUID()}`;
  const config = { ...loadConfig(), databaseUrl: databaseUrl!, environment, storeDriver: 'postgres' as const };
  const db = createPlatformDataSource(config); await db.initialize(); await db.runMigrations();
  const store = await PostgresStore.create(config);
  const a = new RegistrationRepository(databaseUrl!, environment, 'launcher', 'test');
  const b = new RegistrationRepository(databaseUrl!, environment, 'launcher', 'test');
  const identity = new IdentityRepository(databaseUrl!, environment, environment, 'test-rate-key'); await identity.initialize();
  const input = (account: string, inviteCode: string, extra: Partial<RegistrationInput> = {}): RegistrationInput =>
    ({ account, password: 'RegistrationPassword123!', inviteCode, transactionId: randomUUID(), clientId: 'launcher', policyVersion: 0, ...extra });
  try {
    const old = await store.createUserCenterUser({ account: 'ExistingMember', password: 'Old123!', roleIds: ['mx-admin'] });
    const before = await db.query("SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 AND kind IN ('iam-user','iam-user-credential') ORDER BY kind,id", [environment]);
    const invite = await a.createInvitation({ label: 'Last seat', maxUses: 1, days: 1 });
    const alice = input('Alice', invite.code), bob = input('Bob', invite.code);
    const outcomes = await Promise.allSettled([a.register(alice), b.register(bob)]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const winningInput = outcomes[0].status === 'fulfilled' ? alice : bob;
    const winner = (outcomes.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ userId: string }>).value;
    assert.deepEqual(await b.register(winningInput), winner, 'retry reuses account without spending another slot');
    assert.equal((await a.invitations())[0].uses, 1);
    assert.ok(!JSON.stringify(await a.invitations()).includes(invite.code));
    const newUser = await identity.account(winner.userId);
    assert.deepEqual(newUser?.roleIds, ['mx-user']);
    assert.deepEqual(newUser?.appAccess.allowedAppIds, []);
    assert.equal((await identity.authenticate(winningInput.account, winningInput.password))?.userId, winner.userId);
    assert.equal((await identity.authenticate('ExistingMember', 'Old123!'))?.userId, old.userId, 'legacy passwords below the signup minimum still work');
    const afterOld = await db.query("SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 AND kind IN ('iam-user','iam-user-credential') AND id<>$2 ORDER BY kind,id", [environment, winner.userId]);
    assert.deepEqual(afterOld, before, 'legacy identities and credentials stay byte-for-byte identical');
    await assert.rejects(a.register({ ...winningInput, account: 'Other' }), /已完成/);
    let policy = await a.updatePolicy({ mode: 'closed', version: 0 });
    await assert.rejects(a.register(input('ClosedAccount', invite.code)), /暂未开放/);
    assert.deepEqual(await a.register(winningInput), winner, 'closing signup never undoes committed registration');
    await assert.rejects(a.updatePolicy({ mode: 'open', version: 0 }), /已更新/);
    policy = await a.updatePolicy({ mode: 'open', version: policy.version });
    await assert.rejects(a.register(input('StaleForm', '', { policyVersion: 0 })), /已更新/);
    await assert.rejects(a.register(input('existingmember', '', { policyVersion: policy.version })), /账号不可用/);
    await assert.rejects(a.register(input('ClientSpoof', '', { policyVersion: policy.version, clientId: 'other' })), /已失效/);
    await assert.rejects(a.register(input('TooShort', '', { policyVersion: policy.version, password: 'Abcd12!' })), /密码需为 8–128 位/);
    await assert.rejects(a.register(input('TooLong', '', { policyVersion: policy.version, password: 'a'.repeat(129) })), /密码需为 8–128 位/);
    const openUser = await a.register(input('OpenUser', '', { policyVersion: policy.version, password: 'Abcd123!' }));
    assert.ok(openUser.userId);
    assert.equal((await identity.authenticate('OpenUser', 'Abcd123!'))?.userId, openUser.userId, 'eight-character signup passwords authenticate');
    const concurrent = await Promise.allSettled([
      a.register(input('Concurrent', '', { policyVersion: policy.version })),
      store.createUserCenterUser({ account: 'Concurrent', password: 'AdminAssignedPassword123!' })
    ]);
    assert.ok(concurrent.some(result => result.status === 'fulfilled'));
    assert.equal((await db.query("SELECT id FROM mx_platform_records WHERE environment=$1 AND kind='iam-user' AND data->>'account'='Concurrent'", [environment])).length, 1);
    policy = await a.updatePolicy({ mode: 'invite_code', version: policy.version });
    const revoked = await a.createInvitation({ label: 'Revoked', maxUses: 2, days: 1 });
    await a.revokeInvitation(revoked.invitation.id);
    await assert.rejects(a.register(input('RevokedUser', revoked.code, { policyVersion: policy.version })), /邀请码无效/);
    const rollback = await a.createInvitation({ label: 'Rollback', maxUses: 1, days: 1 });
    const failing = input('AtomicFailure', rollback.code, { policyVersion: policy.version });
    // A database failure after the account INSERT must leave no partial user,
    // credential or consumed invitation. Fault trigger exists only in this test DB.
    const constraint = `signup_fault_${randomUUID().replaceAll('-', '')}`;
    await db.query(`CREATE FUNCTION ${constraint}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.environment='${environment}' AND NEW.kind='iam-user-credential' THEN RAISE EXCEPTION 'test fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${constraint} BEFORE INSERT ON mx_platform_records FOR EACH ROW EXECUTE FUNCTION ${constraint}()`);
    try { await assert.rejects(a.register(failing), /test fault/); }
    finally { await db.query(`DROP TRIGGER ${constraint} ON mx_platform_records`); await db.query(`DROP FUNCTION ${constraint}()`); }
    assert.equal((await db.query("SELECT id FROM mx_platform_records WHERE environment=$1 AND kind='iam-user' AND data->>'account'='AtomicFailure'", [environment])).length, 0);
    assert.equal((await a.invitations()).find(i => i.id === rollback.invitation.id)?.uses, 0);
    const recovered = await b.register(failing); assert.ok(recovered.userId);
    await a.close(); const restarted = new RegistrationRepository(databaseUrl!, environment, 'launcher', 'test');
    try { assert.deepEqual(await restarted.register(failing), recovered); assert.deepEqual(await restarted.policy(), policy); }
    finally { await restarted.close(); }
  } finally {
    await a.close(); await b.close(); await identity.close(); await (store as unknown as { dataSource: DataSource }).dataSource.destroy();
    await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]);
    await db.query('DELETE FROM mx_identity_records WHERE scope=$1', [environment]); await db.destroy();
  }
});

test('registration admin and internal backchannel reject unauthenticated callers before any writes', async () => {
  const config = loadConfig();
  @Module({ controllers: [RegistrationController], providers: [{ provide: RUNTIME_CONFIG, useValue: config }] })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const origin = await app.getUrl();
    for (const [path, method] of [['/internal/v1/user-center/registration', 'GET'], ['/internal/v1/user-center/registration/policy', 'POST'], ['/identity-backend/registration', 'POST']]) {
      const response = await fetch(origin + path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
      assert.ok([401, 503].includes(response.status));
    }
  } finally { await app.close(); }
});
