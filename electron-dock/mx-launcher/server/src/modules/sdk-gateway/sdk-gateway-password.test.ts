import assert from 'node:assert/strict';
import test from 'node:test';

import type { HttpException } from '@nestjs/common';

import type { PlatformStore } from '../../store/platform-store.js';
import type { PlatformPrincipal, TokenIntrospectionResult, UserPasswordUpdateInput } from '../../types.js';
import { SdkGatewayController } from './sdk-gateway.controller.js';
import type { FeishuAuthService } from './feishu-auth.service.js';

const writerPrincipal: PlatformPrincipal = {
  principalId: 'service-account:svc_partner_portal',
  kind: 'service-account',
  tenantId: 'tenant_default',
  orgIds: ['org_default'],
  displayName: 'Partner Portal',
  userId: null,
  anonymousPrincipalId: null,
  serviceAccountId: 'svc_partner_portal',
  roles: ['mx-service-account'],
  scopes: ['sdk.user.write']
};

test('SDK Gateway password update requires an active Bearer writer', async () => {
  const harness = controllerHarness(activeAuth(writerPrincipal, ['sdk.user.write']));

  await assert.rejects(
    harness.controller.updateUserPassword('usr_target', undefined, { password: 'new-password' }),
    (error) => statusOf(error) === 401
  );
  await assert.rejects(
    harness.controller.updateUserPassword('usr_target', 'Bearer mx-shadow-user:usr_admin', {
      password: 'new-password'
    }),
    (error) => statusOf(error) === 401
  );
  assert.equal(harness.updateCalls.length, 0);
});

test('SDK Gateway password update rejects a normal user token without write scope', async () => {
  const normalUser = normalUserPrincipal();
  const harness = controllerHarness(activeAuth(normalUser, ['auth.read']));

  await assert.rejects(
    harness.controller.updateUserPassword('usr_target', 'Bearer user-token', {
      password: 'new-password'
    }),
    (error) => statusOf(error) === 403
  );
  assert.equal(harness.updateCalls.length, 0);
});

test('SDK Gateway password update records the authenticated principal and revokes target tokens', async () => {
  const harness = controllerHarness(activeAuth(writerPrincipal, ['sdk.user.write']));
  const result = await harness.controller.updateUserPassword(
    'usr_target',
    'Bearer writer-token',
    {
      password: 'new-password',
      requestedBy: 'spoofed-caller',
      requestId: 'password-update-001'
    }
  );

  assert.deepEqual(harness.updateCalls, [{
    userId: 'usr_target',
    password: 'new-password',
    requestedBy: writerPrincipal.principalId,
    requestId: 'password-update-001'
  }]);
  assert.equal(result.password.tokensRevoked, 2);
});

test('SDK Gateway self-service password update verifies the current password and targets the signed-in user', async () => {
  const principal = normalUserPrincipal();
  const harness = controllerHarness(activeAuth(principal, ['auth.read']));
  const result = await harness.controller.updateOwnPassword(
    'Bearer user-token',
    '203.0.113.10',
    {
      currentPassword: 'old-password',
      newPassword: 'new-password',
      requestId: 'self-password-update-001'
    }
  );

  assert.deepEqual(harness.verifyCalls, [{
    userId: principal.userId,
    password: 'old-password',
    requestId: 'self-password-update-001'
  }]);
  assert.deepEqual(harness.updateCalls, [{
    userId: principal.userId,
    password: 'new-password',
    requestedBy: principal.principalId,
    requestId: 'self-password-update-001'
  }]);
  assert.equal(result.password.tokensRevoked, 2);
});

test('SDK Gateway self-service password update rejects an invalid current password', async () => {
  const principal = normalUserPrincipal();
  const harness = controllerHarness(activeAuth(principal, ['auth.read']), { verificationOk: false });

  await assert.rejects(
    harness.controller.updateOwnPassword('Bearer user-token', '203.0.113.10', {
      currentPassword: 'wrong-password',
      newPassword: 'new-password'
    }),
    (error) => statusOf(error) === 401
  );
  assert.equal(harness.updateCalls.length, 0);
});

function controllerHarness(
  auth: TokenIntrospectionResult,
  options?: { verificationOk?: boolean }
): {
  controller: SdkGatewayController;
  updateCalls: UserPasswordUpdateInput[];
  verifyCalls: Array<{ userId?: string | null; password?: string | null; requestId?: string | null }>;
} {
  const updateCalls: UserPasswordUpdateInput[] = [];
  const verifyCalls: Array<{ userId?: string | null; password?: string | null; requestId?: string | null }> = [];
  const store = {
    introspectToken: async () => auth,
    consumeAuthenticationRateLimits: async (inputs: Array<{ limit: number; windowSeconds: number }>) => inputs.map((input) => ({
      allowed: true,
      count: 1,
      limit: input.limit,
      remaining: input.limit - 1,
      windowStartedAt: '2026-07-28T00:00:00.000Z',
      resetAt: '2026-07-28T00:05:00.000Z',
      retryAfterSeconds: input.windowSeconds
    })),
    verifyUserCenterPassword: async (input: { userId?: string | null; password?: string | null; requestId?: string | null }) => {
      verifyCalls.push(input);
      return {
        userId: input.userId ?? 'usr_normal',
        ok: options?.verificationOk !== false,
        hasPassword: true,
        reason: options?.verificationOk === false ? 'invalid credentials' : 'password accepted'
      };
    },
    updateUserCenterPassword: async (input: UserPasswordUpdateInput) => {
      updateCalls.push(input);
      return {
        user: {
          userId: input.userId ?? 'usr_target',
          tenantId: 'tenant_default',
          orgIds: ['org_default'],
          account: 'target',
          email: null,
          displayName: 'Target',
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
            passwordUpdatedAt: '2026-07-28T00:00:00.000Z',
            providers: ['local-password']
          },
          appAccess: {
            homeAppId: 'mx-h2i',
            registeredByAppId: 'partner-portal',
            allowedAppIds: ['mx-h2i'],
            deniedAppIds: []
          },
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-28T00:00:00.000Z'
        },
        tokensRevoked: 2,
        updatedAt: '2026-07-28T00:00:00.000Z'
      };
    }
  } as unknown as PlatformStore;
  return {
    controller: new SdkGatewayController(store, {} as FeishuAuthService),
    updateCalls,
    verifyCalls
  };
}

function normalUserPrincipal(): PlatformPrincipal {
  return {
    ...writerPrincipal,
    principalId: 'user:usr_normal',
    kind: 'user',
    displayName: 'Normal User',
    userId: 'usr_normal',
    serviceAccountId: null,
    roles: ['mx-user'],
    scopes: ['auth.read']
  };
}

function activeAuth(
  principal: PlatformPrincipal,
  scopes: string[]
): TokenIntrospectionResult {
  return {
    active: true,
    tokenKind: principal.kind === 'service-account' ? 'service-token' : 'jwt',
    issuer: 'mx-user-center:test',
    audience: 'mx-sdk',
    subject: principal.principalId,
    principal: { ...principal, scopes },
    scopes,
    expiresAt: '2099-01-01T00:00:00.000Z',
    reason: 'active test token'
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as HttpException | undefined)?.getStatus?.();
}
