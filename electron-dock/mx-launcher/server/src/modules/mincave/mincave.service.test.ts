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
import { mergeMinCaveDevices } from '../../lib/mincave-devices.js';

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

test('device bindings belong to the verified account, deduplicate repeat sessions and retain both account histories on a shared installation', async () => {
  const f = fixture();
  const device = { deviceId: 'shared-device', deviceLabel: 'First Mac', platform: 'darwin' };
  await f.service.session(f.bearer(f.employee.token), { device });
  const first = await f.service.devices(f.bearer(f.employee.token));
  assert.equal(first.userId, 'employee');
  assert.equal(first.devices.length, 1);
  await f.service.session(f.bearer(f.employee.token), { device: { ...device, deviceLabel: 'Renamed Mac' } });
  const repeated = await f.service.devices(f.bearer(f.employee.token));
  assert.equal(repeated.devices.length, 1);
  assert.equal(repeated.devices[0].firstSeenAt, first.devices[0].firstSeenAt);
  assert.equal(repeated.devices[0].deviceLabel, 'Renamed Mac');
  await f.service.session(f.bearer(f.admin.token), { device: { ...device, deviceLabel: 'Admin shared Mac' } });
  await f.service.session(f.bearer(f.admin.token), { device: { deviceId: 'admin-private-device' } });
  assert.equal((await f.service.devices(f.bearer(f.admin.token))).devices.length, 2);
  const employee = await f.service.devices(f.bearer(f.employee.token));
  assert.equal(employee.devices.length, 1);
  assert.equal(employee.devices[0].deviceLabel, 'Renamed Mac');
  assert.ok(!JSON.stringify(employee).includes('Admin shared Mac'));
  assert.ok(!JSON.stringify(employee).includes('admin-private-device'));
  await assert.rejects(f.service.members(f.bearer(f.employee.token)), ForbiddenException);
});
test('device registration rejects forged owners and identity, disabled or unadmitted accounts cannot read devices', async () => {
  const f = fixture();
  for (const body of [
    { userId: 'admin', device: { deviceId: 'forged' } },
    { device: { userId: 'admin', deviceId: 'forged' } },
    { device: { deviceId: 'forged', role: 'admin' } },
    { device: { deviceId: '' } },
    { device: { deviceId: 'x'.repeat(201) } },
    { device: { deviceId: 'ok', deviceLabel: 'bad\nlabel' } },
    { device: { deviceId: 1 } },
  ]) await assert.rejects(f.service.session(f.bearer(f.employee.token), body), BadRequestException);
  assert.equal(f.store.listMinCaveDevices('employee').length, 0);
  await assert.rejects(f.service.devices(f.bearer(f.employee.token)), ForbiddenException);
  await assert.rejects(f.service.devices(), UnauthorizedException);
  await assert.rejects(f.service.devices(f.bearer(f.issue('employee', 'minsight-tenant', { authProvider: 'password' }).token)), UnauthorizedException);
  await f.service.session(f.bearer(f.admin.token));
  await f.service.session(f.bearer(f.employee.token), { device: { deviceId: 'own-device' } });
  await f.service.update(f.bearer(f.admin.token), 'employee', { role: 'employee', enabled: false });
  await assert.rejects(f.service.devices(f.bearer(f.employee.token)), ForbiddenException);
  await assert.rejects(f.service.session(f.bearer(f.employee.token), { device: { deviceId: 'new-device' } }), ForbiddenException);
  assert.equal(f.store.listMinCaveDevices('employee').length, 1);
});
test('released legacy leases are recovered by exact owner/product/device and persisted before a lease can change owner', async () => {
  const f = fixture();
  const legacy = f.store.enrollLauncherNetworkLease({
    appId: 'mx-h2i', productId: 'mx-h2i', mode: 'standalone', identityKind: 'user', leaseProfile: 'feishu',
    installId: 'old-install', deviceId: 'old-device', userId: 'employee', publicKey: 'never-render-public-key',
    deviceLabel: 'Old Windows', platform: 'win32', sourceIp: '198.51.100.99', requestedBy: 'test',
  });
  assert.deepEqual(mergeMinCaveDevices('employee', [], [
    { ...legacy, userId: 'admin' }, { ...legacy, identityKind: 'anonymous' },
    { ...legacy, productId: 'h2o' }, { ...legacy, appId: 'another-app' },
  ]), []);
  legacy.status = 'released';
  legacy.expiresAt = '2020-01-01T00:00:00Z';
  legacy.releasedAt = '2020-01-01T00:00:00Z';
  f.store.enrollLauncherNetworkLease({
    appId: 'mx-h2i', productId: 'mx-h2i', mode: 'standalone', identityKind: 'user', leaseProfile: 'feishu',
    installId: 'admin-install', deviceId: 'admin-only-history', userId: 'admin', publicKey: 'other-public-key', requestedBy: 'test',
  });
  await f.service.session(f.bearer(f.employee.token), { device: { deviceId: 'current-device', deviceLabel: 'My Mac' } });
  const first = await f.service.devices(f.bearer(f.employee.token));
  assert.deepEqual(first.devices.map(row => row.deviceId).sort(), ['current-device', 'old-device']);
  assert.equal(first.devices.find(row => row.deviceId === 'old-device')?.lastVirtualIp, legacy.leaseIp);
  for (const secret of ['never-render-public-key', '198.51.100.99', 'capability', 'installId', 'expiresAt', 'status', 'admin-only-history'])
    assert.ok(!JSON.stringify(first).includes(secret), secret);
  legacy.userId = 'admin';
  const retained = await f.service.devices(f.bearer(f.employee.token));
  assert.equal(retained.devices.length, 2, 'persisted bindings outlive changes in the lease inventory');
});

