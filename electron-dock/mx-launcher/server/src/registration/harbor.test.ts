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
test('Harbor admission: scoped invitations, last-seat concurrency, idempotency, deny and legacy preservation',{skip:!databaseUrl},async()=>{
 const url=new URL(databaseUrl!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.includes('sso_test'));
 const environment=`harbor-${randomUUID()}`,db=createPlatformDataSource({...loadConfig(),databaseUrl:databaseUrl!,environment,storeDriver:'postgres'});
 await db.initialize();await db.runMigrations();
 const repo=new RegistrationRepository(databaseUrl!,environment,'launcher','test'),identity=new IdentityRepository(databaseUrl!,environment,environment,'fixture');await identity.initialize();
 const hub:RegistrationSource={issuer:'https://auth.example.test/identity',clientId:'hub',appId:'mx-insight-hub',appOrigin:'https://hub.example.test'},harbor={...hub,clientId:'harbor',appId:'mx-harbor',appOrigin:'https://harbor.example.test'};
 const body=(account:string,version:number,source=hub,inviteCode='')=>({clientId:'launcher',transactionId:randomUUID(),account,password:'FixturePassword123!',policyVersion:version,source,inviteCode});
 try {
  let policy=await repo.updatePolicy({mode:'invite_code',hubMode:'open',version:0});
  const a=await repo.register(body('ExistingA',policy.version)),b=await repo.register(body('ExistingB',policy.version));
  const original=await identity.account(a.userId),credentials=await db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential' ORDER BY id",[environment]);
  assert.equal(canAccessIdentityApplication(original,'mx-harbor'),false);assert.equal(canAccessIdentityApplication(original,'mx-insight-hub'),true);
  assert.equal((await repo.policy(harbor)).mode,'closed');
  policy=await repo.updatePolicy({...policy,applicationModes:{'mx-harbor':'invite_code'}});
  const common=await repo.createInvitation({label:'generic',days:1,maxUses:1});
  await assert.rejects(repo.register(body('WrongCode',policy.version,harbor,common.code)),/邀请码/);
  const invite=await repo.createInvitation({label:'Harbor only',days:1,maxUses:1,admissionAppId:'mx-harbor'});
  await assert.rejects(repo.register(body('WrongApp',policy.version,{...hub,appId:'mx-launcher'},invite.code)),/邀请码/);
  const admission=(userId:string)=>repo.redeemAdmission({userId,source:harbor,inviteCode:invite.code});
  const race=await Promise.allSettled([admission(a.userId),admission(b.userId)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  const winner=race[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
  assert.deepEqual(await admission(winner.userId),{userId:winner.userId});
  assert.equal(canAccessIdentityApplication(await identity.account(winner.userId),'mx-harbor'),true);assert.equal(canAccessIdentityApplication(await identity.account(loser.userId),'mx-harbor'),false);
  assert.equal((await repo.invitations()).find(i=>i.id===invite.invitation.id)?.uses,1);
  assert.deepEqual((await db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential' ORDER BY id",[environment])),credentials);
  const newInvite=await repo.createInvitation({label:'New',days:1,maxUses:2,admissionAppId:'mx-harbor'});
  const registration=body('NewHarbor',policy.version,harbor,newInvite.code),created=await repo.register(registration);
  assert.deepEqual(await repo.register(registration),created);
  const user=await identity.account(created.userId);assert.deepEqual(user?.appAccess.allowedAppIds,['mx-harbor']);assert.deepEqual(user?.appAccess.deniedAppIds,['mx-h2i','luopan']);assert.deepEqual(user?.roleIds,['mx-user']);
  await assert.rejects(repo.register({...body('NoFeishu',policy.version,harbor,newInvite.code),verifiedFeishuSubject:'test:subject'}),/专用邀请码/);
  await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{appAccess,deniedAppIds}','[\"mx-harbor\"]'::jsonb) WHERE environment=$1 AND kind='iam-user' AND id=$2",[environment,winner.userId]);
  assert.equal(canAccessIdentityApplication(await identity.account(winner.userId),'mx-harbor'),false);
  await assert.rejects(repo.redeemAdmission({userId:winner.userId,source:harbor,inviteCode:newInvite.code}),/管理员/);
  await repo.revokeInvitation(newInvite.invitation.id);await assert.rejects(repo.redeemAdmission({userId:loser.userId,source:harbor,inviteCode:newInvite.code}),/邀请码/);
  policy=await repo.updatePolicy({mode:'invite_code',hubMode:'open',version:policy.version});assert.equal(policy.applicationModes?.['mx-harbor'],'invite_code');assert.equal((await repo.policy(hub)).mode,'open');
  // General invitations keep working after Harbor is registered, but cannot grant its admission.
  for (const appId of ['mx-harbor', 'ordinary-app']) await db.query("INSERT INTO mx_platform_records(kind,id,environment,data) VALUES('app-center-app',$1,$2,$3)", [appId,environment,JSON.stringify({appId,displayName:appId,enabled:true})]);
  const all=await repo.createInvitation({label:'All ordinary apps',days:1,maxUses:1,appGrant:{mode:'all_current',appIds:[]}});
  assert.deepEqual(all.invitation.appGrant?.appIds,['ordinary-app']);
  await assert.rejects(repo.createInvitation({label:'Wrong general grant',days:1,maxUses:1,appGrant:{mode:'selected',appIds:['mx-harbor']}}),/专用邀请/);
  // Even a pre-existing general invitation containing the new app id cannot bypass first-entry admission.
  await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{appGrant,appIds}',$3::jsonb) WHERE environment=$1 AND kind='registration-invite' AND id=$2", [environment,all.invitation.id,JSON.stringify(['ordinary-app','mx-harbor'])]);
  const ordinary=await repo.register(body('OrdinaryUser',policy.version,{...hub,appId:'mx-launcher'},all.code));
  assert.deepEqual((await identity.account(ordinary.userId))?.appAccess.allowedAppIds,['ordinary-app']);
  policy=await repo.updatePolicy({...policy,mode:'closed'});assert.equal((await repo.policy(harbor)).mode,'closed');
  assert.equal((await identity.authenticate('ExistingA','FixturePassword123!'))?.userId,a.userId);
 }finally{await repo.close();await identity.close();await db.query('DELETE FROM mx_platform_records WHERE environment=$1',[environment]);await db.query('DELETE FROM mx_identity_records WHERE scope=$1',[environment]);await db.destroy()}
});
