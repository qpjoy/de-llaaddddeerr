import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { createPlatformDataSource } from '../db/data-source.js';
import { loadConfig } from '../config.js';
import { PostgresStore } from '../store/postgres.js';
import { createUserCenterUserCredential } from '../store/domain.js';
import { accountWriteLock } from '../registration/repository.js';
import { PostgresSsoRepository } from '../admin-sso/repository.js';
import { identityScope, webDeviceId, webSecurityScope } from '../lib/web-session-security.js';
import { IdentityRepository } from './repository.js';

const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;
test('browser revocation persists across issuers/restarts, fences old proofs, owns devices and leaves SDK/network records intact', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl!);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.includes('sso_test'));
  const environment = `web-lifecycle-${randomUUID()}`;
  const config = { ...loadConfig(), databaseUrl: databaseUrl!, environment, storeDriver: 'postgres' as const };
  const db = createPlatformDataSource(config); await db.initialize(); await db.runMigrations();
  const store = await PostgresStore.create(config);
  const issuer = 'https://auth.test/identity', privateIssuer = 'https://private.test/identity';
  const scope = identityScope(environment, issuer), privateScope = identityScope(environment, privateIssuer);
  const a = new IdentityRepository(databaseUrl!, environment, scope, 'fixture');
  const b = new IdentityRepository(databaseUrl!, environment, privateScope, 'fixture');
  const admin = new PostgresSsoRepository(databaseUrl!, environment);
  await a.initialize(); await b.initialize();
  try {
    const user = await store.createUserCenterUser({ account: 'BrowserUser', password: 'OriginalPassword123!' });
    const other = await store.createUserCenterUser({ account: 'OtherBrowserUser', password: 'OtherPassword123!' });
    const time = Date.now() / 1000 - 2;
    const session = (accountId: string, uid: string, loginTs = time) => ({ accountId, uid, loginTs, iat: Math.floor(loginTs), authorizations: { hub: { grantId: 'g' } } });
    await a.adapter('Session').upsert('cookie-a', session(user.userId, 'browser-a'), 600);
    await a.adapter('Session').upsert('cookie-b', session(user.userId, 'browser-b'), 600);
    await b.adapter('Session').upsert('cookie-private', session(user.userId, 'browser-private'), 600);
    await a.adapter('Session').upsert('cookie-other', session(other.userId, 'browser-other'), 600);
    await a.adapter('AccessToken').upsert('token-a', { accountId: user.userId, sessionUid: 'browser-a', iat: Math.floor(time), extra: { mx_auth_time: time } }, 600);
    await a.adapter('AuthorizationCode').upsert('code-a', { accountId: user.userId, sessionUid: 'browser-a', authTime: time }, 600);
    const sentinel = [['iam-token', 'legacy-token'], ['launcher-network-lease', 'original-lease'], ['launcher-network-peer', 'original-peer']];
    for (const [kind, id] of sentinel) await db.query('INSERT INTO mx_platform_records(kind,id,environment,data) VALUES($1,$2,$3,$4)', [kind,id,environment,{ fixture:true, ...(kind === 'iam-token' ? {tokenHash:id,subjectKind:'user',subjectId:user.userId} : {}) }]);
    const before = await db.query('SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 ORDER BY kind,id', [environment]);
    assert.equal((await a.browserSessions(user.userId, 'browser-a')).length, 3);
    await a.revokeBrowserSessions(user.userId, webDeviceId(scope, 'browser-other'), 'forged');
    assert.ok(await a.adapter('Session').find('cookie-other'), 'cannot revoke another account');
    await a.revokeBrowserSessions(user.userId, webDeviceId(scope, 'browser-a'), 'device-action');
    assert.equal(await a.adapter('Session').find('cookie-a'), undefined);
    assert.equal(await a.adapter('AccessToken').find('token-a'), undefined);
    assert.equal(await a.adapter('AuthorizationCode').find('code-a'), undefined);
    assert.ok(await a.adapter('Session').find('cookie-b'));
    assert.equal(await admin.webSessionActive(user.userId, {issuer,authTime:time,sessionUid:'browser-a'}), false);
    await b.revokeBrowserSessions(user.userId, 'all', 'global-action');
    assert.equal(await a.adapter('Session').find('cookie-b'), undefined);
    assert.equal(await b.adapter('Session').find('cookie-private'), undefined);
    assert.equal(await admin.webSessionActive(user.userId, {issuer,authTime:time}), false, 'old BFF sessions without UID are globally revoked');
    assert.ok(await a.adapter('Session').find('cookie-other'));
    await new Promise(resolve => setTimeout(resolve, 2));
    const fresh = Date.now() / 1000;
    await a.adapter('Session').upsert('new-cookie', session(user.userId, 'new-browser', fresh), 600);
    await b.revokeBrowserSessions(user.userId, 'all', 'global-action');
    assert.ok(await a.adapter('Session').find('new-cookie'), 'retry cannot revoke a later login');
    assert.deepEqual(await db.query('SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 ORDER BY kind,id', [environment]), before);
    await a.close(); await a.initialize();
    assert.equal(await a.adapter('Session').find('cookie-a'), undefined, 'restart cannot revive revoked sessions');
    const fault = `web_password_${randomUUID().replaceAll('-', '')}`;
    await db.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.environment='${environment}' AND NEW.kind='audit-event' AND NEW.data->>'eventType'='iam.user.password.updated'
      THEN RAISE EXCEPTION 'password audit fault'; END IF; RETURN NEW; END $$`);
    try {
      await db.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON mx_platform_records FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
      await assert.rejects(store.updateUserCenterPassword({ userId:user.userId, password:'ChangedPassword456!' }), /password audit fault/);
      assert.deepEqual(await db.query('SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 ORDER BY kind,id', [environment]), before, 'password, token revocation and Web fence roll back together');
      assert.ok(await a.adapter('Session').find('new-cookie'));
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${fault} ON mx_platform_records`);
      await db.query(`DROP FUNCTION ${fault}()`);
    }
    assert.equal((await store.updateUserCenterPassword({ userId:user.userId, password:'ChangedPassword456!' })).tokensRevoked, 1, 'explicit password changes preserve the old SDK token revocation behavior');
    // Explicitly old proofs model cookies minted before this deployment too.
    await a.adapter('AccessToken').upsert('legacy-access', {accountId:user.userId,iat:Math.floor(time)}, 600);
    assert.equal(await a.adapter('AccessToken').find('legacy-access'), undefined);
    assert.equal(await a.adapter('Session').find('new-cookie'), undefined);
    assert.equal(await a.authenticate('BrowserUser', 'OriginalPassword123!'), undefined);
    assert.equal((await a.authenticate('BrowserUser', 'ChangedPassword456!'))?.userId, user.userId);
    const writer = db.createQueryRunner(); await writer.connect(); await writer.startTransaction();
    let overlappingLogin: ReturnType<IdentityRepository['authenticate']> | undefined;
    try {
      await accountWriteLock(writer.manager, environment);
      await writer.query("UPDATE mx_platform_records SET data=$1 WHERE environment=$2 AND kind='iam-user-credential' AND id=$3", [createUserCenterUserCredential(user.userId,'NewestPassword789!'),environment,user.userId]);
      overlappingLogin = a.authenticate('BrowserUser', 'ChangedPassword456!');
      // Observe the actual advisory-lock wait, rather than relying on timer ordering.
      const deadline = Date.now() + 2000;
      while (true) {
        const waiting = await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=hashtext($1)::oid AND objid=hashtext($2)::oid AND NOT granted", [environment,'mx-account-creation']);
        if (waiting.length) break;
        assert.ok(Date.now() < deadline, 'Web authentication must wait for the account writer');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await writer.commitTransaction();
      assert.equal(await overlappingLogin, undefined, 'an overlapping password write cannot authenticate the previous credential');
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release(); await overlappingLogin;
    }
  } finally {
    await a.close(); await b.close(); await admin.close(); await (store as unknown as { dataSource: DataSource }).dataSource.destroy();
    await db.query('DELETE FROM mx_identity_records WHERE scope=ANY($1::text[])', [[scope,privateScope,webSecurityScope(environment)]]);
    await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]); await db.destroy();
  }
});
