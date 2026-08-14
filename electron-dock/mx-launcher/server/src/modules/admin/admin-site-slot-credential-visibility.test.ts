import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { PlatformStore } from '../../store/platform-store.js';
import type {
  AdminSiteSlotPipeline,
  SiteSlotDomesticWireGuardSecretInput,
  SiteSlotKind,
  SiteSlotPlanInput
} from '../../types.js';
import { generateWireGuardKeyPair } from '../config-center/wireguard-keys.js';
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

test('Oversea Install/Sync and archive never cross the Domestic WG runtime boundary', async (t) => {
  await withOpsToken(async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'mx-oversea-materialize-isolation-'));
    t.after(() => rmSync(outputDir, { recursive: true, force: true }));
    const rawStore = new MemoryStore(loadConfig());
    const relayKeyPair = generateWireGuardKeyPair();
    const internalKeyPair = generateWireGuardKeyPair();
    const domesticPlan = rawStore.createSiteSlotPlan({
      siteId: 'domestic-isolation-test',
      kind: 'domestic',
      host: '198.51.100.20',
      sshUser: 'root',
      rootAccess: true,
      hasDocker: true,
      hasOutboundInternet: true,
      createdBy: 'test'
    });
    const domesticBefore = rawStore.upsertSiteSlotDomesticWireGuardSecret({
      siteId: domesticPlan.siteId,
      publicEndpoint: '198.51.100.20:51280',
      domesticRelayPrivateKey: relayKeyPair.privateKey,
      domesticRelayPublicKey: relayKeyPair.publicKey,
      internalServicePrivateKey: internalKeyPair.privateKey,
      internalServicePublicKey: internalKeyPair.publicKey,
      requestedBy: 'test'
    });
    rawStore.upsertSiteSlotSshProfile({
      profileId: 'sshprof_mx-oversea-hk01_isolation',
      siteId: 'mx-oversea-hk01',
      kind: 'oversea',
      host: '203.0.113.21',
      sshUser: 'root',
      identityFile: process.execPath,
      knownHostsFile: process.execPath,
      hostKeyAlias: 'mx-oversea-hk01',
      serverPorts: '51289',
      exportPort: 3435,
      workerInternalBaseUrl: 'http://127.0.0.1:18090',
      status: 'active',
      requestedBy: 'test'
    });

    const staleAccess = rawStore.issueSiteSlotAccessAccounts({
      siteId: 'mx-oversea-hk01',
      service: 'hysteria2',
      issueDefaults: true,
      publicHost: '203.0.113.21',
      serverPorts: '51289',
      requestedBy: 'test',
      requestId: 'oversea-domestic-isolation-stale-access'
    });
    const stalePlan = rawStore.createSiteSlotPlan({
      siteId: 'mx-oversea-hk01',
      kind: 'oversea',
      sshProfileId: 'sshprof_mx-oversea-hk01_isolation',
      host: '203.0.113.21',
      sshUser: 'root',
      sshPort: 22,
      rootAccess: true,
      hasDocker: true,
      hasOutboundInternet: true,
      serverPorts: '51289',
      exportPort: 3435,
      workerInternalBaseUrl: 'http://127.0.0.1:18090',
      accessAccounts: staleAccess.accounts,
      createdBy: 'test',
      requestId: 'oversea-domestic-isolation-stale-plan'
    });
    const staleConfigure = stalePlan.deploymentPhases.find((phase) => phase.phaseId === 'configure-oversea-access');
    assert.ok(staleConfigure);
    staleConfigure.commands = staleConfigure.commands.map((command) => (
      command.replace('HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT=7788', 'HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT=7890')
    ));
    assert.ok(staleConfigure.commands.some((command) => command.includes('HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT=7890')));

    const createdPlanKinds: SiteSlotKind[] = [];
    const createdPlans: Awaited<ReturnType<MemoryStore['createSiteSlotPlan']>>[] = [];
    let domesticSecretWrites = 0;
    const store = new Proxy(rawStore, {
      get(target, property, receiver) {
        if (property === 'createSiteSlotPlan') {
          return (input: SiteSlotPlanInput) => {
            const kind = input.kind === 'oversea' ? 'oversea' : 'domestic';
            createdPlanKinds.push(kind);
            assert.equal(kind, 'oversea', 'Oversea ensure must not create a Domestic plan');
            const plan = target.createSiteSlotPlan(input);
            createdPlans.push(plan);
            return plan;
          };
        }
        if (property === 'upsertSiteSlotDomesticWireGuardSecret') {
          return (input: SiteSlotDomesticWireGuardSecretInput) => {
            domesticSecretWrites += 1;
            throw new Error(`Oversea action attempted Domestic WG mutation for ${input.siteId ?? 'domestic-main'}`);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as unknown as PlatformStore;
    const controller = new AdminController(store);
    const internals = controller as unknown as {
      buildOverseaOverview: (...args: unknown[]) => Promise<Record<string, unknown>>;
      runRemoteSshWorker: (...args: unknown[]) => Promise<{
        status: 'completed';
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    };
    internals.buildOverseaOverview = async () => ({});
    internals.runRemoteSshWorker = async () => ({
      status: 'completed',
      exitCode: 0,
      stdout: 'mock Oversea remote sync passed',
      stderr: ''
    });

    const previousArtifactDir = process.env.SITE_SLOT_ARTIFACT_BASE_DIR;
    const previousHostRunnerUrl = process.env.MX_INTERNAL_HOST_RUNNER_URL;
    const originalFetch = globalThis.fetch;
    const hostRunnerRequests: string[] = [];
    process.env.SITE_SLOT_ARTIFACT_BASE_DIR = outputDir;
    process.env.MX_INTERNAL_HOST_RUNNER_URL = 'http://127.0.0.1:9';
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      hostRunnerRequests.push(String(args[0]));
      throw new Error('Domestic host runner must not be called by an Oversea action');
    }) as typeof fetch;
    try {
      const ensured = await controller.ensureOverseaSite(
        undefined,
        'mx-oversea-hk01',
        {
          executeRemote: true,
          confirmInstall: true,
          requestedBy: 'test',
          requestId: 'oversea-domestic-isolation'
        },
        undefined,
        undefined,
        OPS_TOKEN
      );
      assert.equal(ensured.ensure.status, 'passed');
      assert.notEqual(ensured.ensure.planId, stalePlan.planId, 'Install/Sync must not replay a stale Oversea plan');
      assert.equal(createdPlans.length, 1);
      assert.ok(
        createdPlans[0].deploymentPhases
          .flatMap((phase) => phase.commands)
          .some((command) => command.includes('HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT=7788')),
        'the fresh Oversea plan must carry the current system-subscription mixed port'
      );

      const resynced = await controller.ensureOverseaSite(
        undefined,
        'mx-oversea-hk01',
        {
          executeRemote: true,
          confirmInstall: true,
          force: true,
          requestedBy: 'test',
          requestId: 'oversea-domestic-isolation-current-plan-resync'
        },
        undefined,
        undefined,
        OPS_TOKEN
      );
      assert.equal(resynced.ensure.status, 'passed');
      assert.equal(resynced.ensure.planId, ensured.ensure.planId, 'a current 7788 Oversea plan remains reusable');
      assert.equal(createdPlans.length, 1, 'resync must not replace an already current Oversea plan');

      const archived = await controller.archiveOverseaSite(
        undefined,
        'mx-oversea-hk01',
        { requestedBy: 'test', requestId: 'oversea-domestic-isolation-archive' },
        undefined,
        undefined,
        OPS_TOKEN
      );
      assert.equal(archived.archive.site.status, 'archived');
      const pausedAccounts = rawStore.listSiteSlotAccessAccounts('mx-oversea-hk01');
      assert.ok(pausedAccounts.length > 0);
      assert.ok(pausedAccounts.every((account) => account.status === 'paused'));

      const refusedSync = await controller.ensureOverseaSite(
        undefined,
        'mx-oversea-hk01',
        {
          executeRemote: true,
          confirmInstall: true,
          requestedBy: 'test',
          requestId: 'oversea-domestic-isolation-refused-archived-sync'
        },
        undefined,
        undefined,
        OPS_TOKEN
      );
      assert.equal(refusedSync.ensure.status, 'blocked');
      assert.match(refusedSync.ensure.blockedReasons.join('\n'), /archived.*Unarchive/i);
      assert.ok(
        rawStore.listSiteSlotAccessAccounts('mx-oversea-hk01').every((account) => account.status === 'paused'),
        'Install/Sync cannot implicitly reactivate an archived site account'
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousArtifactDir === undefined) delete process.env.SITE_SLOT_ARTIFACT_BASE_DIR;
      else process.env.SITE_SLOT_ARTIFACT_BASE_DIR = previousArtifactDir;
      if (previousHostRunnerUrl === undefined) delete process.env.MX_INTERNAL_HOST_RUNNER_URL;
      else process.env.MX_INTERNAL_HOST_RUNNER_URL = previousHostRunnerUrl;
    }

    const domesticAfter = rawStore.getSiteSlotDomesticWireGuardSecret(domesticPlan.siteId);
    assert.deepEqual(createdPlanKinds, ['oversea']);
    assert.equal(existsSync(join(outputDir, 'oversea', 'manifest.json')), true);
    assert.equal(
      existsSync(join(outputDir, 'domestic')),
      false,
      'Oversea Install/Sync must not materialize a Domestic artifact set'
    );
    assert.equal(domesticSecretWrites, 0);
    assert.deepEqual(hostRunnerRequests, [], 'Oversea actions must not probe or apply the Domestic host runner');
    assert.equal(
      rawStore.listSiteSlotPlans().filter((plan) => plan.kind === 'domestic').length,
      1,
      'the pre-existing Domestic plan is the only Domestic plan after Oversea actions'
    );
    assert.deepEqual(domesticAfter?.fingerprints, domesticBefore.fingerprints);
    assert.equal(domesticAfter?.domesticRelayPrivateKey, domesticBefore.domesticRelayPrivateKey);
    assert.equal(domesticAfter?.internalServicePrivateKey, domesticBefore.internalServicePrivateKey);
  });
});

test('Domestic materialize with rotate=false reuses both key pairs and only rebuilds artifacts', async (t) => {
  await withOpsToken(async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'mx-domestic-materialize-isolation-'));
    t.after(() => rmSync(outputDir, { recursive: true, force: true }));
    const store = new MemoryStore(loadConfig());
    const plan = store.createSiteSlotPlan({
      siteId: 'domestic-materialize-test',
      kind: 'domestic',
      host: '198.51.100.30',
      sshUser: 'root',
      rootAccess: true,
      hasDocker: true,
      hasOutboundInternet: true,
      createdBy: 'test'
    });
    const relayKeyPair = generateWireGuardKeyPair();
    const internalKeyPair = generateWireGuardKeyPair();
    const before = store.upsertSiteSlotDomesticWireGuardSecret({
      siteId: plan.siteId,
      publicEndpoint: '198.51.100.30:51280',
      domesticRelayPrivateKey: relayKeyPair.privateKey,
      domesticRelayPublicKey: relayKeyPair.publicKey,
      internalServicePrivateKey: internalKeyPair.privateKey,
      internalServicePublicKey: internalKeyPair.publicKey,
      requestedBy: 'test'
    });

    const previousArtifactDir = process.env.SITE_SLOT_ARTIFACT_BASE_DIR;
    const previousHostRunnerUrl = process.env.MX_INTERNAL_HOST_RUNNER_URL;
    const originalFetch = globalThis.fetch;
    const hostRunnerRequests: string[] = [];
    process.env.SITE_SLOT_ARTIFACT_BASE_DIR = outputDir;
    process.env.MX_INTERNAL_HOST_RUNNER_URL = 'http://127.0.0.1:9';
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      hostRunnerRequests.push(String(args[0]));
      throw new Error('Domestic materialize must not call the host runner apply API');
    }) as typeof fetch;

    let response: Awaited<ReturnType<AdminController['executeAction']>>;
    try {
      response = await new AdminController(store).executeAction(
        undefined,
        {
          actionId: 'site-slot.domestic-wg.materialize',
          path: `/internal/v1/config-center/domestic-wg-secrets/${plan.siteId}/materialize-ready`,
          body: {
            siteId: plan.siteId,
            planId: plan.planId,
            // A stale UI/plan body must not rewrite any live-owned setting
            // during an artifact-only recovery.
            publicEndpoint: '203.0.113.250:59999',
            listenPort: 59999,
            internalDirectEnabled: false,
            internalDirectListenPort: 59998,
            domesticGatewayIp: '10.88.99.1',
            domesticGatewayCidr: '10.88.99.0/24',
            productRelayCidrs: ['10.99.0.0/16'],
            userRelayCidr: '10.99.0.0/16',
            internalServiceIp: '10.88.99.88',
            internalServiceCidr: '10.88.99.0/24',
            guestRelayCidr: '10.100.0.0/16',
            rotateRelayKey: false,
            rotateInternalServiceKey: false,
            confirmRotate: false,
            preserveExistingKeys: true,
            requestedBy: 'test',
            requestId: 'domestic-materialize-no-rotate'
          }
        },
        undefined,
        undefined,
        OPS_TOKEN
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousArtifactDir === undefined) delete process.env.SITE_SLOT_ARTIFACT_BASE_DIR;
      else process.env.SITE_SLOT_ARTIFACT_BASE_DIR = previousArtifactDir;
      if (previousHostRunnerUrl === undefined) delete process.env.MX_INTERNAL_HOST_RUNNER_URL;
      else process.env.MX_INTERNAL_HOST_RUNNER_URL = previousHostRunnerUrl;
    }

    const result = (response as unknown as {
      domesticWgMaterialize: {
        status: string;
        execution: string;
        artifact: { status: string } | null;
        rotate: Record<string, boolean>;
        generated: Record<string, boolean>;
        clientRefresh: { changed: boolean };
      };
    }).domesticWgMaterialize;
    const after = store.getSiteSlotDomesticWireGuardSecret(plan.siteId);
    assert.equal(result.status, 'passed');
    assert.equal(result.execution, 'completed');
    assert.equal(result.artifact?.status, 'ready');
    assert.deepEqual(result.rotate, {
      domesticRelayKeyPair: false,
      internalServiceKeyPair: false
    });
    assert.deepEqual(result.generated, {
      domesticRelayKeyPair: false,
      internalServiceKeyPair: false
    });
    assert.equal(result.clientRefresh.changed, false);
    assert.deepEqual(after?.fingerprints, before.fingerprints);
    assert.equal(after?.domesticRelayPrivateKey, relayKeyPair.privateKey);
    assert.equal(after?.domesticRelayPublicKey, relayKeyPair.publicKey);
    assert.equal(after?.internalServicePrivateKey, internalKeyPair.privateKey);
    assert.equal(after?.internalServicePublicKey, internalKeyPair.publicKey);
    assert.equal(after?.publicEndpoint, before.publicEndpoint);
    assert.equal(after?.listenPort, before.listenPort);
    assert.equal(after?.internalDirectEnabled, before.internalDirectEnabled);
    assert.equal(after?.internalDirectListenPort, before.internalDirectListenPort);
    assert.equal(after?.domesticGatewayIp, before.domesticGatewayIp);
    assert.equal(after?.domesticGatewayCidr, before.domesticGatewayCidr);
    assert.deepEqual(after?.productRelayCidrs, before.productRelayCidrs);
    assert.equal(after?.userRelayCidr, before.userRelayCidr);
    assert.equal(after?.internalServiceIp, before.internalServiceIp);
    assert.equal(after?.internalServiceCidr, before.internalServiceCidr);
    assert.equal(after?.guestRelayCidr, before.guestRelayCidr);
    assert.deepEqual(hostRunnerRequests, [], 'materialize must not call status/apply on the host runner');
    assert.equal(store.listSiteSlotExecutions(plan.planId).length, 0, 'materialize must not create an apply execution');
  });
});

