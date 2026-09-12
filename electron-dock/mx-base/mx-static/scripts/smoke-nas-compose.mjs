// Isolated local filesystem simulation; does not mount or contact a real NAS.
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
const dir=fileURLToPath(new URL('..',import.meta.url)),root=await mkdtemp(join(tmpdir(),'static-nas-compose-'))
for(const path of ['data','state','secrets','nas'])await mkdir(join(root,path))
const token='test'.repeat(16),headers={authorization:`Bearer ${token}`},project=`mx-static-nas-test-${process.pid}`
await writeFile(join(root,'secrets/projects.json'),JSON.stringify({test:{read:token,write:token}}),{mode:0o444})
await writeFile(join(root,'secrets/signing-key'),token,{mode:0o444})
await writeFile(join(root,'nas/.mx-static-volume-id'),'nas-test',{mode:0o444})
await writeFile(join(root,'test.json'),JSON.stringify({services:{writer:{healthcheck:{interval:'1s'}},reader:{healthcheck:{interval:'1s'}}}}))
const env={...process.env,MX_STATIC_DATA_PATH:join(root,'data'),MX_STATIC_STATE_PATH:join(root,'state'),MX_STATIC_SECRETS_PATH:join(root,'secrets'),MX_STATIC_WRITER_PORT:'0',MX_STATIC_READER_PORT:'0',MX_STATIC_NAS_PATH:join(root,'nas'),MX_STATIC_NAS_VOLUME_ID:'nas-test',MX_STATIC_NAS_REQUIRE_NFS:'false',MX_STATIC_CACHE_TTL_MS:'0'}
const docker=args=>execFileSync('docker',args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000}).trim()
const compose=args=>docker(['compose','--project-directory',dir,'-f',join(dir,'compose.yml'),'-f',join(dir,'compose.nas.yml'),'-f',join(root,'test.json'),'--profile','nas','-p',project,...args])
const control=action=>compose(['exec','-T','writer','node','mx-base/mx-static/src/archive-control.mjs',action,'nas-test'])
async function until(check){for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,200))}throw Error('NAS smoke condition timed out')}
try {
 docker(['volume','create',project+'-state'])
 env.MX_STATIC_STATE_PATH=docker(['volume','inspect',project+'-state','--format','{{.Mountpoint}}'])
 docker(['run','--rm','--user','0','-v',project+'-state:/state','mx-static:0.3.0','chown','1000:1000','/state'])
 docker(['run','--rm','--user','0','-v',`${root}:/fixture`,'mx-static:0.3.0','chown','1000:1000','/fixture/data','/fixture/state','/fixture/nas'])
 compose(['up','-d','--no-build','--wait','writer','reader'])
 const writer='http://'+compose(['port','writer','18200']),reader='http://'+compose(['port','reader','18200'])
 const ids=compose(['ps','-q','writer','reader'])
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=','base64')
 const upload=async()=>{const r=await fetch(writer+'/static/v1/projects/test/upload',{method:'POST',headers:{...headers,'content-type':'image/png'},body:png,signal:AbortSignal.timeout(3000)});assert.equal(r.status,201);return r.json()}
 const status=()=>fetch(writer+'/static/v1/projects/test/storage',{headers}).then(r=>r.json())
 const first=await upload()
 control('attach');compose(['up','-d','--no-deps','archive'])
 await until(async()=>{try{return (await readFile(join(root,'nas/objects',first.key))).equals(png)}catch{return false}})
 await until(async()=>(await status()).backend.health==='online')
 control('detach');compose(['stop','--timeout','3','archive'])
 await rename(join(root,'nas'),join(root,'nas-offline'));await mkdir(join(root,'nas'))
 control('attach');compose(['up','-d','--no-deps','--force-recreate','archive'])
 await until(async()=>(await status()).backend.health==='backoff')
 const second=await upload()
 assert.equal((await fetch(writer+'/static/health',{signal:AbortSignal.timeout(1000)})).status,200)
 assert.deepEqual(Buffer.from(await fetch(reader+'/static/files/'+first.key,{headers}).then(r=>r.arrayBuffer())),png)
 assert.equal(compose(['ps','-q','writer','reader']),ids)
 control('detach');compose(['stop','--timeout','3','archive'])
 await rm(join(root,'nas'),{recursive:true});await rename(join(root,'nas-offline'),join(root,'nas'))
 control('attach');compose(['up','-d','--no-deps','--force-recreate','archive'])
 await until(async()=>{try{return (await readFile(join(root,'nas/objects',second.key))).equals(png)}catch{return false}})
 await until(async()=>(await status()).backend.health==='online')
 const evict=await fetch(writer+'/static/v1/projects/test/storage/evict',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({key:first.key})})
 assert.equal(evict.status,202)
 await until(async()=>{try{await readFile(join(root,'data/objects',first.key));return false}catch{return true}})
 const cold=await fetch(reader+'/static/files/'+first.key,{headers});assert.equal(cold.status,503)
 await until(async()=>{const r=await fetch(reader+'/static/files/'+first.key,{headers});await r.arrayBuffer();return r.status===200})
 assert.equal(compose(['ps','-q','writer','reader']),ids)
 console.log('PASS: optional archive attachment, missing mount identity, local reads/writes while offline, replay on reconnect, reader-triggered cold restore; core container IDs unchanged')
} catch(error){try{console.error(await fetch('http://'+compose(['port','writer','18200'])+'/static/v1/projects/test/storage',{headers}).then(r=>r.json()));console.error(control('status'))}catch{}console.error(compose(['logs','--tail','20']));throw error}
finally{try{compose(['down','--timeout','5'])}finally{docker(['volume','rm',project+'-state']);await rm(root,{recursive:true,force:true})}}
