import 'reflect-metadata';
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {RegistrationClientError} from '../registration/backchannel.js';
import {createServer,request} from 'node:http';
import {createPlatformDataSource} from '../db/data-source.js';import {loadConfig} from '../config.js';
import {IdentityRepository} from './repository.js';import {RegistrationRepository} from '../registration/repository.js';import {createIdentityProvider} from './provider.js';
const databaseUrl=process.env.MX_SSO_TEST_DATABASE_URL;
test('Harbor hosted and native OIDC: existing accounts need invites and revocation invalidates old tokens',{skip:!databaseUrl},async t=>{
 const target=new URL(databaseUrl!);assert.ok(['localhost','127.0.0.1'].includes(target.hostname)&&target.pathname.includes('sso_test'));
 const environment=`harbor-journey-${randomUUID()}`,db=createPlatformDataSource({...loadConfig(),databaseUrl:databaseUrl!,environment,storeDriver:'postgres'});await db.initialize();await db.runMigrations();
 const accounts=new IdentityRepository(databaseUrl!,environment,environment,'test-rate');await accounts.initialize();const registration=new RegistrationRepository(databaseUrl!,environment,'launcher','test');
 const origin='https://auth.example.test',app={appId:'mx-harbor',origin:'https://harbor.example.test',clientId:'harbor',clientSecret:'h'.repeat(43),audience:'mx-harbor'};
 const hub={issuer:origin+'/identity',appId:'mx-insight-hub',clientId:'hub',appOrigin:'https://hub.example.test'};
 const policy=await registration.updatePolicy({mode:'invite_code',hubMode:'open',applicationModes:{'mx-harbor':'invite_code'},version:0});
 const users=[];for(const account of ['HostedUser','NativeUser'])users.push(await registration.register({transactionId:randomUUID(),clientId:'launcher',source:hub,account,password:'OriginalPassword123!',policyVersion:policy.version}));
 const application=createIdentityProvider({origin,adminOrigin:'https://launcher.example.test',issuer:origin+'/identity',clientId:'launcher',clientSecret:'s'.repeat(43),cookieKeys:['a'.repeat(43)],applications:[app],jwks:{keys:[{...generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'}]}},accounts,name=>accounts.adapter(name),{policy:source=>registration.policy(source),register:input=>registration.register({...input,clientId:'launcher'}),redeemAdmission:async input=>{try{return await registration.redeemAdmission(input)}catch(error:any){throw new RegistrationClientError(error.status,error.message)}},feishu:async()=>({enabled:true})});
 const server=createServer((req,res)=>{req.headers['x-forwarded-proto']='https';void application.handle(req,res)});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await registration.close();await accounts.close();await db.query('DELETE FROM mx_platform_records WHERE environment=$1',[environment]);await db.query('DELETE FROM mx_identity_records WHERE scope=$1',[environment]);await db.destroy()});
 const jar=new Map<string,string>();
 const call=(path:string,options:{method?:string;headers?:Record<string,string>;body?:string}={})=>new Promise<{status:number;text:string;location:string}>((resolve,reject)=>{const url=new URL(path,origin),req=request({hostname:'127.0.0.1',port:(server.address() as {port:number}).port,path:url.pathname+url.search,method:options.method||'GET',headers:{host:'auth.example.test',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...options.headers}},res=>{for(const raw of res.headers['set-cookie']||[]){const [k,v]=raw.split(';')[0].split('=');jar.set(k,v)}let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode!,text,location:res.headers.location||''}))});req.on('error',reject);req.end(options.body)});
 const basic=`Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,verifier='v'.repeat(43);
 const auth=(native:boolean)=>'/identity/auth?'+new URLSearchParams({client_id:app.clientId,redirect_uri:app.origin+'/auth/sso/callback',response_type:'code',scope:'openid mx:identity',prompt:'login',state:randomUUID(),nonce:randomUUID(),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),...(native?{mx_surface:'application'}:{})});
 const capability=await call('/identity/app-account',{method:'POST',headers:{authorization:basic,'content-type':'application/json'},body:JSON.stringify({action:'capabilities'})});
 assert.equal(capability.status,200);assert.deepEqual(JSON.parse(capability.text),{nativeForm:true,appId:app.appId,origin:app.origin,audience:app.audience});
 const expiring=await call(auth(true));await call(expiring.location);
 await accounts.adapter('Interaction').destroy(expiring.location.split('/').at(-1)!);
 const expired=await call(expiring.location);assert.equal(expired.status,400);assert.match(expired.text,/数港 DataPort/);assert.ok(expired.text.includes(app.origin));
 assert.doesNotMatch(expired.text,/MX Launcher|Insight Hub|mx-pay|前往其他应用/);
 const unknown=await call(auth(true).replace('client_id=harbor','client_id=unknown'));
 assert.equal(unknown.status,400);assert.doesNotMatch(unknown.text,/MX Launcher|Insight Hub|mx-pay|应用入口|前往其他应用/);
 for(const [index,native] of [false,true].entries()){
  jar.clear();const invite=await registration.createInvitation({label:'Harbor',days:1,maxUses:1,admissionAppId:'mx-harbor'});
  let step=await call(auth(native));assert.equal(step.status,303,step.text);const interaction=step.location;step=await call(interaction);const login=index?'NativeUser':'HostedUser';
  if(native){assert.equal(step.status,303,step.text);const flow=new URL(step.location).searchParams.get('flow');assert.ok(flow);const account=(action:string,extra={})=>call('/identity/app-account',{method:'POST',headers:{authorization:basic,'content-type':'application/json'},body:JSON.stringify({action,input:{flow,...extra}})});
   const options=JSON.parse((await account('options')).text);assert.equal(options.admissionRequired,true);assert.equal(options.feishu,false);assert.equal((await account('feishu')).status,403);
   assert.equal((await account('login',{login,password:'OriginalPassword123!'})).status,400);
   const completed=await account('login',{login,password:'OriginalPassword123!',inviteCode:invite.code});assert.equal(completed.status,200,completed.text);step=await call(JSON.parse(completed.text).redirect);
  }else{assert.equal(step.status,200,step.text);assert.match(step.text,/首次进入/);assert.doesNotMatch(step.text,/使用飞书登录/);const csrf=/name="csrf" value="([^"]+)"/.exec(step.text)![1];const submit=(inviteCode='')=>call(interaction,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,login,password:'OriginalPassword123!',inviteCode}).toString()});assert.equal((await submit()).status,400);step=await submit(invite.code)}
  for(let i=0;i<8&&!step.location.startsWith(app.origin);i++){assert.ok(step.location,step.text);step=await call(step.location)}
  assert.ok(step.location.startsWith(app.origin),step.text);const code=new URL(step.location).searchParams.get('code');assert.ok(code);
  const token=await call('/identity/token',{method:'POST',headers:{authorization:basic,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:code!,code_verifier:verifier,redirect_uri:app.origin+'/auth/sso/callback'}).toString()});assert.equal(token.status,200,token.text);
  const accessToken=JSON.parse(token.text).access_token,userinfo=()=>call('/identity/me',{headers:{authorization:`Bearer ${accessToken}`}});
  let info=await userinfo();assert.equal(info.status,200,info.text);assert.equal(JSON.parse(info.text).mx_identity.audience,app.audience);assert.equal(JSON.parse(info.text).sub,users[index].userId);
  await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{appAccess,allowedAppIds}','[]'::jsonb) WHERE environment=$1 AND kind='iam-user' AND id=$2",[environment,users[index].userId]);
  info=await userinfo();assert.notEqual(info.status,200,'revoked grant must invalidate old access token');
  const remembered=await call(auth(false).replace('prompt=login','prompt=none'));assert.ok(!remembered.location.includes('code='),'old provider session must not bypass admission');
 }
});
