import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../../config.js';
import { createPlatformDataSource } from '../../db/data-source.js';
import { internalAdminContext } from '../../lib/internal-admin-context.js';
import { MemoryStore } from '../../store/memory.js';
import { PostgresStore } from '../../store/postgres.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { luopanIdentifiedInstallUsers, UserAppUpdatePolicyConflictError } from '../../store/user-app-update-policy.js';
import type { AuditEventInput, LauncherNetworkLease, RuntimeConfig } from '../../types.js';
import { UserCenterController } from './user-center.controller.js';

for (const driver of ['memory', 'postgres'] as const) {
  const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;
  test(`${driver}: Luopan update policy and optional application denial are atomic and isolated`,
    { skip: driver === 'postgres' && !databaseUrl }, async () => {
      const environment = `luopan-controls-${randomUUID()}`;
      const config: RuntimeConfig = { ...loadConfig(), environment, storeDriver: driver, ...(databaseUrl ? { databaseUrl } : {}) };
      if (driver === 'postgres') {
        const target = new URL(databaseUrl!);
        assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.includes('sso_test'));
      }
      const db = driver === 'postgres' ? createPlatformDataSource(config) : null;
      if (db) { await db.initialize(); await db.runMigrations(); }
      const store: PlatformStore = driver === 'postgres' ? await PostgresStore.create(config) : new MemoryStore(config);
      try {
        const user = await store.createUserCenterUser({
          account: 'controls-user', password: 'ControlsPassword123!',
          allowedAppIds: ['mx-h2i', 'luopan'], deniedAppIds: ['other-app'], roleIds: ['mx-user']
        });
        const other = await store.createUserCenterUser({ account: 'other-controls-user', password: 'OtherPassword123!' });
        const tokens = await Promise.all(['mx-h2i', 'luopan'].map(appId => store.issueUserCenterToken({
          subjectKind: 'user', subjectId: user.userId, appId, audience: 'mx-sdk', scopes: ['auth.read']
        })));
        const h2i = await enroll(store, user.userId, 'mx-h2i', 'h2i');
        const luopan = await enroll(store, user.userId, 'luopan', 'luopan');
        const beforeUser = structuredClone((await store.listUserCenterUsers()).find(row => row.userId === user.userId));
        const beforeLeases = structuredClone(await store.listLauncherNetworkLeases());
        assert.equal(await store.getUserAppUpdatePolicy('luopan', user.userId), null);
        const first = await store.setLuopanUserControls({ userId: user.userId, updatesBlocked: true, expectedRevision: 0, requestedBy: 'admin', reason: 'renewal' });
        assert.equal(first.policy.revision, 1);
        assert.equal(first.policy.updatesBlocked, true);
        assert.equal(first.loginBlocked, false);
        assert.deepEqual((await store.listUserCenterUsers()).find(row => row.userId === user.userId), beforeUser);
        assert.deepEqual(await store.listLauncherNetworkLeases(), beforeLeases);
        for (const token of tokens) assert.equal((await store.introspectToken({ token: token.token })).active, true);
        assert.equal((await store.verifyUserCenterPassword({ userId: user.userId, password: 'ControlsPassword123!' })).ok, true);
        assert.equal(await store.getUserAppUpdatePolicy('mx-h2i', user.userId), null);
        assert.equal(await store.getUserAppUpdatePolicy('luopan', other.userId), null);
        assert.deepEqual((await store.listLauncherNetworkLeasesForInstall('luopan', luopan.installId)).map(row => row.leaseId), [luopan.leaseId]);
        assert.deepEqual(await store.listLauncherNetworkLeasesForInstall('mx-h2i', luopan.installId), []);

        await assert.rejects(async () => store.setLuopanUserControls({ userId: user.userId, updatesBlocked: false, loginBlocked: true, expectedRevision: 0 }), UserAppUpdatePolicyConflictError);
        assert.equal((await store.getUserAppUpdatePolicy('luopan', user.userId))?.revision, 1);
        assert.equal((await store.getUserCenterUserIdentity(user.userId))?.appAccess.deniedAppIds.includes('luopan'), false);

        const blocked = await store.setLuopanUserControls({ userId: user.userId, updatesBlocked: true, loginBlocked: true, expectedRevision: 1 });
        assert.equal(blocked.policy.revision, 2);
        assert.deepEqual((await store.getUserCenterUserIdentity(user.userId))?.appAccess.deniedAppIds, ['other-app', 'luopan']);
        const loginChangedUser = (await store.listUserCenterUsers()).find(row => row.userId === user.userId)!;
        assert.deepEqual({ ...loginChangedUser, appAccess: beforeUser!.appAccess, updatedAt: beforeUser!.updatedAt }, beforeUser,
          'optional login denial preserves credentials, global status, roles and browser-session invalidation');
        assert.equal((await store.introspectToken({ token: tokens[0]!.token })).active, true, 'H2I token is retained');
        assert.deepEqual(await store.listLauncherNetworkLeases(), beforeLeases, 'optional login denial does not mutate peers or leases');

        // Generic editor saves must not undo a dedicated change made by another administrator.
        await store.createUserCenterUser({ userId: user.userId, replaceAppAccess: true, allowedAppIds: ['mx-h2i'], deniedAppIds: ['other-app'], preserveLuopanLoginAccess: true });
        assert.deepEqual((await store.getUserCenterUserIdentity(user.userId))?.appAccess.deniedAppIds, ['other-app', 'luopan']);
        await store.setLuopanUserControls({ userId: user.userId, updatesBlocked: false, expectedRevision: 2 });
        assert.equal((await store.getUserCenterUserIdentity(user.userId))?.appAccess.deniedAppIds.includes('luopan'), true, 'omitted login flag preserves denial');
        await store.setLuopanUserControls({ userId: user.userId, updatesBlocked: false, loginBlocked: false, expectedRevision: 3 });
        await store.createUserCenterUser({ userId: user.userId, replaceAppAccess: true, allowedAppIds: ['mx-h2i'], deniedAppIds: ['other-app', 'luopan'], preserveLuopanLoginAccess: true });
        assert.deepEqual((await store.getUserCenterUserIdentity(user.userId))?.appAccess.deniedAppIds, ['other-app'], 'stale editor cannot restore a removed denial');
        assert.equal((await store.getLauncherNetworkLease(h2i.leaseId))?.status, 'active');

        if (driver === 'postgres') {
          const mutable = store as PostgresStore & { recordAuditTo: (...args: unknown[]) => Promise<unknown> };
          const original = (mutable as any).recordAuditTo;
          (mutable as any).recordAuditTo = async () => { throw new Error('audit unavailable'); };
          try {
            await assert.rejects(async () => store.setLuopanUserControls({ userId: user.userId, updatesBlocked: true, loginBlocked: true, expectedRevision: 4 }), /audit unavailable/);
          } finally { (mutable as any).recordAuditTo = original; }
          assert.equal((await store.getUserAppUpdatePolicy('luopan', user.userId))?.revision, 4);
          assert.deepEqual((await store.getUserCenterUserIdentity(user.userId))?.appAccess.deniedAppIds, ['other-app']);

          // Pause after reading the user but before persisting optional login
          // access. A real second connection tries the same row deletion used
          // by deleteUserCenterUser, which deliberately takes no account lock.
          let entered!: () => void;
          let release!: () => void;
          const enteredGate = new Promise<void>(resolve => { entered = resolve; });
          const releaseGate = new Promise<void>(resolve => { release = resolve; });
          const originalSave = (store as any).saveRecordTo;
          (store as any).saveRecordTo = async (...args: any[]) => {
            if (args[1] === 'user-app-update-policy' && args[3]?.userId === other.userId) {
              entered();
              await releaseGate;
            }
            return originalSave.apply(store, args);
          };
          const pendingSave = store.setLuopanUserControls({ userId: other.userId, updatesBlocked: true, loginBlocked: true, expectedRevision: 0 });
          try {
            await enteredGate;
            await assert.rejects(db!.transaction(async manager => {
              await manager.query("SET LOCAL lock_timeout = '150ms'");
              await manager.query("DELETE FROM mx_platform_records WHERE environment=$1 AND kind='iam-user' AND id=$2", [environment, other.userId]);
            }), (error: unknown) => (error as { code?: string }).code === '55P03',
            'deletion must wait for the pending login-control mutation instead of leaving an orphan after its upsert');
          } finally {
            release();
            await pendingSave;
            (store as any).saveRecordTo = originalSave;
          }
          await store.deleteUserCenterUser({ userId: other.userId, requestedBy: 'concurrent-delete-test' });
          assert.equal(await store.getUserCenterUserIdentity(other.userId), null, 'normal deletion succeeds once the mutation commits');
        }
      } finally {
        if (driver === 'postgres') await (store as unknown as { dataSource: { destroy(): Promise<void> } }).dataSource.destroy();
        if (db) { await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]); await db.destroy(); }
      }
    });
}

