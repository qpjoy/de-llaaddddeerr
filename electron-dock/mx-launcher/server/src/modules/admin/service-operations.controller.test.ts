import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceOperationsController } from './service-operations.controller.js';

test('every service-operations route requires the existing ops token before contacting the agent', async () => {
  const saved = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'test-internal-token';
  try {
    const controller = new ServiceOperationsController();
    for (const call of [() => controller.instances(), () => controller.profiles({}), () => controller.plans({}), () => controller.execute({}), () => controller.operations(), () => controller.operation('bad'), () => controller.reconcile({})]) {
      assert.throws(call, /valid Internal ops token/);
    }
  } finally { if (saved === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN; else process.env.MX_INTERNAL_OPS_TOKEN = saved; }
});

test('proxy forwards only to the configured agent and never follows redirects', async () => {
  const environment = { ...process.env }; const originalFetch = globalThis.fetch;
  process.env.MX_INTERNAL_OPS_TOKEN = 'ops'; process.env.MX_SERVICE_OPERATIONS_URL = 'http://127.0.0.1:19290'; process.env.MX_SERVICE_OPERATIONS_TOKEN = 'private-agent-token';
  let requests = 0;
  globalThis.fetch = (async (url, options) => {
    requests++; assert.equal(String(url), 'http://127.0.0.1:19290/v1/plans');
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>)['x-mx-operations-token'], 'private-agent-token');
    return new Response(JSON.stringify({ id: 'fixture-plan' }), { status: 200 });
  }) as typeof fetch;
  try {
    const controller = new ServiceOperationsController();
    assert.deepEqual(await controller.plans({ instanceId: 'ocr', action: 'status' }, 'ops'), { id: 'fixture-plan' });
    assert.throws(() => controller.operation('../../elsewhere', 'ops'), /任务 ID/);
    process.env.MX_SERVICE_OPERATIONS_URL = '';
    await assert.rejects(controller.instances('ops'), /尚未接入|未接入/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; for (const key of ['MX_INTERNAL_OPS_TOKEN', 'MX_SERVICE_OPERATIONS_URL', 'MX_SERVICE_OPERATIONS_TOKEN']) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; } }
});
