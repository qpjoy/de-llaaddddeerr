import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import { nullableString } from '../../lib/http.js';
import {
  hashToken,
  SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID,
  SYSTEM_SUBSCRIPTION_MIXED_PORT,
  systemSubscriptionAccessAccountName
} from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import type {
  LauncherNetworkMihomoSite,
  SiteSlotAccessAccount,
  SiteSlotPlan,
  SiteSlotSshProfile,
  SiteSlotWorkerJob,
  SiteSlotWorkerReport,
  SystemSubscriptionCatalog,
  SystemSubscriptionItem
} from '../../types.js';

export async function buildSystemSubscriptionCatalog(store: PlatformStore): Promise<SystemSubscriptionCatalog> {
  const [sites, profiles, plans, jobs, reports] = await Promise.all([
    store.listLauncherNetworkMihomoSites(),
    store.listSiteSlotSshProfiles(),
    store.listSiteSlotPlans(),
    store.listSiteSlotWorkerJobs(),
    store.listSiteSlotWorkerReports()
  ]);
  // Archived sites retain plans/reports for audit and may be restored, but
  // they are not live subscription channels.
  const liveSites = sites.filter((site) => site.status !== 'archived');
  const subscriptions = await Promise.all(liveSites.map(async (site) => {
    const account = await store.getSiteSlotAccessAccount(
      site.siteId,
      systemSubscriptionAccessAccountName(site.siteId)
    );
    const profile = latestByUpdatedAt(profiles.filter((candidate) => (
      candidate.siteId === site.siteId
      && candidate.kind === 'oversea'
      && candidate.status === 'active'
    )));
    const latestPlan = plans.find((plan) => plan.siteId === site.siteId && plan.kind === 'oversea') ?? null;
    const appliedReport = latestSystemSubscriptionDeploymentReport(reports, jobs, latestPlan, account);
    return buildSystemSubscriptionItem(site, account, profile, latestPlan, appliedReport);
  }));
  return {
    account: {
      accountId: SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID,
      kind: 'system-subscription-catalog',
      displayName: 'Subscriptions',
      status: 'active',
      loginAllowed: false,
      immutable: true,
      pinnedRank: 0
    },
    subscriptions,
    summary: {
      total: subscriptions.length,
      ready: subscriptions.filter((item) => item.status === 'ready').length,
      pending: subscriptions.filter((item) => item.status === 'pending-sync').length,
      blocked: subscriptions.filter((item) => item.status === 'blocked' || item.status === 'disabled').length
    },
    generatedAt: new Date().toISOString()
  };
}

export function systemSubscriptionDirectUrl(item: SystemSubscriptionItem, password: string): string {
  const host = item.delivery.host;
  if (!host) throw new Error('System subscription host is missing');
  const user = encodeURIComponent(item.delivery.auth.username);
  const secret = encodeURIComponent(password);
  return `${item.delivery.scheme}://${user}:${secret}@${httpUrlHost(host)}:${item.delivery.port}${item.delivery.path}`;
}

export async function systemSubscriptionDomainUrl(
  store: PlatformStore,
  account: SiteSlotAccessAccount,
  password: string
): Promise<string | null> {
  const expectedUsername = systemSubscriptionAccessAccountName(account.siteId);
  if (account.status !== 'active' || account.username !== expectedUsername) return null;
  try {
    const configs = await store.listSiteSlotDomesticRuntimeConfigs();
    for (const config of configs) {
      if (config.status !== 'active') continue;
      try {
        const base = new URL(config.edge.publicBaseUrl);
        if (base.protocol !== 'https:' || isIP(base.hostname) !== 0) continue;
        const path = `/internal/v1/site-slots/${encodeURIComponent(account.siteId)}`
          + `/subscriptions/hysteria2/${encodeURIComponent(expectedUsername)}.yaml`;
        const url = new URL(path, base);
        url.username = SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID;
        url.password = password;
        return url.toString();
      } catch {
        // Continue to another active runtime config if this record is malformed.
      }
    }
  } catch {
    // Domain publication is optional metadata. A missing/malformed runtime
    // record or store read failure must never suppress the direct-IP URL.
  }
  return null;
}

export function systemSubscriptionBasicAuthorizationMatches(
  authorization: string | undefined,
  account: SiteSlotAccessAccount
): boolean {
  const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].length % 4 !== 0) return false;
  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.toString('base64') !== match[1]) return false;
  const expected = Buffer.from(`${SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID}:${account.authToken}`, 'utf8');
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}

function latestByUpdatedAt<T extends { updatedAt?: string | null }>(items: T[]): T | null {
  return [...items].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0] ?? null;
}

