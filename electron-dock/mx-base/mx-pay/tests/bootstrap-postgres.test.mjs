import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import pg from 'pg'
import { databaseResources } from '../scripts/postgres.mjs'
import { migrate } from '../server/migrate.mjs'

// Explicitly opt in with a PG16 installation; creates only a disposable data
// directory and ephemeral loopback listener. Never discovers a business DB.
test('PG16 bootstrap SQL, least-privilege runtime, repeat init and backup/restore round trip', {skip:process.env.MX_PAY_TEST_PG_BIN ? false : 'Set MX_PAY_TEST_PG_BIN to disposable-test PG16 tools'},async t=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'mxp-'))
  const dataDir=join(dir,'data'), bootstrap=join(dir,'bootstrap'), pgdata=join(dataDir,'pgdata')
  fs.mkdirSync(dataDir);fs.mkdirSync(bootstrap)
  const credentials={installationID:randomBytes(16).toString('hex'),ownerPassword:randomBytes(32).toString('hex'),runtimePassword:randomBytes(32).toString('hex')}
  for(const [name,value] of Object.entries(credentials))fs.writeFileSync(join(bootstrap,name),value,{mode:0o600})
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening')
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve))
  const env={...process.env,PATH:`${process.env.MX_PAY_TEST_PG_BIN}:${process.env.PATH}`,LANG:'C',LC_ALL:'C',PGDATA:pgdata,PGHOST:dir,PGPORT:String(port),PGUSER:'mx_pay_owner',PGDATABASE:'mx_pay'}
  const run=(cmd,args,options={})=>execFileSync(cmd,args,{env,encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe'],...options})
  t.after(()=>{try{run('pg_ctl',['-D',pgdata,'-m','immediate','-w','stop'])}catch{}fs.rmSync(dir,{recursive:true,force:true})})
  assert.match(run('postgres',['--version']),/PostgreSQL\) 16\./)
  let script=databaseResources({},credentials,{initialize:true}).spec.template.spec.containers[0].command[2]
  script=script.replaceAll('/var/lib/postgresql/data',dataDir).replaceAll('/bootstrap',bootstrap)
    .replace("-c listen_addresses=''",`-c listen_addresses='' -k ${dir} -p ${port}`)
  const first=run('sh',['-ec',script]).trim()
  assert.match(first,/^\d{10,25}$/)
  assert.equal(run('sh',['-ec',script]).trim(),first,'init retry retains database/role identities')
  run('pg_ctl',['-D',pgdata,'-o',`-c listen_addresses=127.0.0.1 -k ${dir} -p ${port}`,'-l',join(dir,'pg.log'),'-w','start'])
  const url=`postgresql://mx_pay_owner:${credentials.ownerPassword}@127.0.0.1:${port}/mx_pay`
  await migrate(url,{log(){}},{runtimeRole:'mx_pay_runtime'})
  const runtime=new pg.Pool({host:'127.0.0.1',port,user:'mx_pay_runtime',password:credentials.runtimePassword,database:'mx_pay'})
  try {
    await runtime.query('SELECT count(*) FROM pay.orders')
    await runtime.query("INSERT INTO app_auth.browser_sso_records(kind,id,payload,expires_at) VALUES('login','test-record','encrypted-test-payload',now())")
    await runtime.query("DELETE FROM app_auth.browser_sso_records WHERE id='test-record'")
    await assert.rejects(runtime.query('CREATE TABLE public.should_fail(id int)'),{code:'42501'})
    await assert.rejects(runtime.query('DELETE FROM pay.audit'),{code:'42501'})
    await assert.rejects(runtime.query('ALTER ROLE mx_pay_owner PASSWORD \'no\''),{code:'42501'})
  } finally {await runtime.end()}
  run('psql',['-X','-v','ON_ERROR_STOP=1','-c',"CREATE TABLE backup_evidence(id int PRIMARY KEY, message text); INSERT INTO backup_evidence VALUES(1,'payment evidence retained')"])
  const archive=join(dir,'mx_pay.dump')
  run('pg_dump',['--format=custom','--no-owner','--no-acl','--file',archive])
  assert.match(run('pg_restore',['--list',archive]),/backup_evidence/)
  const input=fs.openSync(archive,'r')
  try {assert.match(run('pg_restore',['--list'],{stdio:[input,'pipe','pipe']}),/backup_evidence/)}
  finally {fs.closeSync(input)}
  run('psql',['-X','-v','ON_ERROR_STOP=1','-d','postgres','-c','CREATE DATABASE mx_pay_restore'])
  run('pg_restore',['--exit-on-error','--no-owner','--no-acl','--dbname','mx_pay_restore',archive])
  assert.equal(run('psql',['-XAt','-d','mx_pay_restore','-c','SELECT message FROM backup_evidence WHERE id=1']).trim(),'payment evidence retained')
  assert.equal(Number(run('psql',['-XAt','-d','mx_pay_restore','-c','SELECT count(*) FROM schema_migrations']).trim()),fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).length)
  run('pg_ctl',['-D',pgdata,'-m','fast','-w','stop'])
  const guard=databaseResources({systemIdentifier:first+'1'},credentials).items.find(i=>i.kind==='StatefulSet').spec.template.spec.containers[0].command[2].replaceAll('/var/lib/postgresql/data',dataDir)
  assert.throws(()=>run('sh',['-ec',guard]),error=>error.status===1 && /identity missing\/changed/.test(error.stderr.toString()))
  fs.renameSync(pgdata,join(dataDir,'retained-original'))
  assert.throws(()=>run('sh',['-ec',guard]),error=>error.status===1)
  assert.equal(fs.existsSync(pgdata),false,'restart did not initialize missing data or select retained-original')
})
