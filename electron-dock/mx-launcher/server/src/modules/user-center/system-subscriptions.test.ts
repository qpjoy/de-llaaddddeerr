import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { hashToken, systemSubscriptionAccessAccountName } from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import type { SiteSlotPlan, SiteSlotWorkerJob, SiteSlotWorkerReport } from '../../types.js';
import { SiteSlotsController } from '../site-slots/site-slots.controller.js';
import { UserCenterController } from './user-center.controller.js';

const OPS_TOKEN = 'system-subscriptions-test-ops-token';

test('system runtime usernames preserve the semantic suffix within the Oversea path limit', () => {
  const username = systemSubscriptionAccessAccountName(`oversea-${'very-long-site-'.repeat(8)}`);
  assert.ok(username.length <= 64);
  assert.ok(username.endsWith('-subscriptions'));
});

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

function seed(options: { tlsFingerprint?: string | null } = {}) {
  const store = new MemoryStore(loadConfig());
  store.upsertSiteSlotSshProfile({
    profileId: 'profile-system-oversea',
    siteId: 'mx-oversea-hk01',
    kind: 'oversea',
    host: '203.0.113.21',
    exportPort: 3434,
    status: 'active',
    requestedBy: 'test'
  });
  store.upsertLauncherNetworkMihomoSite({
    siteId: 'mx-oversea-hk01',
    publicHost: '203.0.113.21',
    serverPorts: '52120',
    tlsFingerprint: options.tlsFingerprint === undefined ? 'AA:BB:CC' : options.tlsFingerprint,
    requestedBy: 'test'
  });
  return { store, controller: new UserCenterController(store) };
}

test('subscriptions is a virtual non-login account and ensure never leaks its token', async () => {
  await withOpsToken(async () => {
    const { store, controller } = seed();
    const beforeUsers = store.listUserCenterUsers();
    const ensured = await controller.ensureSystemSubscriptions(OPS_TOKEN, {
      requestedBy: 'test',
      siteIds: ['mx-oversea-hk01']
    });
    const username = systemSubscriptionAccessAccountName('mx-oversea-hk01');
    const account = store.getSiteSlotAccessAccount('mx-oversea-hk01', username);

    assert.ok(account?.authToken);
    assert.equal(ensured.catalog.account.loginAllowed, false);
    assert.equal(ensured.catalog.account.immutable, true);
    assert.equal(ensured.catalog.subscriptions[0]?.client.mixedPort, 7890);
    assert.equal(ensured.catalog.subscriptions[0]?.trafficPolicy.mode, 'unlimited');
    assert.equal(ensured.catalog.subscriptions[0]?.status, 'pending-sync');
    assert.equal(JSON.stringify(ensured).includes(account!.authToken), false, 'ensure response must remain masked');
    assert.deepEqual(store.listUserCenterUsers(), beforeUsers, 'no login subject is added');
    assert.equal(store.listUserCenterUsers().some((user) => user.account === 'subscriptions'), false);
    await assert.rejects(
      controller.revealSystemSubscription('mx-oversea-hk01', OPS_TOKEN),
      /not ready/,
      'a merely Internal-issued account is not a consumable subscription yet'
    );
  });
});

test('system subscription management rejects anything except the Internal ops token', async () => {
  await withOpsToken(async () => {
    const { controller } = seed();
    await assert.rejects(controller.systemSubscriptions('user-bearer-or-wrong-token'), /valid Internal ops token/);
    await assert.rejects(controller.ensureSystemSubscriptions(undefined, {}), /valid Internal ops token/);
  });
});

