import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { RuntimeConfig } from '../../types.js';
import {
  FeishuAuthService,
  feishuSubjectHash,
  type FeishuFetch
} from './feishu-auth.service.js';
import { SdkGatewayController } from './sdk-gateway.controller.js';

const REDIRECT_URI = 'http://127.0.0.1:17891/oauth/feishu/callback';
const STATE = 'state_0123456789abcdef';
const CODE_VERIFIER = 'v'.repeat(64);
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

test('Feishu authorization config and URL enforce exact redirect and S256 PKCE', async () => {
  const config = feishuConfig();
  const store = new MemoryStore(config);
  await store.bootstrapUserCenter();
  const service = new FeishuAuthService(config, store, unexpectedFetch());
  const controller = new SdkGatewayController(store, service);

  const publicConfig = controller.feishuConfig();
  assert.equal(publicConfig.config.enabled, true);
  assert.deepEqual(publicConfig.config.pkce, {
    required: true,
    codeChallengeMethod: 'S256',
    localExchangeBinding: true,
    providerVerification: 'requires-real-tenant-validation'
  });
  assert.equal(JSON.stringify(publicConfig).includes('test-app-secret'), false);
  assert.equal(JSON.stringify(publicConfig).includes('tenant_allowed'), false);

  const result = await controller.feishuAuthorize({
    redirectUri: REDIRECT_URI,
    state: STATE,
    codeChallenge: CODE_CHALLENGE
  });
  assert.match(result.exchangeHandle, /^mxfx1\.[A-Za-z0-9_-]{43}$/);
  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get('client_id'), 'cli_test');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('state'), STATE);
  assert.equal(url.searchParams.get('code_challenge'), CODE_CHALLENGE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  await assert.rejects(
    controller.feishuAuthorize({
      redirectUri: `${REDIRECT_URI}/`,
      state: STATE,
      codeChallenge: CODE_CHALLENGE
    }),
    BadRequestException
  );
  await assert.rejects(
    controller.feishuAuthorize({
      redirectUri: REDIRECT_URI,
      state: STATE,
      codeChallenge: 'too-short'
    }),
    BadRequestException
  );
});

