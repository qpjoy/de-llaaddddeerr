import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../config.js';
import { MemoryStore } from '../../store/memory.js';
import { builtinUserCenterRoles, createUserPrincipalFromRecord } from '../../store/domain.js';

test('application roles are explicit and preserve existing user credentials, app admission and network scopes', () => {
  const store = new MemoryStore(loadConfig());
  store.bootstrapUserCenter();
  const roles = builtinUserCenterRoles();
  for (const name of ['mx-admin','mx-user']) {
    assert.equal(roles.find(r=>r.roleId===name)!.scopes.some(s=>s.startsWith('mx:pay:') || s==='mx:hub:admin' || s==='mx:dataport:admin'),false);
  }
  const root = store.createUserCenterUser({ account:'root',password:'fixture-root-password',roleIds:['mx-user'] });
  const prior = createUserPrincipalFromRecord(root,roles);
  assert.equal(prior.scopes.includes('mx:pay:admin'),false,'name alone never grants administration');
  const updated = store.createUserCenterUser({userId:root.userId,account:root.account!,roleIds:['mx-user','mx-hub-admin','mx-pay-admin']});
  assert.equal(updated.userId,root.userId);
  assert.deepEqual(updated.appAccess,root.appAccess);
  const current = createUserPrincipalFromRecord(updated,roles);
  assert.deepEqual(new Set(current.scopes),new Set([...prior.scopes,'mx:hub:admin','mx:pay:admin']));
  const revoked = store.createUserCenterUser({userId:root.userId,account:root.account!,roleIds:['mx-user']});
  assert.deepEqual(createUserPrincipalFromRecord(revoked,roles).scopes,prior.scopes);
});

 test('DataPort administration is a separate explicit grant, never inferred from taku or generic platform roles', () => {
  const store = new MemoryStore(loadConfig());store.bootstrapUserCenter();
  const roles=builtinUserCenterRoles();
  const user=store.createUserCenterUser({account:'taku',password:'fixture-password',roleIds:['mx-user','mx-admin','mx-hub-admin']});
  assert.equal(createUserPrincipalFromRecord(user,roles).scopes.includes('mx:dataport:admin'),false);
  const granted=store.createUserCenterUser({userId:user.userId,account:user.account!,roleIds:[...user.roleIds,'mx-dataport-admin']});
  assert.deepEqual(granted.appAccess,user.appAccess);
  assert.deepEqual(new Set(createUserPrincipalFromRecord(granted,roles).scopes),new Set([...createUserPrincipalFromRecord(user,roles).scopes,'mx:dataport:admin']));
 });