function latestSystemSubscriptionDeploymentReport(
  reports: SiteSlotWorkerReport[],
  jobs: SiteSlotWorkerJob[],
  latestPlan: SiteSlotPlan | null,
  account: SiteSlotAccessAccount | null
): SiteSlotWorkerReport | null {
  if (!latestPlan || latestPlan.kind !== 'oversea' || !account) return null;
  const planCarriesSystemSubscription = latestPlan.deploymentPhases?.some((phase) => (
    phase.commands.some((command) => command.includes('HY2_SYSTEM_SUBSCRIPTION_ACCOUNT='))
  )) === true && latestPlan.deploymentPhases?.some((phase) => (
    phase.commands.includes(`Verify system-subscription-credential-sha256=${hashToken(account.authToken)}`)
  )) === true;
  if (!planCarriesSystemSubscription) return null;
  const realRemoteJobIds = new Set(jobs
    .filter((job) => (
      job.planId === latestPlan.planId
      && job.mode === 'remote-ssh'
      && job.dryRun === false
      && job.status === 'passed'
      && job.worker.kind !== 'awx-runner'
    ))
    .map((job) => job.jobId));
  return reports
    .filter((report) => (
      report.planId === latestPlan.planId
      && realRemoteJobIds.has(report.jobId)
      && report.status === 'passed'
      && report.createdAt.localeCompare(account.updatedAt) >= 0
      && report.stepReports.some((step) => (
        step.status === 'passed'
        && step.exitCode === 0
        && step.sourceId.startsWith('configure-oversea-access.')
        && step.sourceId.endsWith('.9')
        && isExecutedRemoteWorkerEvidence(step.stdout)
      ))
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function isExecutedRemoteWorkerEvidence(stdout: string | null): boolean {
  if (!stdout) return false;
  try {
    const evidence = JSON.parse(stdout) as Record<string, unknown>;
    const executionResult = recordOrNull(evidence.executionResult);
    return evidence.mode === 'artifact-push-remote-ssh'
      && evidence.dryRun === false
      && evidence.execution === 'executed'
      && executionResult?.exitCode === 0;
  } catch {
    return false;
  }
}

function buildSystemSubscriptionItem(
  site: LauncherNetworkMihomoSite,
  account: SiteSlotAccessAccount | null,
  profile: SiteSlotSshProfile | null,
  latestPlan: SiteSlotPlan | null,
  appliedReport: SiteSlotWorkerReport | null
): SystemSubscriptionItem {
  const runtimeUsername = systemSubscriptionAccessAccountName(site.siteId);
  const configuredHost = nullableString(site.publicHost ?? profile?.host);
  // Bind reveal to the exact host covered by passing worker evidence.
  const deployedHost = nullableString(latestPlan?.host);
  const host = deployedHost ?? configuredHost;
  const hostChangedSincePlan = Boolean(
    deployedHost
    && configuredHost
    && unbracketHost(deployedHost).toLowerCase() !== unbracketHost(configuredHost).toLowerCase()
  );
  const exportPort = validTcpPort(latestPlan?.runtime.oversea?.exportPort ?? profile?.exportPort, 3434);
  const path = `/peer_${encodeURIComponent(runtimeUsername)}.mihomo.yaml`;
  let status: SystemSubscriptionItem['status'] = 'ready';
  let statusReason = 'Direct-IP subscription is deployed and ready to reveal.';
  if (site.status === 'archived') {
    status = 'disabled';
    statusReason = 'The Oversea site is archived.';
  } else if (!account) {
    status = 'pending-sync';
    statusReason = 'Ensure the system runtime account, then run Oversea Install/Sync.';
  } else if (account.status !== 'active') {
    status = 'disabled';
    statusReason = 'The system runtime account is paused.';
  } else if (!host) {
    status = 'blocked';
    statusReason = 'The Oversea public IP is not configured.';
  } else if (isIP(unbracketHost(host)) === 0) {
    status = 'blocked';
    statusReason = 'A literal Oversea public IP is required for the direct-IP channel.';
  } else if (hostChangedSincePlan) {
    status = 'pending-sync';
    statusReason = 'The Oversea public IP changed after the latest plan; run Install/Sync again.';
  } else if (!site.tlsFingerprint) {
    status = 'pending-sync';
    statusReason = 'The latest Oversea deployment has not reported its TLS fingerprint yet.';
  } else if (!appliedReport) {
    status = 'pending-sync';
    statusReason = 'The account exists in Internal, but the latest Oversea plan has not deployed it yet.';
  }
  const masked = host
    ? `http://${SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID}:***@${httpUrlHost(host)}:${exportPort}${path}`
    : null;
  return {
    subscriptionId: `oversea-direct:${site.siteId}`,
    label: `${site.siteId} Direct IP`,
    siteId: site.siteId,
    status,
    statusReason,
    recommended: true,
    delivery: {
      kind: 'oversea-direct-ip-http-basic',
      scheme: 'http',
      host,
      port: exportPort,
      path,
      urlMasked: masked,
      auth: {
        type: 'basic',
        username: SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID,
        passwordAvailable: Boolean(account?.authToken)
      }
    },
    client: {
      mixedPort: SYSTEM_SUBSCRIPTION_MIXED_PORT,
      routingMode: 'cn-direct',
      explicitUseOnly: true
    },
    trafficPolicy: {
      mode: 'unlimited',
      maxBytes: null,
      resetPeriod: null,
      expiresAt: null
    },
    bandwidthHint: { down: '50 Mbps', up: '50 Mbps' },
    runtimeAccountId: account?.accountId ?? null,
    runtimeUsername,
    updatedAt: account?.updatedAt ?? site.updatedAt
  };
}

function validTcpPort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function unbracketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function httpUrlHost(host: string): string {
  const bare = unbracketHost(host);
  return isIP(bare) === 6 ? `[${bare}]` : bare;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
