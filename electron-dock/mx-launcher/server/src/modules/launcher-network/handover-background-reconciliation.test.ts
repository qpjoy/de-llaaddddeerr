import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { LauncherNetworkController } from './launcher-network.controller.js';

const execFileAsync = promisify(execFile);

test('background reconciliation survives startup and timer failures, then retries without leaking errors', async () => {
  // A real child process verifies Node's unhandled-rejection behavior, without
  // installing a process handler that could hide a production process exit.
  const controllerUrl = new URL('./launcher-network.controller.ts', import.meta.url).href;
  const script = `
    import { LauncherNetworkController } from ${JSON.stringify(controllerUrl)};
    let attempts = 0;
    const deadline = setTimeout(() => { throw new Error('reconciliation did not recover'); }, 6000);
    const store = {
      async listLauncherNetworkHandovers() {
        attempts += 1;
        if (attempts <= 2) throw new Error('postgres://sensitive-credential@database/private-query');
        setImmediate(() => {
          controller.onModuleDestroy();
          clearTimeout(deadline);
          console.log(JSON.stringify({ attempts, recovered: true }));
        });
        return [];
      }
    };
    const controller = new LauncherNetworkController(store, {
      launcherNetworkHandoverReconcileMs: 1000,
      launcherNetworkRuntimeSnapshotIntervalMs: 0,
      siteRole: 'internal'
    });
    controller.onModuleInit();
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      timeout: 10_000
    });
  assert.deepEqual(JSON.parse(stdout.trim()), { attempts: 3, recovered: true });
  assert.deepEqual(stderr.trim().split('\n').map((line) => JSON.parse(line)), [
    { event: 'launcher_network.handover.reconcile_failed', retry: 'next-interval' },
    { event: 'launcher_network.handover.reconcile_failed', retry: 'next-interval' }
  ]);
  assert.doesNotMatch(stdout + stderr, /sensitive-credential|private-query|postgres:\/\//);
});

test('direct reconciliation propagates errors and releases its single-flight guard for retry', async () => {
  const failure = new Error('direct reconciliation failure');
  let attempts = 0;
  const store = {
    async listLauncherNetworkHandovers() {
      attempts += 1;
      if (attempts === 1) throw failure;
      return [];
    }
  } as unknown as PlatformStore;
  const controller = new LauncherNetworkController(store, loadConfig());

  await assert.rejects(controller.reconcileExpiredHandovers(), (error) => error === failure);
  await controller.reconcileExpiredHandovers();
  assert.equal(attempts, 2);
});