test('Feishu token exchange provisions an isolated user and returns only an internal token', async () => {
  const config = feishuConfig();
  const store = new MemoryStore(config);
  await store.bootstrapUserCenter();
  await store.createUserCenterUser({
    userId: 'usr_existing_local',
    account: 'existing-local',
    email: 'same@example.com',
    displayName: 'Same Person',
    roleIds: ['mx-user']
  });
  const upstream = sequenceFetch([
    {
      code: 0,
      access_token: 'feishu-access-token',
      refresh_token: 'feishu-refresh-token',
      expires_in: 7_200
    },
    {
      code: 0,
      data: {
        tenant_key: 'tenant_allowed',
        open_id: 'ou_external_user',
        name: 'Same Person',
        email: 'same@example.com'
      }
    }
  ]);
  const service = new FeishuAuthService(config, store, upstream.fetch);
  const controller = new SdkGatewayController(store, service);
  const authorization = await controller.feishuAuthorize({
    redirectUri: REDIRECT_URI,
    state: STATE,
    codeChallenge: CODE_CHALLENGE
  });

  const response = await controller.feishuToken({
    code: 'authorization-code',
    redirectUri: REDIRECT_URI,
    codeVerifier: CODE_VERIFIER,
    exchangeHandle: authorization.exchangeHandle,
    audience: 'mx-sdk',
    scope: 'auth.read appcenter.read',
    requestId: 'req-feishu-test'
  });
  assert.equal(response.token.auth_provider, 'feishu');
  assert.equal(
    response.token.subject,
    `user:usr_feishu_${feishuSubjectHash('tenant_allowed:ou_external_user')}`
  );
  assert.match(response.token.access_token, /^mx-v1-/);
  assert.deepEqual(response.token.scope, 'auth.read appcenter.read');
  const serializedResponse = JSON.stringify(response);
  assert.equal(serializedResponse.includes('feishu-access-token'), false);
  assert.equal(serializedResponse.includes('feishu-refresh-token'), false);
  assert.equal(serializedResponse.includes('test-app-secret'), false);

  const users = await store.listUserCenterUsers();
  const linked = users.filter(
    (user) => user.profile.externalIds.feishuSubject === 'tenant_allowed:ou_external_user'
  );
  assert.equal(linked.length, 1);
  assert.notEqual(linked[0]?.userId, 'usr_existing_local');
  assert.equal(linked[0]?.email, null);
  assert.deepEqual(
    [...(linked[0]?.appAccess.allowedAppIds ?? [])].sort(),
    ['appcenter', 'h2o', 'mx-h2i']
  );
  assert.equal(linked[0]?.appAccess.homeAppId, 'mx-h2i');
  assert.equal(linked[0]?.appAccess.registeredByAppId, 'mx-h2i');

  assert.equal(upstream.calls.length, 2);
  const tokenRequest = JSON.parse(String(upstream.calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal(tokenRequest.client_secret, 'test-app-secret');
  assert.equal(tokenRequest.code_verifier, CODE_VERIFIER);
  assert.equal(tokenRequest.redirect_uri, REDIRECT_URI);
  const userInfoHeaders = upstream.calls[1]?.init.headers as Record<string, string>;
  assert.equal(userInfoHeaders.authorization, 'Bearer feishu-access-token');

  await assert.rejects(
    controller.feishuToken({
      code: 'replayed-authorization-code',
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      exchangeHandle: authorization.exchangeHandle
    }),
    UnauthorizedException
  );
  assert.equal(upstream.calls.length, 2);
});

test('Feishu exchange rejects malformed PKCE and non-allowlisted tenants before issuing a token', async () => {
  const config = feishuConfig();
  const store = new MemoryStore(config);
  await store.bootstrapUserCenter();
  const upstream = sequenceFetch([
    {
      code: 0,
      access_token: 'denied-tenant-token'
    },
    {
      code: 0,
      data: {
        tenant_key: 'tenant_denied',
        open_id: 'ou_external_user',
        name: 'Denied User'
      }
    }
  ]);
  const service = new FeishuAuthService(config, store, upstream.fetch);
  const malformedAuthorization = await service.authorize({
    redirectUri: REDIRECT_URI,
    state: STATE,
    codeChallenge: CODE_CHALLENGE
  });

  await assert.rejects(
    service.exchange({
      code: 'authorization-code',
      redirectUri: REDIRECT_URI,
      codeVerifier: 'invalid verifier',
      exchangeHandle: malformedAuthorization.exchangeHandle
    }),
    BadRequestException
  );
  assert.equal(upstream.calls.length, 0);

  const authorization = await service.authorize({
    redirectUri: REDIRECT_URI,
    state: `${STATE}_tenant`,
    codeChallenge: CODE_CHALLENGE
  });
  await assert.rejects(
    service.exchange({
      code: 'authorization-code',
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      exchangeHandle: authorization.exchangeHandle
    }),
    UnauthorizedException
  );
  const users = await store.listUserCenterUsers();
  assert.equal(
    users.some((user) => user.profile.externalIds.feishuSubject?.startsWith('tenant_denied:')),
    false
  );
});

test('Feishu login preserves roles on a pre-linked Internal user while adding app access', async () => {
  const config = feishuConfig();
  const store = new MemoryStore(config);
  await store.bootstrapUserCenter();
  await store.createUserCenterUser({
    userId: 'usr_prelinked_feishu',
    account: 'prelinked-feishu',
    displayName: 'Prelinked Admin',
    roleIds: ['mx-admin'],
    orgIds: ['org_finance'],
    externalIds: {
      feishuSubject: 'tenant_allowed:ou_prelinked_user'
    },
    allowedAppIds: ['mx-h2i']
  });
  const upstream = sequenceFetch([
    {
      code: 0,
      access_token: 'prelinked-feishu-access-token'
    },
    {
      code: 0,
      data: {
        tenant_key: 'tenant_allowed',
        open_id: 'ou_prelinked_user',
        name: 'Prelinked Admin'
      }
    }
  ]);
  const service = new FeishuAuthService(config, store, upstream.fetch);
  const authorization = await service.authorize({
    redirectUri: REDIRECT_URI,
    state: STATE,
    codeChallenge: CODE_CHALLENGE
  });

  await service.exchange({
    code: 'prelinked-authorization-code',
    redirectUri: REDIRECT_URI,
    codeVerifier: CODE_VERIFIER,
    exchangeHandle: authorization.exchangeHandle
  });

  const user = (await store.listUserCenterUsers())
    .find((item) => item.userId === 'usr_prelinked_feishu');
  assert.deepEqual(user?.roleIds, ['mx-admin']);
  assert.deepEqual(user?.orgIds, ['org_finance']);
  assert.deepEqual(
    [...(user?.appAccess.allowedAppIds ?? [])].sort(),
    ['appcenter', 'h2o', 'mx-h2i']
  );
});

test('Feishu exchange handle is opaque, verifier-bound, and consumed atomically', async () => {
  const config = feishuConfig();
  const store = new MemoryStore(config);
  await store.bootstrapUserCenter();
  const service = new FeishuAuthService(config, store, unexpectedFetch());
  const authorization = await service.authorize({
    redirectUri: REDIRECT_URI,
    state: `${STATE}_binding`,
    codeChallenge: CODE_CHALLENGE
  });

  await assert.rejects(
    service.exchange({
      code: 'authorization-code',
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      exchangeHandle: `mxfx1.${'x'.repeat(43)}`
    }),
    UnauthorizedException
  );

  await assert.rejects(
    service.exchange({
      code: 'authorization-code',
      redirectUri: REDIRECT_URI,
      codeVerifier: 'w'.repeat(64),
      exchangeHandle: authorization.exchangeHandle
    }),
    UnauthorizedException
  );

  await assert.rejects(
    service.exchange({
      code: 'authorization-code',
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
      exchangeHandle: authorization.exchangeHandle
    }),
    UnauthorizedException
  );
});

test('service-account OAuth requires the configured Internal ops credential', async () => {
  const config = feishuConfig();
  const store = new MemoryStore(config);
  await store.bootstrapUserCenter();
  const service = new FeishuAuthService(config, store, unexpectedFetch());
  const controller = new SdkGatewayController(store, service);
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'sdk-gateway-test-internal-ops-token';
  try {
    await assert.rejects(
      controller.token({
        grant_type: 'client_credentials',
        client_id: 'svc_sdk_gateway',
        client_secret: 'not-the-ops-token'
      }),
      UnauthorizedException
    );
    const result = await controller.token({
      grant_type: 'client_credentials',
      client_id: 'svc_sdk_gateway',
      client_secret: process.env.MX_INTERNAL_OPS_TOKEN,
      audience: 'mx-sdk'
    });
    assert.match(result.token.access_token, /^mx-v1-/);
    assert.equal(result.token.auth_provider, null);
  } finally {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previous;
  }
});

test('publisher service-account OAuth uses an account-specific secret and filters requested scopes', async () => {
  const config = feishuConfig();
  const store = new MemoryStore(config);
  await store.bootstrapUserCenter();
  await store.createUserCenterServiceAccount({
    serviceAccountId: 'svc_release_luopan',
    displayName: 'Luopan Release Publisher',
    scopes: ['sdk.release.read', 'sdk.release.publish'],
    allowedProductIds: ['luopan']
  });
  const service = new FeishuAuthService(config, store, unexpectedFetch());
  const controller = new SdkGatewayController(store, service);
  const publisherSecret = 'luopan-publisher-secret-0000000000000000';
  const previous = process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON;
  process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON = JSON.stringify({
    svc_release_luopan: publisherSecret
  });
  try {
    await assert.rejects(
      controller.token({
        grant_type: 'client_credentials',
        client_id: 'svc_release_luopan',
        client_secret: process.env.MX_INTERNAL_OPS_TOKEN || 'global-ops-token-must-not-work'
      }),
      UnauthorizedException
    );
    const result = await controller.token({
      grant_type: 'client_credentials',
      client_id: 'svc_release_luopan',
      client_secret: publisherSecret,
      audience: 'mx-sdk',
      scope: 'sdk.release.publish rbac.manage',
      expires_in: 24 * 60 * 60
    });
    assert.match(result.token.access_token, /^mx-v1-/);
    assert.equal(result.token.scope, 'sdk.release.publish');
    assert.ok(result.token.expires_in <= 60 * 60);
    assert.deepEqual(
      (result.token.principal as { scopes?: string[] }).scopes,
      ['sdk.release.publish']
    );
  } finally {
    if (previous === undefined) delete process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON;
    else process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON = previous;
  }
});

function feishuConfig(): RuntimeConfig {
  return {
    ...loadConfig(),
    feishuAppId: 'cli_test',
    feishuAppSecret: 'test-app-secret',
    feishuAllowedTenantKeys: ['tenant_allowed'],
    feishuRedirectUris: [REDIRECT_URI],
    feishuAutoProvisionEnabled: true,
    feishuAuthorizeUrl: 'https://accounts.feishu.test/open-apis/authen/v1/authorize',
    feishuTokenUrl: 'https://open.feishu.test/open-apis/authen/v2/oauth/token',
    feishuUserInfoUrl: 'https://open.feishu.test/open-apis/authen/v1/user_info'
  };
}

function sequenceFetch(payloads: unknown[]): {
  fetch: FeishuFetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FeishuFetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const payload = payloads[calls.length - 1];
    if (payload === undefined) throw new Error('unexpected fetch');
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { fetch, calls };
}

function unexpectedFetch(): FeishuFetch {
  return async () => {
    throw new Error('unexpected fetch');
  };
}
