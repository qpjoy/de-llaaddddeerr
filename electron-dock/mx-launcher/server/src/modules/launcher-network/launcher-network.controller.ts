import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Ip,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException
} from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import { assertInternalOpsToken, internalOpsTokenMatches, INTERNAL_OPS_TOKEN_HEADER } from '../../lib/internal-ops-auth.js';
import {
  assertLauncherLeaseCapability,
  launcherLeaseCapabilityMaterial,
  launcherLeaseCapabilityMatches,
  LAUNCHER_LEASE_CAPABILITY_HEADER,
  mintLauncherLeaseCapability
} from '../../lib/launcher-lease-auth.js';
import {
  LauncherAnonymousEnrollmentPolicyError,
  LauncherProductUserAccessDeniedError,
  assertLauncherProductUserAccess,
  launcherNetworkLeaseIsActive,
  launcherNetworkLeaseMatchesProfile,
  launcherNetworkLeaseProfile,
  launcherNetworkLeaseProductId,
  launcherProductUserAccessBlocked,
  normalizeLauncherNetworkProductId,
  MX_H2I_PRODUCT_ID
} from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE, RUNTIME_CONFIG } from '../../tokens.js';
import type { RuntimeConfig } from '../../types.js';
import type {
  AuditEvent,
  LauncherNetworkHandover,
  LauncherNetworkLease,
  OpsLauncherNetworkLease,
  LauncherProductUserAccessResult,
  SiteSlotDomesticWireGuardSecret,
  SiteSlotPlan,
  SiteSlotSshProfile,
  UserCenterUser,
  UserCenterUserIdentity
} from '../../types.js';

const execFileAsync = promisify(execFile);
const LAUNCHER_PEER_LEASE_CAPABILITY_HEADER = 'x-mx-peer-lease-capability';
const NEW_LAUNCHER_LEASE_CAPABILITY_HEADER = 'x-mx-new-lease-capability';

@Controller('internal/v1/launcher-network')
export class LauncherNetworkController implements OnModuleInit, OnModuleDestroy {
  private handoverReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private handoverReconcileInFlight: Promise<void> | null = null;

  constructor(
    @Inject(PLATFORM_STORE) private readonly store: PlatformStore,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig
  ) {}

  onModuleInit(): void {
    const intervalMs = Math.max(1_000, this.config.launcherNetworkHandoverReconcileMs);
    this.handoverReconcileTimer = setInterval(() => {
      void this.reconcileExpiredHandovers();
    }, intervalMs);
    this.handoverReconcileTimer.unref?.();
    void this.reconcileExpiredHandovers();
  }

  onModuleDestroy(): void {
    if (this.handoverReconcileTimer) clearInterval(this.handoverReconcileTimer);
    this.handoverReconcileTimer = null;
  }

  @Post('snapshots')
  async createSnapshot(
    @Headers('authorization') authorization: string | undefined,
    @Body() rawBody: unknown,
    @Headers(LAUNCHER_LEASE_CAPABILITY_HEADER) leaseCapability?: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken?: string
  ) {
    const body = asRecord(rawBody);
    const leaseId = nullableString(body.leaseId);
    if (!leaseId) {
      throw new BadRequestException('Launcher snapshots require a previously enrolled leaseId');
    }
    const existingLease = leaseId ? await this.store.getLauncherNetworkLease(leaseId) : null;
    const bodyLeaseProfile = nullableString(body.leaseProfile);
    const existingLeaseProfile = existingLease
      ? existingLease.leaseProfile ?? (existingLease.identityKind === 'user' ? 'employee' : 'anonymous')
      : null;
    if (existingLeaseProfile && bodyLeaseProfile && bodyLeaseProfile !== existingLeaseProfile) {
      throw new UnauthorizedException('Launcher snapshot leaseProfile does not match the existing lease');
    }
    if (existingLease?.identityKind === 'anonymous' && !internalOpsTokenMatches(opsToken)) {
      assertLauncherLeaseCapability(existingLease, leaseCapability);
    }
    const requestedUserId = nullableString(body.userId) ?? existingLease?.userId ?? null;
    const requestedLeaseProfile = existingLeaseProfile ?? bodyLeaseProfile;
    const auth = await authorizedLeaseIdentity(
      this.store,
      authorization,
      requestedUserId,
      requestedLeaseProfile,
      existingLease?.identityKind === 'user' || Boolean(requestedUserId),
      this.config.launcherNetworkLegacyUnauthenticatedUserLeasesEnabled
    );
    if (auth.userId && existingLease && !internalOpsTokenMatches(opsToken)) {
      const user = (await this.store.listUserCenterUsers())
        .find((candidate) => candidate.userId === auth.userId);
      this.assertProductUserAccess(user, existingLease.productId);
    }
    try {
      return {
        snapshot: await this.store.createLauncherNetworkSnapshot({
          leaseId,
          installId: nullableString(body.installId) ?? undefined,
          deviceId: nullableString(body.deviceId) ?? undefined,
          siteId: nullableString(body.siteId),
          userId: auth.userId,
          leaseProfile: auth.leaseProfile,
          publicKey: nullableString(body.publicKey),
          appId: nullableString(body.appId) ?? MX_H2I_PRODUCT_ID,
          launcherMode: launcherProductMode(nullableString(body.launcherMode)),
          requestId: nullableString(body.requestId) ?? undefined
        })
      };
    } catch (error) {
      rethrowLauncherNetworkPolicyError(error);
    }
  }

