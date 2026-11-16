import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { PlatformStore } from '../../store/platform-store.js';
import type { SiteSlotAccessAccount, SiteSlotPlanInput, SiteSlotSshProfile } from '../../types.js';
import { AdminController } from './admin.controller.js';
import type { OverseaRecoveryLive } from './oversea-recovery.js';

const OPS = 'recovery-test-ops';
const SITE = 'mx-oversea-recovery-test';
const HOST = '192.0.2.21';
const OLD_HOST = '192.0.2.20';
const TLS = Array(32).fill('AB').join(':');
const NEW_TLS = Array(32).fill('CD').join(':');

function live(healthy: boolean, changes: Partial<OverseaRecoveryLive> = {}): OverseaRecoveryLive {
  return {
    checkedAt: '2026-11-16T00:00:00Z', ssh: true, dockerInstalled: healthy, docker: healthy,
    compose: healthy, stack: healthy, hysteria: healthy, outlet: healthy, health: healthy,
    advertisedHost: healthy ? HOST : null, tlsFingerprint: healthy ? TLS : null,
    tlsMatchesRuntime: healthy, accountsMatch: healthy, portsMatch: healthy, healthy, ...changes
  };
}

async function withOps(run: () => Promise<void>) {
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  const previousGate = process.env.SITE_SLOT_WORKER_REMOTE_SSH;
  process.env.MX_INTERNAL_OPS_TOKEN = OPS;
  delete process.env.SITE_SLOT_WORKER_REMOTE_SSH;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previous;
    if (previousGate === undefined) delete process.env.SITE_SLOT_WORKER_REMOTE_SSH;
    else process.env.SITE_SLOT_WORKER_REMOTE_SSH = previousGate;
  }
}

function fixture(publicHost = HOST) {
  const raw = new MemoryStore(loadConfig());
  raw.upsertSiteSlotSshProfile({
    profileId: `sshprof_${SITE}`, siteId: SITE, kind: 'oversea', host: HOST, sshUser: 'root', sshPort: 22,
    identityFile: process.execPath, knownHostsFile: process.execPath, hostKeyAlias: SITE,
    serverPorts: '51288', exportPort: 3434, workerInternalBaseUrl: 'http://127.0.0.1:18090',
    strictHostKeyChecking: 'yes', batchMode: 'yes', requestedBy: 'test'
  });
  raw.issueSiteSlotAccessAccounts({ siteId: SITE, publicHost, serverPorts: '51288', tlsFingerprint: TLS, issueDefaults: true });
  const mutations: string[] = [];
  const createdPlanInputs: SiteSlotPlanInput[] = [];
  const store = new Proxy(raw, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const method = String(name);
        if (/^(create|upsert|issue|start|record|archive)/.test(method)) {
          mutations.push(method);
          assert.doesNotMatch(method, /Domestic|WireGuard/, 'recovery must not touch Domestic or WG state');
          if (method === 'createSiteSlotPlan') {
            assert.equal((args[0] as SiteSlotPlanInput).kind, 'oversea');
            createdPlanInputs.push(structuredClone(args[0] as SiteSlotPlanInput));
          }
        }
        return value.apply(target, args);
      };
    }
  }) as unknown as PlatformStore;
  const controller = new AdminController(store);
  const internal = controller as unknown as {
    probeOverseaRecovery: (profile: SiteSlotSshProfile, accounts: SiteSlotAccessAccount[]) => Promise<OverseaRecoveryLive>;
    buildOverseaOverview: () => Promise<Record<string, unknown>>;
    materializeSiteSlotArtifactSet: (kind: string) => Promise<Record<string, unknown>>;
    runRemoteSshWorker: () => Promise<{ status: string; exitCode: number; stdout: string; stderr: string }>;
  };
  internal.probeOverseaRecovery = async () => live(false);
  internal.buildOverseaOverview = async () => ({});
  internal.materializeSiteSlotArtifactSet = async (kind) => {
    assert.equal(kind, 'oversea');
    return { blockedReasons: [], manifest: null, execution: 'materialized', mode: 'test' };
  };
  internal.runRemoteSshWorker = async () => ({ status: 'completed', exitCode: 0, stdout: '', stderr: '' });
  const run = (body: Record<string, unknown> = {}) => controller.recoverOverseaSite(undefined, SITE, { expectedHost: HOST, ...body }, undefined, undefined, OPS);
  return { raw, controller, internal, mutations, createdPlanInputs, run };
}