test('a direct URL is revealed only after the latest Oversea plan has passing deployment evidence', async () => {
  await withOpsToken(async () => {
    const { store, controller } = seed();
    await controller.ensureSystemSubscriptions(OPS_TOKEN, { siteIds: ['mx-oversea-hk01'] });
    const username = systemSubscriptionAccessAccountName('mx-oversea-hk01');
    const account = store.getSiteSlotAccessAccount('mx-oversea-hk01', username)!;
    const deployedAt = '2099-01-02T00:00:00.000Z';
    const plan = {
      planId: 'slotplan-system-subscriptions',
      siteId: 'mx-oversea-hk01',
      kind: 'oversea',
      host: '203.0.113.21',
      runtime: { oversea: { exportPort: 3435 } },
      deploymentPhases: [{ commands: [
        'HY2_SYSTEM_SUBSCRIPTION_ACCOUNT=mx-oversea-hk01-subscriptions',
        `Verify system-subscription-credential-sha256=${hashToken(account.authToken)}`
      ] }],
      createdAt: '2099-01-01T00:00:00.000Z'
    } as SiteSlotPlan;
    const job = {
      jobId: 'job-system-subscriptions',
      planId: plan.planId,
      mode: 'remote-ssh',
      dryRun: false,
      status: 'passed',
      worker: { kind: 'oversea-site-agent' }
    } as SiteSlotWorkerJob;
    const report = {
      reportId: 'report-system-subscriptions',
      jobId: 'job-system-subscriptions',
      sessionId: 'session-system-subscriptions',
      runId: 'run-system-subscriptions',
      planId: plan.planId,
      siteId: plan.siteId,
      environment: 'test',
      workerId: 'worker-test',
      status: 'passed',
      message: null,
      stepReports: [{
        stepId: 'step-configure-oversea-access',
        sourceId: 'configure-oversea-access.9',
        order: 5,
        status: 'passed',
        exitCode: 0,
        stdout: JSON.stringify({
          mode: 'artifact-push-remote-ssh',
          dryRun: false,
          execution: 'executed',
          executionResult: { exitCode: 0, stdout: '[redacted output]', stderr: null }
        }),
        stderr: '',
        startedAt: deployedAt,
        finishedAt: deployedAt,
        attempt: 1
      }],
      rollbackPlan: null,
      nextActions: [],
      createdAt: deployedAt
    } as SiteSlotWorkerReport;
    store.listSiteSlotPlans = () => [plan];
    store.listSiteSlotWorkerJobs = () => [job];
    store.listSiteSlotWorkerReports = () => [report];

    const described = await controller.systemSubscriptions(OPS_TOKEN);
    const item = described.catalog.subscriptions[0];
    assert.equal(item?.status, 'ready');
    assert.equal(item?.delivery.port, 3435, 'the actually deployed plan port overrides an older profile default');
    assert.match(item?.delivery.urlMasked ?? '', /^http:\/\/subscriptions:\*\*\*@203\.0\.113\.21:3435\//);
    assert.equal(JSON.stringify(described).includes(account.authToken), false, 'GET never exposes clear text');

    const revealed = await controller.revealSystemSubscription('mx-oversea-hk01', OPS_TOKEN);
    assert.match(revealed.subscription.url, /^http:\/\/subscriptions:[^@]+@203\.0\.113\.21:3435\/peer_/);
    assert.ok(revealed.subscription.url.includes(encodeURIComponent(account.authToken)));
    assert.match(revealed.subscription.installCommand, /--instance subscriptions --mixed-port 7890/);
    assert.doesNotMatch(revealed.subscription.installCommand, /7788/);

    store.upsertLauncherNetworkMihomoSite({
      siteId: 'mx-oversea-hk01',
      publicHost: '203.0.113.99',
      requestedBy: 'test-host-change'
    });
    const afterHostChange = await controller.systemSubscriptions(OPS_TOKEN);
    assert.equal(afterHostChange.catalog.subscriptions[0]?.status, 'pending-sync');
    assert.match(afterHostChange.catalog.subscriptions[0]?.statusReason ?? '', /public IP changed/);
    assert.match(
      afterHostChange.catalog.subscriptions[0]?.delivery.urlMasked ?? '',
      /@203\.0\.113\.21:3435\//,
      'even the masked URL remains bound to the host covered by deployment evidence'
    );
    await assert.rejects(
      controller.revealSystemSubscription('mx-oversea-hk01', OPS_TOKEN),
      /not ready/,
      'a changed host must receive fresh deployment evidence before credentials can be revealed'
    );
  });
});

test('a hostname cannot masquerade as the direct-IP channel', async () => {
  await withOpsToken(async () => {
    const { store, controller } = seed();
    store.upsertLauncherNetworkMihomoSite({
      siteId: 'mx-oversea-hk01',
      publicHost: 'oversea.example.com',
      requestedBy: 'test'
    });
    await controller.ensureSystemSubscriptions(OPS_TOKEN, { siteIds: ['mx-oversea-hk01'] });
    const described = await controller.systemSubscriptions(OPS_TOKEN);
    assert.equal(described.catalog.subscriptions[0]?.status, 'blocked');
    assert.match(described.catalog.subscriptions[0]?.statusReason ?? '', /literal Oversea public IP/);
  });
});

test('passing worker evidence is not called ready until Oversea reports its TLS fingerprint', async () => {
  await withOpsToken(async () => {
    const { store, controller } = seed({ tlsFingerprint: null });
    await controller.ensureSystemSubscriptions(OPS_TOKEN, { siteIds: ['mx-oversea-hk01'] });
    const account = store.getSiteSlotAccessAccount(
      'mx-oversea-hk01',
      systemSubscriptionAccessAccountName('mx-oversea-hk01')
    )!;
    const plan = {
      planId: 'slotplan-without-fingerprint',
      siteId: 'mx-oversea-hk01',
      kind: 'oversea',
      runtime: { oversea: { exportPort: 3434 } },
      deploymentPhases: [{ commands: [
        'HY2_SYSTEM_SUBSCRIPTION_ACCOUNT=mx-oversea-hk01-subscriptions',
        `Verify system-subscription-credential-sha256=${hashToken(account.authToken)}`
      ] }],
      createdAt: '2099-01-01T00:00:00.000Z'
    } as SiteSlotPlan;
    store.listSiteSlotPlans = () => [plan];
    store.listSiteSlotWorkerJobs = () => [{
      jobId: 'job-without-fingerprint',
      planId: plan.planId,
      mode: 'remote-ssh',
      dryRun: false,
      status: 'passed',
      worker: { kind: 'oversea-site-agent' }
    } as SiteSlotWorkerJob];
    store.listSiteSlotWorkerReports = () => [{
      jobId: 'job-without-fingerprint',
      planId: plan.planId,
      siteId: plan.siteId,
      status: 'passed',
      stepReports: [{ status: 'passed', sourceId: 'configure-oversea-access.9' }],
      createdAt: '2099-01-02T00:00:00.000Z'
    } as SiteSlotWorkerReport];

    const described = await controller.systemSubscriptions(OPS_TOKEN);
    assert.equal(described.catalog.subscriptions[0]?.status, 'pending-sync');
    assert.match(described.catalog.subscriptions[0]?.statusReason ?? '', /TLS fingerprint/);
  });
});

test('AWX shadow evidence never makes a system subscription ready', async () => {
  await withOpsToken(async () => {
    const { store, controller } = seed();
    await controller.ensureSystemSubscriptions(OPS_TOKEN, { siteIds: ['mx-oversea-hk01'] });
    const account = store.getSiteSlotAccessAccount(
      'mx-oversea-hk01',
      systemSubscriptionAccessAccountName('mx-oversea-hk01')
    )!;
    const plan = {
      planId: 'slotplan-awx-shadow',
      siteId: 'mx-oversea-hk01',
      kind: 'oversea',
      runtime: { oversea: { exportPort: 3434 } },
      deploymentPhases: [{ commands: [
        'HY2_SYSTEM_SUBSCRIPTION_ACCOUNT=mx-oversea-hk01-subscriptions',
        `Verify system-subscription-credential-sha256=${hashToken(account.authToken)}`
      ] }],
      createdAt: '2099-01-01T00:00:00.000Z'
    } as SiteSlotPlan;
    store.listSiteSlotPlans = () => [plan];
    store.listSiteSlotWorkerJobs = () => [{
      jobId: 'job-awx-shadow',
      planId: plan.planId,
      mode: 'awx-shadow',
      dryRun: true,
      status: 'passed',
      worker: { kind: 'awx-runner' }
    } as SiteSlotWorkerJob];
    store.listSiteSlotWorkerReports = () => [{
      jobId: 'job-awx-shadow',
      planId: plan.planId,
      siteId: plan.siteId,
      status: 'passed',
      stepReports: [{
        status: 'passed',
        exitCode: 0,
        sourceId: 'configure-oversea-access.9',
        stdout: JSON.stringify({
          mode: 'artifact-push-remote-ssh',
          dryRun: false,
          execution: 'executed',
          executionResult: { exitCode: 0 }
        })
      }],
      createdAt: '2099-01-02T00:00:00.000Z'
    } as SiteSlotWorkerReport];

    const described = await controller.systemSubscriptions(OPS_TOKEN);
    assert.equal(described.catalog.subscriptions[0]?.status, 'pending-sync');
  });
});

test('site-slot APIs protect system material and reject forged passing reports', async () => {
  await withOpsToken(async () => {
    const { store } = seed();
    const siteSlots = new SiteSlotsController(store);
    const planInput = {
      siteId: 'mx-oversea-hk01',
      kind: 'oversea',
      host: '203.0.113.21',
      rootAccess: true,
      exportPort: 3434,
      createdBy: 'test',
      requestId: 'system-subscription-security-test'
    };
    await assert.rejects(
      siteSlots.createPlan(undefined, planInput),
      /valid Internal ops token/,
      'creating a credential-bearing Oversea plan requires ops authentication'
    );
    const { plan } = await siteSlots.createPlan(OPS_TOKEN, planInput);
    const account = store.getSiteSlotAccessAccount(
      'mx-oversea-hk01',
      systemSubscriptionAccessAccountName('mx-oversea-hk01')
    )!;
    const fullView = await siteSlots.getPlan(plan.planId, OPS_TOKEN);
    const fullJson = JSON.stringify(fullView);
    assert.match(fullJson, /tunnel-state\.json/);
    const encodedState = fullJson.match(/printf \\"%s\\" ([A-Za-z0-9+/=]+) \| base64 -d/)?.[1];
    assert.ok(encodedState, 'the trusted worker view contains the encoded tunnel state');
    assert.ok(Buffer.from(encodedState, 'base64').toString('utf8').includes(account.authToken));

    const publicView = await siteSlots.getPlan(plan.planId, undefined);
    const publicJson = JSON.stringify(publicView);
    assert.equal(publicJson.includes('tunnel-state.json'), false);
    assert.equal(publicJson.includes('system-subscription-credential-sha256='), false);
    assert.equal(publicJson.includes(account.authToken), false);

    await assert.rejects(
      siteSlots.listAccessAccounts('mx-oversea-hk01', undefined),
      /valid Internal ops token/
    );
    await assert.rejects(
      siteSlots.issueAccessAccounts('mx-oversea-hk01', undefined, { issueDefaults: true }),
      /valid Internal ops token/
    );
    await assert.rejects(
      siteSlots.issueAccessAccounts('mx-oversea-hk01', undefined, { issueDefaults: false }),
      /valid Internal ops token/,
      'an empty explicit account list resolves to store defaults and must stay ops-only'
    );
    await assert.rejects(
      siteSlots.issueAccessAccounts('mx-oversea-hk01', undefined, {
        issueDefaults: false,
        accountNames: [account.username.toUpperCase()]
      }),
      /valid Internal ops token/,
      'credential issuance stays ops-only regardless of account-name case'
    );
    for (const alias of [
      account.username.replace('-subscriptions', '--subscriptions'),
      account.username.replace('-subscriptions', '@@subscriptions'),
      `${account.username}${'-'.repeat(100)}`
    ]) {
      await assert.rejects(
        siteSlots.issueAccessAccounts('mx-oversea-hk01', undefined, {
          issueDefaults: false,
          accountNames: [alias]
        }),
        /valid Internal ops token/,
        `canonical alias must not bypass issuance authentication: ${alias}`
      );
    }
    const canonicalAliasResult = await siteSlots.issueAccessAccounts('mx-oversea-hk01', OPS_TOKEN, {
      issueDefaults: false,
      accountNames: [account.username.replace('-subscriptions', '--subscriptions')]
    });
    assert.equal(canonicalAliasResult.accounts[0]?.username, account.username);
    assert.equal(
      canonicalAliasResult.accounts[0]?.authToken,
      account.authToken,
      'canonical aliases must reuse the existing credential instead of rotating the system account'
    );
    await assert.rejects(
      siteSlots.getHysteria2MihomoSubscription('mx-oversea-hk01', account.username),
      /available only through its Oversea direct-IP channel/
    );

    const execution = await store.createSiteSlotExecution({
      planId: plan.planId,
      action: 'apply',
      mode: 'manual',
      confirmApply: true,
      requestedBy: 'test'
    });
    const session = await store.startSiteSlotRunnerSession({
      runId: execution.runId,
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy: 'test'
    });
    const job = await store.createSiteSlotWorkerJob({
      sessionId: session.sessionId,
      workerId: 'worker-system-subscription-security',
      workerKind: 'oversea-site-agent',
      approvalId: 'approval-system-subscription-security',
      requestedBy: 'test'
    });
    await assert.rejects(
      siteSlots.recordWorkerReport(job.jobId, undefined, { status: 'passed', stepReports: [] }),
      /valid Internal ops token/,
      'anonymous callers cannot mark a real worker job passed'
    );
    await assert.rejects(
      siteSlots.recordWorkerReport(job.jobId, OPS_TOKEN, { status: 'passed', stepReports: [] }),
      /explicit successful evidence for every worker step/,
      'report-level passed cannot synthesize missing remote execution evidence'
    );
  });
});
