import assert from 'node:assert/strict';
import test from 'node:test';

import type { HttpException } from '@nestjs/common';

import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import type { FeishuAuthService } from './feishu-auth.service.js';
import { SdkGatewayController } from './sdk-gateway.controller.js';

test('Luopan access evaluation rejects an existing generic token without revoking its other applications', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  await store.upsertAppCenterApp({ appId: 'mx-h2i', displayName: 'MX-H2I', accessPolicy: { defaultDecision: 'authenticated' } });
  const user = await store.createUserCenterUser({
    userId: 'usr_luopan_access', account: 'luopan-access', password: 'AccessPassword1!',
    roleIds: ['mx-admin']
  });
  const controller = new SdkGatewayController(store, {} as FeishuAuthService);
  const login = { grant_type: 'password', username: user.account, password: 'AccessPassword1!', audience: 'mx-sdk', scope: 'sdk.identity.read' };
  const generic = await controller.token(login);
  const h2i = await controller.token({ ...login, appId: 'mx-h2i' });
  const input = { token: generic.token.access_token, audience: 'mx-sdk', routeId: 'sdk.identity.context', appId: 'luopan' };
  assert.equal((await controller.access(input)).decision.allowed, true);

  await store.createUserCenterUser({ userId: user.userId, roleIds: ['mx-admin'], deniedAppIds: ['luopan'] });
  // The old Java service's generic token is still valid. Its caller must ask
  // for Luopan access, which overrides both public access and admin bypass.
  assert.equal((await controller.introspect({ token: generic.token.access_token, audience: 'mx-sdk' })).introspection.active, true);
  const denied = (await controller.access({ ...input, userId: 'usr_demo_admin' })).decision;
  assert.equal(denied.allowed, false);
  assert.equal(denied.principal?.userId, user.userId);
  assert.equal(denied.appAccess?.appId, 'luopan');
  assert.deepEqual(denied.appAccess?.missing, ['user-deny:luopan']);
  assert.equal((await controller.access({ ...input, appId: 'mx-h2i' })).decision.allowed, true);
  assert.equal((await controller.introspect({ token: h2i.token.access_token, audience: 'mx-sdk' })).introspection.active, true);
  await assert.rejects(controller.token({ ...login, appId: 'luopan' }), (error: unknown) =>
    (error as HttpException).getStatus?.() === 403);

  await store.createUserCenterUser({ userId: user.userId, roleIds: ['mx-admin'], deniedAppIds: [], replaceAppAccess: true });
  assert.equal((await controller.access(input)).decision.allowed, true);
});

test('public Luopan cannot make an invalid or wrong-audience token a valid user session', async () => {
  const store = new MemoryStore(loadConfig());
  await store.bootstrapUserCenter();
  const controller = new SdkGatewayController(store, {} as FeishuAuthService);
  const input = { audience: 'mx-sdk', routeId: 'sdk.identity.context', appId: 'luopan' };
  const invalid = (await controller.access({ ...input, token: 'not-a-token', userId: 'usr_demo_admin' })).decision;
  assert.equal(invalid.allowed, false);
  assert.equal(invalid.principal, null);
  const ordinary = await controller.token({ grant_type: 'password', username: 'test', password: 'test', audience: 'mx-sdk', scope: 'sdk.identity.read sdk.user.read' });
  const allowed = (await controller.access({ ...input, token: ordinary.token.access_token })).decision;
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.principal?.kind, 'user');
  assert.equal(allowed.appAccess?.appId, 'luopan');
  const login = await controller.token({ grant_type: 'password', username: 'test', password: 'test', audience: 'other-app' });
  const wrongAudience = (await controller.access({ ...input, token: login.token.access_token })).decision;
  assert.equal(wrongAudience.allowed, false);
  assert.equal(wrongAudience.principal, null);
});
