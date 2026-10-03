import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,readFile,chmod,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root=fileURLToPath(new URL('../../',import.meta.url))
test('delivery deploy validates private credentials, preserves installed config and excludes Public API/migration jobs',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'delivery-config-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const file=join(dir,'delivery.env'),calls=join(dir,'calls')
  await writeFile(join(dir,'kubectl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$DELIVERY_TEST_CALLS"\nif [ "$1" = apply ]; then cat >/dev/null; else printf "{}"; fi\n',{mode:0o700})
  const secret='delivery-only-fixture-secret-at-least-32-bytes'
  await writeFile(file,`MX_INSIGHT_PAYMENT_DELIVERY_SOURCES=${JSON.stringify([{appId:'hub',environment:'test',channelId:'mock',baseUrl:'https://pay.example.test',token:secret}])}\n`,{mode:0o600})
  const run=(target,script='configure_payment_delivery mx-insight-hub')=>spawnSync('bash',['-c',`source "$1/scripts/manage.sh"; ${script}`,'_',root],{
    env:{...process.env,PATH:`${dir}:${process.env.PATH}`,DELIVERY_TEST_CALLS:calls,MX_INSIGHT_PAYMENT_DELIVERY_ENV_FILE:target},encoding:'utf8'})
  let result=run(file);assert.equal(result.status,0,result.stderr);assert.ok(!`${result.stdout}${result.stderr}`.includes(secret))
  const args=await readFile(calls,'utf8');assert.match(args,/--from-env-file=/);assert.ok(!args.includes(secret))
  result=run('', 'ROOT_DIR="$(dirname "$DELIVERY_TEST_CALLS")"; configure_payment_delivery mx-insight-hub')
  assert.equal(result.status,0,result.stderr);assert.equal(await readFile(calls,'utf8'),args)
  assert.notEqual(run(join(dir,'missing')).status,0)
  await chmod(file,0o644);assert.notEqual(run(file).status,0);assert.equal(await readFile(calls,'utf8'),args)
  await chmod(file,0o600);await writeFile(file,'DATABASE_URL=postgres://bad\n');assert.notEqual(run(file).status,0)
  for(const name of ['30-public-api.yaml','20-migration-job.yaml'])assert.doesNotMatch(await readFile(join(root,'deploy/k8s/internal',name),'utf8'),/mx-insight-hub-payment-delivery/)
  assert.match(await readFile(join(root,'deploy/k8s/internal/31-admin-api.yaml'),'utf8'),/mx-insight-hub-payment-delivery/)
  assert.match(await readFile(join(root,'.dockerignore'),'utf8'),/^secrets\/$/m)
  assert.match(await readFile(join(root,'.gitignore'),'utf8'),/^secrets\/payment-delivery.env$/m)
})
