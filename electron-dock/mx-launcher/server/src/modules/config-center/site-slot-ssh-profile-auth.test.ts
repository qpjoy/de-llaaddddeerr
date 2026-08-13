import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlatformStore } from '../../store/platform-store.js';
import type { RuntimeConfig } from '../../types.js';
import { ConfigCenterController } from './config-center.controller.js';

test('SSH profile mutation and remote probe require ops auth before store or process access', async () => {
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'ssh-profile-auth-test-token';
  try {
    const store = new Proxy({} as PlatformStore, {
      get() {
        throw new Error('store must not be touched before Internal ops authentication');
      }
    });
    const controller = new ConfigCenterController(store, {} as RuntimeConfig);

    await assert.rejects(
      controller.upsertSiteSlotSshProfile({ host: '198.51.100.77' }, undefined),
      /valid Internal ops token/
    );
    await assert.rejects(
      controller.bootstrapSiteSlotSshProfile({ executeBootstrap: true }, 'wrong-token'),
      /valid Internal ops token/
    );
    await assert.rejects(
      controller.probeSiteSlotSshProfileReadiness('ssh_oversea', { executeReadOnlyProbe: true }, undefined),
      /valid Internal ops token/
    );
  } finally {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previous;
  }
});
