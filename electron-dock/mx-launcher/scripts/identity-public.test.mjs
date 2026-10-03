import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initializeProfile,readProfile,savePrivate} from './identity-profile.mjs';
import {registerPublic,renderInternalIngress} from './identity-public.mjs';
import {registerHub} from './identity-hub.mjs';
import {resources,inspectIdentity} from './identity-deploy.mjs';
import {publicAdminConfig} from './identity-public-profile.mjs';

test('public registration preserves private issuer/keys, Hub members contract and session key; idempotent/recovery fences',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mx-public-')),file=join(dir,'profile.json'),hubFile=join(dir,'hub','profile.json');
 try {
  const old=initializeProfile('https://10.88.88.88:18443',file);
  registerHub({origin:'https://hub.minsight-ai.com',environment:'internal-main',file,hubFile});
  const privateHub=JSON.parse(readFileSync(hubFile));
  const input={origin:'https://auth.minsight-ai.com',adminOrigin:'https://launcher.minsight-ai.com',hubOrigin:'https://hub.minsight-ai.com',environment:'internal-main',file,hubFile};
  const entry=registerPublic(input),next=readProfile(file),hub=JSON.parse(readFileSync(hubFile));
  assert.deepEqual({...next,applications:undefined,publicEntry:undefined},{...old,applications:undefined,publicEntry:undefined});
  assert.equal(hub.sessionKey,privateHub.sessionKey);assert.equal(hub.legacyIssuer,privateHub.legacyIssuer);
  assert.equal(hub.previousProviders[0].issuer,privateHub.issuer);
  const before=readFileSync(file,'utf8'),beforeHub=readFileSync(hubFile,'utf8');
  registerPublic(input);assert.equal(readFileSync(file,'utf8'),before);assert.equal(readFileSync(hubFile,'utf8'),beforeHub);
  assert.throws(()=>registerPublic({...input,origin:'https://different.example.com'}),/迁移/);
  const built=resources(next,'a'.repeat(40));
  assert.equal(built.publicDeployment.spec.template.spec.containers[0].ports[0].hostIP,'10.88.88.88');
  assert.equal(built.publicDeployment.spec.template.spec.containers[0].ports[0].hostPort,18444);
  assert.equal(built.deployment.spec.template.spec.containers[0].ports[0].hostPort,18443);
  assert.deepEqual(JSON.parse(Buffer.from(built.admin.data.MX_ADMIN_PUBLIC_SSO_CONFIG,'base64')),publicAdminConfig(entry));
  assert.ok(!JSON.stringify(built).includes(old.caKey));
  const execute=args=>args.includes('mx-identity-runtime')?JSON.stringify(built.runtime):'';
  assert.doesNotThrow(()=>inspectIdentity(next,execute));assert.throws(()=>inspectIdentity(old,execute),/issuer/);
  const ingress=renderInternalIngress(entry);assert.match(ingress,/allow 10\.88\.0\.1;/);assert.ok(!ingress.includes('location /internal/'));
  savePrivate(file,{...next,publicEntry:{...entry,transportOrigin:'http://0.0.0.0:18444'}});assert.throws(()=>readProfile(file),/公网身份档案/);
 } finally {rmSync(dir,{recursive:true,force:true})}
});

test('manage.sh dispatches public registration under the deployment lock without shell scope errors',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mx-public-cli-'));
 try {
  const bin=join(dir,'bin');mkdirSync(bin);
  for(const [name,body] of Object.entries({uname:'echo Linux',id:'echo 0',flock:'exit 0',node:'printf "%s\\n" "$@"'}))
   writeFileSync(join(bin,name),'#!/usr/bin/env bash\n'+body+'\n',{mode:0o755});
  const source=readFileSync(new URL('./manage.sh',import.meta.url),'utf8');
  const scripts=fileURLToPath(new URL('.',import.meta.url));
  const prepared=source.replace(/^SCRIPT_DIR=.*$/m,`SCRIPT_DIR='${scripts.replaceAll("'","'\\''")}'`).replaceAll('/run/mx-launcher-deploy.lock',join(dir,'deploy.lock'));
  const script=join(dir,'manage.sh');writeFileSync(script,prepared);
  const args=['https://auth.minsight-ai.com','https://launcher.minsight-ai.com','https://hub.minsight-ai.com'];
  const result=spawnSync('bash',[script,'ops','identity','public',...args],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/identity-public\.mjs/);
  assert.ok(args.every(arg=>result.stdout.includes(arg)));
 } finally {rmSync(dir,{recursive:true,force:true})}
});
