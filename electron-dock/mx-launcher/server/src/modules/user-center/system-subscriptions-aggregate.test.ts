import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../config.js';
import { hashToken, normalizeOverseaBandwidth, systemSubscriptionAccessAccountName } from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import type { OverseaBandwidthPolicy, SiteSlotPlan, SiteSlotWorkerJob, SiteSlotWorkerReport } from '../../types.js';
import { UserCenterController } from './user-center.controller.js';

const OPS = 'aggregate-fixture-ops';
const limited = { mode: 'limited', upMbps: 30, downMbps: 30 } as const;
const unlimited = { ...limited, mode: 'unlimited' } as const;

async function fixture(run: (value: ReturnType<typeof seed>) => Promise<void>) {
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = OPS;
  try { await run(seed()); } finally {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previous;
  }
}

function seed() {
  const store = new MemoryStore(loadConfig());
  const controller = new UserCenterController(store);
  store.upsertSiteSlotDomesticRuntimeConfig({ siteId: 'domestic-main', status: 'active', bootstrapProtocol: 'https', bootstrapHost: 'h2i.example.com', bootstrapPort: 443 });
  const plans: SiteSlotPlan[] = [];
  const jobs: SiteSlotWorkerJob[] = [];
  const reports: SiteSlotWorkerReport[] = [];
  store.listSiteSlotPlans = () => plans;
  store.listSiteSlotWorkerJobs = () => jobs;
  store.listSiteSlotWorkerReports = () => reports;
  function site(siteId: string, bandwidth?: OverseaBandwidthPolicy, deployed = true) {
    store.upsertSiteSlotSshProfile({ profileId: `ssh-${siteId}`, kind: 'oversea', siteId, host: '203.0.113.20', bandwidth, status: 'active' });
    store.upsertLauncherNetworkMihomoSite({ siteId, publicHost: '203.0.113.20', serverPorts: '51289', tlsFingerprint: 'AA:BB:CC' });
    const username = systemSubscriptionAccessAccountName(siteId);
    store.issueSiteSlotAccessAccounts({ siteId, issueDefaults: false, accountNames: [username] });
    const account = store.getSiteSlotAccessAccount(siteId, username)!;
    const plan = {
      planId: `plan-${siteId}`, siteId, kind: 'oversea', host: '203.0.113.20',
      runtime: { oversea: { exportPort: 3435, bandwidth } },
      deploymentPhases: [{ commands: [`HY2_SYSTEM_SUBSCRIPTION_ACCOUNT=${username}`, `Verify system-subscription-credential-sha256=${hashToken(account.authToken)}`] }],
      createdAt: '2099-01-01T00:00:00.000Z'
    } as SiteSlotPlan;
    plans.unshift(plan);
    if (deployed) {
      jobs.push({ jobId: `job-${siteId}`, planId: plan.planId, mode: 'remote-ssh', dryRun: false, status: 'passed', worker: { kind: 'oversea-site-agent' } } as SiteSlotWorkerJob);
      reports.push({ jobId: `job-${siteId}`, planId: plan.planId, status: 'passed', createdAt: '2099-01-02T00:00:00.000Z', stepReports: [{ sourceId: 'configure-oversea-access.9', status: 'passed', exitCode: 0, stdout: JSON.stringify({ mode: 'artifact-push-remote-ssh', dryRun: false, execution: 'executed', executionResult: { exitCode: 0 } }) }] } as SiteSlotWorkerReport);
    }
    return account;
  }
  return { store, controller, site, plans };
}
function token(url: string) { return new URL(url).pathname.split('/').pop()!.replace(/\.yaml$/, ''); }
function proxyBlock(yaml: string, siteId: string) { return yaml.split(`  - name: "${siteId}-hysteria2"`)[1]?.split(/\n(?:  - name:|proxy-groups:)/)[0] ?? ''; }

