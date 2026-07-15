import assert from 'node:assert/strict';

import { HttpException } from '@nestjs/common';

import { loadConfig } from '../src/config.js';
import { UserCenterController } from '../src/modules/user-center/user-center.controller.js';
import { USER_OVERSEA_SUBSCRIPTION_SCOPE } from '../src/store/domain.js';
import { MemoryStore } from '../src/store/memory.js';

const USER_ID = 'usr_demo_user';
const OTHER_USER_ID = 'usr_demo_admin';

const store = new MemoryStore(loadConfig());
store.bootstrapUserCenter();
const controller = new UserCenterController(store);

const selfToken = store.issueUserCenterToken({
  subjectKind: 'user',
  subjectId: USER_ID,
  audience: 'mx-sdk',
  scopes: [USER_OVERSEA_SUBSCRIPTION_SCOPE],
  requestId: 'smoke-user-oversea-self'
});
const noScopeToken = store.issueUserCenterToken({
  subjectKind: 'user',
  subjectId: USER_ID,
  audience: 'mx-sdk',
  scopes: ['auth.read'],
  requestId: 'smoke-user-oversea-no-scope'
});
const adminToken = store.issueUserCenterToken({
  subjectKind: 'user',
  subjectId: OTHER_USER_ID,
  audience: 'mx-sdk',
  scopes: ['site-slot.manage', 'site-slot.execute'],
  requestId: 'smoke-user-oversea-admin'
});

await expectStatus(
  controller.ensureUserOverseaSubscription(USER_ID, undefined, { syncRuntime: false }),
  401
);
await expectStatus(
  controller.ensureUserOverseaSubscription(USER_ID, bearer('mx-shadow-user:usr_demo_user'), { syncRuntime: false }),
  401
);
await expectStatus(
  controller.ensureUserOverseaSubscription(USER_ID, bearer('mx-shadow-service:svc_sdk_gateway'), { syncRuntime: false }),
  401
);
await expectStatus(
  controller.ensureUserOverseaSubscription(USER_ID, bearer(noScopeToken.token), { syncRuntime: false }),
  403
);
await expectStatus(
  controller.ensureUserOverseaSubscription(OTHER_USER_ID, bearer(selfToken.token), { syncRuntime: false }),
  403
);

const selfEnsure = await controller.ensureUserOverseaSubscription(
  USER_ID,
  bearer(selfToken.token),
  { syncRuntime: false, includeYaml: true, requestId: 'smoke-user-oversea-ensure' }
);
assert.equal(selfEnsure.entitlement?.userId, USER_ID);
assert.ok(selfEnsure.subscription?.yaml?.includes('type: hysteria2'));

const yaml = await controller.userOverseaSubscription(USER_ID, bearer(selfToken.token));
assert.match(yaml, /type:\s*hysteria2/);
await expectStatus(controller.userOverseaSubscription(OTHER_USER_ID, bearer(selfToken.token)), 403);

const adminEnsure = await controller.ensureUserOverseaSubscription(
  USER_ID,
  bearer(adminToken.token),
  { syncRuntime: false, requestId: 'smoke-user-oversea-admin-ensure' }
);
assert.equal(adminEnsure.entitlement?.userId, USER_ID);

console.log('OK user Oversea endpoints require a real Bearer token');
console.log('OK user Oversea endpoints bind token subject to path user');
console.log(`OK user Oversea endpoints require ${USER_OVERSEA_SUBSCRIPTION_SCOPE}`);
console.log('OK explicit site-slot manage+execute scopes allow admin access');

function bearer(token: string): string {
  return `Bearer ${token}`;
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => (
    error instanceof HttpException && error.getStatus() === status
  ));
}