test('workspace applications persist, reject unsafe writes, isolate tenants and protect concurrent edits', async () => {
  const f = fixture();
  await f.service.session(f.bearer(f.admin.token));
  await f.service.session(f.bearer(f.employee.token));
  const before = (await f.service.members(f.bearer(f.admin.token))).workspace;
  assert.equal(before.applications.length, 6);
  assert.equal(before.revision, 0);
  const app = before.applications.find(row => row.id === 'web-hub')!;
  const edit = { revision: 0, kind: 'application', id: app.id, value: { name: 'Updated Hub', url: app.url, category: app.category, published: false } };
  await assert.rejects(f.service.updateWorkspace(f.bearer(f.employee.token), edit), ForbiddenException);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com/\n']) {
    await assert.rejects(f.service.updateWorkspace(f.bearer(f.admin.token), { ...edit, value: { ...edit.value, url } }), BadRequestException);
  }
  await assert.rejects(f.service.updateWorkspace(f.bearer(f.admin.token), { ...edit, actorId: 'employee' }), BadRequestException);
  await assert.rejects(f.service.updateWorkspace(f.bearer(f.admin.token), { ...edit, value: { ...edit.value, roleIds: ['mx-admin'] } }), BadRequestException);
  await f.service.updateWorkspace(f.bearer(f.admin.token), edit);
  await assert.rejects(f.service.updateWorkspace(f.bearer(f.admin.token), edit), ConflictException);
  const saved = f.store.getMinCaveWorkspace('minsight-tenant');
  assert.equal(saved.revision, 1);
  assert.equal(saved.applications.find(row => row.id === app.id)!.url, app.url, 'query and fragment are preserved');
  assert.equal((await f.service.session(f.bearer(f.employee.token))).applications.some(row => row.id === app.id), false);
  assert.equal(f.store.getMinCaveWorkspace('another-tenant').revision, 0);
  saved.applications.length = 0;
  assert.equal(f.store.getMinCaveWorkspace('minsight-tenant').applications.length, 6);
  assert.throws(() => f.store.updateMinCaveWorkspace({ ...edit, revision: 1, kind: 'application', actorId: 'admin', tenantKey: 'another-tenant' }), ForbiddenException);
});
test('department policies change same-token workbench entries, with deny precedence and reversible disable', async () => {
  const f = fixture();
  f.user('sales');
  f.store.createUserCenterUser({ userId: 'sales', account: 'sales', profile: { department: '销售' } });
  const sales = f.bearer(f.issue('sales').token);
  const admin = f.bearer(f.admin.token);
  const employee = f.bearer(f.employee.token);
  await f.service.session(admin);
  await f.service.session(employee);
  await f.service.session(sales);
  const allow = { name: '研发使用 Delta', department: '研发', appIds: ['web-delta'], action: 'allow', enabled: true };
  await f.service.updateWorkspace(admin, { revision: 0, kind: 'policy', value: allow });
  assert.ok((await f.service.session(employee)).applications.some(row => row.id === 'web-delta'));
  assert.ok(!(await f.service.session(sales)).applications.some(row => row.id === 'web-delta'));
  const deny = { name: '暂停 Delta', department: '*', appIds: ['web-delta'], action: 'deny', enabled: true };
  await f.service.updateWorkspace(admin, { revision: 1, kind: 'policy', value: deny });
  assert.ok(!(await f.service.session(employee)).applications.some(row => row.id === 'web-delta'));
  const policy = f.store.getMinCaveWorkspace('minsight-tenant').policies.find(row => row.action === 'deny')!;
  await f.service.updateWorkspace(admin, { revision: 2, kind: 'policy', id: policy.id, value: { ...deny, enabled: false } });
  assert.ok((await f.service.session(employee)).applications.some(row => row.id === 'web-delta'));
  assert.ok(!(await f.service.session(sales)).applications.some(row => row.id === 'web-delta'));
  for (const value of [{ ...allow, appIds: ['unknown'] }, { ...allow, appIds: [] }, { ...allow, department: '外部不存在部门' }, { ...allow, action: 'admin' }])
    await assert.rejects(f.service.updateWorkspace(admin, { revision: 3, kind: 'policy', value }), BadRequestException);
  await f.service.update(admin, 'sales', { role: 'admin', enabled: true });
  await f.service.update(sales, 'admin', { role: 'employee', enabled: true });
  assert.throws(() => f.store.updateMinCaveWorkspace({ actorId: 'admin', tenantKey: 'minsight-tenant', revision: 3, kind: 'policy', value: allow }), ForbiddenException);
});

