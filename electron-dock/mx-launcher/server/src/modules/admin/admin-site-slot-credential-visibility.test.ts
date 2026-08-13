import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlatformStore } from '../../store/platform-store.js';
import type { AdminSiteSlotPipeline } from '../../types.js';
import { AdminController } from './admin.controller.js';

const OPS_TOKEN = 'admin-site-slot-credential-test-ops-token';
const SYSTEM_AUTH_TOKEN = 'system-auth-token-must-not-leak';
const SYSTEM_CREDENTIAL_DIGEST = 'system-credential-digest-must-not-leak';
const TUNNEL_STATE_BASE64 = Buffer.from(JSON.stringify({
  accessAccounts: [{ username: 'mx-oversea-hk01-subscriptions', authToken: SYSTEM_AUTH_TOKEN }]
}), 'utf8').toString('base64');

async function withOpsToken<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = OPS_TOKEN;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previous;
  }
}

function sensitivePipeline(): AdminSiteSlotPipeline {
  return {
    summary: {
      planId: 'slotplan-system-credential',
      siteId: 'mx-oversea-hk01',
      kind: 'oversea',
      environment: 'test',
      status: 'ready-for-preflight',
      health: 'ready',
      currentStage: 'plan',
      latestStatus: 'ready-for-preflight',
      latestUpdatedAt: '2099-01-01T00:00:00.000Z',
      counts: {
        executions: 1,
        runnerSessions: 1,
        workerJobs: 1,
        workerReports: 0,
        rollbackExecutions: 0,
        rollbackReports: 0
      },
      warnings: [],
      failureSummary: null,
      domesticWireGuard: null,
      nextActions: [],
      actionHints: []
    },
    plan: {
      planId: 'slotplan-system-credential',
      accessAccounts: [{
        username: 'mx-oversea-hk01-subscriptions',
        authToken: SYSTEM_AUTH_TOKEN
      }],
      systemSubscriptionCredentialDigest: SYSTEM_CREDENTIAL_DIGEST,
      deploymentPhases: [{
        commands: [
          `printf "%s" ${TUNNEL_STATE_BASE64} | base64 -d > /opt/mx/site-agent/tunnel-state.json`,
          `Verify system-subscription-credential-sha256=${SYSTEM_CREDENTIAL_DIGEST}`
        ]
      }]
    },
    executions: [{ steps: [{ command: 'execution-command-must-not-leak' }] }],
    runnerSessions: [{ stepResults: [{ command: 'session-command-must-not-leak' }] }],
    workerJobs: [{ steps: [{ command: 'job-command-must-not-leak' }] }],
    workerReports: [],
    rollbackExecutions: [],
    rollbackReports: [],
    timeline: [{
      entryId: 'timeline-system-credential',
      kind: 'plan',
      status: 'ready-for-preflight',
      at: '2099-01-01T00:00:00.000Z',
      title: 'System subscription plan',
      summary: 'Sensitive timeline fixture',
      warnings: [],
      nextActions: [],
      details: {
        authToken: SYSTEM_AUTH_TOKEN,
        command: 'timeline-command-must-not-leak'
      }
    }]
  } as unknown as AdminSiteSlotPipeline;
}

function controllerWithPipeline(pipeline: AdminSiteSlotPipeline): AdminController {
  const controller = new AdminController({} as PlatformStore);
  (controller as unknown as {
    buildSiteSlotPipelines: () => Promise<AdminSiteSlotPipeline[]>;
  }).buildSiteSlotPipelines = async () => [pipeline];
  return controller;
}

test('admin site-slot pipeline requires a valid ops header to reveal commands or credentials', async () => {
  await withOpsToken(async () => {
    const pipeline = sensitivePipeline();
    const controller = controllerWithPipeline(pipeline);

    for (const opsToken of [undefined, 'wrong-ops-token']) {
      const response = await controller.siteSlotPipeline(
        undefined,
        pipeline.summary.planId,
        undefined,
        undefined,
        opsToken
      );
      const json = JSON.stringify(response);
      assert.equal(json.includes(SYSTEM_AUTH_TOKEN), false);
      assert.equal(json.includes(SYSTEM_CREDENTIAL_DIGEST), false);
      assert.equal(json.includes(TUNNEL_STATE_BASE64), false);
      assert.equal(json.includes('execution-command-must-not-leak'), false);
      assert.equal(json.includes('session-command-must-not-leak'), false);
      assert.equal(json.includes('job-command-must-not-leak'), false);
      assert.equal(json.includes('timeline-command-must-not-leak'), false);
      assert.match(json, /redacted Internal site-slot/);
      assert.equal(response.pipeline.summary.planId, pipeline.summary.planId);
      assert.equal(response.actionPolicy.authMode, 'shadow-rbac-v1');
    }

    const trusted = await controller.siteSlotPipeline(
      undefined,
      pipeline.summary.planId,
      undefined,
      undefined,
      OPS_TOKEN
    );
    const trustedJson = JSON.stringify(trusted);
    assert.ok(trustedJson.includes(SYSTEM_AUTH_TOKEN));
    assert.ok(trustedJson.includes(SYSTEM_CREDENTIAL_DIGEST));
    assert.ok(trustedJson.includes(TUNNEL_STATE_BASE64));
    assert.ok(trustedJson.includes('execution-command-must-not-leak'));
    assert.strictEqual(trusted.pipeline, pipeline, 'the trusted worker contract remains unchanged');
  });
});