test('admin API validates booleans/revisions, authenticates, and records the authenticated actor', async context => {
  const previousToken = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'luopan-controls-test';
  context.after(() => {
    if (previousToken === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousToken;
  });
  const store = new MemoryStore(loadConfig());
  const audits: AuditEventInput[] = [];
  const recordAudit = store.recordAudit.bind(store);
  store.recordAudit = input => { audits.push(input); return recordAudit(input); };
  const controller = new UserCenterController(store);
  const user = store.createUserCenterUser({ account: 'controls-api' });
  await assert.rejects(controller.luopanControls(user.userId, 'wrong'), status(401));
  await assert.rejects(controller.setLuopanControls(user.userId, undefined, { updatesBlocked: true, expectedRevision: 0 }), status(401));
  const initial = await controller.luopanControls(user.userId, 'luopan-controls-test');
  assert.equal(initial.policy.revision, 0);
  assert.equal(initial.policy.updatesBlocked, false);
  assert.equal(initial.loginBlocked, false);
  assert.equal(initial.coverage.status, 'unconfirmed');
  for (const invalid of [
    {}, { updatesBlocked: 'true', expectedRevision: 0 }, { updatesBlocked: true, expectedRevision: '0' },
    { updatesBlocked: true, expectedRevision: -1 }, { updatesBlocked: true, expectedRevision: 1.5 },
    { updatesBlocked: true, expectedRevision: 0, loginBlocked: null },
    { updatesBlocked: true, expectedRevision: 0, loginBlocked: 'false' },
    { updatesBlocked: true, expectedRevision: 0, reason: {} }
  ]) await assert.rejects(controller.setLuopanControls(user.userId, 'luopan-controls-test', invalid), status(400));
  await assert.rejects(controller.luopanControls('missing-user', 'luopan-controls-test'), status(404));
  await assert.rejects(controller.setLuopanControls('missing-user', 'luopan-controls-test', { updatesBlocked: true, expectedRevision: 0 }), status(404));
  await enroll(store, user.userId, 'luopan', 'identified');
  const saved = await internalAdminContext.run({ userId: 'actual-admin', requestId: 'actual-request' }, () => controller.setLuopanControls(user.userId, undefined, {
    updatesBlocked: true, expectedRevision: 0, requestedBy: 'spoofed-admin', requestId: 'spoofed-request'
  }));
  assert.equal(saved.policy.updatedBy, 'actual-admin');
  assert.equal(saved.coverage.status, 'identified');
  assert.equal(saved.coverage.installCount, 1);
  const savedAudit = audits.find(row => row.eventType === 'release.user_app_update_policy.updated');
  assert.equal(savedAudit?.requestId, 'actual-request');
  assert.equal(savedAudit?.metadata?.requestedBy, 'actual-admin');
  await assert.rejects(controller.setLuopanControls(user.userId, 'luopan-controls-test', { updatesBlocked: false, expectedRevision: 0, loginBlocked: true }), status(409));
  assert.equal(store.getUserCenterUserIdentity(user.userId)?.appAccess.deniedAppIds.includes('luopan'), false);
});

test('coverage ignores unrelated/expired/released leases and excludes mixed identities on an install', async () => {
  const store = new MemoryStore(loadConfig());
  const user = store.createUserCenterUser({ account: 'coverage-user' });
  const lease = await enroll(store, user.userId, 'luopan', 'coverage');
  const now = Date.now();
  const valid = { ...lease, expiresAt: new Date(now + 60000).toISOString() };
  assert.deepEqual([...luopanIdentifiedInstallUsers([valid], now)], [[valid.installId, user.userId]]);
  const other = { ...valid, userId: 'other-user' };
  assert.equal(luopanIdentifiedInstallUsers([valid, other], now).size, 0);
  assert.equal(luopanIdentifiedInstallUsers([valid, { ...valid, identityKind: 'anonymous', userId: null }], now).size, 0);
  const invalid: LauncherNetworkLease[] = [
    { ...valid, status: 'released' }, { ...valid, expiresAt: 'not-a-time' },
    { ...valid, expiresAt: new Date(now).toISOString() }, { ...valid, productId: 'mx-h2i' }
  ];
  assert.equal(luopanIdentifiedInstallUsers(invalid, now).size, 0);
  assert.equal(luopanIdentifiedInstallUsers([valid, { ...other, status: 'released' }], now).get(valid.installId), user.userId);
});

async function enroll(store: PlatformStore, userId: string, productId: string, suffix: string) {
  return store.enrollLauncherNetworkLease({
    productId, appId: productId, userId, identityKind: 'user', mode: 'standalone', leaseProfile: 'employee',
    installId: `inst-${suffix}`, deviceId: `device-${suffix}`, publicKey: `key-${suffix}`
  });
}

function status(expected: number) {
  return (error: unknown) => (error as { getStatus?: () => number })?.getStatus?.() === expected;
}
