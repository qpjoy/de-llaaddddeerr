import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { loadConfig } from '../config.js';
import type { PlatformRecordRow } from '../db/entities.js';
import type { UserCenterTokenRecord } from '../types.js';
import {
  buildAppCenterApp,
  builtinUserCenterRoles,
  createUserCenterServiceAccount,
  createUserCenterTokenRecord,
  createUserCenterUser
} from './domain.js';
import { PostgresStore } from './postgres.js';

type RecordWrite = Pick<PlatformRecordRow, 'kind' | 'id' | 'environment' | 'siteId' | 'data'>;
type RecordLookup = { where: { kind: string; id?: string; environment: string } };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('authentication waited for an unresolved audit write')), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function harness(t: TestContext, behavior: {
  insert?: (rows: RecordWrite[]) => Promise<unknown>;
  save?: (row: RecordWrite) => Promise<unknown>;
  read?: (kind: string, id?: string) => Promise<void>;
} = {}) {
  const config = { ...loadConfig(), environment: 'auth-audit-test', siteId: 'test-site' };
  const user = createUserCenterUser({
    userId: 'usr_audit_test', account: 'AuditTest', roleIds: ['mx-user'], allowedAppIds: ['compass']
  });
  const token = 'mx-v1-fixture-token-that-must-not-be-in-audit';
  const { record } = createUserCenterTokenRecord(config, {
    subjectKind: 'user', subjectId: user.userId, audience: 'mx-sdk', scopes: ['auth.read']
  }, token);
  const rows = new Map<string, RecordWrite>();
  const writes: RecordWrite[][] = [];
  const saves: RecordWrite[] = [];
  const reads: Array<{ kind: string; id?: string }> = [];
  const put = (kind: string, id: string, data: object) => {
    rows.set(`${kind}:${id}`, {
      kind, id, environment: config.environment, siteId: config.siteId, data: data as Record<string, unknown>
    });
  };
  put('iam-user', user.userId, user);
  put('iam-token', record.tokenHash, record);
  for (const role of builtinUserCenterRoles()) put('iam-role', role.roleId, role);
  put('app-center-app', 'compass', buildAppCenterApp({ appId: 'compass', enabled: true }));
  const repository = {
    async findOne({ where }: RecordLookup) {
      assert.equal(where.environment, config.environment);
      reads.push({ kind: where.kind, id: where.id });
      await behavior.read?.(where.kind, where.id);
      return rows.get(`${where.kind}:${where.id}`) ?? null;
    },
    async find({ where }: RecordLookup) {
      assert.equal(where.environment, config.environment);
      reads.push({ kind: where.kind });
      await behavior.read?.(where.kind);
      return [...rows.values()].filter(row => row.kind === where.kind);
    },
    async insert(batch: RecordWrite[]) {
      writes.push(batch);
      return behavior.insert?.(batch) ?? {};
    },
    async save(row: RecordWrite) {
      saves.push(row);
      await behavior.save?.(row);
      rows.set(`${row.kind}:${row.id}`, row);
      return row;
    }
  };
  const store = Reflect.construct(PostgresStore, [config, {}, repository]) as PostgresStore;
  const queue = (store as unknown as {
    observationalAuditQueue: { flush(): Promise<void>; close(): void }
  }).observationalAuditQueue;
  t.after(() => queue?.close());
  return { store, queue, token, record, user, rows, put, writes, saves, reads };
}