test('node bandwidth is opt-in, validates rates, and legacy JP plans retain 30 Mbps caps', async () => {
  await fixture(async ({ store }) => {
    assert.deepEqual(normalizeOverseaBandwidth(), limited);
    for (const rate of [0, -1, Infinity, NaN, 100001]) {
      assert.throws(() => normalizeOverseaBandwidth({ ...limited, upMbps: rate }), /Bandwidth/);
    }
    for (const [siteId, bandwidth] of [['mx-oversea-jp01', undefined], ['mx-oversea-xjp01', unlimited]] as const) {
      const profile = store.upsertSiteSlotSshProfile({ profileId: `ssh-${siteId}`, siteId, kind: 'oversea', host: '203.0.113.20', bandwidth });
      const plan = store.createSiteSlotPlan({ siteId, kind: 'oversea', sshProfileId: profile.profileId, host: profile.host, createdBy: 'test' });
      assert.deepEqual(plan.runtime.oversea?.bandwidth, bandwidth ?? limited);
      const commands = plan.deploymentPhases.flatMap(phase => phase.commands).join('\n');
      assert.match(commands, bandwidth ? /HY2_SERVER_BANDWIDTH_MODE=unlimited/ : /HY2_SERVER_BANDWIDTH_MODE=limited/);
      assert.match(commands, bandwidth ? /HY2_SERVER_BANDWIDTH_UP=\\*"\\*"/ : /HY2_SERVER_BANDWIDTH_UP=\\*"30 Mbps\\*"/);
      const edited = store.upsertSiteSlotSshProfile({ profileId: profile.profileId, siteId, kind: 'oversea', host: profile.host, sshPort: 2222 });
      assert.deepEqual(edited.bandwidth, bandwidth ?? limited, 'editing SSH without bandwidth preserves its policy');
    }
  });
});

test('one manual URL adds ready nodes dynamically, preserves JP hints, excludes pending and archived nodes', async () => {
  await fixture(async ({ store, controller, site }) => {
    const jp = site('mx-oversea-jp01');
    const issued = await controller.issueSystemSubscriptionLink(OPS);
    const key = token(issued.link.url);
    assert.equal(new URL(issued.link.url).username, '');
    const first = await controller.publicOverseaSubscription(key);
    assert.match(first, /请先选择节点/);
    assert.match(first, /proxies: \[REJECT\]/);
    assert.match(first, /store-selected: true/);
    assert.doesNotMatch(first, /Oversea-Auto|type: fallback|type: url-test/);
    assert.match(proxyBlock(first, 'mx-oversea-jp01'), /up: "50 Mbps"/);
    assert.match(first, new RegExp(jp.authToken));
    site('mx-oversea-xjp01', unlimited);
    site('mx-oversea-pending', unlimited, false);
    const refreshed = await controller.publicOverseaSubscription(key);
    assert.match(refreshed, /mx-oversea-xjp01-hysteria2/);
    assert.doesNotMatch(refreshed, /mx-oversea-pending/);
    assert.doesNotMatch(proxyBlock(refreshed, 'mx-oversea-xjp01'), /(?:up|down):/);
    assert.equal(proxyBlock(refreshed, 'mx-oversea-jp01'), proxyBlock(first, 'mx-oversea-jp01'));
    const hinted = await controller.publicOverseaSubscription(key, '100');
    assert.match(proxyBlock(hinted, 'mx-oversea-xjp01'), /up: "100 Mbps"/);
    assert.equal(proxyBlock(hinted, 'mx-oversea-jp01'), proxyBlock(first, 'mx-oversea-jp01'));
    for (const invalid of ['nope', '0', '-1', 'Infinity', '100001']) {
      await assert.rejects(controller.publicOverseaSubscription(key, invalid), /bandwidth/);
    }
    store.archiveLauncherNetworkMihomoSite({ siteId: 'mx-oversea-xjp01', archived: true });
    assert.doesNotMatch(await controller.publicOverseaSubscription(key), /mx-oversea-xjp01/);
  });
});