test('member grants survive repeat login and role changes, intersect department rules, and project only safe device fields', async () => {
  const f = fixture();
  const admin = f.bearer(f.admin.token), employee = f.bearer(f.employee.token);
  await f.service.session(admin);
  await f.service.session(employee, { device: { deviceId: 'private-device', deviceLabel: '真实 Mac', platform: 'darwin', deviceModel: 'private-model', osVersion: 'private-version' } });
  const profile = structuredClone(f.store.getUserCenterUser('employee')!.profile);
  await f.service.update(admin, 'employee', { role: 'employee', enabled: true, appIds: ['web-delta'] });
  assert.deepEqual((await f.service.session(employee)).applications.map(app => app.id), ['web-delta']);
  assert.deepEqual((await f.service.session(employee)).applications.map(app => app.id), ['web-delta']);
  await f.service.update(admin, 'employee', { role: 'admin', enabled: true });
  assert.deepEqual((await f.service.session(employee)).applications.map(app => app.id), ['web-delta']);
  await f.service.updateWorkspace(admin, { revision: 0, kind: 'policy', value: { name: '拒绝 Delta', department: '研发', appIds: ['web-delta'], action: 'deny', enabled: true } });
  assert.deepEqual((await f.service.session(employee)).applications, []);
  const management = await f.service.members(admin);
  const member = management.members.find(row => row.id === 'employee')!;
  assert.deepEqual(member.appIds, ['web-delta']);
  assert.deepEqual(member.effectiveAppIds, []);
  assert.deepEqual(member.devices, [{ name: '真实 Mac', platform: 'darwin' }]);
  assert.ok(!JSON.stringify(management).includes('private-device'));
  assert.ok(!JSON.stringify(management).includes('private-model'));
  assert.ok(!JSON.stringify(management).includes('private-version'));
  for (const appIds of [['unknown'], 'web-hub', [null], Array(201).fill('web-hub')])
    await assert.rejects(f.service.update(admin, 'employee', { role: 'employee', enabled: true, appIds }), BadRequestException);
  await f.service.update(admin, 'employee', { role: 'employee', enabled: true, appIds: [] });
  assert.deepEqual((await f.service.session(employee)).applications, []);
  await assert.rejects(f.service.update(employee, 'employee', { role: 'employee', enabled: true, appIds: ['web-hub'] }), ForbiddenException);
  assert.deepEqual(f.store.getUserCenterUser('employee')!.profile, profile);
  assert.deepEqual((await f.service.session(admin)).applications.map(app => app.id), ['web-hub', 'web-night-all', 'web-compass', 'web-argus', 'web-compass-admin']);
});
