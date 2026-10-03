import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { createIdentityServer } from './server.js';
import { IdentityRepository } from './repository.js';
import { createPlatformDataSource } from '../db/data-source.js';
import { loadConfig } from '../config.js';
import { MemoryStore } from '../store/memory.js';
import { createUserCenterUserCredential } from '../store/domain.js';
import { loadPublicAdminSsoConfig } from '../admin-sso/config.js';

const databaseUrl=process.env.MX_SSO_TEST_DATABASE_URL;
test('public gateway: exact hosts/secret, isolated paths, HTTPS OIDC discovery and password code/PKCE with original user', {skip:!databaseUrl},async t=>{
 const environment=`public-test-${randomUUID()}`;
 const db=createPlatformDataSource({...loadConfig(),databaseUrl:databaseUrl!,environment,storeDriver:'postgres'});
 await db.initialize();await db.runMigrations();
 const repo=new IdentityRepository(databaseUrl!,environment,environment,'rate-secret');await repo.initialize();
 const memory=new MemoryStore(loadConfig());
 const user=memory.createUserCenterUser({userId:'public-original-user',account:'OriginalUser',password:'OriginalPassword123!',roleIds:['mx-user']});
 for(const [kind,data] of [['iam-user',user],['iam-user-credential',createUserCenterUserCredential(user.userId,'OriginalPassword123!')]] as const)
   await db.query('INSERT INTO mx_platform_records(kind,id,environment,data) VALUES($1,$2,$3,$4)',[kind,user.userId,environment,data]);
 let seenHeaders:Record<string,unknown>={};
 const upstream=createServer((req,res)=>{seenHeaders=req.headers;res.end('upstream');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const settings={origin:'https://auth.example.test',adminOrigin:'https://launcher.example.test',issuer:'https://auth.example.test/identity',
  clientId:'mx-launcher-public-admin',clientSecret:'s'.repeat(43),ingressToken:'g'.repeat(43),cookieKeys:['a'.repeat(43),'b'.repeat(43)],
  jwks:{keys:[{...generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'}),kid:'public-test',alg:'RS256',use:'sig'}]}};
 const server=createIdentityServer({settings,repository:repo,cert:Buffer.alloc(0),key:Buffer.alloc(0),upstream:new URL(`http://127.0.0.1:${(upstream.address() as {port:number}).port}`)});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);await repo.close();await db.query('DELETE FROM mx_platform_records WHERE environment=$1',[environment]);await db.destroy();});
 const jar=new Map<string,string>();
 const call=(path:string,{host='auth.example.test',method='GET',body='',headers={}}:{host?:string;method?:string;body?:string;headers?:Record<string,string>}={})=>new Promise<{status:number;text:string;location?:string;cookies:string[]}>((resolve,reject)=>{
  const url=new URL(path,settings.origin);
  const req=request({hostname:'127.0.0.1',port:(server.address() as {port:number}).port,path:url.pathname+url.search,method,headers:{host,'x-mx-identity-gateway':settings.ingressToken,'x-mx-client-ip':'198.51.100.9',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...headers}},res=>{
   for(const raw of res.headers['set-cookie']??[]){const [k,v]=raw.split(';')[0].split('=');jar.set(k,v);}
   let text='';res.on('data',p=>text+=p);res.on('end',()=>resolve({status:res.statusCode!,text,location:res.headers.location,cookies:res.headers['set-cookie']??[]}));
  });req.on('error',reject);req.end(body);
 });
 assert.equal((await call('/identity/.well-known/openid-configuration',{host:'wrong.example.test'})).status,421);
 assert.equal((await call('/identity/.well-known/openid-configuration',{headers:{'x-mx-identity-gateway':'wrong'}})).status,403);
 for(const path of ['/admin/','/internal/v1/users','/identity-backend/registration']) assert.equal((await call(path)).status,404);
 assert.equal((await call('/internal/v1/users',{host:'launcher.example.test'})).status,404);
 assert.equal((await call('/identity/.well-known/openid-configuration',{host:'launcher.example.test'})).status,404);
 assert.equal((await call('/admin/',{host:'launcher.example.test',headers:{'x-mx-ops-token':'must-not-forward',authorization:'Bearer must-not-forward'}})).text,'upstream');
 assert.equal(seenHeaders.host,'launcher.example.test');assert.equal(seenHeaders['x-mx-ops-token'],undefined);assert.equal(seenHeaders.authorization,undefined);
 const discovery=JSON.parse((await call('/identity/.well-known/openid-configuration')).text);assert.equal(discovery.issuer,settings.issuer);
 const verifier='v'.repeat(43),state=randomUUID();
 let step=await call('/identity/auth?'+new URLSearchParams({client_id:settings.clientId,response_type:'code',scope:'openid',redirect_uri:`${settings.adminOrigin}/auth/admin/callback`,state,nonce:'n'.repeat(43),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}));
 assert.equal(step.status,303,step.text);assert.ok(step.cookies.every(c=>/secure/i.test(c)));
 const interaction=step.location!;step=await call(interaction);assert.equal(step.status,200,step.text);
 const csrf=/name="csrf" value="([^"]+)"/.exec(step.text)![1];
 step=await call(interaction,{method:'POST',headers:{origin:settings.origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,login:'OriginalUser',password:'OriginalPassword123!'}).toString()});
 for(let i=0;i<6&&!step.location?.startsWith(settings.adminOrigin);i++)step=await call(step.location!);
 assert.ok(step.location?.startsWith(`${settings.adminOrigin}/auth/admin/callback`),JSON.stringify(step));
 const code=new URL(step.location!).searchParams.get('code')!;
 const redeemed=await call(discovery.token_endpoint,{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:`${settings.adminOrigin}/auth/admin/callback`}).toString()});
 assert.equal(redeemed.status,200,redeemed.text);
 const claims=JSON.parse(Buffer.from(JSON.parse(redeemed.text).id_token.split('.')[1],'base64url').toString());assert.equal(claims.iss,settings.issuer);assert.equal(claims.sub,user.userId);
 const config={issuer:settings.issuer,origin:settings.adminOrigin,clientId:settings.clientId,clientSecret:settings.clientSecret,callbackUrl:`${settings.adminOrigin}/auth/admin/callback`,localSubjects:true,ingressToken:settings.ingressToken};
 assert.deepEqual(loadPublicAdminSsoConfig({MX_ADMIN_PUBLIC_SSO_CONFIG:JSON.stringify(config)}),config);
});
