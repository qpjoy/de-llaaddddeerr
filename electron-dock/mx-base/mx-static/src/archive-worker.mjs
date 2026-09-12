import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ArchiveCatalog } from './archive-catalog.mjs'

// One child maximum. A hard-NFS D-state child may not exit even after SIGKILL:
// do not start replacements and exhaust host tasks/file descriptors.
export class ArchiveWorker {
  constructor({stateDir,localRoot,nasRoot,volumeId,requireNfs=true,timeoutMs=15000,maxDurationMs=900000,probeIntervalMs=30000,spawnImpl=spawn}) {
    if(![timeoutMs,maxDurationMs,probeIntervalMs].every(n=>Number.isSafeInteger(n)&&n>0)) throw Error('Invalid archive deadlines')
    this.catalog=new ArchiveCatalog(stateDir)
    this.config={stateDir,localRoot,nasRoot,volumeId,requireNfs}
    Object.assign(this,{timeoutMs,maxDurationMs,probeIntervalMs,spawnImpl})
    this.child=null;this.stopped=false;this.nextRun=0;this.health='starting';this.lastError=null
  }
  tick() {
    if(this.stopped) return
    if(!this.catalog.backend().enabled) {this.health='detached';this.catalog.heartbeat(this.health);return}
    this.catalog.heartbeat(this.health,this.lastError)
    if(this.child || Date.now()<this.nextRun) return
    const job=this.catalog.claim()
    const child=this.spawnImpl(process.execPath,[fileURLToPath(new URL('./archive-io.mjs',import.meta.url)),JSON.stringify({...this.config,job})],{stdio:['ignore','ignore','pipe','ipc']})
    this.child=child
    let error='',finished=false
    child.stderr?.on('data',chunk=>{error=(error+chunk).slice(0,200)})
    const finish=(ok,reason)=>{
      if(finished) return
      finished=true;clearTimeout(timer);clearTimeout(absoluteTimer)
      if(job) {if(ok)this.catalog.complete(job);else this.catalog.fail(job,reason)}
      this.health=ok?'online':'backoff';this.lastError=ok?null:reason
      this.catalog.heartbeat(this.health,ok?null:reason)
      this.nextRun=Date.now()+(ok?(job?0:this.probeIntervalMs):Math.min(300000,Math.max(5000,this.probeIntervalMs)))
    }
    const expire=()=>{finish(false,'nas_io_timeout');this.health='stalled';this.catalog.heartbeat('stalled','nas_io_timeout');child.kill('SIGKILL')}
    let timer=setTimeout(expire,this.timeoutMs)
    const absoluteTimer=setTimeout(expire,this.maxDurationMs)
    child.on('message',message=>{if(message?.progress && !finished){clearTimeout(timer);timer=setTimeout(expire,this.timeoutMs)}})
    child.on('error',()=>{finish(false,'archive_child_failed');this.child=null;if(this.stopped)this.catalog.close()})
    child.on('exit',code=>{finish(code===0,error.trim()||'archive_io_failed');this.child=null;if(this.stopped)this.catalog.close()})
  }
  start() { this.timer=setInterval(()=>{try{this.tick()}catch{this.health='control_error'}},1000);this.tick();return this }
  async stop() {
    this.stopped=true;clearInterval(this.timer)
    if(this.child) this.child.kill('SIGKILL')
    // Caller may exit the container; do not block HTTP service shutdown on NFS.
    if(!this.child) this.catalog.close()
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const worker=new ArchiveWorker({stateDir:process.env.MX_STATIC_STATE_DIR||'/state',localRoot:'/data',nasRoot:'/nas',volumeId:process.env.MX_STATIC_NAS_VOLUME_ID,timeoutMs:Number(process.env.MX_STATIC_NAS_IDLE_TIMEOUT_MS||15000),maxDurationMs:Number(process.env.MX_STATIC_NAS_MAX_JOB_MS||900000),requireNfs:process.env.MX_STATIC_NAS_REQUIRE_NFS!=='false'}).start()
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{worker.stop();setTimeout(()=>process.exit(0),100).unref()})
}
