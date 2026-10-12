import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProfile, readProfile, savePrivate } from './identity-profile.mjs';
import { createPublicEntry } from './identity-public-profile.mjs';
import { registerPublic } from './identity-public.mjs';
import { registerApplication } from './identity-app.mjs';
import { inspectIdentity, resources } from './identity-deploy.mjs';

test('additional applications preserve existing keys, support both entries and refuse replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'mx-app-profile-')), file = join(root, 'profile.json');
  try {
    const p = initializeProfile('https://10.88.88.88:18443', file);
    const publicEntry = createPublicEntry({ origin: 'https://auth.example.test', adminOrigin: 'https://admin.example.test', hubOrigin: 'https://hub.example.test', audience: 'hub', privateOrigin: p.origin });
    savePrivate(file, { ...p, publicEntry });
    const input = { appId: 'mx-customer', origin: 'https://customer.example.test', audience: 'customer', entry: 'public', appFile: join(root, 'customer', 'profile.json'), file };
    registerApplication(input);
    const bytes = readFileSync(input.appFile, 'utf8'); registerApplication(input);
    assert.equal(readFileSync(input.appFile, 'utf8'), bytes); assert.equal(statSync(input.appFile).mode & 0o777, 0o600);
    const consumer = JSON.parse(bytes);
    assert.equal(Buffer.from(consumer.sessionKey, 'base64url').length, 32);
    // The pre-SDK profile can be upgraded once without changing provider credentials.
    const { sessionKey, ...legacyConsumer } = consumer;
    savePrivate(input.appFile, legacyConsumer);
    registerApplication(input);
    const upgraded = JSON.parse(readFileSync(input.appFile, 'utf8'));
    assert.deepEqual({ ...upgraded, sessionKey: undefined }, { ...consumer, sessionKey: undefined });
    const upgradedBytes = readFileSync(input.appFile, 'utf8'); registerApplication(input);
    assert.equal(readFileSync(input.appFile, 'utf8'), upgradedBytes);
    savePrivate(input.appFile, { ...upgraded, sessionKey: 'broken' });
    assert.throws(() => registerApplication(input), /会话密钥/);
    assert.equal(JSON.parse(readFileSync(input.appFile, 'utf8')).sessionKey, 'broken');
    savePrivate(input.appFile, upgraded);
    const next = readProfile(file);
    const runtime = resources({ ...p, publicEntry }).runtime;
    const execute = args => args.includes('get') && args.includes('mx-identity-runtime') ? JSON.stringify(runtime) : '';
    assert.doesNotThrow(() => inspectIdentity(next, execute));
    assert.throws(() => inspectIdentity({ ...p, publicEntry }, args => args.includes('get') && args.includes('mx-identity-runtime') ? JSON.stringify(resources(next).runtime) : ''), /客户端/);
    assert.deepEqual(next.publicEntry.applications[0], publicEntry.applications[0]);
    assert.deepEqual({ ...next.publicEntry, applications: undefined }, { ...publicEntry, applications: undefined });
    // Adding applications removes the former assumption that Hub occupies slot zero.
    savePrivate(file, { ...next, publicEntry: { ...next.publicEntry, applications: [...next.publicEntry.applications].reverse() } });
    const hubFile = join(root, 'hub', 'profile.json');
    registerPublic({ origin: publicEntry.origin, adminOrigin: publicEntry.adminOrigin, hubOrigin: publicEntry.applications[0].origin,
      environment: 'test', audience: 'hub', file, hubFile });
    assert.equal(JSON.parse(readFileSync(hubFile, 'utf8')).clientId, 'mx-insight-hub-web');
    assert.equal(readProfile(file).publicEntry.applications.length, 2);
    assert.throws(() => registerApplication({ ...input, origin: 'https://changed.example.test' }), /迁移/);
    registerApplication({ ...input, entry: 'private', appFile: join(root, 'private', 'profile.json') });
    assert.deepEqual({ ...readProfile(file), applications: undefined, publicEntry: undefined }, { ...p, applications: undefined, publicEntry: undefined });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DataPort origin migration retains all credentials and other applications; deployment accepts only its exact proof',async()=>{
 const {migrateApplicationOrigin}=await import('./identity-app.mjs');
 const root=mkdtempSync(join(tmpdir(),'dataport-migration-')),file=join(root,'profile.json'),appFile=join(root,'app','profile.json');
 try {
  const p=initializeProfile('https://10.88.88.88:18443',file),publicEntry=createPublicEntry({origin:'https://auth.example.test',adminOrigin:'https://admin.example.test',hubOrigin:'https://hub.example.test',audience:'hub',privateOrigin:p.origin});
  savePrivate(file,{...p,publicEntry});
  registerApplication({file,appFile,appId:'mx-harbor',origin:'https://harbor.minsight-ai.com',audience:'mx-harbor',entry:'public'});
  const before=readProfile(file),consumer=JSON.parse(readFileSync(appFile,'utf8')),runtime=resources(before).runtime;
  const input={file,appFile,appId:'mx-harbor',fromOrigin:'https://harbor.minsight-ai.com',origin:'https://dataport.minsight-ai.com'};
  migrateApplicationOrigin(input);migrateApplicationOrigin(input);
  const after=readProfile(file),next=JSON.parse(readFileSync(appFile,'utf8'));
  for(const key of ['clientId','clientSecret','sessionKey','audience','issuer'])assert.equal(next[key],consumer[key]);
  assert.deepEqual(after.publicEntry.applications.filter(a=>a.appId!=='mx-harbor'),before.publicEntry.applications.filter(a=>a.appId!=='mx-harbor'));
  assert.deepEqual({...after,publicEntry:undefined,dataportOriginMigration:undefined},{...before,publicEntry:undefined,dataportOriginMigration:undefined});
  assert.deepEqual(JSON.parse(readFileSync(file+'.before-dataport','utf8')),before);
  const execute=args=>args.includes('get')&&args.includes('mx-identity-runtime')?JSON.stringify(runtime):'';
  assert.doesNotThrow(()=>inspectIdentity(after,execute));
  assert.throws(()=>inspectIdentity({...after,dataportOriginMigration:undefined},execute),/客户端/);
  const changed=structuredClone(after);changed.publicEntry.applications.find(a=>a.appId==='mx-harbor').clientSecret='z'.repeat(43);
  assert.throws(()=>inspectIdentity(changed,execute),/客户端/);
  assert.throws(()=>migrateApplicationOrigin({...input,appId:'mx-h2i'}),/仅用于/);
 }finally{rmSync(root,{recursive:true,force:true})}
});
