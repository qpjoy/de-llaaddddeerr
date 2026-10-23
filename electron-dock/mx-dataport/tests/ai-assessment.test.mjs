import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compassDeltaToken,secretDocument} from '../scripts/configure-ai.mjs';
import {permittedCustomerRoute} from '../apps/server/app.mjs';
const token='synthetic-fixture-token-only-123456789';
test('only the exact Compass Delta credential is reused; ambiguous/missing configuration is refused',()=>{
  assert.equal(compassDeltaToken('delta:\n  api-token: ${DELTA_API_TOKEN:'+token+'}\n'),token);
  for(const input of ['', 'api-token: ${OTHER_TOKEN:'+token+'}', 'api-token: ${DELTA_API_TOKEN:}',
    `api-token: \${DELTA_API_TOKEN:${token}}\napi-token: \${DELTA_API_TOKEN:${token}}`])assert.throws(()=>compassDeltaToken(input));
  const secret=secretDocument(token);
  assert.equal(secret.metadata.name,'mx-dataport-ai');assert.equal(secret.metadata.namespace,'mx-insight-hub');
  assert.equal(Buffer.from(secret.data.token,'base64').toString(),token);
  assert.equal(Buffer.from(secret.data.environment,'base64').toString(),'prod');
  assert.throws(()=>secretDocument(token,'unknown'));
});
test('Secret generation stays outside Git, uses 0600, never prints a credential or overwrites an existing file',t=>{
  const dir=mkdtempSync(join(tmpdir(),'dataport-ai-secret-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'application.yml'),out=join(dir,'secret.json');
  writeFileSync(source,'delta:\n  api-token: ${DELTA_API_TOKEN:'+token+'}\n');
  const script=fileURLToPath(new URL('../scripts/configure-ai.mjs',import.meta.url));
  const run=(output=out)=>spawnSync(process.execPath,[script,'--from-compass',source,'--out',output],{encoding:'utf8'});
  const result=run();assert.equal(result.status,0);assert.ok(!result.stdout.includes(token));assert.ok(!result.stderr.includes(token));
  assert.equal(statSync(out).mode&0o777,0o600);
  assert.equal(Buffer.from(JSON.parse(readFileSync(out,'utf8')).data.token,'base64').toString(),token);
  assert.equal(run().status,1);
  assert.equal(run(fileURLToPath(new URL('../ai-secret-must-not-exist.json',import.meta.url))).status,1);
});
test('browser can only read enterprise-scoped AI receipts, never submit arbitrary data or choose Delta run IDs',()=>{
  const tenant='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
  assert.equal(permittedCustomerRoute('GET',`/enterprises/${tenant}/assessments/${id}`),true);
  assert.equal(permittedCustomerRoute('POST',`/enterprises/${tenant}/assessments/${id}`),false);
  for(const path of ['/agent/run','/api/agent/run/by-key/test',`/enterprises/${tenant}/assessments/${id}/retry`])
    assert.equal(permittedCustomerRoute('GET',path),false);
});