test('artifact-only Domestic refresh fails closed before generating missing or replacement keys', async () => {
  await withOpsToken(async () => {
    const store = new MemoryStore(loadConfig());
    const plan = store.createSiteSlotPlan({
      siteId: 'domestic-artifact-refresh-incomplete',
      kind: 'domestic',
      host: '198.51.100.40',
      sshUser: 'root',
      rootAccess: true,
      hasDocker: true,
      hasOutboundInternet: true,
      createdBy: 'test'
    });
    const before = store.upsertSiteSlotDomesticWireGuardSecret({
      siteId: plan.siteId,
      publicEndpoint: '198.51.100.40:51280',
      domesticRelayPrivateKey: null,
      domesticRelayPublicKey: null,
      internalServicePrivateKey: null,
      internalServicePublicKey: null,
      requestedBy: 'test'
    });
    const response = await new AdminController(store).executeAction(
      undefined,
      {
        actionId: 'site-slot.domestic-wg.materialize',
        path: `/internal/v1/config-center/domestic-wg-secrets/${plan.siteId}/materialize-ready`,
        body: {
          siteId: plan.siteId,
          planId: plan.planId,
          preserveExistingKeys: true,
          rotateRelayKey: true,
          rotateInternalServiceKey: true,
          confirmRotate: true,
          requestedBy: 'test'
        }
      },
      undefined,
      undefined,
      OPS_TOKEN
    );
    const result = (response as unknown as {
      domesticWgMaterialize: {
        status: string;
        generated: Record<string, boolean>;
        blockedReasons: string[];
      };
    }).domesticWgMaterialize;
    const after = store.getSiteSlotDomesticWireGuardSecret(plan.siteId);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.generated, {
      domesticRelayKeyPair: false,
      internalServiceKeyPair: false
    });
    assert.match(result.blockedReasons.join('\n'), /cannot rotate|key pair is incomplete/);
    assert.equal(after?.updatedAt, before.updatedAt, 'a blocked artifact refresh does not write the secret');
    assert.equal(after?.domesticRelayPrivateKey, null);
    assert.equal(after?.internalServicePrivateKey, null);
  });
});