test('preview and healthy recovery perform no mutations, issuance or deployment', async () => withOps(async () => {
  const f = fixture();
  const before = structuredClone(f.raw.listSiteSlotAccessAccounts(SITE));
  const preview = await f.run();
  assert.equal(preview.recovery.status, 'ready');
  assert.equal(preview.recovery.changed, false);
  assert.deepEqual(f.mutations, []);
  f.internal.probeOverseaRecovery = async () => live(true);
  const healthy = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(healthy.recovery.status, 'healthy');
  assert.equal(healthy.recovery.changed, false);
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.raw.listSiteSlotAccessAccounts(SITE), before);
}));

test('SSH failures, mismatched targets, missing confirmation and disabled env gate fail before writes', async () => withOps(async () => {
  const f = fixture();
  f.internal.probeOverseaRecovery = async () => live(false, { ssh: false, category: 'auth' });
  const failed = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(failed.recovery.status, 'blocked');
  assert.deepEqual(failed.recovery.nextActions, ['bootstrap-existing-key']);
  assert.equal((await f.run({ expectedHost: OLD_HOST })).recovery.status, 'blocked');
  assert.equal((await f.run({ executeRecovery: true })).recovery.status, 'blocked');
  process.env.SITE_SLOT_WORKER_REMOTE_SSH = '0';
  assert.equal((await f.run()).recovery.status, 'blocked');
  assert.deepEqual(f.mutations, []);
}));

test('existing Docker without Compose is blocked instead of invoking the engine installer', async () => withOps(async () => {
  const f = fixture();
  f.internal.probeOverseaRecovery = async () => live(false, { dockerInstalled: true, docker: true });
  const result = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(result.recovery.status, 'blocked');
  assert.match(result.recovery.blockedReasons.join(' '), /Compose.*avoid upgrading/);
  assert.deepEqual(f.mutations, []);
}));

test('recovery uses fresh plan/current account tokens and publishes moved host only after final health', async () => withOps(async () => {
  const f = fixture(OLD_HOST);
  const accountsBefore = structuredClone(f.raw.listSiteSlotAccessAccounts(SITE));
  const stale = f.raw.createSiteSlotPlan({
    siteId: SITE, kind: 'oversea', sshProfileId: `sshprof_${SITE}`, host: HOST, sshUser: 'root', sshPort: 22,
    rootAccess: true, hasDocker: true, hasOutboundInternet: true, serverPorts: '51288', exportPort: 3434,
    workerInternalBaseUrl: 'http://127.0.0.1:18090',
    accessAccounts: accountsBefore.map((account) => ({ username: account.username, authToken: 'stale-token' }))
  });
  let probes = 0;
  f.internal.probeOverseaRecovery = async () => {
    assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.publicHost, OLD_HOST, 'new address must not be published during either probe');
    probes += 1;
    return probes === 1 ? live(false) : live(true, { tlsFingerprint: NEW_TLS });
  };
  f.internal.runRemoteSshWorker = async () => {
    assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.publicHost, OLD_HOST);
    return { status: 'completed', exitCode: 0, stdout: 'private-worker-output', stderr: '' };
  };
  const response = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(response.recovery.status, 'recovered');
  assert.notEqual(response.recovery.planId, stale.planId, 'recovery never reuses credential-bearing historical plans');
  const plan = f.raw.getSiteSlotPlan(response.recovery.planId!);
  assert.equal(plan?.host, HOST);
  assert.doesNotMatch(JSON.stringify(plan), /stale-token/);
  assert.deepEqual(f.createdPlanInputs[0].accessAccounts?.map(({ username, authToken }) => ({ username, authToken })),
    accountsBefore.map(({ username, authToken }) => ({ username, authToken })));
  assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.publicHost, HOST);
  assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.tlsFingerprint, NEW_TLS);
  assert.deepEqual(f.raw.listSiteSlotAccessAccounts(SITE), accountsBefore);
  assert.ok(!f.mutations.includes('issueSiteSlotAccessAccounts'));
  assert.ok(response.recovery.steps.some((step) => step.stepId === 'final-live-check' && step.status === 'passed'));
  assert.doesNotMatch(JSON.stringify(response), /private-worker-output|authToken|stale-token/);
}));