test('slow observational audit inserts do not hold introspection, principal context, or gateway access open', async t => {
  const stalledWrite = deferred();
  const h = harness(t, { insert: () => stalledWrite.promise });
  t.after(() => stalledWrite.resolve());
  const first = await promptly(h.store.introspectToken({ token: h.token, audience: 'mx-sdk', requestId: 'first' }));
  assert.equal(first.active, true);
  assert.equal(h.saves.length, 0, 'read-side authentication must not invoke synchronous audit save');

  const flushing = h.queue.flush();
  await Promise.resolve();
  assert.equal(h.writes.length, 1, 'an audit insert is now waiting on the simulated database');
  const [auth, context, access] = await promptly(Promise.all([
    h.store.introspectToken({ token: h.token, audience: 'mx-sdk', requestId: 'auth-during-wal-stall' }),
    h.store.resolvePrincipalContext({ token: h.token, audience: 'mx-sdk', requestId: 'context-during-wal-stall' }),
    h.store.evaluateSdkGatewayAccess({ token: h.token, audience: 'mx-sdk', routeId: 'sdk.identity.introspect', requestId: 'gateway-during-wal-stall' })
  ]));
  assert.equal(auth.active, true);
  assert.equal(context.auth.active, true);
  assert.equal(context.source, 'token');
  assert.equal(context.principal.userId, h.user.userId);
  assert.equal(access.allowed, true);
  assert.equal(h.writes.length, 1, 'the stalled insert must not spawn more database writers');
  assert.equal(h.saves.length, 0);

  stalledWrite.resolve();
  await flushing;
  await h.queue.flush();
  const events = h.writes.flat().map(row => row.data);
  assert.deepEqual(new Set(events.map(event => event.eventType)), new Set([
    'auth.token.introspected', 'identity.context.resolved', 'sdk.gateway.access.evaluated'
  ]));
  assert.equal(events.length, 6);
  assert.equal(events.every(event => event.provenance === 'server' && event.environment === 'auth-audit-test'), true);
  assert.equal(new Set(events.map(event => event.eventId)).size, 6);
  assert.equal(JSON.stringify(events).includes(h.token), false);
  assert.equal(JSON.stringify(events).includes(h.record.tokenHash), false);
});

test('failed observational inserts do not turn valid tokens into authentication errors', async t => {
  const h = harness(t, { insert: async () => { throw new Error('simulated WAL write failure'); } });
  assert.equal((await promptly(h.store.introspectToken({ token: h.token }))).active, true);
  await h.queue.flush();
  assert.equal(h.writes.length, 1);
  assert.equal((await promptly(h.store.introspectToken({ token: h.token }))).active, true);
  assert.equal((await promptly(h.store.introspectToken({ token: 'invalid-token' }))).active, false);
  assert.equal(h.saves.length, 0);
});

test('introspection still checks current token, audience, revocation, subject status, and application admission', async t => {
  const h = harness(t);
  const introspect = () => promptly(h.store.introspectToken({ token: h.token, audience: 'mx-sdk' }));
  assert.equal((await introspect()).active, true);
  assert.deepEqual((await introspect()).scopes, ['auth.read'], 'token scopes remain narrowed');

  for (const [patch, expectedReason] of [
    [{ expiresAt: new Date(0).toISOString() }, 'token has expired'],
    [{ revokedAt: new Date().toISOString() }, 'token has been revoked'],
    [{ audience: 'another-service' }, 'token audience does not match']
  ] as Array<[Partial<UserCenterTokenRecord>, string]>) {
    h.put('iam-token', h.record.tokenHash, { ...h.record, ...patch });
    const rejected = await introspect();
    assert.equal(rejected.active, false);
    assert.equal(rejected.principal, null);
    assert.equal(rejected.reason, expectedReason);
  }
  h.put('iam-token', h.record.tokenHash, h.record);
  h.put('iam-user', h.user.userId, { ...h.user, status: 'disabled' });
  assert.equal((await introspect()).reason, 'token subject is not active');
  h.rows.delete(`iam-user:${h.user.userId}`);
  assert.equal((await introspect()).active, false);
  h.put('iam-user', h.user.userId, {
    ...h.user, appAccess: { ...h.user.appAccess, deniedAppIds: ['compass'] }
  });
  h.put('iam-token', h.record.tokenHash, { ...h.record, appId: 'compass' });
  const denied = await introspect();
  assert.equal(denied.active, false);
  assert.equal(denied.reason, 'app_access_denied');
  h.put('iam-user', h.user.userId, h.user);
  assert.equal((await introspect()).active, true, 'live account state is re-read for each request');
  const missing = await promptly(h.store.introspectToken({}));
  assert.equal(missing.active, false);
  assert.equal(missing.reason, 'token is missing');
  const unknown = await promptly(h.store.introspectToken({ token: 'invalid-token' }));
  assert.equal(unknown.active, false);
  assert.equal(unknown.principal, null);
  assert.equal(h.saves.length, 0);
});

