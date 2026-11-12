import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../config.js';
import { PostgresStore } from '../../store/postgres.js';
import { createPlatformDataSource } from '../../db/data-source.js';
import { MinCaveService } from './mincave.service.js';
import { MINCAVE_ADMIN } from '../../lib/mincave-access.js';

const databaseUrl = process.env.MX_MINCAVE_TEST_DATABASE_URL;
test(
  'Postgres serializes both role-edit paths and persists admission without replaying bootstrap',
  { skip: !databaseUrl },
  async () => {
    const target = new URL(databaseUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
    assert.ok(target.pathname.includes('mincave_test'), 'Use an isolated mincave_test database');
    const config = {
      ...loadConfig(),
      databaseUrl: databaseUrl!,
      storeDriver: 'postgres' as const,
      environment: `mincave-test-${randomUUID()}`,
      mincaveFeishuTenantKey: 'minsight',
      mincaveInitialAdminUserId: 'admin',
    };
    const store = await PostgresStore.create(config);
    const service = new MinCaveService(config, store);
    try {
      for (const id of ['admin', 'other']) {
        await store.createUserCenterUser({
          userId: id,
          account: id,
          roleIds: ['mx-user', ...(id === 'other' ? [MINCAVE_ADMIN] : [])],
          externalIds: { feishuSubject: `minsight:ou_${id}` },
        });
        const issued = await store.issueUserCenterToken({
          subjectKind: 'user',
          subjectId: id,
          appId: 'mx-h2i',
          authProvider: 'feishu',
          scopes: ['auth.read'],
          verifiedFeishuIdentity: { tenantKey: 'minsight', subject: `minsight:ou_${id}` },
        });
        await service.session(`Bearer ${issued.token}`);
      }
      const draft = { actorId: 'admin', tenantKey: 'minsight', revision: 0, kind: 'application' as const, id: 'web-delta', value: { name: 'Delta', url: 'https://delta.example.test/', category: '中台应用', published: false } };
      const writes = await Promise.allSettled([store.updateMinCaveWorkspace(draft), store.updateMinCaveWorkspace(draft)]);
      assert.equal(writes.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal((await store.getMinCaveWorkspace('minsight')).revision, 1);
      const results = await Promise.allSettled([
        store.updateMinCaveMember({
          actorId: 'admin',
          userId: 'other',
          tenantKey: 'minsight',
          role: 'employee',
          enabled: true,
        }),
        store.createUserCenterUser({ userId: 'admin', account: 'admin', roleIds: ['mx-user'] }),
      ]);
      assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
      assert.equal(
        (await store.listUserCenterUsers()).filter((user) => user.roleIds.includes(MINCAVE_ADMIN))
          .length,
        1,
      );
      assert.equal((await store.listMinCaveMembers()).length, 2);
      const device = { deviceId: 'shared-installation', deviceLabel: 'QA Mac', platform: 'darwin', deviceModel: null, osVersion: null };
      await Promise.all([
        store.recordMinCaveDevice('admin', device),
        store.recordMinCaveDevice('admin', { ...device, deviceId: 'second-installation' }),
        store.recordMinCaveDevice('other', { ...device, deviceLabel: 'Other account' }),
      ]);
      const first = (await store.listMinCaveDevices('admin')).find(row => row.deviceId === device.deviceId)!;
      await store.recordMinCaveDevice('admin', { ...device, deviceLabel: 'Renamed Mac' });
      const devices = await store.listMinCaveDevices('admin');
      assert.equal(devices.length, 2);
      assert.equal(devices.find(row => row.deviceId === device.deviceId)!.firstSeenAt, first.firstSeenAt);
      assert.equal(devices.find(row => row.deviceId === device.deviceId)!.deviceLabel, 'Renamed Mac');
      assert.ok(!JSON.stringify(devices).includes('Other account'));
      assert.equal((await store.listMinCaveDevices('other')).length, 1);
      // Read through a separate store/connection, proving bindings are database-backed.
      const reopened = await PostgresStore.create(config);
      try {
        assert.deepEqual(await reopened.listMinCaveDevices('admin'), devices);
        const workspace = await reopened.getMinCaveWorkspace('minsight');
        assert.equal(workspace.revision, 1);
        assert.equal(workspace.applications.find(row => row.id === 'web-delta')!.published, false);
      } finally {
        reopened.onModuleDestroy();
        await Reflect.get(reopened, 'dataSource').destroy();
      }

    } finally {
      store.onModuleDestroy();
      // The test owns this store and its explicit isolated database connection.
      const source = Reflect.get(store, 'dataSource') as ReturnType<
        typeof createPlatformDataSource
      >;
      await source.query('DELETE FROM mx_platform_records WHERE environment=$1', [
        config.environment,
      ]);
      await source.destroy();
    }
  },
);
