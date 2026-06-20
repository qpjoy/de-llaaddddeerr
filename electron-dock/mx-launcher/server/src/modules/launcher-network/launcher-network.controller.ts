import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import { MX_H2I_PRODUCT_ID } from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { LauncherNetworkLease, SiteSlotPlan, SiteSlotSshProfile } from '../../types.js';

const execFileAsync = promisify(execFile);

@Controller('internal/v1/launcher-network')
export class LauncherNetworkController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Post('snapshots')
  async createSnapshot(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      snapshot: await this.store.createLauncherNetworkSnapshot({
        installId: nullableString(body.installId) ?? undefined,
        deviceId: nullableString(body.deviceId) ?? undefined,
        siteId: nullableString(body.siteId),
        userId: nullableString(body.userId),
        publicKey: nullableString(body.publicKey),
        appId: nullableString(body.appId) ?? MX_H2I_PRODUCT_ID,
        launcherMode: launcherProductMode(nullableString(body.launcherMode)),
        requestId: nullableString(body.requestId) ?? undefined
      })
    };
  }

  @Post('enrollments')
  async enrollLease(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      lease: await this.store.enrollLauncherNetworkLease({
        productId: nullableString(body.productId),
        mode: nullableString(body.mode),
        identityKind: nullableString(body.identityKind),
        installId: nullableString(body.installId),
        deviceId: nullableString(body.deviceId),
        siteId: nullableString(body.siteId),
        userId: nullableString(body.userId),
        publicKey: nullableString(body.publicKey),
        deviceLabel: nullableString(body.deviceLabel),
        platform: nullableString(body.platform),
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }

  @Get('leases')
  async listLeases() {
    return {
      leases: await this.store.listLauncherNetworkLeases()
    };
  }

  @Get('leases/:leaseId')
  async getLease(@Param('leaseId') leaseId: string) {
    const lease = await this.store.getLauncherNetworkLease(leaseId);
    if (!lease) throw new NotFoundException('Launcher network lease not found');
    return { lease };
  }

  @Post('leases/:leaseId/release')
  async releaseLease(@Param('leaseId') leaseId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      lease: await this.store.releaseLauncherNetworkLease(leaseId, {
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }

  @Post('leases/:leaseId/domestic-peer/sync')
  async syncDomesticPeer(@Param('leaseId') leaseId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const lease = await this.store.getLauncherNetworkLease(leaseId);
    if (!lease) throw new NotFoundException('Launcher network lease not found');
    const domesticPeerSync = await syncDomesticRelayPeer(this.store, lease, {
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
    return { lease, domesticPeerSync };
  }

  @Get('products')
  async listProductNetworks() {
    return {
      products: await this.store.listLauncherProductNetworks()
    };
  }

  @Get('products/:productId')
  async getProductNetwork(@Param('productId') productId: string) {
    const product = await this.store.getLauncherProductNetwork(productId);
    if (!product) throw new NotFoundException('Launcher product network not found');
    return { product };
  }

  @Post('products/:productId')
  async upsertProductNetwork(@Param('productId') productId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      product: await this.store.upsertLauncherProductNetwork({
        productId,
        displayName: nullableString(body.displayName),
        mode: nullableString(body.mode),
        standaloneChannelProductId: nullableString(body.standaloneChannelProductId),
        productIndex: numberValue(body.productIndex),
        serviceVip: nullableString(body.serviceVip),
        userCidr: nullableString(body.userCidr),
        anonymousCidr: nullableString(body.anonymousCidr),
        userLeaseStart: nullableString(body.userLeaseStart),
        userLeaseEnd: nullableString(body.userLeaseEnd),
        anonymousLeaseStart: nullableString(body.anonymousLeaseStart),
        anonymousLeaseEnd: nullableString(body.anonymousLeaseEnd),
        defaultDomesticSiteId: nullableString(body.defaultDomesticSiteId),
        defaultOverseaSiteId: nullableString(body.defaultOverseaSiteId),
        updatePolicy: nullableString(body.updatePolicy),
        rateLimitProfile: nullableString(body.rateLimitProfile),
        dnsPolicyId: nullableString(body.dnsPolicyId),
        licensePolicyId: nullableString(body.licensePolicyId),
        enabled: typeof body.enabled === 'boolean' ? body.enabled : null,
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }

  @Get('mihomo/sites/:siteId')
  async getMihomoSite(@Param('siteId') siteId: string) {
    const site = await this.store.getLauncherNetworkMihomoSite(siteId);
    if (!site) throw new NotFoundException('Launcher Network mihomo site not found');
    return { site };
  }

  @Get('mihomo/sites/:siteId/reachability')
  async getMihomoSiteReachability(@Param('siteId') siteId: string) {
    const reachability = await this.store.getLauncherNetworkMihomoReachability(siteId);
    if (!reachability) throw new NotFoundException('Launcher Network mihomo reachability plan not found');
    return { reachability };
  }

  @Post('mihomo/sites/:siteId')
  async upsertMihomoSite(@Param('siteId') siteId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      site: await this.store.upsertLauncherNetworkMihomoSite({
        siteId,
        publicHost: nullableString(body.publicHost),
        serverPorts: nullableString(body.serverPorts),
        tlsFingerprint: nullableString(body.tlsFingerprint),
        subscriptionBaseUrl: nullableString(body.subscriptionBaseUrl),
        routingPolicy: nullableString(body.routingPolicy),
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }
}

function launcherProductMode(value: string | null): 'standalone' | 'embed' | null {
  if (value === 'standalone' || value === 'embed') return value;
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

async function syncDomesticRelayPeer(
  store: PlatformStore,
  lease: LauncherNetworkLease,
  input: { requestedBy?: string | null; requestId?: string | null }
) {
  const checkedAt = new Date().toISOString();
  const plan = await latestDomesticPlan(store, lease.domesticSiteId || lease.siteId);
  const profile = await domesticSshProfile(store, plan, lease.domesticSiteId || lease.siteId);
  const failures = domesticRelayPeerSyncFailures(lease, plan, profile);
  if (failures.length > 0) {
    return {
      status: 'blocked' as const,
      execution: 'not-started' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      domesticRelay: domesticRelayPlanEvidence(plan, profile),
      failures
    };
  }

  const script = domesticRelayPeerSyncScript(lease.publicKey ?? '', `${lease.leaseIp}/32`);
  const ssh = sshArgv(profile as SiteSlotSshProfile, script);
  try {
    const result = await execFileAsync('ssh', ssh, {
      timeout: (effectiveSshConnectTimeoutSeconds(profile?.connectTimeoutSeconds) + 60) * 1000,
      maxBuffer: 4 * 1024 * 1024
    });
    await store.recordAudit({
      eventType: 'launcher_network.domestic_peer.synced',
      actorKind: lease.identityKind === 'user' ? 'user' : 'install',
      userId: lease.userId,
      installId: lease.installId,
      deviceId: lease.deviceId,
      productId: lease.productId,
      siteId: lease.domesticSiteId,
      overlayIp: lease.leaseIp,
      requestId: input.requestId ?? null,
      metadata: {
        leaseId: lease.leaseId,
        publicKey: lease.publicKey,
        allowedIp: `${lease.leaseIp}/32`,
        profileId: profile?.profileId ?? null,
        requestedBy: input.requestedBy ?? 'launcher-network'
      }
    });
    return {
      status: 'passed' as const,
      execution: 'executed' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      domesticRelay: domesticRelayPlanEvidence(plan, profile),
      result: {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr
      }
    };
  } catch (error) {
    const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      status: 'failed' as const,
      execution: 'failed' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      domesticRelay: domesticRelayPlanEvidence(plan, profile),
      result: {
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message
      },
      failures: [sshFailureSummary(execError.stderr ?? execError.message, execError.code)]
    };
  }
}

async function latestDomesticPlan(store: PlatformStore, siteId: string): Promise<SiteSlotPlan | null> {
  const plans = await store.listSiteSlotPlans();
  return plans
    .filter((plan) => plan.kind === 'domestic' && plan.siteId === siteId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

async function domesticSshProfile(
  store: PlatformStore,
  plan: SiteSlotPlan | null,
  siteId: string
): Promise<SiteSlotSshProfile | null> {
  if (plan?.ssh.profileId) return store.getSiteSlotSshProfile(plan.ssh.profileId);
  return store.getSiteSlotSshProfileForSite(siteId);
}

function domesticRelayPeerSyncFailures(
  lease: LauncherNetworkLease,
  plan: SiteSlotPlan | null,
  profile: SiteSlotSshProfile | null
): string[] {
  const identityFileExists = profile?.identityFile ? existsSync(profile.identityFile) : null;
  const knownHostsFileExists = profile?.knownHostsFile ? existsSync(profile.knownHostsFile) : null;
  return [
    ...(lease.status === 'active' ? [] : [`lease is not active: ${lease.status}`]),
    ...(lease.publicKey ? [] : ['lease publicKey is required before Domestic peer sync']),
    ...(lease.publicKey && validWireGuardPublicKey(lease.publicKey) ? [] : lease.publicKey ? ['lease publicKey is not a valid WireGuard public key'] : []),
    ...(validRelayLeaseIp(lease.leaseIp) ? [] : ['leaseIp must be in launcher product relay range']),
    ...(plan ? [] : [`domestic plan not found for site ${lease.domesticSiteId || lease.siteId}`]),
    ...(plan && plan.status === 'blocked' ? [`domestic plan is blocked: ${plan.planId}`] : []),
    ...(profile ? [] : [`active SSH profile not found for Domestic site ${lease.domesticSiteId || lease.siteId}`]),
    ...(profile?.status === 'active' ? [] : profile ? [`SSH profile is ${profile.status}`] : []),
    ...(profile?.host ? [] : ['SSH profile host is required before Domestic peer sync']),
    ...(profile?.identityFile ? [] : ['SSH identity file is required before Domestic peer sync']),
    ...(profile?.identityFile && identityFileExists === false ? [`SSH identity file does not exist: ${profile.identityFile}`] : []),
    ...(profile?.knownHostsFile ? [] : ['SSH known_hosts file is required before Domestic peer sync']),
    ...(profile?.knownHostsFile && knownHostsFileExists === false ? [`SSH known_hosts file does not exist: ${profile.knownHostsFile}`] : [])
  ];
}

function domesticRelayPeerSyncScript(publicKey: string, allowedIp: string): string {
  return [
    'set -eu',
    'printf "mx-launcher-domestic-peer-sync\\n"',
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    `wg set mx-domestic peer ${shellQuote(publicKey)} allowed-ips ${shellQuote(allowedIp)}`,
    'if command -v wg-quick >/dev/null 2>&1; then wg-quick save mx-domestic || true; fi',
    `printf "peer=%s\\n" ${shellQuote(publicKey)}`,
    `printf "allowed_ip=%s\\n" ${shellQuote(allowedIp)}`,
    `wg show mx-domestic allowed-ips | awk -v peer=${shellQuote(publicKey)} '$1 == peer { print "allowed " $0 }'`,
    `wg show mx-domestic latest-handshakes | awk -v peer=${shellQuote(publicKey)} '$1 == peer { print "handshake " $0 }'`
  ].join('; ');
}

function sshArgv(profile: SiteSlotSshProfile, command: string): string[] {
  const connectTimeoutSeconds = effectiveSshConnectTimeoutSeconds(profile.connectTimeoutSeconds);
  const args = [
    '-F', internalSshConfigFile(profile),
    '-o', `BatchMode=${profile.batchMode ?? 'yes'}`,
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o', 'ConnectionAttempts=2',
    '-o', 'AddressFamily=inet',
    '-o', 'IPQoS=none',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', `StrictHostKeyChecking=${profile.strictHostKeyChecking ?? 'yes'}`
  ];
  if (internalSshUsesDefaultIsolatedConfig(profile)) {
    args.push('-o', 'ProxyCommand=none', '-o', 'ProxyJump=none');
  }
  if (profile.identityFile) args.push('-i', profile.identityFile);
  if (profile.knownHostsFile) args.push('-o', `UserKnownHostsFile=${profile.knownHostsFile}`);
  if (profile.hostKeyAlias) {
    args.push('-o', `HostKeyAlias=${profile.hostKeyAlias}`);
    args.push('-o', 'CheckHostIP=no');
  }
  args.push('-p', String(profile.sshPort ?? 22), `${profile.sshUser ?? 'root'}@${profile.host}`, command);
  return args;
}

function internalSshConfigFile(profile?: SiteSlotSshProfile | null): string {
  return profile?.sshConfigFile?.trim()
    || process.env.MX_SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || process.env.SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || '/dev/null';
}

function internalSshUsesDefaultIsolatedConfig(profile?: SiteSlotSshProfile | null): boolean {
  return !profile?.sshConfigFile && !process.env.MX_SITE_SLOT_SSH_CONFIG_FILE && !process.env.SITE_SLOT_SSH_CONFIG_FILE;
}

function effectiveSshConnectTimeoutSeconds(value: number | null | undefined): number {
  return Math.max(30, value ?? 30);
}

function domesticRelayLeaseEvidence(lease: LauncherNetworkLease) {
  return {
    leaseId: lease.leaseId,
    productId: lease.productId,
    identityKind: lease.identityKind,
    leaseIp: lease.leaseIp,
    allowedIp: `${lease.leaseIp}/32`,
    publicKey: lease.publicKey,
    domesticSiteId: lease.domesticSiteId,
    expiresAt: lease.expiresAt
  };
}

function domesticRelayPlanEvidence(plan: SiteSlotPlan | null, profile: SiteSlotSshProfile | null) {
  return {
    siteId: plan?.siteId ?? profile?.siteId ?? null,
    planId: plan?.planId ?? null,
    planStatus: plan?.status ?? null,
    host: profile?.host ?? plan?.host ?? null,
    interfaceName: 'mx-domestic',
    gatewayIp: '10.88.0.1',
    profileId: profile?.profileId ?? plan?.ssh.profileId ?? null
  };
}

function validWireGuardPublicKey(value: string): boolean {
  return /^[A-Za-z0-9+/=]{32,88}$/.test(value) && !/\s/.test(value);
}

function validRelayLeaseIp(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  return octets[0] === 10
    && octets[1] >= 89
    && octets[1] <= 254
    && octets[2] <= 254
    && octets[3] >= 1
    && octets[3] <= 254;
}

function sshFailureSummary(stderr: unknown, exitCode: unknown): string {
  const text = String(stderr ?? '');
  if (/host key verification failed/i.test(text)) return 'SSH host key verification failed';
  if (/permission denied/i.test(text)) return 'SSH permission denied';
  if (/timed out|operation timed out/i.test(text)) return 'SSH connection timed out';
  return `SSH command failed${typeof exitCode === 'number' ? ` (${exitCode})` : ''}: ${text.split('\n')[0] || 'unknown error'}`;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
