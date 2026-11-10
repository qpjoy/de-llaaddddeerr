import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import { MINCAVE_ADMIN, MINCAVE_EMPLOYEE } from '../../lib/mincave-access.js';
import { MinCaveService } from './mincave.service.js';

function fixture() {
  const config = {
    ...loadConfig(),
    mincaveFeishuTenantKey: 'minsight-tenant',
    mincaveInitialAdminUserId: 'admin',
  };
  const store = new MemoryStore(config);
  store.bootstrapUserCenter();
  const service = new MinCaveService(config, store);
  function user(id: string, tenant = 'minsight-tenant', roles = ['mx-user']) {
    return store.createUserCenterUser({
      userId: id,
      account: id,
      displayName: `Name ${id}`,
      roleIds: roles,
      externalIds: { feishuSubject: `${tenant}:ou_${id}` },
      profile: { department: '研发', attributes: { privateValue: 'never-render' } },
    });
  }
  function issue(id: string, tenant = 'minsight-tenant', overrides: Record<string, unknown> = {}) {
    return store.issueUserCenterToken({
      subjectKind: 'user',
      subjectId: id,
      audience: 'mx-sdk',
      appId: 'mx-h2i',
      scopes: ['auth.read'],
      authProvider: 'feishu',
      verifiedFeishuIdentity: { tenantKey: tenant, subject: `${tenant}:ou_${id}` },
      ...overrides,
    });
  }
  user('admin');
  user('employee');
  const admin = issue('admin');
  const employee = issue('employee');
  const bearer = (token: string) => `Bearer ${token}`;
  return { config, store, service, user, issue, admin, employee, bearer };
}
test('enterprise admission defaults to employee and initializes only the exact designated administrator once', async () => {
  const f = fixture();
  assert.equal((await f.service.session(f.bearer(f.admin.token))).role, 'admin');
  assert.equal((await f.service.session(f.bearer(f.employee.token))).role, 'employee');
  assert.equal(f.store.listMinCaveMembers().length, 2);
  await f.service.session(f.bearer(f.employee.token));
  assert.equal(f.store.listMinCaveMembers().length, 2);
  f.user('mx-only-admin', 'minsight-tenant', ['mx-admin']);
  assert.equal(
    (await f.service.session(f.bearer(f.issue('mx-only-admin').token))).role,
    'employee',
  );
  f.user('role-only', 'minsight-tenant', [MINCAVE_EMPLOYEE]);
  assert.equal((await f.service.session(f.bearer(f.issue('role-only').token))).role, 'employee');
  f.user('same-name');
  assert.equal((await f.service.session(f.bearer(f.issue('same-name').token))).canManage, false);
  f.user('outsider', 'other-tenant', [MINCAVE_ADMIN, 'mx-user']);
  await assert.rejects(
    f.service.session(f.bearer(f.issue('outsider', 'other-tenant').token)),
    ForbiddenException,
  );
  assert.ok(!f.store.listMinCaveMembers().some((row) => row.userId === 'outsider'));
  assert.ok(
    !f.store
      .listUserCenterRoles()
      .find((row) => row.roleId === 'mx-admin')!
      .scopes.includes('mx:mincave:admin'),
  );
});
test('password, missing provenance, wrong app, revoked and expired tokens never admit; caller-supplied tenant or roles cannot elevate', async () => {
  const f = fixture();
  for (const overrides of [
    { authProvider: 'password' },
    { verifiedFeishuIdentity: null },
    { appId: 'h2o' },
    { audience: 'other' },
  ]) {
    await assert.rejects(
      f.service.session(f.bearer(f.issue('employee', 'minsight-tenant', overrides).token)),
      UnauthorizedException,
    );
  }
  const revoked = f.issue('employee');
  revoked.record.revokedAt = new Date().toISOString();
  const expired = f.issue('employee');
  expired.record.expiresAt = new Date(Date.now() - 1000).toISOString();
  for (const issued of [revoked, expired])
    await assert.rejects(f.service.session(f.bearer(issued.token)), UnauthorizedException);
  await assert.rejects(f.service.session(), UnauthorizedException);
  await assert.rejects(
    new MinCaveService({ ...f.config, mincaveFeishuTenantKey: null }, f.store).session(
      f.bearer(f.admin.token),
    ),
    ServiceUnavailableException,
  );
});
test('Launcher and MinCave share live roles; MinCave updates preserve all other privileges and never regrant a revoked role', async () => {
  const f = fixture();
  f.user('employee', 'minsight-tenant', ['mx-user', 'mx-pay-auditor']);
  const before = f.store.listUserCenterUsers().find((row) => row.userId === 'employee')!;
  await f.service.session(f.bearer(f.admin.token));
  await f.service.session(f.bearer(f.employee.token));
  await assert.rejects(f.service.members(f.bearer(f.employee.token)), ForbiddenException);
  await assert.rejects(
    f.service.update(f.bearer(f.admin.token), 'employee', {
      role: 'admin',
      enabled: true,
      roleIds: ['mx-admin'],
    }),
    BadRequestException,
  );
  await f.service.update(f.bearer(f.admin.token), 'employee', { role: 'admin', enabled: true });
  assert.equal((await f.service.session(f.bearer(f.employee.token))).canManage, true);
  const promoted = f.store.listUserCenterUsers().find((row) => row.userId === 'employee')!;
  assert.deepEqual(promoted.roleIds, ['mx-user', 'mx-pay-auditor', MINCAVE_ADMIN]);
  assert.deepEqual(promoted.appAccess, before.appAccess);
  assert.deepEqual(promoted.profile, before.profile);
  const list = await f.service.members(f.bearer(f.employee.token));
  assert.ok(!JSON.stringify(list).includes('never-render'));
  assert.ok(!JSON.stringify(list).includes('credential'));
  // Launcher role edit is effective with the same existing access token.
  f.store.createUserCenterUser({
    userId: 'employee',
    account: 'employee',
    roleIds: ['mx-user', 'mx-pay-auditor', MINCAVE_EMPLOYEE],
  });
  assert.equal((await f.service.session(f.bearer(f.employee.token))).canManage, false);
  await assert.rejects(
    f.service.update(f.bearer(f.employee.token), 'admin', { role: 'employee', enabled: true }),
    ForbiddenException,
  );
  await f.service.update(f.bearer(f.admin.token), 'employee', { role: 'employee', enabled: false });
  await assert.rejects(f.service.session(f.bearer(f.employee.token)), ForbiddenException);
  assert.deepEqual(
    f.store.listUserCenterUsers().find((row) => row.userId === 'employee')!.roleIds,
    ['mx-user', 'mx-pay-auditor'],
  );
});
test('both management paths protect the last effective administrator, including disable, unlink and delete', async () => {
  const f = fixture();
  await f.service.session(f.bearer(f.admin.token));
  await f.service.session(f.bearer(f.employee.token));
  await assert.rejects(
    f.service.update(f.bearer(f.admin.token), 'admin', { role: 'employee', enabled: true }),
    ConflictException,
  );
  assert.throws(
    () => f.store.createUserCenterUser({ userId: 'admin', account: 'admin', roleIds: ['mx-user'] }),
    ConflictException,
  );
  assert.throws(
    () =>
      f.store.createUserCenterUser({
        userId: 'admin',
        account: 'admin',
        roleIds: ['mx-user', MINCAVE_ADMIN],
        status: 'disabled',
      }),
    ConflictException,
  );
  assert.throws(() => f.store.deleteUserCenterUser({ userId: 'admin' }), ConflictException);
  assert.throws(
    () =>
      f.store.createUserCenterUser({
        userId: 'employee',
        account: 'employee',
        roleIds: [MINCAVE_ADMIN, MINCAVE_EMPLOYEE],
      }),
    ConflictException,
  );
  await f.service.update(f.bearer(f.admin.token), 'employee', { role: 'admin', enabled: true });
  await f.service.update(f.bearer(f.employee.token), 'admin', { role: 'employee', enabled: true });
  assert.equal(
    (await f.service.session(f.bearer(f.admin.token))).role,
    'employee',
    'initial admin setting never regrants on a later login',
  );
});
