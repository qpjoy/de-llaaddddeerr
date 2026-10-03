import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { loadConfig } from '../../config.js';
import { createPlatformDataSource } from '../../db/data-source.js';
import { MemoryStore } from '../../store/memory.js';
import { PostgresStore } from '../../store/postgres.js';
import type { PlatformStore } from '../../store/platform-store.js';
import type { RuntimeConfig } from '../../types.js';
import { SdkGatewayController } from '../sdk-gateway/sdk-gateway.controller.js';
import type { FeishuAuthService } from '../sdk-gateway/feishu-auth.service.js';
import { LauncherNetworkController } from './launcher-network.controller.js';

// Run the same authorization scenario against production persistence and memory.
for (const driver of ['memory', 'postgres'] as const) {
  const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;
  test(`${driver}: explicit H2I ban overrides public/admin/grants and old sessions; Luopan remains usable`,
    { skip: driver === 'postgres' && !databaseUrl }, async () => {
      const environment = `app-deny-${randomUUID()}`;
      const config: RuntimeConfig = { ...loadConfig(), environment, storeDriver: driver, ...(databaseUrl ? { databaseUrl } : {}) };
      if (driver === 'postgres') {
        const target = new URL(databaseUrl!);
        assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.includes('sso_test'));
      }
      const db = driver === 'postgres' ? createPlatformDataSource(config) : null;
      if (db) { await db.initialize(); await db.runMigrations(); }
      const store: PlatformStore = driver === 'postgres' ? await PostgresStore.create(config) : new MemoryStore(config);
      try {
        const sdk = new SdkGatewayController(store, {} as FeishuAuthService);
        const network = new LauncherNetworkController(store, config);
        const user = await store.createUserCenterUser({
          account: 'BanTest', password: 'BanPassword123!', roleIds: ['mx-admin'], allowedAppIds: ['mx-h2i', 'luopan']
        });
        const login = (appId?: string, password = 'BanPassword123!') => sdk.token({
          grant_type: 'password', username: 'BanTest', password, appId, audience: 'mx-sdk', scope: 'auth.read'
        }, '192.0.2.40');
        const generic = (await login()).token.access_token;
        const scoped = (await login('mx-h2i')).token.access_token;
        const luopanToken = (await login('luopan')).token.access_token;
        const input = (productId: string) => ({
          appId: productId, productId, mode: 'standalone', identityKind: 'user', userId: user.userId,
          installId: `inst_${productId}`, deviceId: `dev_${productId}`, publicKey: `pub_${productId}`, leaseProfile: 'employee'
        });
        const h2i = (await network.enrollLease(`Bearer ${generic}`, input('mx-h2i'), undefined, undefined, '192.0.2.40')).lease;
        const luopan = (await network.enrollLease(`Bearer ${luopanToken}`, input('luopan'), undefined, undefined, '192.0.2.40')).lease;
        await store.createUserCenterUser({ userId: user.userId, deniedAppIds: ['mx-h2i'] });
        assert.equal((await store.evaluateAppCenterAccess({ appId: 'mx-h2i', userId: user.userId })).allowed, false);
        await assert.rejects(login('mx-h2i'), denied);
        await assert.rejects(login('mx-h2i', 'wrong'), (error: any) => error.getStatus() === 401, 'authenticate before disclosing ban');
        assert.equal((await store.introspectToken({ token: scoped })).active, false);
        assert.equal((await store.introspectToken({ token: scoped })).reason, 'app_access_denied');
        assert.equal((await store.introspectToken({ token: generic })).active, true, 'legacy shared identity stays usable in other apps');
        assert.equal((await store.introspectToken({ token: luopanToken })).active, true);
        await login(); // Hub and legacy callers can still authenticate globally.
        await login('luopan');
        for (const token of [generic, luopanToken]) {
          await assert.rejects(network.enrollLease(`Bearer ${token}`, input('mx-h2i'), h2i.capability), denied);
          await assert.rejects(network.enrollLease(`Bearer ${token}`, { ...input('mx-h2i'), installId: 'new', deviceId: 'new', publicKey: 'new' }), denied);
        }
        for (const appId of ['mx-h2i', 'luopan']) {
          await assert.rejects(network.createSnapshot(`Bearer ${generic}`, {
            leaseId: h2i.leaseId, appId, userId: user.userId, leaseProfile: 'employee'
          }, h2i.capability), denied, 'snapshot checks actual lease product even with spoofed appId');
        }
        for (const method of ['syncDomesticPeer', 'syncInternalDirectPeer'] as const) {
          await assert.rejects(network[method](h2i.leaseId, undefined, h2i.capability, undefined, undefined, {}), denied,
            'saved capability cannot bypass the ban');
        }
        await assert.rejects(async () => store.enrollLauncherNetworkLease(input('mx-h2i')), /禁止访问/);
        await assert.rejects(async () => store.createLauncherNetworkSnapshot({
          leaseId: h2i.leaseId, appId: 'mx-h2i', userId: user.userId, leaseProfile: 'employee'
        }), /禁止访问/);
        assert.equal((await network.enrollLease(`Bearer ${luopanToken}`, input('luopan'), luopan.capability)).lease.status, 'active');
        assert.equal(await store.getLauncherProductUserAccess('mx-h2i', user.userId), null, 'no projected network ban record');
        assert.equal((await store.getUserCenterUserIdentity(user.userId))?.status, 'active');
        // Cleanup stays possible; unban never clears an independent network policy.
        await store.releaseLauncherNetworkLease(h2i.leaseId);
        await store.setLauncherProductUserAccess({ productId: 'mx-h2i', userId: user.userId, blocked: true });
        await store.createUserCenterUser({ userId: user.userId, allowedAppIds: ['mx-h2i', 'luopan'], deniedAppIds: [], replaceAppAccess: true });
        await login('mx-h2i');
        await assert.rejects(network.enrollLease(`Bearer ${generic}`, input('mx-h2i')), (error: any) =>
          error.getStatus() === 403 && error.getResponse().code === 'launcher_product_user_access_denied');
        await store.setLauncherProductUserAccess({ productId: 'mx-h2i', userId: user.userId, blocked: false });
        assert.equal((await network.enrollLease(`Bearer ${generic}`, input('mx-h2i'))).lease.status, 'active');
      } finally {
        if (driver === 'postgres') await (store as unknown as { dataSource: DataSource }).dataSource.destroy();
        if (db) {
          await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]);
          await db.destroy();
        }
      }
    });
}

function denied(error: any): boolean {
  assert.equal(error.getStatus(), 403);
  assert.equal(error.getResponse().code, 'app_access_denied');
  assert.equal(error.getResponse().appId, 'mx-h2i');
  return true;
}
