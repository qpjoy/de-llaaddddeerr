import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../config.js';
import {createPlatformDataSource} from '../db/data-source.js';
import {RegistrationRepository,type RegistrationSource} from './repository.js';
import {IdentityRepository} from '../identity/repository.js';
import {canAccessIdentityApplication} from '../identity/application-access.js';
const databaseUrl=process.env.MX_SSO_TEST_DATABASE_URL;
test('DataPort self-signup and legacy admission are closed; retained MX accounts and other applications remain unchanged',{skip:!databaseUrl},async()=>{
 const url=new URL(databaseUrl!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.includes('sso_test'));
 const environment=`harbor-managed-${randomUUID()}`,db=createPlatformDataSource({...loadConfig(),databaseUrl:databaseUrl!,environment,storeDriver:'postgres'});
 await db.initialize();await db.runMigrations();
 const repo=new RegistrationRepository(databaseUrl!,environment,'launcher','test'),identity=new IdentityRepository(databaseUrl!,environment,environment,'fixture');await identity.initialize();
 const hub:RegistrationSource={issuer:'https://auth.example.test/identity',clientId:'hub',appId:'mx-insight-hub',appOrigin:'https://hub.example.test'},harbor={...hub,clientId:'harbor',appId:'mx-harbor',appOrigin:'https://harbor.example.test'};
 try {
  const policy=await repo.updatePolicy({mode:'invite_code',hubMode:'open',applicationModes:{'mx-harbor':'invite_code'},version:0});
  const user=await repo.register({clientId:'launcher',transactionId:randomUUID(),account:'ExistingMX',password:'FixturePassword123!',policyVersion:policy.version,source:hub});
  const before=await identity.account(user.userId),credentials=await db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential'",[environment]);
  assert.equal((await repo.policy(harbor)).mode,'closed');assert.equal((await repo.policy(hub)).mode,'open');
  const invite=await repo.createInvitation({label:'Legacy retained',days:1,maxUses:1,admissionAppId:'mx-harbor'});
  await assert.rejects(repo.redeemAdmission({userId:user.userId,source:harbor,inviteCode:invite.code}),{code:'registration_closed'});
  await assert.rejects(repo.register({clientId:'launcher',transactionId:randomUUID(),account:'ClosedHarbor',password:'FixturePassword123!',policyVersion:policy.version,source:harbor,inviteCode:invite.code}),{code:'dataport_managed_accounts'});
  assert.deepEqual(await identity.account(user.userId),before);
  assert.deepEqual(await db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential'",[environment]),credentials);
  assert.equal((await identity.authenticate('ExistingMX','FixturePassword123!'))?.userId,user.userId);
  assert.equal((await repo.invitations()).find(i=>i.id===invite.invitation.id)?.uses,0);
  assert.equal(canAccessIdentityApplication(before,'mx-insight-hub'),true);assert.equal(canAccessIdentityApplication(before,'mx-harbor'),false);
 }finally{await repo.close();await identity.close();await db.query('DELETE FROM mx_platform_records WHERE environment=$1',[environment]);await db.query('DELETE FROM mx_identity_records WHERE scope=$1',[environment]);await db.destroy();}
});
