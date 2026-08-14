import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import {
  hashToken,
  siteSlotWorkerReportTlsFingerprint,
  systemSubscriptionAccessAccountName
} from '../../store/domain.js';
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

test('a dedicated non-secret worker step preserves TLS fingerprint evidence beside redacted verification output', () => {
  const fingerprint = '2E:4A:D1:02:CF:A5:9D:5A:F0:13:F4:44:04:65:A6:D3:E3:18:DA:16:15:B3:26:01:72:B8:A3:5B:2E:62:B4:1A';
  const report = {
    reportId: 'slotreport-safe-fingerprint',
    siteId: 'mx-oversea-hk01',
    workerId: 'oversea-site-agent-test',
    message: null,
    stepReports: [{
      sourceId: 'configure-oversea-access.9',
      stdout: '[redacted output]',
      stderr: null
    }, {
      sourceId: 'configure-oversea-access.11',
      stdout: JSON.stringify({
        execution: 'executed',
        executionResult: { stdout: `TLS fingerprint: ${fingerprint}` }
      }),
      stderr: null
    }]
  } as SiteSlotWorkerReport;

  assert.equal(siteSlotWorkerReportTlsFingerprint(report), fingerprint);

  const { store } = seed({ tlsFingerprint: null });
  const before = store.getLauncherNetworkMihomoSite('mx-oversea-hk01');
  (store as unknown as {
    applySiteSlotWorkerReportMihomoEvidence: (input: SiteSlotWorkerReport) => void;
  }).applySiteSlotWorkerReportMihomoEvidence(report);
  const after = store.getLauncherNetworkMihomoSite('mx-oversea-hk01');
  assert.equal(after?.tlsFingerprint, fingerprint);
  assert.equal(after?.publicHost, before?.publicHost);
  assert.equal(after?.serverPorts, before?.serverPorts);
  assert.equal(after?.status, before?.status);
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
  store.upsertSiteSlotDomesticRuntimeConfig({
    siteId: 'domestic-main',
    status: 'active',
    bootstrapProtocol: 'https',
    bootstrapHost: 'h2i.example.com',
    bootstrapPort: 443,
    requestedBy: 'test'
  });
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
    await controller.ensureSystemSubscriptions(OPS_TOKEN, {
      requestedBy: 'test-repeat',
      siteIds: ['mx-oversea-hk01']
    });
    assert.equal(
      store.getSiteSlotAccessAccount('mx-oversea-hk01', username)?.authToken,
      account!.authToken,
      'idempotent Ensure keeps the long-lived system credential stable'
    );
    assert.equal(ensured.catalog.account.loginAllowed, false);
    assert.equal(ensured.catalog.account.immutable, true);
    assert.equal(ensured.catalog.subscriptions[0]?.client.mixedPort, 7788);
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
    const siteSlots = new SiteSlotsController(store);
    await assert.rejects(
      siteSlots.getHysteria2MihomoSubscription('mx-oversea-hk01', username, systemBasic(account!.authToken)),
      /not found/,
      'the HTTPS system YAML route uses the same strict deployment-ready gate'
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

test('archived Oversea evidence is preserved outside the live system subscription catalog', async () => {
  await withOpsToken(async () => {
    const { store, controller } = seed();
    await controller.ensureSystemSubscriptions(OPS_TOKEN, { siteIds: ['mx-oversea-hk01'] });
    const before = await controller.systemSubscriptions(OPS_TOKEN);
    assert.equal(before.catalog.subscriptions.length, 1);

    store.archiveLauncherNetworkMihomoSite({
      siteId: 'mx-oversea-hk01',
      archived: true,
      requestedBy: 'test'
    });

    const after = await controller.systemSubscriptions(OPS_TOKEN);
    assert.equal(after.catalog.subscriptions.length, 0, 'retired sites do not clutter the live URL catalog');
    assert.equal(after.catalog.summary.total, 0);
    assert.equal(
      store.listLauncherNetworkMihomoSites().find((site) => site.siteId === 'mx-oversea-hk01')?.status,
      'archived',
      'the site record and its audit evidence remain restorable'
    );
    await assert.rejects(
      controller.revealSystemSubscription('mx-oversea-hk01', OPS_TOKEN),
      /not found/,
      'an archived channel cannot reveal credentials'
    );
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
    assert.equal(revealed.subscription.urls.directIp, revealed.subscription.url, 'url remains the direct-IP compatibility alias');
    assert.match(
      revealed.subscription.urls.domain ?? '',
      /^https:\/\/subscriptions:[^@]+@h2i\.example\.com\/internal\/v1\/site-slots\/mx-oversea-hk01\/subscriptions\/hysteria2\/mx-oversea-hk01-subscriptions\.yaml$/
    );
    assert.ok(revealed.subscription.urls.domain?.includes(encodeURIComponent(account.authToken)));
    assert.equal('installCommand' in revealed.subscription, false, 'reveal returns only the URL, not a local installer');
    assert.doesNotMatch(JSON.stringify(revealed), /qp-tunnel-cli|--instance|7890/);
    assert.match(revealed.subscription.note, /does not install or manage a local proxy instance/);

    const listDomesticRuntimeConfigs = store.listSiteSlotDomesticRuntimeConfigs.bind(store);
    store.listSiteSlotDomesticRuntimeConfigs = () => {
      throw new Error('simulated Domestic config read failure');
    };
    try {
      const withoutDomain = await controller.revealSystemSubscription('mx-oversea-hk01', OPS_TOKEN);
      assert.equal(withoutDomain.subscription.url, revealed.subscription.url);
      assert.equal(withoutDomain.subscription.urls.directIp, revealed.subscription.urls.directIp);
      assert.equal(withoutDomain.subscription.urls.domain, null);
    } finally {
      store.listSiteSlotDomesticRuntimeConfigs = listDomesticRuntimeConfigs;
    }

    store.upsertSiteSlotDomesticRuntimeConfig({
      siteId: 'domestic-main',
      status: 'active',
      bootstrapProtocol: 'https',
      bootstrapHost: 'replacement-h2i.example.com',
      bootstrapPort: 443,
      requestedBy: 'test-domain-change'
    });
    const afterDomainChange = await controller.revealSystemSubscription('mx-oversea-hk01', OPS_TOKEN);
    assert.equal(afterDomainChange.subscription.url, revealed.subscription.url);
    assert.equal(afterDomainChange.subscription.urls.directIp, revealed.subscription.urls.directIp);
    assert.match(afterDomainChange.subscription.urls.domain ?? '', /@replacement-h2i\.example\.com\//);
    assert.ok(
      afterDomainChange.subscription.urls.domain?.includes(encodeURIComponent(account.authToken)),
      'changing only the domain reuses the same stable system credential'
    );

    const siteSlots = new SiteSlotsController(store);
    let authenticatedPlanReads = 0;
    store.listSiteSlotPlans = () => {
      authenticatedPlanReads += 1;
      return [plan];
    };
    for (const authorization of [
      undefined,
      `Bearer ${account.authToken}`,
      systemBasic('wrong-token'),
      `Basic ${Buffer.from(`operator:${account.authToken}`).toString('base64')}`
    ]) {
      await assert.rejects(
        siteSlots.getHysteria2MihomoSubscription('mx-oversea-hk01', username, authorization),
        /not found/,
        'missing, Bearer and incorrect Basic credentials are indistinguishable'
      );
    }
    assert.equal(authenticatedPlanReads, 0, 'unauthenticated probes do not trigger the deployment-evidence scan');
    const yaml = await siteSlots.getHysteria2MihomoSubscription(
      'mx-oversea-hk01',
      username,
      systemBasic(account.authToken)
    );
    assert.equal(authenticatedPlanReads, 1);
    assert.match(yaml, /^# Generated from the Internal-issued mx-oversea-hk01-subscriptions access account\./);
    assert.match(yaml, /mixed-port: 7788/);
    assert.match(yaml, /down: "50 Mbps"/);
    assert.match(yaml, /up: "50 Mbps"/);
    assert.match(yaml, /name: "peer_mx-oversea-hk01-subscriptions"/);
    assert.match(yaml, /fingerprint: "AA:BB:CC"/);
    assert.match(yaml, /dns:\n(?:      - "[^"]+"\n){4}/);
    assert.match(yaml, /name: PROXY/);
    assert.match(yaml, /MATCH,PROXY/);
    assert.doesNotMatch(yaml, /30 Mbps|name: Oversea|mixed-port: 7890/);

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

function systemBasic(password: string): string {
  return `Basic ${Buffer.from(`subscriptions:${password}`, 'utf8').toString('base64')}`;
}

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
      /not found/,
      'anonymous system YAML requests never reveal whether the account or deployment exists'
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
