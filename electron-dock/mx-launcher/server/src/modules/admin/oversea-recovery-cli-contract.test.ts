import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { LauncherNetworkMihomoSite, SiteSlotSshProfile } from '../../types.js';
import { SiteSlotsController } from '../site-slots/site-slots.controller.js';

const OPS = 'cli-contract-test-ops';
const SITE = 'mx-oversea-cli-contract';
const HOST = '192.0.2.71';
const TLS = Array(32).fill('AB').join(':');

test('CLI fresh-plan validation accepts real ops API plans and preserves current account material', async (t) => {
  const previousOps = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = OPS;
  t.after(() => {
    if (previousOps === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previousOps;
  });
  const source = readFileSync(new URL('../../../../scripts/k8s-oversea-recover.sh', import.meta.url), 'utf8');
  const start = source.indexOf('function summary(');
  const end = source.indexOf('async function verifyEffectiveSshHost(');
  assert.ok(start >= 0 && end > start, 'extract the actual CLI preparation helpers without running kubectl or SSH');

  for (const callback of [null, 'https://internal.example.net/callback/']) {
    const store = new MemoryStore(loadConfig());
    const controller = new SiteSlotsController(store);
    const profile = store.upsertSiteSlotSshProfile({
      profileId: `sshprof_${SITE}`, siteId: SITE, kind: 'oversea', host: HOST,
      sshUser: 'root', sshPort: 2222, identityFile: process.execPath, knownHostsFile: process.execPath,
      hostKeyAlias: SITE, strictHostKeyChecking: 'yes', batchMode: 'yes',
      serverPorts: '51288', exportPort: 3434, workerInternalBaseUrl: 'http://127.0.0.1:18090/',
      overseaCallbackBaseUrl: callback, requestedBy: 'test'
    });
    store.issueSiteSlotAccessAccounts({ siteId: SITE, publicHost: HOST, serverPorts: '51288', tlsFingerprint: TLS, issueDefaults: true });
    const extra = store.issueSiteSlotAccessAccounts({ siteId: SITE, accountNames: ['additional-active', 'additional-paused'] });
    extra.accounts.find(account => account.username === 'additional-paused')!.status = 'paused';
    const accountMaterial = () => store.listSiteSlotAccessAccounts(SITE)
      .map(({ username, authToken, status }) => ({ username, authToken, status }))
      .sort((a, b) => a.username.localeCompare(b.username));
    const before = structuredClone(accountMaterial());
    const registeredSite = structuredClone(store.getLauncherNetworkMihomoSite(SITE))!;
    const requests: Array<{ path: string; body?: unknown }> = [];
    const summaries: string[] = [];
    const api = async (path: string, body?: unknown) => {
      requests.push({ path, body });
      if (path === `/internal/v1/site-slots/${SITE}/access-accounts`) return controller.listAccessAccounts(SITE, OPS);
      if (path === `/internal/v1/config-center/site-slot-ssh-profiles/site/${SITE}`) return { profile: store.getSiteSlotSshProfileForSite(SITE) };
      if (path === '/internal/v1/site-slots/plans') return body === undefined ? controller.listPlans(OPS) : controller.createPlan(OPS, body);
      if (path === `/internal/v1/launcher-network/mihomo/sites/${SITE}`) return { site: store.getLauncherNetworkMihomoSite(SITE) };
      throw new Error(`Unexpected API request: ${path}`);
    };
    const prepare = runInNewContext(`${source.slice(start, end)}\nprepareFreshPlan;`, {
      siteId: SITE, expectedHost: HOST, encodedSite: encodeURIComponent(SITE), requestId: 'cli-contract',
      api, Buffer, URL, process: { env: {} }, console: { log: (value: string) => summaries.push(value) }
    }) as (profile: SiteSlotSshProfile, site: LauncherNetworkMihomoSite) => Promise<{ planId: string; accountSnapshot: string }>;

    const prepared = await prepare(profile, registeredSite);
    const plan = store.getSiteSlotPlan(prepared.planId)!;
    assert.equal(plan.kind, 'oversea');
    assert.equal(plan.host, HOST);
    assert.equal(plan.ssh.profileId, profile.profileId);
    assert.notEqual(plan.status, 'blocked');
    assert.deepEqual(JSON.parse(prepared.accountSnapshot), before.filter(account => account.status === 'active').map(account => [account.username, account.authToken]));
    assert.deepEqual(accountMaterial(), before, 'legacy plan creation keeps all current tokens and account statuses');
    assert.equal(store.getLauncherNetworkMihomoSite(SITE)?.tlsFingerprint, TLS);
    assert.equal(store.getLauncherNetworkMihomoSite(SITE)?.publicHost, HOST);
    assert.equal(requests.filter(request => request.body !== undefined).length, 1, 'only plan creation mutates; no ensure/terminal call');
    assert.equal(summaries.length, 1);
    assert.equal(JSON.parse(summaries[0]).planId, prepared.planId);
    for (const account of before) assert.ok(!summaries.join('').includes(account.authToken), 'CLI summary never exposes account material');
  }
});
