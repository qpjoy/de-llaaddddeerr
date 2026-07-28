import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

import type { LauncherNetworkLease } from '../types.js';

export const LAUNCHER_LEASE_CAPABILITY_HEADER = 'x-mx-lease-capability';
export const LAUNCHER_LEASE_CAPABILITY_VERSION = 1;

export interface MintedLauncherLeaseCapability {
  token: string;
  digest: string;
  version: number;
}

export function mintLauncherLeaseCapability(): MintedLauncherLeaseCapability {
  return launcherLeaseCapabilityMaterial(`mxlc1.${randomBytes(32).toString('base64url')}`);
}

export function launcherLeaseCapabilityMaterial(token: string): MintedLauncherLeaseCapability {
  const normalized = token.trim();
  if (!/^mxlc1\.[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new UnauthorizedException('A valid new launcher lease capability is required');
  }
  return {
    token: normalized,
    digest: launcherLeaseCapabilityDigest(normalized),
    version: LAUNCHER_LEASE_CAPABILITY_VERSION
  };
}

export function assertLauncherLeaseCapability(
  lease: LauncherNetworkLease,
  provided: string | undefined
): void {
  if (!launcherLeaseCapabilityMatches(lease, provided)) {
    throw new UnauthorizedException('A valid launcher lease capability is required');
  }
}

export function launcherLeaseCapabilityMatches(
  lease: LauncherNetworkLease,
  provided: string | undefined,
  options: { allowReleased?: boolean } = {}
): boolean {
  return launcherLeaseCapabilityCandidates(provided)
    .some((candidate) => launcherLeaseCapabilityTokenMatches(lease, candidate, options));
}

function launcherLeaseCapabilityTokenMatches(
  lease: LauncherNetworkLease,
  candidate: string,
  options: { allowReleased?: boolean }
): boolean {
  const expected = lease.capabilityDigest?.trim() ?? '';
  if (
    (lease.status !== 'active' && options.allowReleased !== true)
    || lease.capabilityVersion !== LAUNCHER_LEASE_CAPABILITY_VERSION
    || !expected
    || !candidate.startsWith('mxlc1.')
  ) {
    return false;
  }
  const expiresAt = Date.parse(lease.capabilityExpiresAt ?? lease.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return false;
  const candidateDigest = launcherLeaseCapabilityDigest(candidate);
  const expectedBytes = Buffer.from(expected, 'hex');
  const candidateBytes = Buffer.from(candidateDigest, 'hex');
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

function launcherLeaseCapabilityCandidates(provided: string | undefined): string[] {
  return [...new Set(String(provided ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('mxlc1.')))]
    .slice(0, 16);
}

function launcherLeaseCapabilityDigest(token: string): string {
  return createHash('sha256')
    .update('mx-launcher-lease-capability-v1\0')
    .update(token)
    .digest('hex');
}
