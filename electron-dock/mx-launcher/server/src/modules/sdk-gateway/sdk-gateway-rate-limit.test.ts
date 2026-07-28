import assert from 'node:assert/strict';
import test from 'node:test';

import type { HttpException } from '@nestjs/common';

import {
  authenticationRateLimitBucketKey,
  consumeFixedWindowRateLimit,
  type AuthenticationRateLimitInput,
  type AuthenticationRateLimitState
} from '../../lib/auth-rate-limit.js';
import type { PlatformStore } from '../../store/platform-store.js';
import type { UserCenterUser } from '../../types.js';
import { SdkGatewayController } from './sdk-gateway.controller.js';
import type { FeishuAuthService } from './feishu-auth.service.js';

const activeUser: UserCenterUser = {
  userId: 'usr_alice',
  tenantId: 'tenant_internal',
  orgIds: ['org_internal'],
  account: 'alice',
  email: 'alice@example.com',
  displayName: 'Alice Example',
  roleIds: ['mx-user'],
  status: 'active',
  profile: {
    title: null,
    department: null,
    location: null,
    address: null,
    phone: null,
    tags: [],
    attributes: {},
    externalIds: {}
  },
  credential: {
    hasPassword: true,
    passwordUpdatedAt: '2026-07-27T00:00:00.000Z',
    providers: ['local-password']
  },
  appAccess: {
    homeAppId: 'mx-h2i',
    registeredByAppId: 'mx-h2i',
    allowedAppIds: ['mx-h2i'],
    deniedAppIds: []
  },
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z'
};

test('password aliases share one canonical user limiter before password verification', async () => {
  const harness = controllerHarness();
  const aliases = [
    'alice',
    ' Alice ',
    'alice@example.com',
    'usr_alice',
    'Alice Example'
  ];

  for (let index = 0; index < 10; index += 1) {
    await assert.rejects(
      harness.controller.token({
        grant_type: 'password',
        username: aliases[index % aliases.length],
        password: 'wrong'
      }, '203.0.113.8'),
      (error) => statusOf(error) === 401
    );
  }
  assert.equal(harness.verifyCalls(), 10);

  await assert.rejects(
    harness.controller.token({
      grant_type: 'password',
      username: 'alice@example.com',
      password: 'wrong'
    }, '203.0.113.8'),
    (error) => statusOf(error) === 429
  );
  assert.equal(harness.verifyCalls(), 10, 'rate limiting must run before the synchronous password hash check');
});

test('client_credentials is never evaluated through the Domestic public edge', async () => {
  const harness = controllerHarness();
  await assert.rejects(
    harness.controller.token({
      grant_type: 'client_credentials',
      client_id: 'svc_sdk_gateway',
      client_secret: 'not-a-secret'
    }, '203.0.113.9', 'domestic-edge'),
    (error) => statusOf(error) === 401
  );
  assert.equal(harness.rateLimitConsumes(), 0);
});

test('one canonical account is limited even when the source IP rotates', async () => {
  const harness = controllerHarness();
  for (let index = 0; index < 25; index += 1) {
    await assert.rejects(
      harness.controller.token({
        grant_type: 'password',
        username: 'alice',
        password: 'wrong'
      }, `198.51.100.${index + 1}`),
      (error) => statusOf(error) === 401
    );
  }
  await assert.rejects(
    harness.controller.token({
      grant_type: 'password',
      username: 'alice@example.com',
      password: 'wrong'
    }, '198.51.100.200'),
    (error) => statusOf(error) === 429
  );
  assert.equal(harness.verifyCalls(), 25);
});

test('one source IP is limited even when unknown account names rotate', async () => {
  const harness = controllerHarness();
  for (let index = 0; index < 60; index += 1) {
    await assert.rejects(
      harness.controller.token({
        grant_type: 'password',
        username: `unknown-${index}`,
        password: 'wrong'
      }, '192.0.2.44'),
      (error) => statusOf(error) === 401
    );
  }
  await assert.rejects(
    harness.controller.token({
      grant_type: 'password',
      username: 'unknown-final',
      password: 'wrong'
    }, '192.0.2.44'),
    (error) => statusOf(error) === 429
  );
  assert.equal(harness.verifyCalls(), 0);
});

test('fixed-window limiter resets only after the configured window', () => {
  const first = consumeFixedWindowRateLimit(null, {
    bucketKey: 'test:bucket',
    limit: 1,
    windowSeconds: 300,
    now: '2026-07-27T00:00:00.000Z'
  });
  const blocked = consumeFixedWindowRateLimit(first, {
    bucketKey: 'test:bucket',
    limit: 1,
    windowSeconds: 300,
    now: '2026-07-27T00:04:59.999Z'
  });
  const reset = consumeFixedWindowRateLimit(blocked, {
    bucketKey: 'test:bucket',
    limit: 1,
    windowSeconds: 300,
    now: '2026-07-27T00:05:00.000Z'
  });

  assert.equal(first.allowed, true);
  assert.equal(blocked.allowed, false);
  assert.equal(reset.allowed, true);
  assert.equal(reset.count, 1);
});

test('rate-limit record keys do not persist raw account or client IP values', () => {
  const key = authenticationRateLimitBucketKey(
    'password-source-subject',
    '203.0.113.10\nAlice@example.com'
  );
  assert.match(key, /^password-source-subject:[a-f0-9]{64}$/);
  assert.equal(key.includes('203.0.113.10'), false);
  assert.equal(key.toLowerCase().includes('alice'), false);
});

function controllerHarness(): {
  controller: SdkGatewayController;
  verifyCalls: () => number;
  rateLimitConsumes: () => number;
} {
  const buckets = new Map<string, AuthenticationRateLimitState>();
  let verifyCalls = 0;
  let rateLimitConsumes = 0;
  const store = {
    listUserCenterUsers: async () => [activeUser],
    consumeAuthenticationRateLimits: async (inputs: AuthenticationRateLimitInput[]) => {
      rateLimitConsumes += 1;
      return inputs.map((input) => {
        const decision = consumeFixedWindowRateLimit(buckets.get(input.bucketKey) ?? null, input);
        buckets.set(input.bucketKey, {
          windowStartedAt: decision.windowStartedAt,
          count: decision.count
        });
        return decision;
      });
    },
    verifyUserCenterPassword: async () => {
      verifyCalls += 1;
      return {
        userId: activeUser.userId,
        ok: false,
        hasPassword: true,
        reason: 'invalid credentials'
      };
    }
  } as unknown as PlatformStore;
  return {
    controller: new SdkGatewayController(store, {} as FeishuAuthService),
    verifyCalls: () => verifyCalls,
    rateLimitConsumes: () => rateLimitConsumes
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as HttpException | undefined)?.getStatus?.();
}
