import assert from 'node:assert/strict';
import test from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PostgresStore } from '../../store/postgres.js';
import { PlatformController } from './platform.controller.js';

const config = loadConfig();

test('readiness waits for the store check without collecting platform counters', async () => {
  let releaseCheck!: () => void;
  let checks = 0;
  const store = {
    ready: () => {
      checks += 1;
      return new Promise<void>((resolve) => { releaseCheck = resolve; });
    },
    overview: () => { throw new Error('readiness must not run dashboard queries'); }
  } as unknown as PlatformStore;
  const controller = new PlatformController(store, config);
  let completed = false;
  const response = controller.readyz().then((result) => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(checks, 1);
  assert.equal(completed, false);
  releaseCheck();
  assert.deepEqual(await response, {
    ok: true,
    environment: config.environment,
    siteId: config.siteId,
    siteRole: config.siteRole,
    enabledModules: config.enabledModules,
    storeDriver: config.storeDriver,
    publicBaseUrl: config.publicBaseUrl,
    internalBaseUrl: config.internalBaseUrl
  });
});

test('database failures fail readiness with HTTP 503 while liveness stays independent', async () => {
  const store = {
    ready: async () => { throw new Error('database connection details'); }
  } as unknown as PlatformStore;
  const controller = new PlatformController(store, config);
  assert.equal(controller.healthz().ok, true);
  await assert.rejects(controller.readyz(), (error: unknown) => {
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.getStatus(), 503);
    assert.equal(error.message, 'Platform store is unavailable');
    return true;
  });
});

test('Postgres readiness uses one lightweight query and propagates query failures', async () => {
  const queries: string[] = [];
  let failure: Error | undefined;
  const store = {
    dataSource: {
      query: async (sql: string) => {
        queries.push(sql);
        if (failure) throw failure;
        return [{ '?column?': 1 }];
      }
    }
  } as unknown as PostgresStore;
  await PostgresStore.prototype.ready.call(store);
  assert.deepEqual(queries, ['SELECT 1']);
  failure = new Error('database unavailable');
  await assert.rejects(PostgresStore.prototype.ready.call(store), (error) => error === failure);
});

test('memory store readiness needs no database and the overview endpoint retains counters', async () => {
  const memoryConfig = { ...config, storeDriver: 'memory' as const };
  const store = new MemoryStore(memoryConfig);
  const controller = new PlatformController(store, memoryConfig);
  assert.equal((await controller.readyz()).ok, true);
  const overview = await controller.overview();
  assert.equal(typeof overview.auditEvents, 'number');
  assert.equal(typeof overview.appCenterApps, 'number');
});

test('a previously ready API stays in rotation while one database check is slow', async () => {
  let checks = 0;
  let releaseSlow!: () => void;
  const store = {
    ready: () => {
      checks += 1;
      if (checks === 1) return Promise.resolve();
      return new Promise<void>((resolve) => { releaseSlow = resolve; });
    }
  } as unknown as PlatformStore;
  const controller = new PlatformController(store, config);
  assert.equal((await controller.readyz()).ok, true);
  const slow = await controller.readyz();
  assert.equal(slow.ok, true);
  assert.equal((slow as { degraded?: boolean }).degraded, true);
  assert.equal(checks, 2);
  releaseSlow();
});