test('system subscription admin writes require the dedicated ops header before store access', async () => {
  await withOpsToken(async () => {
    const store = new Proxy({} as PlatformStore, {
      get() {
        throw new Error('store must not be touched before Internal ops authentication');
      }
    });
    const controller = new AdminController(store);

    await assert.rejects(
      controller.shadowSetupOverseaSite(
        `Bearer ${OPS_TOKEN}`,
        'mx-oversea-hk01',
        {},
        undefined,
        undefined,
        undefined
      ),
      /valid Internal ops token/,
      'an Authorization bearer token cannot substitute for x-mx-ops-token'
    );
    await assert.rejects(
      controller.ensureOverseaSite(undefined, 'mx-oversea-hk01', {}, undefined, undefined, 'wrong-ops-token'),
      /valid Internal ops token/
    );
    await assert.rejects(
      controller.archiveOverseaSite(undefined, 'mx-oversea-hk01', {}, undefined, undefined, undefined),
      /valid Internal ops token/
    );
    await assert.rejects(
      controller.runOverseaTerminalCommand(
        undefined,
        'mx-oversea-hk01',
        { command: 'cat users.csv' },
        undefined,
        undefined,
        undefined
      ),
      /valid Internal ops token/,
      'the shadow admin cannot use terminal output as a credential exfiltration bypass'
    );
  });
});

test('admin actionPolicy remains usable while every site-slot mutation requires the dedicated ops header', async () => {
  await withOpsToken(async () => {
    const controller = new AdminController({} as PlatformStore);
    let dispatchCount = 0;
    (controller as unknown as {
      dispatchAdminAction: () => Promise<Record<string, unknown>>;
    }).dispatchAdminAction = async () => {
      dispatchCount += 1;
      return {
        execution: { steps: [{ command: 'action-command-must-not-leak' }] },
        accessAccounts: [{ authToken: SYSTEM_AUTH_TOKEN }]
      };
    };

    const createOverseaPlan = {
      actionId: 'site-slot.plan.create',
      path: '/internal/v1/site-slots/plans',
      body: { kind: 'oversea', siteId: 'mx-oversea-hk01' }
    };
    await assert.rejects(
      controller.executeAction(undefined, createOverseaPlan, undefined, undefined, undefined),
      /valid Internal ops token/
    );
    assert.equal(dispatchCount, 0, 'the managed plan action is rejected before dispatch');

    const ordinaryAction = {
      actionId: 'site-slot.preflight.create',
      path: '/internal/v1/site-slots/plans/slotplan-system-credential/preflight',
      body: {}
    };
    await assert.rejects(
      controller.executeAction(undefined, ordinaryAction, undefined, undefined, undefined),
      /valid Internal ops token/,
      'shadow-admin compatibility cannot create executions or trusted worker evidence'
    );
    assert.equal(dispatchCount, 0);

    const ordinaryResult = await controller.executeAction(
      undefined,
      ordinaryAction,
      undefined,
      undefined,
      OPS_TOKEN
    );
    assert.equal(dispatchCount, 1);
    assert.ok(JSON.stringify(ordinaryResult).includes(SYSTEM_AUTH_TOKEN));

    const trustedResult = await controller.executeAction(
      undefined,
      createOverseaPlan,
      undefined,
      undefined,
      OPS_TOKEN
    );
    assert.equal(dispatchCount, 2);
    assert.ok(JSON.stringify(trustedResult).includes(SYSTEM_AUTH_TOKEN));
  });
});

test('admin Oversea plan materializes the current Internal credentials instead of placeholders', async () => {
  const account = {
    accountId: 'access-system-subscriptions',
    siteId: 'mx-oversea-hk01',
    service: 'hysteria2',
    username: 'mx-oversea-hk01-subscriptions',
    authToken: SYSTEM_AUTH_TOKEN,
    role: 'operator',
    status: 'active',
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z'
  };
  const issued: Array<Record<string, unknown>> = [];
  const store = {
    async issueSiteSlotAccessAccounts(input: Record<string, unknown>) {
      issued.push(input);
      return { accounts: [account] };
    },
    async listSiteSlotAccessAccounts() {
      return [account];
    }
  } as unknown as PlatformStore;
  const controller = new AdminController(store);
  const materialized = await (controller as unknown as {
    withCurrentAccessAccountMaterial: (input: Record<string, unknown>) => Promise<{
      siteId: string;
      accessAccounts: Array<{ username: string; authToken: string }>;
    }>;
  }).withCurrentAccessAccountMaterial({
    kind: 'oversea',
    siteId: 'mx-oversea-hk01',
    host: '203.0.113.10',
    serverPorts: '52120',
    requestId: 'admin-oversea-plan-test'
  });

  assert.equal(issued.length, 1);
  assert.deepEqual(issued[0], {
    siteId: 'mx-oversea-hk01',
    service: 'hysteria2',
    issueDefaults: true,
    publicHost: '203.0.113.10',
    serverPorts: '52120',
    requestedBy: 'admin-controller',
    requestId: 'admin-oversea-plan-test-oversea-access'
  });
  assert.equal(materialized.siteId, 'mx-oversea-hk01');
  assert.deepEqual(materialized.accessAccounts, [{
    username: account.username,
    authToken: SYSTEM_AUTH_TOKEN,
    status: 'active',
    upRate: '50 Mbps',
    downRate: '50 Mbps'
  }]);
});