test('failed recovery preserves published host/ports and restores the previous TLS fingerprint', async () => withOps(async () => {
  const f = fixture(OLD_HOST);
  f.raw.upsertSiteSlotSshProfile({ ...f.raw.getSiteSlotSshProfile(`sshprof_${SITE}`)!, serverPorts: '51289' });
  const before = structuredClone(f.raw.getLauncherNetworkMihomoSite(SITE)!);
  f.internal.runRemoteSshWorker = async () => {
    assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.publicHost, OLD_HOST);
    assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.serverPorts, '51288');
    f.raw.upsertLauncherNetworkMihomoSite({ siteId: SITE, tlsFingerprint: NEW_TLS });
    return { status: 'failed', exitCode: 1, stdout: 'private-token-output', stderr: 'private-token-error' };
  };
  const response = await f.run({ executeRecovery: true, confirmRecovery: true });
  const after = f.raw.getLauncherNetworkMihomoSite(SITE)!;
  assert.equal(response.recovery.status, 'failed');
  assert.equal(after.publicHost, before.publicHost);
  assert.equal(after.serverPorts, before.serverPorts);
  assert.equal(after.tlsFingerprint, before.tlsFingerprint);
  assert.doesNotMatch(JSON.stringify(response), /private-token/);
}));

test('metadata-only repair avoids reinstalling an already healthy remote', async () => withOps(async () => {
  const f = fixture(OLD_HOST);
  f.internal.probeOverseaRecovery = async () => live(true);
  const response = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(response.recovery.status, 'recovered');
  assert.deepEqual(f.mutations, ['upsertLauncherNetworkMihomoSite']);
  assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.publicHost, HOST);
}));

test('an unchanged Elastic IP with an old successful report still recovers a replacement empty VM', async () => withOps(async () => {
  const f = fixture();
  const previous = await f.controller.ensureOverseaSite(undefined, SITE, {}, undefined, undefined, OPS);
  const job = f.raw.getSiteSlotWorkerJob(previous.ensure.jobId!)!;
  assert.ok(job);
  const oldReport = f.raw.recordSiteSlotWorkerReport({
    jobId: job.jobId, status: 'passed', stepReports: [{
      stepId: job.steps[0].stepId, status: 'passed', exitCode: 0,
      stdout: JSON.stringify({ mode: 'artifact-push-remote-ssh', execution: 'executed' })
    }]
  });
  assert.equal(oldReport.status, 'passed');
  f.mutations.length = 0;
  let probes = 0;
  f.internal.probeOverseaRecovery = async () => ++probes === 1 ? live(false) : live(true);
  const result = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(result.recovery.status, 'recovered');
  assert.notEqual(result.recovery.planId, previous.ensure.planId);
  assert.equal(f.raw.getSiteSlotPlan(result.recovery.planId!)?.host, HOST);
  assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.publicHost, HOST);
  assert.ok(!f.mutations.includes('issueSiteSlotAccessAccounts'));
}));

