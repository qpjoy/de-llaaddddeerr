import { createHash } from 'node:crypto';

export interface AuthenticationRateLimitInput {
  bucketKey: string;
  limit: number;
  windowSeconds: number;
  now?: string | null;
}

export interface AuthenticationRateLimitState {
  windowStartedAt: string;
  count: number;
}

export interface AuthenticationRateLimitDecision extends AuthenticationRateLimitState {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
}

export function authenticationRateLimitBucketKey(scope: string, value: string): string {
  const safeScope = scope.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 48);
  if (!safeScope) throw new Error('authentication rate-limit scope is required');
  const digest = createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  return `${safeScope}:${digest}`;
}

export function consumeFixedWindowRateLimit(
  previous: AuthenticationRateLimitState | null | undefined,
  input: AuthenticationRateLimitInput
): AuthenticationRateLimitDecision {
  const bucketKey = input.bucketKey?.trim();
  if (!bucketKey || bucketKey.length > 160) {
    throw new Error('authentication rate-limit bucketKey must contain at most 160 characters');
  }
  const limit = positiveInteger(input.limit, 'limit');
  const windowSeconds = positiveInteger(input.windowSeconds, 'windowSeconds');
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error('authentication rate-limit now must be an ISO timestamp');

  const previousStartMs = previous ? Date.parse(previous.windowStartedAt) : Number.NaN;
  const previousCount = previous && Number.isInteger(previous.count) && previous.count >= 0
    ? previous.count
    : 0;
  const windowMs = windowSeconds * 1000;
  const resetWindow = !Number.isFinite(previousStartMs)
    || previousStartMs > nowMs
    || nowMs - previousStartMs >= windowMs;
  const windowStartedAt = new Date(resetWindow ? nowMs : previousStartMs).toISOString();
  const count = (resetWindow ? 0 : previousCount) + 1;
  const resetAtMs = Date.parse(windowStartedAt) + windowMs;

  return {
    windowStartedAt,
    count,
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(resetAtMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000))
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`authentication rate-limit ${field} must be a positive integer`);
  }
  return value;
}
