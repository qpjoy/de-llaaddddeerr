import { timingSafeEqual } from 'node:crypto';

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

export const INTERNAL_OPS_TOKEN_HEADER = 'x-mx-ops-token';

export function assertInternalOpsToken(provided: string | undefined): void {
  const expected = process.env.MX_INTERNAL_OPS_TOKEN?.trim();
  if (!expected) {
    throw new ServiceUnavailableException('Internal ops authentication is not configured');
  }
  if (!secureTokenEqual(provided?.trim() ?? '', expected)) {
    throw new UnauthorizedException('A valid Internal ops token is required');
  }
}

export function internalOpsTokenMatches(candidate: string | undefined): boolean {
  const expected = process.env.MX_INTERNAL_OPS_TOKEN?.trim();
  return Boolean(expected && secureTokenEqual(candidate?.trim() ?? '', expected));
}

function secureTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