  @Post('enrollments')
  async enrollLease(
    @Headers('authorization') authorization: string | undefined,
    @Body() rawBody: unknown,
    @Headers(LAUNCHER_LEASE_CAPABILITY_HEADER) leaseCapability?: string,
    @Headers(NEW_LAUNCHER_LEASE_CAPABILITY_HEADER) newLeaseCapability?: string,
    @Ip() sourceIp?: string
  ) {
    const body = asRecord(rawBody);
    const requestedUserId = nullableString(body.userId);
    const requestedIdentityKind = nullableString(body.identityKind);
    const requestedInstallId = nullableString(body.installId);
    const requestedDeviceId = nullableString(body.deviceId);
    const requestedPublicKey = nullableString(body.publicKey);
    const requestedProductId = launcherNetworkLeaseProductId(
      nullableString(body.productId) ?? nullableString(body.appId)
    );
    const leases = await this.store.listLauncherNetworkLeases();
    const previousAnonymousLeaseRecords = requestedInstallId
      ? leases.filter((lease) => (
        lease.identityKind === 'anonymous'
        && lease.productId === requestedProductId
        && lease.installId === requestedInstallId
      )).sort((left, right) => (
        (Number(right.generation) || 0) - (Number(left.generation) || 0)
        || right.updatedAt.localeCompare(left.updatedAt)
      ))
      : [];
    const previousAnonymousLease = previousAnonymousLeaseRecords
      .find((lease) => launcherNetworkLeaseIsActive(lease))
      ?? null;
    const previousAnonymousLeaseRecord = previousAnonymousLease
      ?? previousAnonymousLeaseRecords[0]
      ?? null;
    const publicKeyLeases = requestedPublicKey
      ? leases.filter((lease) => launcherNetworkLeaseIsActive(lease)
        && lease.publicKey === requestedPublicKey
        && lease.leaseId !== previousAnonymousLease?.leaseId)
      : [];
    if (
      previousAnonymousLeaseRecord
      && (
        previousAnonymousLeaseRecord.publicKey !== requestedPublicKey
        || previousAnonymousLeaseRecord.deviceId !== requestedDeviceId
      )
    ) {
      throw new UnauthorizedException(
        'Anonymous lease renewal requires the existing device and public key; key rotation needs a separate migration'
      );
    }
    if (previousAnonymousLease?.capabilityDigest) {
      assertLauncherLeaseCapability(previousAnonymousLease, leaseCapability);
    } else if (
      previousAnonymousLeaseRecord?.capabilityDigest
      && !launcherLeaseCapabilityMatches(
        previousAnonymousLeaseRecord,
        leaseCapability,
        { allowReleased: true }
      )
    ) {
      throw new UnauthorizedException('A valid launcher lease capability is required');
    }
    const auth = await authorizedLeaseIdentity(
      this.store,
      authorization,
      requestedUserId,
      nullableString(body.leaseProfile),
      requestedIdentityKind === 'user' || Boolean(requestedUserId),
      this.config.launcherNetworkLegacyUnauthenticatedUserLeasesEnabled
    );
    const previousUserIdentityLease = auth.userId
      ? leases.find((lease) => (
          launcherNetworkLeaseIsActive(lease)
          && lease.identityKind === 'user'
          && lease.productId === requestedProductId
          && lease.installId === requestedInstallId
          && lease.userId === auth.userId
          && launcherNetworkLeaseProfile(lease.leaseProfile, lease.identityKind) === auth.leaseProfile
        ))
      : null;
    if (
      previousUserIdentityLease
      && (
        previousUserIdentityLease.deviceId !== requestedDeviceId
        || previousUserIdentityLease.publicKey !== requestedPublicKey
      )
    ) {
      throw new UnauthorizedException(
        'User lease renewal requires the existing device and public key; key rotation needs a separate migration'
      );
    }
    const legacyCapabilityClaimLeaseIds: string[] = [];
    if (previousAnonymousLease && !previousAnonymousLease.capabilityDigest) {
      legacyCapabilityClaimLeaseIds.push(previousAnonymousLease.leaseId);
    }
    for (const publicKeyLease of publicKeyLeases) {
      if (launcherLeaseCapabilityMatches(publicKeyLease, leaseCapability)) continue;
      if (publicKeyLease.leaseId === previousUserIdentityLease?.leaseId) {
        if (!publicKeyLease.capabilityDigest && newLeaseCapability) {
          legacyCapabilityClaimLeaseIds.push(publicKeyLease.leaseId);
        }
        continue;
      }
      const legacyUserClaimMatches = (
        !publicKeyLease.capabilityDigest
        && publicKeyLease.identityKind === 'user'
        && Boolean(auth.userId)
        && publicKeyLease.userId === auth.userId
        && publicKeyLease.productId === requestedProductId
        && publicKeyLease.installId === requestedInstallId
        && publicKeyLease.deviceId === requestedDeviceId
        && publicKeyLease.publicKey === requestedPublicKey
      );
      if (!legacyUserClaimMatches) {
        throw new UnauthorizedException('This WireGuard public key is already bound to another active lease');
      }
      if (newLeaseCapability) {
        legacyCapabilityClaimLeaseIds.push(publicKeyLease.leaseId);
      }
    }
    const ownedPublicKeyLeases = [
      ...(previousAnonymousLease ? [previousAnonymousLease] : []),
      ...publicKeyLeases
    ].filter((lease) => (
      lease.productId === requestedProductId
      && lease.installId === requestedInstallId
      && lease.deviceId === requestedDeviceId
      && lease.publicKey === requestedPublicKey
      && (
        lease.identityKind === 'anonymous'
        || (Boolean(auth.userId) && lease.userId === auth.userId)
      )
    ));
    const product = await this.store.getLauncherProductNetwork(requestedProductId);
    const existingReplacement = product
      ? ownedPublicKeyLeases.find((lease) => (
          launcherNetworkLeaseProfile(lease.leaseProfile, lease.identityKind) === auth.leaseProfile
          && launcherNetworkLeaseMatchesProfile(product, auth.leaseProfile, lease)
          && lease.replacementForLeaseId
        ))
      : null;
    const invalidProfileLease = product
      ? ownedPublicKeyLeases.find((lease) => (
          launcherNetworkLeaseProfile(lease.leaseProfile, lease.identityKind) === auth.leaseProfile
          && !launcherNetworkLeaseMatchesProfile(product, auth.leaseProfile, lease)
        ))
      : null;
    const replacementForLeaseId = existingReplacement?.replacementForLeaseId
      ?? invalidProfileLease?.leaseId
      ?? null;
    const capability = newLeaseCapability
      ? launcherLeaseCapabilityMaterial(newLeaseCapability)
      : mintLauncherLeaseCapability();
    const capabilityExpiresAt = new Date(
      Date.now() + 180 * 24 * 60 * 60 * 1000
    ).toISOString();
    const anonymousRenewalLeaseId = !auth.userId
      && previousAnonymousLease
      && Boolean(previousAnonymousLease.capabilityDigest)
      ? previousAnonymousLease.leaseId
      : null;
    let lease: LauncherNetworkLease;
    try {
      lease = await this.store.enrollLauncherNetworkLease({
        appId: nullableString(body.appId),
        productId: nullableString(body.productId),
        mode: nullableString(body.mode),
        identityKind: nullableString(body.identityKind),
        leaseProfile: auth.leaseProfile,
        installId: requestedInstallId,
        deviceId: requestedDeviceId,
        siteId: nullableString(body.siteId),
        userId: auth.userId,
        publicKey: requestedPublicKey,
        deviceLabel: nullableString(body.deviceLabel),
        platform: nullableString(body.platform),
        deviceModel: nullableString(body.deviceModel),
        osVersion: nullableString(body.osVersion),
        appVersion: nullableString(body.appVersion),
        sourceIp: sourceIp?.trim() || null,
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId),
        sdkTestMode: body.sdkTestMode === true ? true : nullableString(body.sdkTestMode),
        capabilityDigest: capability.digest,
        capabilityVersion: capability.version,
        capabilityExpiresAt,
        legacyCapabilityClaimLeaseIds,
        replacementForLeaseId,
        anonymousRenewalLeaseId
      });
    } catch (error) {
      rethrowLauncherNetworkPolicyError(error);
    }
    const handoverLeases = (await Promise.all(
      ownedPublicKeyLeases
        .filter((candidate) => candidate.leaseId !== lease.leaseId)
        .map((candidate) => this.store.getLauncherNetworkLease(candidate.leaseId))
    ))
      .filter((candidate): candidate is LauncherNetworkLease => Boolean(
        candidate
        && launcherNetworkLeaseIsActive(candidate)
        && launcherLeaseCapabilityMatches(candidate, capability.token)
      ))
      .map((candidate) => publicLauncherLease(candidate, capability.token));
    const publicLease = publicLauncherLease(lease, capability.token);
    const leaseResponse: typeof publicLease & {
      handoverLeases?: Array<ReturnType<typeof publicLauncherLease>>;
    } = handoverLeases.length > 0
      ? { ...publicLease, handoverLeases }
      : publicLease;
    return {
      lease: leaseResponse
    };
  }

  @Get('leases')
  async listLeases(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    const [leases, users] = await Promise.all([
      this.store.listLauncherNetworkLeases(),
      this.store.listUserCenterUserIdentities()
    ]);
    const usersById = new Map(users.map((user) => [user.userId, user]));
    return {
      leases: leases.map((lease) => opsLauncherLease(
        lease,
        lease.userId ? usersById.get(lease.userId) ?? null : null
      ))
    };
  }

  @Get('leases/:leaseId')
  async getLease(
    @Param('leaseId') leaseId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined
  ) {
    assertInternalOpsToken(opsToken);
    const lease = await this.store.getLauncherNetworkLease(leaseId);
    if (!lease) throw new NotFoundException('Launcher network lease not found');
    const user = lease.userId
      ? (await this.store.listUserCenterUserIdentities()).find((candidate) => candidate.userId === lease.userId) ?? null
      : null;
    return { lease: opsLauncherLease(lease, user) };
  }

  @Get('leases/:leaseId/activity')
  async getLeaseActivity(
    @Param('leaseId') leaseId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined
  ) {
    assertInternalOpsToken(opsToken);
    const lease = await this.store.getLauncherNetworkLease(leaseId);
    if (!lease) throw new NotFoundException('Launcher network lease not found');
    const activity = (await this.store.listAuditEvents({
      metadataLeaseId: lease.leaseId,
      limit: 50
    })).map(launcherLeaseActivityView);
    return {
      leaseId: lease.leaseId,
      source: 'audit-events' as const,
      count: activity.length,
      activity
    };
  }

  @Post('leases/:leaseId/release')
  async releaseLease(
    @Param('leaseId') leaseId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(LAUNCHER_LEASE_CAPABILITY_HEADER) leaseCapability: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    const body = asRecord(rawBody);
    const existing = await this.store.getLauncherNetworkLease(leaseId);
    if (!existing) throw new NotFoundException('Launcher network lease not found');
    if (!launcherNetworkLeaseIsActive(existing)) {
      if (
        !internalOpsTokenMatches(opsToken)
        && !launcherLeaseCapabilityMatches(existing, leaseCapability, { allowReleased: true })
      ) {
        throw new UnauthorizedException('A valid launcher lease capability is required');
      }
      return { lease: publicLauncherLease(existing) };
    }
    const lease = await this.requireLeaseAccess(
      leaseId,
      authorization,
      leaseCapability,
      opsToken,
      { allowInactiveUserCapability: true }
    );
    const released = await this.store.releaseLauncherNetworkLease(lease.leaseId, {
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
    return {
      lease: publicLauncherLease(released)
    };
  }

  @Post('leases/:leaseId/domestic-peer/sync')
  async syncDomesticPeer(
    @Param('leaseId') leaseId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(LAUNCHER_LEASE_CAPABILITY_HEADER) leaseCapability: string | undefined,
    @Headers(LAUNCHER_PEER_LEASE_CAPABILITY_HEADER) peerLeaseCapability: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    const body = asRecord(rawBody);
    const lease = await this.requireLeaseAccess(leaseId, authorization, leaseCapability, opsToken);
    const handover = await this.resolvePeerHandover(
      lease,
      body,
      authorization,
      peerLeaseCapability,
      opsToken,
      'domestic'
    );
    const domesticPeerSync = await syncDomesticRelayPeer(this.store, lease, {
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId),
      allowedIps: handover.allowedIps
    });
    await this.recordPeerHandoverResult(
      handover,
      'domestic',
      launcherPeerSyncSucceeded(domesticPeerSync),
      launcherPeerSyncError(domesticPeerSync)
    );
    return { lease: publicLauncherLease(lease), domesticPeerSync };
  }

  @Post('leases/:leaseId/domestic-relay/diagnostics')
  async diagnoseDomesticRelay(
    @Param('leaseId') leaseId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(LAUNCHER_LEASE_CAPABILITY_HEADER) leaseCapability: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    const body = asRecord(rawBody);
    const lease = await this.requireLeaseAccess(leaseId, authorization, leaseCapability, opsToken);
    const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease(this.store, lease, {
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
    return { lease: publicLauncherLease(lease), domesticRelayDiagnostics };
  }

  @Post('leases/:leaseId/internal-direct-peer/sync')
  async syncInternalDirectPeer(
    @Param('leaseId') leaseId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(LAUNCHER_LEASE_CAPABILITY_HEADER) leaseCapability: string | undefined,
    @Headers(LAUNCHER_PEER_LEASE_CAPABILITY_HEADER) peerLeaseCapability: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    const body = asRecord(rawBody);
    const lease = await this.requireLeaseAccess(leaseId, authorization, leaseCapability, opsToken);
    const handover = await this.resolvePeerHandover(
      lease,
      body,
      authorization,
      peerLeaseCapability,
      opsToken,
      'internal'
    );
    const internalDirectPeerSync = await syncInternalDirectPeerForLease(this.store, lease, {
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId),
      allowedIps: handover.allowedIps
    });
    await this.recordPeerHandoverResult(
      handover,
      'internal',
      launcherPeerSyncSucceeded(internalDirectPeerSync),
      launcherPeerSyncError(internalDirectPeerSync)
    );
    return { lease: publicLauncherLease(lease), internalDirectPeerSync };
  }

  @Get('products')
  async listProductNetworks() {
    return {
      products: await this.store.listLauncherProductNetworks()
    };
  }

  @Get('products/:productId/user-access')
  async listProductUserAccess(
    @Param('productId') rawProductId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined
  ) {
    assertInternalOpsToken(opsToken);
    const productId = normalizeLauncherNetworkProductId(rawProductId);
    const product = await this.store.getLauncherProductNetwork(productId);
    if (!product) throw new NotFoundException('Launcher product network not found');
    const [users, leases] = await Promise.all([
      this.store.listUserCenterUserIdentities(),
      this.store.listLauncherNetworkLeases(productId)
    ]);
    const entries = users
      .filter((user) => launcherProductUserAccessBlocked(user, productId))
      .map((user) => productUserAccessView(
        productUserAccessEntry(user, productId, leases),
        null
      ))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.userId.localeCompare(right.userId));
    return {
      productUserAccess: {
        productId,
        blockedUsers: entries,
        blockedUserCount: entries.length,
        generatedAt: new Date().toISOString()
      }
    };
  }

  @Get('products/:productId/users/:userId/access')
  async getProductUserAccess(
    @Param('productId') rawProductId: string,
    @Param('userId') userId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined
  ) {
    assertInternalOpsToken(opsToken);
    const productId = normalizeLauncherNetworkProductId(rawProductId);
    if (!await this.store.getLauncherProductNetwork(productId)) {
      throw new NotFoundException('Launcher product network not found');
    }
    const [users, leases] = await Promise.all([
      this.store.listUserCenterUserIdentities(),
      this.store.listLauncherNetworkLeases(productId)
    ]);
    const user = users.find((candidate) => candidate.userId === userId);
    if (!user) throw new NotFoundException('User not found');
    return {
      productUserAccess: productUserAccessView(
        productUserAccessEntry(user, productId, leases),
        null
      )
    };
  }

  @Post('products/:productId/users/:userId/access')
  async setProductUserAccess(
    @Param('productId') productId: string,
    @Param('userId') userId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    const body = asRecord(rawBody);
    if (typeof body.blocked !== 'boolean') {
      throw new BadRequestException('blocked must be a boolean');
    }
    const reason = nullableString(body.reason);
    if (reason && reason.length > 500) {
      throw new BadRequestException('reason must be 500 characters or fewer');
    }
    let result: LauncherProductUserAccessResult;
    try {
      result = await this.store.setLauncherProductUserAccess({
        productId,
        userId,
        blocked: body.blocked,
        reason,
        requestedBy: nullableString(body.requestedBy) ?? 'desktop-admin',
        requestId: nullableString(body.requestId) ?? `launcher-product-user-access-${Date.now()}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Launcher product not found:')) {
        throw new NotFoundException(message);
      }
      if (message.startsWith('User not found:')) {
        throw new NotFoundException(message);
      }
      throw error;
    }
    const leases = await this.store.listLauncherNetworkLeases(result.productId);
    return {
      productUserAccess: productUserAccessView(
        productUserAccessEntry(result.user, result.productId, leases),
        result
      )
    };
  }

  @Get('products/:productId')
  async getProductNetwork(@Param('productId') productId: string) {
    const product = await this.store.getLauncherProductNetwork(productId);
    if (!product) throw new NotFoundException('Launcher product network not found');
    return { product };
  }

  @Post('products/:productId')
  async upsertProductNetwork(
    @Param('productId') productId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    const body = asRecord(rawBody);
    return {
      product: await this.store.upsertLauncherProductNetwork({
        productId,
        displayName: nullableString(body.displayName),
        mode: nullableString(body.mode),
        networkScope: nullableString(body.networkScope),
        standaloneChannelProductId: nullableString(body.standaloneChannelProductId),
        productIndex: numberValue(body.productIndex),
        internalControlIp: nullableString(body.internalControlIp),
        domesticGatewayIp: nullableString(body.domesticGatewayIp),
        dnsServer: nullableString(body.dnsServer),
        serviceVip: nullableString(body.serviceVip),
        userCidr: nullableString(body.userCidr),
        feishuCidr: nullableString(body.feishuCidr),
        anonymousCidr: nullableString(body.anonymousCidr),
        userLeaseStart: nullableString(body.userLeaseStart),
        userLeaseEnd: nullableString(body.userLeaseEnd),
        feishuLeaseStart: nullableString(body.feishuLeaseStart),
        feishuLeaseEnd: nullableString(body.feishuLeaseEnd),
        anonymousLeaseStart: nullableString(body.anonymousLeaseStart),
        anonymousLeaseEnd: nullableString(body.anonymousLeaseEnd),
        defaultDomesticSiteId: nullableString(body.defaultDomesticSiteId),
        defaultOverseaSiteId: nullableString(body.defaultOverseaSiteId),
        updatePolicy: nullableString(body.updatePolicy),
        rateLimitProfile: nullableString(body.rateLimitProfile),
        dnsPolicyId: nullableString(body.dnsPolicyId),
        licensePolicyId: nullableString(body.licensePolicyId),
        anonymousEnrollmentPolicy: launcherAnonymousEnrollmentPolicyInput(body.anonymousEnrollmentPolicy),
        anonymousUiVisibility: launcherAnonymousUiVisibilityInput(body.anonymousUiVisibility),
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
  async upsertMihomoSite(
    @Param('siteId') siteId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
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

  private async requireLeaseAccess(
    leaseId: string,
    authorization: string | undefined,
    leaseCapability: string | undefined,
    opsToken: string | undefined,
    options: {
      allowInactiveUserCapability?: boolean;
      allowReleasedCapability?: boolean;
    } = {}
  ): Promise<LauncherNetworkLease> {
    const lease = await this.store.getLauncherNetworkLease(leaseId);
    if (!lease) throw new NotFoundException('Launcher network lease not found');
    if (
      lease.identityKind === 'user'
      && lease.userId
      && options.allowInactiveUserCapability !== true
      && !internalOpsTokenMatches(opsToken)
    ) {
      const user = (await this.store.listUserCenterUsers())
        .find((candidate) => candidate.userId === lease.userId);
      this.assertProductUserAccess(user, lease.productId);
    }
    if (!launcherNetworkLeaseIsActive(lease)) {
      if (
        options.allowReleasedCapability === true
        && (
          internalOpsTokenMatches(opsToken)
          || launcherLeaseCapabilityMatches(lease, leaseCapability, { allowReleased: true })
        )
      ) {
        return lease;
      }
      throw new UnauthorizedException('Launcher network lease is released or expired');
    }
    if (internalOpsTokenMatches(opsToken)) {
      return lease;
    }
    if (launcherLeaseCapabilityMatches(lease, leaseCapability)) {
      if (
        lease.identityKind === 'user'
        && lease.userId
        && options.allowInactiveUserCapability !== true
      ) {
        const user = (await this.store.listUserCenterUsers())
          .find((candidate) => candidate.userId === lease.userId);
        if (!user || user.status !== 'active') {
          throw new UnauthorizedException('Launcher lease user is disabled or no longer exists');
        }
        this.assertProductUserAccess(user, lease.productId);
      }
      return lease;
    }
    if (lease.identityKind !== 'user' || !lease.userId) {
      throw new UnauthorizedException('A valid launcher lease capability is required');
    }
    const token = bearerToken(authorization);
    if (!token) throw new UnauthorizedException('A valid launcher user token or lease capability is required');
    const introspection = await this.store.introspectToken({ token, audience: 'mx-sdk' });
    if (
      !introspection.active
      || introspection.tokenKind === 'shadow-token'
      || introspection.principal?.kind !== 'user'
      || introspection.principal.userId !== lease.userId
      || !['local-password', 'feishu'].includes(introspection.authProvider ?? '')
    ) {
      throw new UnauthorizedException('Launcher lease token is inactive or does not own this lease');
    }
    if (options.allowInactiveUserCapability !== true) {
      const user = (await this.store.listUserCenterUsers())
        .find((candidate) => candidate.userId === lease.userId);
      this.assertProductUserAccess(user, lease.productId);
    }
    return lease;
  }

  private assertProductUserAccess(
    user: UserCenterUser | undefined,
    productId: string
  ): void {
    try {
      assertLauncherProductUserAccess(user, productId);
    } catch (error) {
      rethrowLauncherNetworkPolicyError(error);
    }
  }

  private async resolvePeerHandover(
    lease: LauncherNetworkLease,
    body: Record<string, unknown>,
    authorization: string | undefined,
    peerLeaseCapability: string | undefined,
    opsToken: string | undefined,
    _peer: 'domestic' | 'internal'
  ): Promise<{
    phase: 'single' | 'prepare' | 'commit' | 'abort';
    allowedIps: string[];
    transition: LauncherNetworkHandover | null;
  }> {
    const phase = nullableString(body.handoverPhase);
    const peerLeaseId = nullableString(body.peerLeaseId);
    if (!phase && !peerLeaseId) {
      const pendingTransition = (await this.store.listLauncherNetworkHandovers())
        .find((candidate) => (
          !launcherNetworkHandoverTerminal(candidate)
          && (
            candidate.oldLeaseId === lease.leaseId
            || candidate.newLeaseId === lease.leaseId
          )
        ));
      if (pendingTransition) {
        throw new UnauthorizedException(
          'Launcher peer sync requires the active persisted handover transition'
        );
      }
      await this.assertCurrentLeaseGeneration(lease);
      return { phase: 'single', allowedIps: [`${lease.leaseIp}/32`], transition: null };
    }
    const transitionId = nullableString(body.transitionId);
    if (
      !peerLeaseId
      || !transitionId
      || !/^[A-Za-z0-9._-]{8,160}$/.test(transitionId)
      || !['prepare', 'commit', 'abort'].includes(phase ?? '')
    ) {
      throw new UnauthorizedException(
        'A valid transitionId, peer handover phase, and peerLeaseId are required'
      );
    }
    let transition = await this.store.getLauncherNetworkHandover(transitionId);
    const peerLease = await this.requireLeaseAccess(
      peerLeaseId,
      authorization,
      peerLeaseCapability,
      opsToken,
      {
        allowReleasedCapability: Boolean(
          transition && launcherNetworkHandoverTerminal(transition)
        )
      }
    );
    if (
      peerLease.leaseId === lease.leaseId
      || peerLease.productId !== lease.productId
      || peerLease.installId !== lease.installId
      || peerLease.deviceId !== lease.deviceId
      || peerLease.domesticSiteId !== lease.domesticSiteId
      || !peerLease.publicKey
      || peerLease.publicKey !== lease.publicKey
    ) {
      throw new UnauthorizedException('Launcher peer handover leases do not belong to the same device and public key');
    }
    const resolvedPhase = phase as 'prepare' | 'commit' | 'abort';
    const newLease = resolvedPhase === 'abort' ? peerLease : lease;
    const oldLease = resolvedPhase === 'abort' ? lease : peerLease;
    if (
      (Number(newLease.generation) || 0) <= (Number(oldLease.generation) || 0)
      || (newLease.replacementForLeaseId && newLease.replacementForLeaseId !== oldLease.leaseId)
    ) {
      throw new UnauthorizedException(
        'Launcher peer handover direction does not match the newer lease generation'
      );
    }
    if (transition?.status !== 'aborted') {
      await this.assertCurrentLeaseGeneration(newLease);
    }
    const product = await this.store.getLauncherProductNetwork(newLease.productId);
    const newLeaseProfile = launcherNetworkLeaseProfile(
      newLease.leaseProfile,
      newLease.identityKind
    );
    if (
      !product
      || !launcherNetworkLeaseMatchesProfile(product, newLeaseProfile, newLease)
    ) {
      throw new UnauthorizedException(
        'Launcher peer handover target does not belong to its configured profile range'
      );
    }
    if (resolvedPhase === 'prepare' && !transition) {
      const deadlineAt = new Date(
        Date.now() + Math.max(10_000, this.config.launcherNetworkHandoverTtlMs)
      ).toISOString();
      const peerRequirements = await this.launcherHandoverPeerRequirements(newLease);
      try {
        transition = await this.store.createLauncherNetworkHandover({
          transitionId,
          productId: newLease.productId,
          installId: newLease.installId,
          deviceId: newLease.deviceId,
          publicKey: newLease.publicKey as string,
          oldLeaseId: oldLease.leaseId,
          newLeaseId: newLease.leaseId,
          oldLeaseIp: oldLease.leaseIp,
          newLeaseIp: newLease.leaseIp,
          ...peerRequirements,
          deadlineAt
        });
      } catch {
        transition = await this.store.getLauncherNetworkHandover(transitionId);
      }
    }
    if (!transition || !launcherNetworkHandoverMatchesLeases(transition, oldLease, newLease)) {
      throw new UnauthorizedException(
        'Launcher peer handover does not match a persisted transition'
      );
    }
    if (
      resolvedPhase !== 'abort'
      && Date.parse(transition.deadlineAt) <= Date.now()
    ) {
      throw new UnauthorizedException(
        'Launcher peer handover deadline expired and the transition is being aborted'
      );
    }
    if (
      (resolvedPhase === 'prepare'
        && !['preparing', 'prepared'].includes(transition.status))
      || (resolvedPhase === 'commit'
        && !['prepared', 'commit-pending', 'committed'].includes(transition.status))
      || (resolvedPhase === 'abort'
        && !['preparing', 'prepared', 'commit-pending', 'abort-pending', 'aborted']
          .includes(transition.status))
    ) {
      throw new UnauthorizedException(
        `Launcher peer handover cannot ${resolvedPhase} from ${transition.status}`
      );
    }
    return {
      phase: resolvedPhase,
      allowedIps: resolvedPhase === 'prepare'
        ? [...new Set([`${peerLease.leaseIp}/32`, `${lease.leaseIp}/32`])]
        : [`${lease.leaseIp}/32`],
      transition
    };
  }

  private async launcherHandoverPeerRequirements(
    lease: LauncherNetworkLease
  ): Promise<{ domesticRequired: boolean; internalRequired: boolean }> {
    const secret = await this.store.getSiteSlotDomesticWireGuardSecret(
      lease.domesticSiteId || lease.siteId
    );
    const internalRequired = Boolean(
      secret?.internalDirectEnabled === true
      && secret.internalDirectEndpoint
      && secret.internalServicePublicKey
    );
    const domesticConfigured = Boolean(
      secret?.publicEndpoint
      && secret.domesticRelayPublicKey
    );
    return {
      domesticRequired: domesticConfigured || !internalRequired,
      internalRequired
    };
  }

  private async recordPeerHandoverResult(
    handover: {
      phase: 'single' | 'prepare' | 'commit' | 'abort';
      transition: LauncherNetworkHandover | null;
    },
    peer: 'domestic' | 'internal',
    success: boolean,
    error: string | null
  ): Promise<void> {
    if (handover.phase === 'single' || !handover.transition) return;
    const transition = await this.store.advanceLauncherNetworkHandover({
      transitionId: handover.transition.transitionId,
      peer,
      phase: handover.phase,
      success,
      error
    });
    await this.retireCompletedHandoverLease(transition);
  }

  async reconcileExpiredHandovers(
    now = new Date(),
    syncOverride?: (
      handover: LauncherNetworkHandover,
      oldLease: LauncherNetworkLease
    ) => Promise<{
      domesticPeerSync: { status?: string; execution?: string; error?: string };
      internalPeerSync: { status?: string; execution?: string; error?: string };
    }>
  ): Promise<void> {
    if (this.handoverReconcileInFlight) return this.handoverReconcileInFlight;
    this.handoverReconcileInFlight = this.runExpiredHandoverReconciliation(now, syncOverride)
      .finally(() => {
        this.handoverReconcileInFlight = null;
      });
    return this.handoverReconcileInFlight;
  }

  private async runExpiredHandoverReconciliation(
    now: Date,
    syncOverride?: (
      handover: LauncherNetworkHandover,
      oldLease: LauncherNetworkLease
    ) => Promise<{
      domesticPeerSync: { status?: string; execution?: string; error?: string };
      internalPeerSync: { status?: string; execution?: string; error?: string };
    }>
  ): Promise<void> {
    const handovers = (await this.store.listLauncherNetworkHandovers())
      .filter((handover) => (
        handover.status === 'abort-pending'
        || (
          !launcherNetworkHandoverTerminal(handover)
          && Date.parse(handover.deadlineAt) <= now.getTime()
        )
      ));
    for (const handover of handovers) {
      const oldLease = await this.store.getLauncherNetworkLease(handover.oldLeaseId);
      const newLease = await this.store.getLauncherNetworkLease(handover.newLeaseId);
      if (!oldLease || !newLease || !launcherNetworkLeaseIsActive(oldLease, now)) {
        const error = 'Persisted launcher handover cannot abort because its old lease is unavailable';
        await Promise.all([
          this.store.advanceLauncherNetworkHandover({
            transitionId: handover.transitionId,
            peer: 'domestic',
            phase: 'abort',
            success: false,
            error
          }),
          this.store.advanceLauncherNetworkHandover({
            transitionId: handover.transitionId,
            peer: 'internal',
            phase: 'abort',
            success: false,
            error
          })
        ]);
        continue;
      }
      const allowedIps = [`${oldLease.leaseIp}/32`];
      let domesticPeerSync;
      let internalPeerSync;
      if (syncOverride) {
        ({ domesticPeerSync, internalPeerSync } = await syncOverride(handover, oldLease));
      } else {
        const [domesticResult, internalResult] = await Promise.allSettled([
          handover.domesticRequired === false
            ? Promise.resolve({ status: 'skipped', execution: 'not-started' })
            : syncDomesticRelayPeer(this.store, oldLease, {
                requestedBy: 'launcher-handover-reconciler',
                requestId: `${handover.transitionId}:deadline-abort:domestic`,
                allowedIps
              }),
          handover.internalRequired === false
            ? Promise.resolve({ status: 'skipped', execution: 'not-started' })
            : syncInternalDirectPeerForLease(this.store, oldLease, {
                requestedBy: 'launcher-handover-reconciler',
                requestId: `${handover.transitionId}:deadline-abort:internal`,
                allowedIps
              })
        ]);
        domesticPeerSync = domesticResult.status === 'fulfilled'
          ? domesticResult.value
          : { status: 'failed', error: String(domesticResult.reason) };
        internalPeerSync = internalResult.status === 'fulfilled'
          ? internalResult.value
          : { status: 'failed', error: String(internalResult.reason) };
      }
      await this.store.advanceLauncherNetworkHandover({
        transitionId: handover.transitionId,
        peer: 'domestic',
        phase: 'abort',
        success: launcherPeerSyncSucceeded(domesticPeerSync),
        error: launcherPeerSyncError(domesticPeerSync)
      });
      const transition = await this.store.advanceLauncherNetworkHandover({
        transitionId: handover.transitionId,
        peer: 'internal',
        phase: 'abort',
        success: launcherPeerSyncSucceeded(internalPeerSync),
        error: launcherPeerSyncError(internalPeerSync)
      });
      await this.retireCompletedHandoverLease(transition);
    }
  }

  private async retireCompletedHandoverLease(
    transition: LauncherNetworkHandover
  ): Promise<void> {
    if (!launcherNetworkHandoverTerminal(transition)) return;
    const retiredLeaseId = transition.status === 'committed'
      ? transition.oldLeaseId
      : transition.newLeaseId;
    const retiredLease = await this.store.getLauncherNetworkLease(retiredLeaseId);
    if (!retiredLease || !launcherNetworkLeaseIsActive(retiredLease)) return;
    await this.store.releaseLauncherNetworkLease(retiredLeaseId, {
      requestedBy: 'launcher-network-handover',
      requestId: `${transition.transitionId}:${transition.status}:retire`
    });
  }

  private async assertCurrentLeaseGeneration(lease: LauncherNetworkLease): Promise<void> {
    if (!lease.publicKey) return;
    const candidates = (await this.store.listLauncherNetworkLeases(lease.productId))
      .filter((candidate) => (
        launcherNetworkLeaseIsActive(candidate)
        && candidate.publicKey === lease.publicKey
        && candidate.installId === lease.installId
        && candidate.deviceId === lease.deviceId
      ))
      .sort((left, right) => (
        (Number(right.generation) || 0) - (Number(left.generation) || 0)
        || right.updatedAt.localeCompare(left.updatedAt)
        || right.leaseId.localeCompare(left.leaseId)
      ));
    if (candidates[0]?.leaseId !== lease.leaseId) {
      throw new UnauthorizedException(
        'Launcher network lease was superseded by a newer lease for this device key'
      );
    }
  }
}

function launcherNetworkHandoverTerminal(
  handover: LauncherNetworkHandover
): boolean {
  return handover.status === 'committed' || handover.status === 'aborted';
}

function launcherNetworkHandoverMatchesLeases(
  handover: LauncherNetworkHandover,
  oldLease: LauncherNetworkLease,
  newLease: LauncherNetworkLease
): boolean {
  return handover.productId === newLease.productId
    && handover.installId === newLease.installId
    && handover.deviceId === newLease.deviceId
    && handover.publicKey === newLease.publicKey
    && handover.oldLeaseId === oldLease.leaseId
    && handover.newLeaseId === newLease.leaseId
    && handover.oldLeaseIp === oldLease.leaseIp
    && handover.newLeaseIp === newLease.leaseIp;
}

function launcherPeerSyncSucceeded(result: {
  status?: string | null;
  execution?: string | null;
} | null | undefined): boolean {
  return ['passed', 'skipped'].includes(result?.status ?? '')
    || result?.execution === 'passed';
}

function launcherPeerSyncError(result: {
  status?: string | null;
  execution?: string | null;
  error?: string | null;
  message?: string | null;
  failures?: unknown;
} | null | undefined): string | null {
  if (!result) return 'Launcher peer sync returned no result';
  if (launcherPeerSyncSucceeded(result)) return null;
  if (result.error) return result.error;
  if (result.message) return result.message;
  if (Array.isArray(result.failures)) return result.failures.map(String).join('; ');
  return 'Launcher peer sync did not pass';
}

function rethrowLauncherNetworkPolicyError(error: unknown): never {
  if (error instanceof LauncherAnonymousEnrollmentPolicyError) {
    throw new ForbiddenException({
      code: error.code,
      message: error.message
    });
  }
  if (error instanceof LauncherProductUserAccessDeniedError) {
    throw new ForbiddenException({
      code: error.code,
      message: error.message,
      productId: error.productId,
      userId: error.userId
    });
  }
  throw error;
}

function publicLauncherLease(
  lease: LauncherNetworkLease,
  capability?: string
): Omit<LauncherNetworkLease, 'capabilityDigest' | 'capabilityVersion' | 'capabilityExpiresAt' | 'sourceIp'>
  & { capability?: string } {
  const {
    capabilityDigest: _capabilityDigest,
    capabilityVersion: _capabilityVersion,
    capabilityExpiresAt: _capabilityExpiresAt,
    sourceIp: _sourceIp,
    ...safeLease
  } = lease;
  return capability ? { ...safeLease, capability } : safeLease;
}

function opsLauncherLease(
  lease: LauncherNetworkLease,
  user: UserCenterUserIdentity | null
): OpsLauncherNetworkLease {
  const {
    capabilityDigest: _capabilityDigest,
    capabilityVersion: _capabilityVersion,
    capabilityExpiresAt: _capabilityExpiresAt,
    ...safeLease
  } = lease;
  return {
    ...safeLease,
    userDisplayName: user?.displayName ?? null,
    userAccount: user?.account ?? null
  };
}

function launcherLeaseActivityView(event: AuditEvent) {
  const known = launcherLeaseActivityPresentation(event);
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    createdAt: event.createdAt,
    siteId: event.siteId,
    requestId: event.requestId,
    summary: known.summary,
    status: known.status,
    plane: known.plane
  };
}

function launcherLeaseActivityPresentation(event: AuditEvent): {
  summary: string;
  status: 'passed' | 'blocked' | 'recorded';
  plane: 'control-plane' | 'domestic' | 'internal-direct' | 'audit';
} {
  if (event.eventType === 'launcher_network.lease.enrolled') {
    return { summary: 'Lease enrolled', status: 'recorded', plane: 'control-plane' };
  }
  if (event.eventType === 'launcher_network.lease.refreshed') {
    return { summary: 'Lease renewed', status: 'recorded', plane: 'control-plane' };
  }
  if (event.eventType === 'launcher_network.lease.released') {
    return { summary: 'Lease released', status: 'recorded', plane: 'control-plane' };
  }
  if (event.eventType === 'launcher_network.domestic_peer.synced') {
    return { summary: 'Domestic WireGuard peer synchronized', status: 'passed', plane: 'domestic' };
  }
  if (event.eventType === 'launcher_network.domestic_relay.diagnosed') {
    return {
      summary: 'Domestic relay diagnostics recorded',
      status: launcherLeaseActivityRecordedStatus(event),
      plane: 'domestic'
    };
  }
  if (event.eventType === 'launcher_network.internal_direct_peer.synced') {
    return {
      summary: 'Internal direct WireGuard peer synchronized',
      status: launcherLeaseActivityRecordedStatus(event),
      plane: 'internal-direct'
    };
  }
  return { summary: 'Lease-linked audit event', status: 'recorded', plane: 'audit' };
}

function launcherLeaseActivityRecordedStatus(event: AuditEvent): 'passed' | 'blocked' | 'recorded' {
  const status = event.metadata?.status;
  return status === 'passed' || status === 'blocked' ? status : 'recorded';
}

function productUserAccessEntry(
  user: UserCenterUserIdentity,
  productId: string,
  leases: LauncherNetworkLease[]
) {
  const userLeases = leases
    .filter((lease) => lease.identityKind === 'user' && lease.userId === user.userId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const lastLease = userLeases[0] ?? null;
  return {
    productId,
    userId: user.userId,
    blocked: launcherProductUserAccessBlocked(user, productId),
    account: user.account,
    displayName: user.displayName,
    userStatus: user.status,
    userUpdatedAt: user.updatedAt,
    activeLeaseIds: userLeases
      .filter((lease) => launcherNetworkLeaseIsActive(lease))
      .map((lease) => lease.leaseId),
    lastLease: lastLease ? {
      leaseId: lastLease.leaseId,
      status: lastLease.status,
      leaseIp: lastLease.leaseIp,
      sourceIp: lastLease.sourceIp ?? null,
      installId: lastLease.installId,
      deviceId: lastLease.deviceId,
      deviceLabel: lastLease.deviceLabel,
      platform: lastLease.platform,
      appVersion: lastLease.appVersion ?? null,
      updatedAt: lastLease.updatedAt,
      releasedAt: lastLease.releasedAt ?? null
    } : null
  };
}

function productUserAccessView(
  entry: ReturnType<typeof productUserAccessEntry>,
  result: LauncherProductUserAccessResult | null
) {
  const releasedLeaseIds = result?.releasedLeases.map((lease) => lease.leaseId) ?? [];
  return {
    ...entry,
    changed: result?.changed ?? false,
    reason: result?.reason ?? null,
    updatedAt: result?.updatedAt ?? entry.userUpdatedAt,
    controlPlane: {
      admission: entry.blocked ? 'blocked' : 'allowed',
      activeLeaseIds: entry.activeLeaseIds,
      releasedLeaseIds,
      releasedLeaseCount: releasedLeaseIds.length,
      userStatusChanged: false,
      tokensRevoked: 0
    },
    runtimePeerRemoval: {
      status: entry.blocked ? 'not-performed' : 'not-requested',
      domestic: 'not-performed',
      internalDirect: 'not-performed',
      message: entry.blocked
        ? 'Control-plane admission is blocked and active database leases were released; WireGuard peer removal was not performed or confirmed.'
        : 'No WireGuard peer removal was requested by this product access operation.'
    }
  };
}

function launcherAnonymousEnrollmentPolicyInput(
  value: unknown
): 'enabled' | 'drain' | 'disabled' | null {
  if (value === undefined || value === null) return null;
  const policy = typeof value === 'string' ? value.trim() : '';
  if (policy === 'enabled' || policy === 'drain' || policy === 'disabled') return policy;
  throw new BadRequestException('anonymousEnrollmentPolicy must be enabled, drain, or disabled');
}

function launcherAnonymousUiVisibilityInput(
  value: unknown
): 'primary' | 'advanced' | 'hidden' | null {
  if (value === undefined || value === null) return null;
  const visibility = typeof value === 'string' ? value.trim() : '';
  if (visibility === 'primary' || visibility === 'advanced' || visibility === 'hidden') return visibility;
  throw new BadRequestException('anonymousUiVisibility must be primary, advanced, or hidden');
}

async function authorizedLeaseIdentity(
  store: PlatformStore,
  authorization: string | undefined,
  requestedUserId: string | null,
  requestedLeaseProfile: string | null,
  userLeaseRequested: boolean,
  allowLegacyUnauthenticatedUserLease: boolean
): Promise<{ userId: string | null; leaseProfile: 'employee' | 'feishu' | 'anonymous' }> {
  if (!userLeaseRequested) {
    return { userId: null, leaseProfile: 'anonymous' };
  }
  const token = bearerToken(authorization);
  if (!token) {
    if (requestedLeaseProfile === 'feishu') {
      throw new UnauthorizedException('Feishu launcher leases require a Feishu-authenticated MX token');
    }
    if (!allowLegacyUnauthenticatedUserLease) {
      throw new UnauthorizedException('Launcher employee leases require an active MX user token');
    }
    const requestedUser = requestedUserId
      ? (await store.listUserCenterUsers()).find((user) => user.userId === requestedUserId)
      : null;
    if (
      !requestedUser
      || requestedUser.status !== 'active'
      || requestedUser.credential.hasPassword !== true
    ) {
      throw new UnauthorizedException('Legacy launcher employee leases require an active password user');
    }
    return { userId: requestedUserId, leaseProfile: 'employee' };
  }
  const introspection = await store.introspectToken({ token, audience: 'mx-sdk' });
  const tokenUserId = introspection.principal?.userId ?? null;
  if (
    !introspection.active
    || introspection.tokenKind === 'shadow-token'
    || introspection.principal?.kind !== 'user'
    || !tokenUserId
  ) {
    throw new UnauthorizedException('Launcher user lease token is inactive or has no user principal');
  }
  if (requestedUserId && requestedUserId !== tokenUserId) {
    throw new UnauthorizedException('Launcher user lease token subject does not match userId');
  }
  if (introspection.authProvider === 'feishu') {
    return { userId: tokenUserId, leaseProfile: 'feishu' };
  }
  if (requestedLeaseProfile === 'feishu') {
    throw new UnauthorizedException('Only a Feishu-authenticated MX token can select the Feishu lease pool');
  }
  if (introspection.authProvider === 'local-password') {
    return { userId: tokenUserId, leaseProfile: 'employee' };
  }
  throw new UnauthorizedException('Launcher employee leases require a local-password or Feishu login token');
}

function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
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
  input: { requestedBy?: string | null; requestId?: string | null; allowedIps?: string[] }
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

  const allowedIps = input.allowedIps?.length ? input.allowedIps : [`${lease.leaseIp}/32`];
  const script = domesticRelayPeerSyncScript(lease.publicKey ?? '', allowedIps);
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
        allowedIps,
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

function domesticRelayPeerSyncScript(publicKey: string, allowedIps: string[]): string {
  const normalizedAllowedIps = [...new Set(allowedIps)];
  const allowedIpList = normalizedAllowedIps.join(',');
  const routeCidrs = [...new Set(normalizedAllowedIps.flatMap(domesticRelayRouteCidrsForAllowedIp))];
  return [
    'set -eu',
    'printf "mx-launcher-domestic-peer-sync\\n"',
    `allowed_ips=${shellQuote(allowedIpList)}`,
    `relay_route_cidrs=${shellQuote(routeCidrs.join(' '))}`,
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    `wg set mx-domestic peer ${shellQuote(publicKey)} allowed-ips ${shellQuote(allowedIpList)}`,
    'ip link set up dev mx-domestic',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null || true',
    ...domesticRelayFirewallEnsureCommands(),
    'for route_cidr in $relay_route_cidrs; do ip route replace "$route_cidr" dev mx-domestic; done',
    'old_ifs="$IFS"; IFS=","; for allowed_ip in $allowed_ips; do ip route replace "$allowed_ip" dev mx-domestic || true; done; IFS="$old_ifs"',
    'if command -v wg-quick >/dev/null 2>&1; then wg-quick save mx-domestic || true; fi',
    `printf "peer=%s\\n" ${shellQuote(publicKey)}`,
    `printf "allowed_ips=%s\\n" ${shellQuote(allowedIpList)}`,
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

async function syncInternalDirectPeerForLease(
  store: PlatformStore,
  lease: LauncherNetworkLease,
  input: { requestedBy?: string | null; requestId?: string | null; allowedIps?: string[] }
) {
  const checkedAt = new Date().toISOString();
  const siteId = lease.domesticSiteId || lease.siteId;
  const secret = await store.getSiteSlotDomesticWireGuardSecret(siteId);
  const plan = await latestDomesticPlan(store, siteId);
  const failures = internalDirectPeerSyncFailures(lease, secret);
  if (failures.length > 0) {
    return {
      status: 'blocked' as const,
      execution: 'not-started' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      internalDirect: internalDirectPeerEvidence(secret),
      failures
    };
  }

  try {
    const allowedIps = input.allowedIps?.length ? input.allowedIps : [`${lease.leaseIp}/32`];
    const payload = await postInternalServicePeerHostRunner('/internal-service-peer/direct-peer-sync', {
      siteId,
      planId: plan?.planId ?? null,
      interfaceName: 'mx-internal-svc',
      internalServiceIp: secret?.internalServiceIp ?? '10.88.88.88',
      leaseId: lease.leaseId,
      peerPublicKey: lease.publicKey,
      peerAllowedIp: allowedIps[0],
      peerAllowedIps: allowedIps,
      requestedBy: input.requestedBy ?? 'launcher-network',
      requestId: input.requestId ?? null
    });
    const directPeerSync = asRecord(payload.directPeerSync ?? payload);
    await store.recordAudit({
      eventType: 'launcher_network.internal_direct_peer.synced',
      actorKind: lease.identityKind === 'user' ? 'user' : 'install',
      userId: lease.userId,
      installId: lease.installId,
      deviceId: lease.deviceId,
      productId: lease.productId,
      siteId,
      overlayIp: lease.leaseIp,
      requestId: input.requestId ?? null,
      metadata: {
        leaseId: lease.leaseId,
        publicKey: lease.publicKey,
        allowedIps,
        status: directPeerSync.status ?? null,
        requestedBy: input.requestedBy ?? 'launcher-network'
      }
    });
    return {
      status: directPeerSync.status === 'passed' ? 'passed' as const : 'blocked' as const,
      execution: directPeerSync.execution === 'completed' ? 'executed' as const : 'not-started' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      internalDirect: internalDirectPeerEvidence(secret),
      result: directPeerSync
    };
  } catch (error) {
    return {
      status: 'failed' as const,
      execution: 'failed' as const,
      checkedAt,
      lease: domesticRelayLeaseEvidence(lease),
      internalDirect: internalDirectPeerEvidence(secret),
      failures: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function internalDirectPeerSyncFailures(
  lease: LauncherNetworkLease,
  secret: SiteSlotDomesticWireGuardSecret | null
): string[] {
  return [
    ...(lease.status === 'active' ? [] : [`lease is not active: ${lease.status}`]),
    ...(lease.publicKey ? [] : ['lease publicKey is required before Internal direct peer sync']),
    ...(lease.publicKey && validWireGuardPublicKey(lease.publicKey) ? [] : lease.publicKey ? ['lease publicKey is not a valid WireGuard public key'] : []),
    ...(validRelayLeaseIp(lease.leaseIp) ? [] : ['leaseIp must be in launcher product relay range']),
    ...(secret ? [] : [`Domestic WG secret not found for site ${lease.domesticSiteId || lease.siteId}`]),
    ...(secret?.status === 'active' ? [] : secret ? [`Domestic WG secret is ${secret.status}`] : []),
    ...(secret?.internalDirectEnabled === true ? [] : ['Internal direct peer is not enabled in Config Center']),
    ...(secret?.internalDirectEndpoint ? [] : ['Internal direct endpoint is not configured']),
    ...(secret?.internalServicePublicKey ? [] : ['Internal service public key is missing'])
  ];
}

function internalDirectPeerEvidence(secret: SiteSlotDomesticWireGuardSecret | null) {
  return {
    siteId: secret?.siteId ?? null,
    enabled: secret?.internalDirectEnabled === true,
    endpoint: secret?.internalDirectEndpoint ?? null,
    listenPort: secret?.internalDirectListenPort ?? null,
    internalServiceIp: secret?.internalServiceIp ?? null,
    publicKeyStatus: secret?.internalServicePublicKey ? 'configured' : 'missing'
  };
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

async function postInternalServicePeerHostRunner(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const baseUrls = internalServicePeerHostRunnerUrlCandidates();
  if (baseUrls.length === 0) throw new Error('MX_INTERNAL_HOST_RUNNER_URL is not configured');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.MX_INTERNAL_HOST_RUNNER_TOKEN?.trim();
  if (token) headers['x-mx-host-runner-token'] = token;
  const errors: string[] = [];
  for (const baseUrl of baseUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let payload: unknown = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${baseUrl}${path}: ${text.slice(0, 500)}`);
      return asRecord(payload);
    } catch (error) {
      errors.push(`${baseUrl}${path} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(errors.join('; '));
}

function internalServicePeerHostRunnerUrlCandidates(): string[] {
  return uniqueStrings([
    internalServicePeerNativeHostRunnerUrl(),
    explicitInternalServicePeerHostRunnerUrl(),
    internalServicePeerK8sHostRunnerFallbackEnabled() ? internalServicePeerK8sHostRunnerUrl() : null
  ].filter((item): item is string => Boolean(item)));
}

function explicitInternalServicePeerHostRunnerUrl(): string | null {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_URL ?? process.env.MX_INTERNAL_SERVICE_PEER_HOST_RUNNER_URL;
  return raw?.trim() ? raw.trim().replace(/\/+$/, '') : null;
}

function internalServicePeerNativeHostRunnerUrl(): string | null {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_NATIVE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  const port = internalServicePeerK8sHostRunnerPort();
  return `http://host.docker.internal:${port}`;
}

function internalServicePeerK8sHostRunnerFallbackEnabled(): boolean {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_K8S_FALLBACK_ENABLED;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function internalServicePeerK8sHostRunnerUrl(): string | null {
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_K8S_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  const name = process.env.MX_INTERNAL_HOST_RUNNER_K8S_NAME?.trim() || 'mx-internal-host-runner';
  const namespace = process.env.MX_INTERNAL_HOST_RUNNER_K8S_NAMESPACE?.trim()
    || process.env.POD_NAMESPACE?.trim()
    || 'mx-internal-shadow';
  return `http://${name}.${namespace}.svc.cluster.local:${internalServicePeerK8sHostRunnerPort()}`;
}

function internalServicePeerK8sHostRunnerPort(): number {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_PORT?.trim()
    || process.env.MX_INTERNAL_HOST_RUNNER_K8S_PORT?.trim()
    || '19190';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 19190;
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
  return /^[A-Za-z0-9+/]{43}=$/.test(value.trim());
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
