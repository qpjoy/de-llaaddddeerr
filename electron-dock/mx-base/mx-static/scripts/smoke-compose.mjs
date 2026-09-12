// Uses a uniquely named local Compose project and temporary fixtures; never targets deployed mx-static.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root = await mkdtemp(join(tmpdir(), 'mx-static-compose-'))
const dir = fileURLToPath(new URL('..', import.meta.url))
for (const path of ['data','state','secrets']) await mkdir(join(root,path))
const token = 'test'.repeat(16)
await writeFile(join(root,'secrets/projects.json'), JSON.stringify({test:{read:token,write:token}}), {mode:0o444})
await writeFile(join(root,'secrets/signing-key'), token, {mode:0o444})
const env = {...process.env, MX_STATIC_DATA_PATH:join(root,'data'), MX_STATIC_STATE_PATH:join(root,'state'), MX_STATIC_SECRETS_PATH:join(root,'secrets'), MX_STATIC_WRITER_PORT:'0', MX_STATIC_READER_PORT:'0', MX_STATIC_PUBLIC_URL:'http://preview.invalid'}
const project = `mx-static-smoke-${process.pid}`
const docker = args => execFileSync('docker',args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
const compose = args => docker(['compose','--project-directory',dir,'-f',join(dir,'compose.yml'),'-p',project,...args])
try {
 docker(['volume','create',project+'-state'])
 env.MX_STATIC_STATE_PATH=docker(['volume','inspect',project+'-state','--format','{{.Mountpoint}}'])
 docker(['run','--rm','--user','0','-v',project+'-state:/state','mx-static:0.3.0','chown','1000:1000','/state'])
 docker(['run','--rm','--user','0','-v',`${root}:/fixture`,'mx-static:0.3.0','chown','-R','1000:1000','/fixture/data','/fixture/state'])
 console.log(compose(['config','--quiet']))
 compose(['up','-d','--no-build','--wait','--wait-timeout','100'])
 const url = name => 'http://' + compose(['port',name,'18200'])
 let writer = url('writer'), reader = url('reader')
 const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=','base64')
 const headers = {authorization:`Bearer ${token}`}
 const upload = await fetch(writer+'/static/v1/projects/test/upload',{method:'POST',headers:{...headers,'content-type':'image/png'},body:png})
 assert.equal(upload.status,201); const meta = await upload.json()
 const file = '/static/files/'+meta.key
 assert.deepEqual(Buffer.from(await fetch(reader+file,{headers}).then(r=>r.arrayBuffer())),png)
 const queued = await fetch(writer+'/static/v1/projects/test/ingest',{method:'POST',headers:{...headers,prefer:'respond-async','content-type':'application/json'},body:JSON.stringify({url:'https://127.0.0.1/blocked'})})
 assert.equal(queued.status,202); const job = await queued.json()
 await new Promise(r=>setTimeout(r,1000))
 assert.equal((await fetch(writer+job.statusUrl,{headers}).then(r=>r.json())).state,'failed')
 compose(['restart','--timeout','40'])
 writer = url('writer'); reader = url('reader')
 for (let i=0;i<100;i++) {
   try { if((await fetch(reader+'/static/health')).ok && (await fetch(writer+'/static/health')).ok) break } catch {}
   await new Promise(r=>setTimeout(r,100))
 }
 assert.deepEqual(Buffer.from(await fetch(reader+file,{headers}).then(r=>r.arrayBuffer())),png)
 assert.equal((await fetch(reader+job.statusUrl,{headers}).then(r=>r.json())).state,'failed')
 console.log('PASS: separate data/state binds; non-root writer + read-only reader; restart bytes/job persistence')
 console.log(compose(['exec','-T','writer','node','-p','JSON.stringify({node:process.version,sqlite:process.versions.sqlite,uid:process.getuid()})']))
 const samples = await Promise.all(Array.from({length:100},async()=>{const start=performance.now();const r=await fetch(reader+file,{headers});assert.equal(r.status,200);await r.arrayBuffer();return performance.now()-start}))
 samples.sort((a,b)=>a-b)
 console.log(JSON.stringify({cachedRequests:100,p50Ms:samples[49],p95Ms:samples[94],note:'localhost 68-byte fixture, not production throughput'}))
} catch(error) { console.error(compose(['logs','--tail','40'])); throw error } finally {
 try { compose(['down','--timeout','40']) } catch(e) { console.error(e.message) }
 docker(['volume','rm',project+'-state'])
 await rm(root,{recursive:true,force:true})
}