test('ordinary Install/Sync rebuilds a historical plan when the same profile moves IP', async () => withOps(async () => {
  const f = fixture(OLD_HOST);
  const accounts = f.raw.listSiteSlotAccessAccounts(SITE);
  const stale = f.raw.createSiteSlotPlan({
    siteId: SITE, kind: 'oversea', sshProfileId: `sshprof_${SITE}`, host: OLD_HOST, sshUser: 'root', sshPort: 22,
    rootAccess: true, hasDocker: true, hasOutboundInternet: true, serverPorts: '51288', exportPort: 3434,
    workerInternalBaseUrl: 'http://127.0.0.1:18090', accessAccounts: accounts
  });
  const result = await f.controller.ensureOverseaSite(undefined, SITE, {}, undefined, undefined, OPS);
  assert.notEqual(result.ensure.planId, stale.planId);
  assert.equal(f.raw.getSiteSlotPlan(result.ensure.planId!)?.host, HOST);
}));

test('archived/paused/shared targets and paused default accounts cannot be implicitly repaired or reactivated', async () => withOps(async () => {
  const shared = fixture();
  shared.raw.upsertSiteSlotSshProfile({ siteId: 'another-oversea', kind: 'oversea', host: HOST });
  assert.equal((await shared.run()).recovery.status, 'blocked');
  assert.deepEqual(shared.mutations, []);
  const paused = fixture();
  paused.raw.listSiteSlotAccessAccounts(SITE)[0].status = 'paused';
  assert.equal((await paused.run({ executeRecovery: true, confirmRecovery: true })).recovery.status, 'blocked');
  assert.deepEqual(paused.mutations, []);
  assert.equal(paused.raw.listSiteSlotAccessAccounts(SITE)[0].status, 'paused');
  const archived = fixture();
  archived.raw.archiveLauncherNetworkMihomoSite({ siteId: SITE, archived: true });
  assert.equal((await archived.run()).recovery.status, 'blocked');
  assert.deepEqual(archived.mutations, []);
}));

test('profile edits during inspection stop recovery before any deployment', async () => withOps(async () => {
  const f = fixture();
  f.internal.probeOverseaRecovery = async () => {
    f.raw.upsertSiteSlotSshProfile({ ...f.raw.getSiteSlotSshProfile(`sshprof_${SITE}`)!, host: '192.0.2.99' });
    return live(false);
  };
  const response = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(response.recovery.status, 'blocked');
  assert.deepEqual(f.mutations, []);
}));

test('healthy/ready observations are rejected if the current target or active accounts change during the probe', async () => withOps(async () => {
  for (const change of ['edit-profile', 'new-active-profile', 'pause-account', 'rotate-account']) {
    const f = fixture(change === 'edit-profile' ? HOST : OLD_HOST);
    f.internal.probeOverseaRecovery = async () => {
      const profile = f.raw.getSiteSlotSshProfile(`sshprof_${SITE}`)!;
      if (change === 'edit-profile') f.raw.upsertSiteSlotSshProfile({ ...profile, host: '192.0.2.99' });
      if (change === 'new-active-profile') {
        const replacement = f.raw.upsertSiteSlotSshProfile({ ...profile, profileId: 'replacement-profile', host: '192.0.2.99' });
        replacement.updatedAt = '2099-01-01T00:00:00.000Z';
      }
      if (change === 'pause-account') f.raw.listSiteSlotAccessAccounts(SITE)[0].status = 'paused';
      if (change === 'rotate-account') f.raw.listSiteSlotAccessAccounts(SITE)[0].authToken = 'new-secret-credential';
      return live(true);
    };
    const response = await f.run({ executeRecovery: true, confirmRecovery: true });
    assert.equal(response.recovery.status, 'blocked', change);
    assert.equal(response.recovery.changed, false, change);
    assert.deepEqual(f.mutations, [], change);
    assert.doesNotMatch(JSON.stringify(response), /new-secret-credential/);
  }
}));