test('saving an unlimited policy does not advertise it before a matching deployment', async () => {
  await fixture(async ({ store, controller, site }) => {
    site('mx-oversea-xjp01', limited);
    store.upsertSiteSlotSshProfile({ profileId: 'ssh-mx-oversea-xjp01', siteId: 'mx-oversea-xjp01', kind: 'oversea', host: '203.0.113.20', bandwidth: unlimited });
    const { catalog } = await controller.systemSubscriptions(OPS);
    assert.deepEqual(catalog.subscriptions[0].bandwidth, { configured: unlimited, deployed: limited, pending: true });
    const issued = await controller.issueSystemSubscriptionLink(OPS);
    assert.match(proxyBlock(await controller.publicOverseaSubscription(token(issued.link.url)), 'mx-oversea-xjp01'), /up: "50 Mbps"/);
  });
});

test('system link issuance, rotation and revoke are isolated from ordinary user links and login', async () => {
  await fixture(async ({ store, controller, site }) => {
    const account = site('mx-oversea-jp01');
    const user = store.createUserCenterUser({ account: 'aggregate-test-user' });
    store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds: ['mx-oversea-jp01'] });
    const login = store.issueUserCenterToken({ subjectKind: 'user', subjectId: user.userId, audience: 'mx-sdk', scopes: ['oversea.subscription.ensure'] });
    const ordinary = store.issueUserOverseaSubscriptionLink(user.userId);
    const original = await controller.publicOverseaSubscription(ordinary.token);
    const users = store.listUserCenterUsers();
    await assert.rejects(controller.issueSystemSubscriptionLink(undefined), /valid Internal ops token/);
    await assert.rejects(controller.revokeSystemSubscriptionLink(login.token), /valid Internal ops token/);
    const a = token((await controller.issueSystemSubscriptionLink(OPS)).link.url);
    assert.equal(store.resolveUserOverseaSubscriptionLink(a), null);
    assert.equal(store.introspectToken({ token: a }).active, false);
    const catalog = JSON.stringify(await controller.systemSubscriptions(OPS));
    assert.ok(!catalog.includes(a) && !catalog.includes(hashToken(a)) && !catalog.includes(account.authToken));
    assert.ok(!JSON.stringify(store.getSystemSubscriptionPublication()).includes(a));
    const b = token((await controller.issueSystemSubscriptionLink(OPS)).link.url);
    await assert.rejects(controller.publicOverseaSubscription(a), /not found/);
    await controller.publicOverseaSubscription(b);
    await controller.revokeSystemSubscriptionLink(OPS);
    await assert.rejects(controller.publicOverseaSubscription(b), /not found/);
    assert.equal((await controller.publicOverseaSubscription(ordinary.token, 'unlimited')).split('\n').slice(1).join('\n'), original.split('\n').slice(1).join('\n'));
    assert.equal(store.introspectToken({ token: login.token }).active, true);
    assert.deepEqual(store.listUserCenterUsers(), users);
    assert.equal(store.getSiteSlotAccessAccount(account.siteId, account.username)?.authToken, account.authToken);
  });
});

test('expired and malformed metadata fail closed; missing HTTPS domain does not invalidate a valid link', async () => {
  await fixture(async ({ store, controller }) => {
    const key = token((await controller.issueSystemSubscriptionLink(OPS)).link.url);
    const publication = store.getSystemSubscriptionPublication();
    store.listSiteSlotDomesticRuntimeConfigs = () => [];
    await assert.rejects(controller.issueSystemSubscriptionLink(OPS), /HTTPS Domestic/);
    assert.deepEqual(store.getSystemSubscriptionPublication(), publication);
    for (const expiresAt of ['2000-01-01T00:00:00.000Z', 'invalid']) {
      store.updateSystemSubscriptionPublication({ link: { ...publication.link!, expiresAt } });
      await assert.rejects(controller.publicOverseaSubscription(key), /not found/);
    }
  });
});
