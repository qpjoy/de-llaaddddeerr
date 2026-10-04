import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { loadConfig } from '../config.js';
import { createPlatformDataSource } from '../db/data-source.js';
import { PostgresStore } from '../store/postgres.js';
import { IdentityRepository } from '../identity/repository.js';
import { SdkGatewayController } from '../modules/sdk-gateway/sdk-gateway.controller.js';
import { LauncherNetworkController } from '../modules/launcher-network/launcher-network.controller.js';
import type { FeishuAuthService } from '../modules/sdk-gateway/feishu-auth.service.js';
import { RegistrationRepository, type RegistrationSource, type RegistrationInput } from './repository.js';

const databaseUrl=process.env.MX_SSO_TEST_DATABASE_URL;
test('application signup policy: trusted provenance, independent Hub mode, legacy preservation and default network denial',{skip:!databaseUrl},async()=>{
  const url=new URL(databaseUrl!);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.includes('sso_test'));
  const environment=`app-signup-${randomUUID()}`,config={...loadConfig(),databaseUrl:databaseUrl!,environment,storeDriver:'postgres' as const};
  const db=createPlatformDataSource(config);await db.initialize();await db.runMigrations();
  const store=await PostgresStore.create(config),repo=new RegistrationRepository(databaseUrl!,environment,'launcher','test');
  const identity=new IdentityRepository(databaseUrl!,environment,environment,'fixture');await identity.initialize();
  const hub:RegistrationSource={issuer:'https://auth.example.test/identity',clientId:'hub-public',appId:'mx-insight-hub',appOrigin:'https://hub.example.test'};
  const launcher:RegistrationSource={...hub,clientId:'launcher-public',appId:'mx-launcher',appOrigin:'https://launcher.example.test'};
  const input=(account:string,policyVersion:number,source?:RegistrationSource):RegistrationInput=>({account,password:'FixturePassword123!',transactionId:randomUUID(),clientId:'launcher',policyVersion,...(source?{source}:{})});
  try {
    const old=await store.createUserCenterUser({account:'ExistingEmployee',password:'OldPassword123!',roleIds:['mx-user']});
    const before=await identity.account(old.userId);
    assert.deepEqual(await repo.policy(hub),{mode:'invite_code',version:0});
    let policy=await repo.updatePolicy({mode:'invite_code',hubMode:'open',version:0});
    assert.equal((await repo.policy(hub)).mode,'open');assert.equal((await repo.policy(launcher)).mode,'invite_code');
    await assert.rejects(repo.register(input('MissingSource',policy.version)),/来源/);
    await assert.rejects(repo.register(input('LauncherNeedsCode',policy.version,launcher)),/邀请码/);
    await assert.rejects(repo.register(input('BadSource',policy.version,{...hub,appOrigin:'https://hub.example.test/path'})),/来源/);
    const body=input('HubCustomer',policy.version,hub),created=await repo.register(body);
    const account=await identity.account(created.userId);
    assert.deepEqual(account?.registration?.source,hub);assert.equal(account?.registration?.method,'password');
    assert.equal(account?.registration?.policyVersion,policy.version);
    assert.deepEqual(account?.roleIds,['mx-user']);assert.deepEqual(account?.appAccess.allowedAppIds,[]);
    assert.deepEqual(account?.appAccess.deniedAppIds,['mx-h2i','luopan']);
    assert.equal(account?.appAccess.registeredByAppId,'mx-identity','legacy policy attribution is not rewritten');
    assert.deepEqual(await repo.register(body),created);
    await store.createUserCenterUser({userId:created.userId,displayName:'Renamed Customer'});
    assert.deepEqual((await identity.account(created.userId))?.registration,account?.registration,'ordinary admin writes preserve immutable provenance');
    const audits=await db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='audit-event' AND data->>'eventType'='identity.account.registered' AND data->>'userId'=$2",[environment,created.userId]);
    assert.deepEqual(audits[0].data.metadata.registration,account?.registration);

    const sdk=new SdkGatewayController(store,{} as FeishuAuthService),network=new LauncherNetworkController(store,config);
    const login=(appId?:string)=>sdk.token({grant_type:'password',username:body.account,password:body.password,appId,audience:'mx-sdk',scope:'auth.read'},'192.0.2.51');
    const generic=(await login()).token.access_token;
    for(const productId of ['mx-h2i','luopan']) {
      await assert.rejects(login(productId),(error:any)=>error.getStatus()===403);
      await assert.rejects(network.enrollLease(`Bearer ${generic}`,{appId:productId,productId,mode:'standalone',identityKind:'user',userId:created.userId,installId:`inst_${productId}`,deviceId:`dev_${productId}`,publicKey:`pub_${productId}`,leaseProfile:'employee'},undefined,undefined,'192.0.2.51'),(error:any)=>error.getStatus()===403);
    }
    assert.deepEqual(await identity.account(old.userId),before,'old account byte structure remains unchanged');
    assert.equal((await identity.authenticate('ExistingEmployee','OldPassword123!'))?.userId,old.userId);

    policy=await repo.updatePolicy({mode:'invite_code',hubMode:'closed',version:policy.version});
    const enterpriseInvitation={issuer:hub.appOrigin,clientId:hub.clientId,invitationId:randomUUID(),expiresAt:new Date(Date.now()+86400000).toISOString()};
    await assert.rejects(repo.register({...input('ClosedHub',policy.version,hub),enterpriseInvitation}),/暂未开放/);
    assert.equal((await identity.authenticate(body.account,body.password))?.userId,created.userId,'closing signup never closes login');
    policy=await repo.updatePolicy({mode:'open',version:policy.version});
    assert.equal(policy.hubMode,'closed','old admin clients cannot erase the independent Hub setting');
    assert.equal((await repo.policy(hub)).mode,'closed');assert.equal((await repo.policy(launcher)).mode,'open');
    policy=await repo.updatePolicy({mode:'closed',hubMode:'open',version:policy.version});
    assert.equal((await repo.policy(hub)).mode,'closed','platform closure wins');
    await assert.rejects(repo.register(input('GlobalClosed',policy.version,hub)),/暂未开放/);
    policy=await repo.updatePolicy({mode:'invite_code',hubMode:'open',version:policy.version});
    await assert.rejects(repo.register(input('StalePolicy',0,hub)),/已更新/);
    await repo.close();const restarted=new RegistrationRepository(databaseUrl!,environment,'launcher','test');
    try{assert.deepEqual(await restarted.register(body),created);assert.equal((await restarted.policy(hub)).mode,'open');}
    finally{await restarted.close();}
  } finally {
    await repo.close();await identity.close();await (store as unknown as {dataSource:DataSource}).dataSource.destroy();
    await db.query('DELETE FROM mx_platform_records WHERE environment=$1',[environment]);await db.query('DELETE FROM mx_identity_records WHERE scope=$1',[environment]);await db.destroy();
  }
});