test('final observation cannot publish when an account is revoked during deployment', async () => withOps(async () => {
  const f = fixture(OLD_HOST);
  let probes = 0;
  f.internal.probeOverseaRecovery = async () => ++probes === 1 ? live(false) : live(true);
  f.internal.runRemoteSshWorker = async () => {
    f.raw.listSiteSlotAccessAccounts(SITE)[0].status = 'paused';
    return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
  };
  const response = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(response.recovery.status, 'failed');
  assert.equal(f.raw.getLauncherNetworkMihomoSite(SITE)?.publicHost, OLD_HOST);
}));

test('failed recovery does not overwrite a concurrent external publication edit', async () => withOps(async () => {
  const f = fixture(OLD_HOST);
  let probes = 0;
  f.internal.probeOverseaRecovery = async () => ++probes === 1 ? live(false) : live(true);
  f.internal.runRemoteSshWorker = async () => {
    f.raw.upsertLauncherNetworkMihomoSite({ siteId: SITE, publicHost: '192.0.2.99', serverPorts: '51290', tlsFingerprint: NEW_TLS });
    return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
  };
  const response = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(response.recovery.status, 'failed');
  const current = f.raw.getLauncherNetworkMihomoSite(SITE)!;
  assert.equal(current.publicHost, '192.0.2.99');
  assert.equal(current.serverPorts, '51290');
  assert.equal(current.tlsFingerprint, NEW_TLS);
  assert.match(response.recovery.warnings.join(' '), /external edits were retained/);
}));

test('the ensure boundary rechecks the probed profile before writing any recovery plan', async () => withOps(async () => {
  const f = fixture();
  const originalList = f.raw.listSiteSlotSshProfiles.bind(f.raw);
  let reads = 0;
  f.raw.listSiteSlotSshProfiles = () => {
    reads += 1;
    if (reads === 4) f.raw.upsertSiteSlotSshProfile({ ...f.raw.getSiteSlotSshProfile(`sshprof_${SITE}`)!, host: '192.0.2.99' });
    return originalList();
  };
  const response = await f.run({ executeRecovery: true, confirmRecovery: true });
  assert.equal(response.recovery.status, 'blocked');
  assert.equal(response.recovery.changed, false);
  assert.deepEqual(f.mutations, []);
}));

test('single-flight recovery blocks concurrent recovery and ordinary ensure for the same site', async () => withOps(async () => {
  const f = fixture();
  let release!: (value: OverseaRecoveryLive) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.internal.probeOverseaRecovery = async () => {
    entered();
    return new Promise<OverseaRecoveryLive>((resolve) => { release = resolve; });
  };
  const first = f.run();
  await started;
  assert.equal((await f.run()).recovery.status, 'blocked');
  const ensure = await f.controller.ensureOverseaSite(undefined, SITE, { executeRemote: true, confirmInstall: true }, undefined, undefined, OPS);
  assert.equal(ensure.ensure.status, 'blocked');
  const terminal = await f.controller.runOverseaTerminalCommand(undefined, SITE, {
    command: 'true', confirmRemoteExecution: true, confirmManualCommand: true
  }, undefined, undefined, OPS);
  assert.equal(terminal.terminal.status, 'blocked');
  await assert.rejects(f.controller.archiveOverseaSite(undefined, SITE, {}, undefined, undefined, OPS), /operation is already running/);
  await assert.rejects(f.controller.shadowSetupOverseaSite(undefined, SITE, {}, undefined, undefined, OPS), /operation is already running/);
  assert.deepEqual(f.mutations, []);
  release(live(true));
  assert.equal((await first).recovery.status, 'healthy');
  f.internal.probeOverseaRecovery = async () => live(true);
  assert.equal((await f.run()).recovery.status, 'healthy', 'lock must be released');
}));

test('ops authentication precedes all recovery store/process access', async () => withOps(async () => {
  const store = new Proxy({} as PlatformStore, { get() { throw new Error('store touched before auth'); } });
  const controller = new AdminController(store);
  await assert.rejects(controller.recoverOverseaSite(undefined, SITE, { expectedHost: HOST }, undefined, undefined, 'wrong'), /valid Internal ops token/);
}));
