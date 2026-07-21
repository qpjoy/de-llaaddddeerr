import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { UserCenterController } from '../src/modules/user-center/user-center.controller.js';
import { MemoryStore } from '../src/store/memory.js';

const store = new MemoryStore(loadConfig());
store.bootstrapUserCenter();
const controller = new UserCenterController(store);

store.createUserCenterUser({
  userId: 'usr_lifecycle_smoke',
  account: 'lifecycle-smoke',
  displayName: 'Lifecycle Smoke',
  password: 'old-lifecycle-password',
  roleIds: ['mx-user'],
  requestId: 'lifecycle-create'
});
const issued = store.issueUserCenterToken({
  subjectKind: 'user',
  subjectId: 'usr_lifecycle_smoke',
  audience: 'mx-sdk',
  scopes: ['auth.read'],
  requestId: 'lifecycle-token'
});
assert.equal(store.verifyUserCenterPassword({
  userId: 'usr_lifecycle_smoke',
  password: 'old-lifecycle-password'
}).ok, true);

const passwordUpdate = await controller.updateUserPassword('usr_lifecycle_smoke', {
  password: 'new-lifecycle-password',
  requestedBy: 'smoke',
  requestId: 'lifecycle-password-update'
});
assert.equal(passwordUpdate.password.tokensRevoked, 1);
assert.equal(store.verifyUserCenterPassword({
  userId: 'usr_lifecycle_smoke',
  password: 'old-lifecycle-password'
}).ok, false);
assert.equal(store.verifyUserCenterPassword({
  userId: 'usr_lifecycle_smoke',
  password: 'new-lifecycle-password'
}).ok, true);
assert.equal(store.introspectToken({ token: issued.token, audience: 'mx-sdk' }).active, false);

store.createUserCenterUser({
  userId: 'usr_import_semantics_smoke',
  account: 'import-semantics-smoke',
  displayName: 'Import Semantics Smoke',
  password: 'import-original-password',
  roleIds: ['mx-user']
});
store.importUserCenterUsers({
  users: [{ account: 'import-semantics-smoke', displayName: 'Import Semantics Smoke' }]
});
assert.equal(store.verifyUserCenterPassword({
  userId: 'usr_import_semantics_smoke',
  password: 'import-original-password'
}).ok, true);
store.importUserCenterUsers({
  users: [{
    account: 'import-semantics-smoke',
    displayName: 'Import Semantics Smoke',
    password: 'import-replacement-password'
  }]
});
assert.equal(store.verifyUserCenterPassword({
  userId: 'usr_import_semantics_smoke',
  password: 'import-original-password'
}).ok, false);
assert.equal(store.verifyUserCenterPassword({
  userId: 'usr_import_semantics_smoke',
  password: 'import-replacement-password'
}).ok, true);
await controller.deleteUser('usr_import_semantics_smoke', { requestedBy: 'smoke' });

store.updateUserCenterPassword({
  userId: 'usr_demo_user',
  password: 'bootstrap-preserved-password',
  requestedBy: 'smoke'
});
store.bootstrapUserCenter();
assert.equal(store.verifyUserCenterPassword({
  userId: 'usr_demo_user',
  password: 'bootstrap-preserved-password'
}).ok, true);

const legacyUser = store.listUserCenterUsers().find((user) => user.account === 'nmtest');
assert.ok(legacyUser);
store.updateUserCenterPassword({
  userId: legacyUser.userId,
  password: 'legacy-user-updated-password',
  requestedBy: 'smoke'
});
store.bootstrapUserCenter();
assert.equal(store.verifyUserCenterPassword({
  userId: legacyUser.userId,
  password: 'legacy-user-updated-password'
}).ok, true);
await controller.deleteUser(legacyUser.userId, {
  requestedBy: 'smoke',
  requestId: 'legacy-user-delete'
});
store.bootstrapUserCenter();
assert.equal(store.listUserCenterUsers().some((user) => user.account === 'nmtest'), false);

const disabledEntitlement = store.upsertUserOverseaEntitlement({
  userId: 'usr_lifecycle_smoke',
  siteIds: [],
  requestedBy: 'smoke'
});
assert.equal(disabledEntitlement.status, 'disabled');
assert.deepEqual(disabledEntitlement.siteIds, []);
store.upsertUserH2oRuntimeProfile({
  userId: 'usr_lifecycle_smoke',
  appId: 'h2o',
  mode: 'rule',
  requestedBy: 'smoke'
});

const deletion = await controller.deleteUser('usr_lifecycle_smoke', {
  requestedBy: 'smoke',
  requestId: 'lifecycle-delete'
});
assert.equal(deletion.deletion.deleted, true);
assert.equal(deletion.deletion.deletedRecords.credential, 1);
assert.equal(deletion.deletion.deletedRecords.tokens, 1);
assert.equal(deletion.deletion.deletedRecords.overseaEntitlements, 1);
assert.equal(deletion.deletion.deletedRecords.h2oRuntimeProfiles, 1);
assert.equal(store.listUserCenterUsers().some((user) => user.userId === 'usr_lifecycle_smoke'), false);
await assert.rejects(controller.deleteUser('usr_demo_user', {}), /Built-in bootstrap user cannot be deleted/);

console.log('OK password update replaces the credential and revokes existing user tokens');
console.log('OK import preserves an omitted password and replaces an explicitly supplied password');
console.log('OK bootstrap preserves an administrator-updated built-in password');
console.log('OK bootstrap preserves and does not resurrect changed or deleted legacy users');
console.log('OK an explicit empty Oversea site list disables access');
console.log('OK safe delete removes local user-scoped records and protects built-in users');
