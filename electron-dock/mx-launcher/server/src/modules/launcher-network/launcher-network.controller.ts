import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import { MX_H2I_PRODUCT_ID } from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { LauncherNetworkLease, SiteSlotDomesticWireGuardSecret, SiteSlotPlan, SiteSlotSshProfile } from '../../types.js';

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

  @Post('leases/:leaseId/domestic-relay/diagnostics')
  async diagnoseDomesticRelay(@Param('leaseId') leaseId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const lease = await this.store.getLauncherNetworkLease(leaseId);
    if (!lease) throw new NotFoundException('Launcher network lease not found');
    const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease(this.store, lease, {
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
    return { lease, domesticRelayDiagnostics };
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
  const routeCidrs = domesticRelayRouteCidrsForAllowedIp(allowedIp);
  return [
    'set -eu',
    'printf "mx-launcher-domestic-peer-sync\\n"',
    `allowed_ip=${shellQuote(allowedIp)}`,
    `relay_route_cidrs=${shellQuote(routeCidrs.join(' '))}`,
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    `wg set mx-domestic peer ${shellQuote(publicKey)} allowed-ips ${shellQuote(allowedIp)}`,
    'ip link set up dev mx-domestic',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null || true',
    ...domesticRelayFirewallEnsureCommands(),
    'for route_cidr in $relay_route_cidrs; do ip route replace "$route_cidr" dev mx-domestic; done',
    'ip route replace "$allowed_ip" dev mx-domestic || true',
    'if command -v wg-quick >/dev/null 2>&1; then wg-quick save mx-domestic || true; fi',
    `printf "peer=%s\\n" ${shellQuote(publicKey)}`,
    `printf "allowed_ip=%s\\n" ${shellQuote(allowedIp)}`,
    'printf "relay_route_cidrs=%s\\n" "$relay_route_cidrs"',
    'ip route get "${allowed_ip%/*}" || true',
    `wg show mx-domestic allowed-ips | awk -v peer=${shellQuote(publicKey)} '$1 == peer { print "allowed " $0 }'`,
    `wg show mx-domestic latest-handshakes | awk -v peer=${shellQuote(publicKey)} '$1 == peer { print "handshake " $0 }'`
  ].join('; ');
}

async function diagnoseDomesticRelayForLease(
  store: PlatformStore,
  lease: LauncherNetworkLease,
  input: { requestedBy?: string | null; requestId?: string | null }
) {
  const checkedAt = new Date().toISOString();
  const siteId = lease.domesticSiteId || lease.siteId;
  const plan = await latestDomesticPlan(store, siteId);
  const profile = await domesticSshProfile(store, plan, siteId);
  const secret = await store.getSiteSlotDomesticWireGuardSecret(siteId);
  const failures = domesticRelayPeerSyncFailures(lease, plan, profile);
  if (failures.length > 0) {
    return {
      status: 'blocked' as const,
      execution: 'not-started' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      domesticRelay: domesticRelayPlanEvidence(plan, profile),
      summary: null,
      failures
    };
  }

  const script = domesticRelayDiagnosticsScript(lease, secret);
  const ssh = sshArgv(profile as SiteSlotSshProfile, script);
  try {
    const result = await execFileAsync('ssh', ssh, {
      timeout: (effectiveSshConnectTimeoutSeconds(profile?.connectTimeoutSeconds) + 45) * 1000,
      maxBuffer: 4 * 1024 * 1024
    });
    const summary = summarizeDomesticRelayDiagnostics(result.stdout, lease, secret);
    const blockedReasons = domesticRelayDiagnosticBlockedReasons(summary);
    await store.recordAudit({
      eventType: 'launcher_network.domestic_relay.diagnosed',
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
        requestedBy: input.requestedBy ?? 'launcher-network',
        status: blockedReasons.length > 0 ? 'blocked' : 'passed',
        blockedReasons
      }
    });
    return {
      status: blockedReasons.length > 0 ? 'blocked' as const : 'passed' as const,
      execution: 'executed' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      domesticRelay: domesticRelayPlanEvidence(plan, profile),
      summary,
      blockedReasons,
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
      summary: summarizeDomesticRelayDiagnostics(execError.stdout ?? '', lease, secret),
      result: {
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message
      },
      failures: [sshFailureSummary(execError.stderr ?? execError.message, execError.code)]
    };
  }
}

function domesticRelayDiagnosticsScript(
  lease: LauncherNetworkLease,
  secret: SiteSlotDomesticWireGuardSecret | null
): string {
  const leaseIp = lease.leaseIp;
  const allowedIp = `${lease.leaseIp}/32`;
  const publicKey = lease.publicKey ?? '';
  const internalPeer = secret?.internalServicePublicKey ?? '';
  const internalIp = secret?.internalServiceIp ?? '10.88.88.88';
  const routeCidrs = domesticRelayRouteCidrsForAllowedIp(allowedIp);
  return [
    'set -eu',
    'printf "mx-launcher-domestic-relay-diagnostics\\n"',
    `lease_ip=${shellQuote(leaseIp)}`,
    `allowed_ip=${shellQuote(allowedIp)}`,
    `client_peer=${shellQuote(publicKey)}`,
    `internal_peer=${shellQuote(internalPeer)}`,
    `internal_ip=${shellQuote(internalIp)}`,
    `relay_route_cidrs=${shellQuote(routeCidrs.join(' '))}`,
    'printf "lease_ip=%s\\n" "$lease_ip"',
    'printf "allowed_ip=%s\\n" "$allowed_ip"',
    'printf "internal_ip=%s\\n" "$internal_ip"',
    'printf "relay_route_cidrs=%s\\n" "$relay_route_cidrs"',
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key exists on Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    'printf "ip_forward=%s\\n" "$(sysctl -n net.ipv4.ip_forward 2>/dev/null || echo unknown)"',
    'if command -v iptables >/dev/null 2>&1; then if iptables -C FORWARD -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null; then printf "firewall_forward=present\\n"; else printf "firewall_forward=missing\\n"; fi; if iptables -S DOCKER-USER >/dev/null 2>&1; then if iptables -C DOCKER-USER -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null; then printf "firewall_docker_user=present\\n"; else printf "firewall_docker_user=missing\\n"; fi; else printf "firewall_docker_user=absent\\n"; fi; else printf "firewall_forward=unknown\\n"; printf "firewall_docker_user=unknown\\n"; fi',
    'printf "client_peer_configured=%s\\n" "$(wg show mx-domestic allowed-ips | awk -v peer="$client_peer" -v ip="$allowed_ip" \'$1 == peer { for (i = 2; i <= NF; i += 1) if ($i == ip) found=1 } END { print found ? "yes" : "no" }\')"',
    'printf "client_latest_handshake=%s\\n" "$(wg show mx-domestic latest-handshakes | awk -v peer="$client_peer" \'$1 == peer { print $2 }\')"',
    'printf "client_transfer=%s\\n" "$(wg show mx-domestic transfer | awk -v peer="$client_peer" \'$1 == peer { print $2 "/" $3 }\')"',
    'if [ -n "$internal_peer" ]; then printf "internal_peer_configured=%s\\n" "$(wg show mx-domestic allowed-ips | awk -v peer="$internal_peer" -v ip="$internal_ip/32" \'$1 == peer { for (i = 2; i <= NF; i += 1) if ($i == ip) found=1 } END { print found ? "yes" : "no" }\')"; printf "internal_latest_handshake=%s\\n" "$(wg show mx-domestic latest-handshakes | awk -v peer="$internal_peer" \'$1 == peer { print $2 }\')"; printf "internal_transfer=%s\\n" "$(wg show mx-domestic transfer | awk -v peer="$internal_peer" \'$1 == peer { print $2 "/" $3 }\')"; else printf "internal_peer_configured=unknown\\n"; printf "internal_latest_handshake=\\n"; printf "internal_transfer=\\n"; fi',
    'for route_cidr in $relay_route_cidrs; do safe="$(printf "%s" "$route_cidr" | tr "./" "__")"; if ip route show "$route_cidr" | grep -q "dev mx-domestic"; then printf "route_%s=present\\n" "$safe"; else printf "route_%s=missing\\n" "$safe"; fi; done',
    'ip route get "$lease_ip" 2>&1 | sed "s/^/route_to_lease /" || true',
    'ip route get "$internal_ip" 2>&1 | sed "s/^/route_to_internal /" || true',
    'ip -4 addr show dev mx-domestic 2>&1 | sed "s/^/addr /" || true',
    'wg show mx-domestic allowed-ips 2>&1 | sed "s/^/allowed_ips /" || true',
    'wg show mx-domestic latest-handshakes 2>&1 | sed "s/^/latest_handshakes /" || true',
    'if command -v curl >/dev/null 2>&1; then if curl -fsS --max-time 4 "http://${internal_ip}:18090/healthz" >/tmp/mx-internal-healthz.out 2>/tmp/mx-internal-healthz.err; then printf "internal_healthz=passed\\n"; else printf "internal_healthz=failed:%s\\n" "$(cat /tmp/mx-internal-healthz.err 2>/dev/null || true)"; fi; else printf "internal_healthz=skipped:curl missing\\n"; fi',
    'if command -v nft >/dev/null 2>&1; then nft list ruleset 2>/dev/null | sed -n "1,80p" | sed "s/^/nft /" || true; elif command -v iptables >/dev/null 2>&1; then iptables -S FORWARD 2>/dev/null | sed "s/^/iptables /" || true; fi'
  ].join('; ');
}

function summarizeDomesticRelayDiagnostics(
  stdout: string,
  lease: LauncherNetworkLease,
  secret: SiteSlotDomesticWireGuardSecret | null
) {
  const routeCidrs = domesticRelayRouteCidrsForAllowedIp(`${lease.leaseIp}/32`);
  const keyed = keyValueLines(stdout);
  const routeStatus = Object.fromEntries(routeCidrs.map((cidr) => {
    const key = `route_${cidr.replace(/[./]/g, '_')}`;
    return [cidr, keyed[key] ?? 'unknown'];
  }));
  return {
    leaseIp: lease.leaseIp,
    allowedIp: `${lease.leaseIp}/32`,
    internalIp: secret?.internalServiceIp ?? '10.88.88.88',
    ipForward: keyed.ip_forward ?? null,
    clientPeerConfigured: keyed.client_peer_configured ?? null,
    clientLatestHandshake: keyed.client_latest_handshake ?? null,
    clientTransfer: keyed.client_transfer ?? null,
    internalPeerConfigured: keyed.internal_peer_configured ?? null,
    internalLatestHandshake: keyed.internal_latest_handshake ?? null,
    internalTransfer: keyed.internal_transfer ?? null,
    firewallForward: keyed.firewall_forward ?? null,
    firewallDockerUser: keyed.firewall_docker_user ?? null,
    relayRouteCidrs: routeCidrs,
    routeStatus,
    routeToLease: firstPrefixedLine(stdout, 'route_to_lease '),
    routeToInternal: firstPrefixedLine(stdout, 'route_to_internal '),
    internalHealthz: keyed.internal_healthz ?? null
  };
}

function domesticRelayDiagnosticBlockedReasons(summary: ReturnType<typeof summarizeDomesticRelayDiagnostics>): string[] {
  return [
    ...(summary.ipForward === '1' ? [] : [`Domestic ip_forward is ${summary.ipForward ?? 'unknown'}, expected 1`]),
    ...(summary.clientPeerConfigured === 'yes' ? [] : [`Domestic client peer ${summary.allowedIp} is not configured`]),
    ...(summary.internalPeerConfigured === 'yes' || summary.internalPeerConfigured === 'unknown' ? [] : [`Domestic Internal peer ${summary.internalIp}/32 is not configured`]),
    ...(summary.firewallForward === 'present' ? [] : [`Domestic FORWARD mx-domestic->mx-domestic rule is ${summary.firewallForward ?? 'unknown'}`]),
    ...(summary.firewallDockerUser === 'present' || summary.firewallDockerUser === 'absent' ? [] : [`Domestic DOCKER-USER mx-domestic->mx-domestic rule is ${summary.firewallDockerUser ?? 'unknown'}`]),
    ...Object.entries(summary.routeStatus)
      .filter(([, status]) => status !== 'present')
      .map(([cidr, status]) => `Domestic route ${cidr} dev mx-domestic is ${status}`),
    ...(summary.routeToLease && /dev mx-domestic/.test(summary.routeToLease) ? [] : [`Domestic route to ${summary.leaseIp} is not on mx-domestic`]),
    ...(summary.internalHealthz === 'passed' ? [] : [`Domestic cannot reach Internal healthz: ${summary.internalHealthz ?? 'unknown'}`])
  ];
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

function domesticRelayRouteCidrsForAllowedIp(allowedIp: string): string[] {
  const ip = allowedIp.split('/')[0] ?? '';
  const parts = ip.split('.').map((part) => Number(part));
  const derived = parts.length === 4 && parts[0] === 10 && Number.isInteger(parts[1]) && parts[1] >= 89 && parts[1] <= 254
    ? `10.${parts[1]}.0.0/16`
    : null;
  return [...new Set([derived, '10.89.0.0/16', '10.90.0.0/16'].filter((cidr): cidr is string => Boolean(cidr)))];
}

function domesticRelayFirewallEnsureCommands(): string[] {
  return [
    'if command -v iptables >/dev/null 2>&1; then iptables -C FORWARD -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -i mx-domestic -o mx-domestic -j ACCEPT; if iptables -S DOCKER-USER >/dev/null 2>&1; then iptables -C DOCKER-USER -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -i mx-domestic -o mx-domestic -j ACCEPT; fi; iptables -C INPUT -i mx-domestic -p udp --dport 53 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p udp --dport 53 -j ACCEPT; iptables -C INPUT -i mx-domestic -p tcp --dport 53 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p tcp --dport 53 -j ACCEPT; fi'
  ];
}

function keyValueLines(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function firstPrefixedLine(stdout: string, prefix: string): string | null {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
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