test('role scope removal and service-account disable take effect on the next authentication read', async t => {
  const h = harness(t);
  const route = { token: h.token, routeId: 'sdk.identity.introspect' };
  assert.equal((await promptly(h.store.evaluateSdkGatewayAccess(route))).allowed, true);
  const role = builtinUserCenterRoles().find(item => item.roleId === 'mx-user')!;
  h.put('iam-role', role.roleId, { ...role, scopes: role.scopes.filter(scope => scope !== 'auth.read') });
  const auth = await promptly(h.store.introspectToken({ token: h.token }));
  assert.equal(auth.active, true);
  assert.deepEqual(auth.scopes, []);
  assert.equal((await promptly(h.store.evaluateSdkGatewayAccess(route))).allowed, false);

  const account = createUserCenterServiceAccount({ serviceAccountId: 'svc_audit_test', scopes: ['sdk.identity.read'] });
  h.put('iam-service-account', account.serviceAccountId, account);
  h.put('iam-token', h.record.tokenHash, {
    ...h.record, subjectKind: 'service-account', subjectId: account.serviceAccountId, scopes: ['sdk.identity.read']
  });
  const serviceAuth = await promptly(h.store.introspectToken({ token: h.token }));
  assert.equal(serviceAuth.active, true);
  assert.equal(serviceAuth.tokenKind, 'service-token');
  assert.equal(serviceAuth.principal?.serviceAccountId, account.serviceAccountId);
  h.put('iam-service-account', account.serviceAccountId, { ...account, status: 'disabled' });
  const disabledAuth = await promptly(h.store.introspectToken({ token: h.token }));
  assert.equal(disabledAuth.active, false);
  assert.equal(disabledAuth.reason, 'token subject is not active');
});

test('gateway scope and app access denials remain effective with asynchronous observation audits', async t => {
  const h = harness(t);
  const access = (routeId: string, appId?: string) => promptly(h.store.evaluateSdkGatewayAccess({
    token: h.token, audience: 'mx-sdk', routeId, appId
  }));
  assert.equal((await access('sdk.identity.introspect', 'compass')).allowed, true);
  const scopeDenied = await access('sdk.users.password.update');
  assert.equal(scopeDenied.allowed, false);
  assert.ok(scopeDenied.missingScopes.includes('sdk.user.write'));
  h.put('iam-user', h.user.userId, {
    ...h.user, appAccess: { ...h.user.appAccess, deniedAppIds: ['compass'] }
  });
  const appDenied = await access('sdk.identity.introspect', 'compass');
  assert.equal(appDenied.allowed, false);
  assert.equal(appDenied.appAccess?.allowed, false);
  h.put('iam-token', h.record.tokenHash, { ...h.record, revokedAt: new Date().toISOString() });
  assert.equal((await access('sdk.identity.introspect')).allowed, false);
});

test('identity reads still wait for the database and propagate read failures without fail-open', async t => {
  const identityRead = deferred();
  const h = harness(t, { read: kind => kind === 'iam-user' ? identityRead.promise : Promise.resolve() });
  t.after(() => identityRead.resolve());
  let completed = false;
  const pending = h.store.introspectToken({ token: h.token }).then(result => { completed = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'only audit persistence may be deferred, not credential validation');
  assert.equal(h.writes.length, 0);
  identityRead.resolve();
  assert.equal((await pending).active, true);

  for (const failingKind of ['iam-token', 'iam-role', 'iam-user']) {
    const failure = new Error(`database unavailable for ${failingKind}`);
    const failed = harness(t, { read: async kind => { if (kind === failingKind) throw failure; } });
    await assert.rejects(failed.store.introspectToken({ token: failed.token }), error => error === failure);
    assert.equal(failed.writes.length, 0);
    assert.equal(failed.saves.length, 0);
  }
});

test('token issuance still waits for its critical audit save and propagates audit failure', async t => {
  const auditSave = deferred();
  const h = harness(t, { save: row => row.kind === 'audit-event' ? auditSave.promise : Promise.resolve() });
  t.after(() => auditSave.resolve());
  let completed = false;
  const issuing = h.store.issueUserCenterToken({ subjectKind: 'user', subjectId: h.user.userId })
    .then(result => { completed = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(h.saves.map(row => row.kind), ['iam-token', 'audit-event']);
  assert.equal(h.saves[1].data.eventType, 'auth.token.issued');
  assert.equal(h.writes.length, 0);
  auditSave.resolve();
  assert.ok((await issuing).token);

  const failure = new Error('critical audit persistence unavailable');
  const failed = harness(t, { save: async row => { if (row.kind === 'audit-event') throw failure; } });
  await assert.rejects(failed.store.issueUserCenterToken({
    subjectKind: 'user', subjectId: failed.user.userId
  }), error => error === failure);
  await assert.rejects(failed.store.recordAudit({ eventType: 'iam.user.upserted' }), error => error === failure);
  assert.equal(failed.writes.length, 0);
});
