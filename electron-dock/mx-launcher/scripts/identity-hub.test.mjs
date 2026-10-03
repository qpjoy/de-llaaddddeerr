import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProfile, readProfile, savePrivate } from './identity-profile.mjs';
import { registerHub } from './identity-hub.mjs';
import { inspectIdentity, resources, MANAGED } from './identity-deploy.mjs';
import { readSsoProfile } from '../../mx-insight-hub/server/identity/sso-config.mjs';

test('Hub registration is additive, retryable, private and preserves old installation credentials', () => {
  const root=mkdtempSync(join(tmpdir(),'mx-hub-profile-')), file=join(root,'profile.json'), hubFile=join(root,'hub','profile.json');
  try {
    const old=initializeProfile('https://10.88.88.88:18443',file);
    const input={origin:'https://hub.example.test',environment:'internal-main',file,hubFile};
    registerHub(input);const p=readProfile(file),hub=readSsoProfile(hubFile),bytes=readFileSync(hubFile,'utf8');
    assert.deepEqual({...p,applications:undefined},{...old,applications:undefined});
    assert.equal(hub.legacyIssuer,'mx-user-center:internal-main');assert.equal(hub.personalTenant,true);
    registerHub(input);assert.equal(readFileSync(hubFile,'utf8'),bytes);assert.equal(statSync(hubFile).mode&0o777,0o600);
    assert.throws(()=>registerHub({...input,origin:'https://other.test'}),/迁移/);
    assert.throws(()=>registerHub({...input,origin:'http://hub.test'}),/HTTPS/);
    const live=resources(old).runtime;
    const execute=args=>args.includes('get')&&args.includes('mx-identity-runtime')?JSON.stringify(live):'';
    assert.doesNotThrow(()=>inspectIdentity(p,execute),'new app can be deployed without rotating existing identity');
    const newLive=resources(p).runtime;
    assert.throws(()=>inspectIdentity(old,args=>args.includes('get')&&args.includes('mx-identity-runtime')?JSON.stringify(newLive):''),/客户端/,'stale backup cannot remove a registered app');
    savePrivate(hubFile,{...hub,clientSecret:'different'});assert.throws(()=>registerHub(input),/停止覆盖/);
  } finally {rmSync(root,{recursive:true,force:true})}
});
