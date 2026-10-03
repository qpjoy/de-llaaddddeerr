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
import { RUNTIME_CONFIG, PLATFORM_STORE } from '../tokens.js';
import { MemoryStore } from '../store/memory.js';
import { internalAdminContext } from '../lib/internal-admin-context.js';
import { UserCenterController } from '../modules/user-center/user-center.controller.js';
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

    // Both identity origins consume the original invitation policy and user DB.
    const sharedInvite = await a.createInvitation({ label: 'Public entry', maxUses: 1, days: 1 });
    const env = { MX_ADMIN_SSO_ENABLED: '1', MX_ADMIN_SSO_ORIGIN: 'https://10.88.88.88:18443',
      MX_ADMIN_SSO_ISSUER: 'https://10.88.88.88:18443/identity', MX_ADMIN_SSO_LOCAL_SUBJECTS: '1',
      MX_ADMIN_SSO_CLIENT_ID: 'launcher', MX_ADMIN_SSO_CLIENT_SECRET: 'private-test-secret',
      MX_ADMIN_PUBLIC_SSO_CONFIG: JSON.stringify({ origin: 'https://launcher.example.com', issuer: 'https://auth.example.com/identity',
        clientId: 'mx-launcher-public-admin', clientSecret: 'p'.repeat(43), ingressToken: 'g'.repeat(43),
        callbackUrl: 'https://launcher.example.com/auth/admin/callback', localSubjects: true }) };
    const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const controller = new RegistrationController(config, store);
    try {
      const body = { timestamp: Date.now(), clientId: 'mx-launcher-public-admin', action: 'register',
        input: { ...input('PublicOriginUser', sharedInvite.code), clientId: 'mx-launcher-public-admin' } };
      await assert.rejects(controller.backchannel(registrationSignature('wrong', body), body), /Unauthorized/);
      const created = await controller.backchannel(registrationSignature('p'.repeat(43), body), body) as { userId: string };
      assert.equal((await identity.authenticate('PublicOriginUser', 'RegistrationPassword123!'))?.userId, created.userId);
      assert.equal((await a.invitations()).find(row => row.id === sharedInvite.invitation.id)?.uses, 1);
      assert.deepEqual(await a.register({ ...body.input, clientId: 'launcher' }), created, 'public signup shares the private registration transaction namespace');
    } finally {
      await controller.onModuleDestroy();
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }

    for (const [appId, decision, enabled] of [['signup-public', 'public', true], ['signup-auth', 'authenticated', true], ['signup-private', 'private', true], ['signup-other', 'private', true], ['signup-disabled', 'private', false]] as const) {
      await store.upsertAppCenterApp({ appId, displayName: appId, enabled, accessPolicy: { defaultDecision: decision, allowRoles: [], allowUserIds: [], allowOrgIds: [] } });
    }
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-public', userId: winner.userId })).allowed, true, 'empty grants inherit public policy');
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-auth', userId: winner.userId })).allowed, true);
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-private', userId: winner.userId })).allowed, false, 'empty grants are not an all-app wildcard');
    for (const appIds of [[], ['unknown-app'], ['signup-disabled']]) {
      await assert.rejects(a.createInvitation({ label: 'Invalid apps', maxUses: 1, days: 1, appGrant: { mode: 'selected', appIds } }), /请选择至少一个/);
    }
    const chosen = await a.createInvitation({ label: 'One app', maxUses: 1, days: 1, appGrant: { mode: 'selected', appIds: ['signup-private'] } });
    const granted = await a.register({ ...input('GrantedUser', chosen.code), ...{ allowedAppIds: ['signup-other'], roleIds: ['mx-admin'] } });
    assert.deepEqual((await identity.account(granted.userId))?.appAccess.allowedAppIds, ['signup-private'], 'only the server-owned invitation grants apps');
    assert.deepEqual((await identity.account(granted.userId))?.roleIds, ['mx-user']);
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-private', userId: granted.userId })).allowed, true);
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-other', userId: granted.userId })).allowed, false);
    await a.revokeInvitation(chosen.invitation.id);
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-private', userId: granted.userId })).allowed, true, 'revoking an invitation does not revoke existing accounts');

    const all = await a.createInvitation({ label: 'Snapshot', maxUses: 1, days: 1, appGrant: { mode: 'all_current', appIds: [] } });
    assert.ok(!all.invitation.appGrant!.appIds.includes('signup-disabled'));
    await store.upsertAppCenterApp({ appId: 'signup-future', displayName: 'Future', accessPolicy: { defaultDecision: 'private' } });
    const allUser = await a.register(input('SnapshotUser', all.code));
    assert.deepEqual((await identity.account(allUser.userId))?.appAccess.allowedAppIds.sort(), [...all.invitation.appGrant!.appIds].sort());
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-future', userId: allUser.userId })).allowed, false, 'all-current never silently grants future apps');

    const legacy = await a.createInvitation({ label: 'Legacy', maxUses: 1, days: 1 });
    await db.query("UPDATE mx_platform_records SET data=data-'appGrant' WHERE environment=$1 AND kind='registration-invite' AND id=$2", [environment, legacy.invitation.id]);
    const legacyUser = await a.register(input('LegacyInvite', legacy.code));
    assert.deepEqual((await identity.account(legacyUser.userId))?.appAccess.allowedAppIds, [], 'pre-upgrade invitations preserve policy inheritance');

    await store.createUserCenterUser({ userId: granted.userId, allowedAppIds: ['signup-other'], deniedAppIds: ['signup-private'] });
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-private', userId: granted.userId })).allowed, false, 'explicit deny wins over a grant');
    assert.deepEqual((await identity.account(granted.userId))?.appAccess.allowedAppIds.sort(), ['signup-other', 'signup-private'], 'old writers still append');
    const users = new UserCenterController(store);
    const replacement = { userId: granted.userId, replaceAppAccess: true, allowedAppIds: [], deniedAppIds: [] };
    await assert.rejects(users.createUser(undefined, replacement), /authentication|token/i);
    await internalAdminContext.run({ userId: 'test-admin', requestId: randomUUID() }, async () => {
      await assert.rejects(users.createUser(undefined, { userId: granted.userId, replaceAppAccess: true, allowedAppIds: [] }), /both/);
      await users.createUser(undefined, replacement);
    });
    assert.deepEqual((await identity.account(granted.userId))?.appAccess.allowedAppIds, [], 'admin editor can remove an explicit grant');
    assert.deepEqual((await identity.account(granted.userId))?.appAccess.deniedAppIds, []);
    assert.equal((await identity.authenticate('GrantedUser', 'RegistrationPassword123!'))?.userId, granted.userId, 'app edits preserve credentials');
    assert.equal((await store.evaluateAppCenterAccess({ appId: 'signup-private', userId: granted.userId })).allowed, false);

    // Web binding verifies both identities and preserves all local privileges.
    const bindBefore = await identity.account(old.userId);
    await assert.rejects(a.bindFeishu('tenant:web-person', 'ExistingMember', 'wrong'), /密码/);
    await assert.rejects(a.bindFeishu('tenant:web-person', 'missing', 'Old123!'), /密码/);
    assert.deepEqual(await a.bindFeishu('tenant:web-person', 'ExistingMember', 'Old123!'), { userId: old.userId });
    assert.deepEqual(await b.bindFeishu('tenant:web-person', 'ExistingMember', 'Old123!'), { userId: old.userId });
    const bound = await identity.account(old.userId);
    assert.deepEqual(bound?.roleIds, bindBefore?.roleIds);
    assert.deepEqual(bound?.appAccess, bindBefore?.appAccess);
    assert.equal(bound?.credential.hasPassword, true);
    assert.equal((await a.feishuAccount('tenant:web-person')).userId, old.userId);
    await assert.rejects(a.bindFeishu('tenant:web-person', winningInput.account, winningInput.password), /其他绑定/);
    await assert.rejects(store.createUserCenterUser({ account: 'DuplicateFeishu', externalIds: { feishuSubject: 'tenant:web-person' } }), /already linked/);
    const webInvite = await a.createInvitation({ label: 'Web Feishu', maxUses: 1, days: 1 });
    const webInput = input('WebFeishu', webInvite.code, { verifiedFeishuSubject: 'tenant:web-new' });
    const webUser = await a.register(webInput);
    assert.deepEqual(await b.register(webInput), webUser);
    assert.equal((await a.feishuAccount('tenant:web-new')).userId, webUser.userId);
    assert.deepEqual((await identity.account(webUser.userId))?.appAccess.allowedAppIds, []);
    const contenders = await Promise.allSettled([
      a.bindFeishu('tenant:race-person', winningInput.account, winningInput.password),
      b.bindFeishu('tenant:race-person', 'GrantedUser', 'RegistrationPassword123!')
    ]);
    assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);

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
  @Module({ controllers: [RegistrationController], providers: [{ provide: RUNTIME_CONFIG, useValue: config }, { provide: PLATFORM_STORE, useValue: new MemoryStore(config) }] })
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
