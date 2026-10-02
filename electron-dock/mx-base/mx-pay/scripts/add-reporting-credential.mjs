// Explicit local enrollment of a read-only consumer; existing keys never rotate.
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCredentials } from '../server/config.mjs'

const [appId,environment,id,output]=process.argv.slice(2)
if (![appId,id].every(v=>/^[A-Za-z0-9._-]{1,80}$/.test(v || '')) || !['test','live'].includes(environment) || process.argv.length>6) throw Error('Usage: node scripts/add-reporting-credential.mjs <appId> <test|live> <credentialId> [credentials-file]')
const file=resolve(output || fileURLToPath(new URL('../secrets/credentials.json',import.meta.url)))
fs.mkdirSync(dirname(file),{recursive:true,mode:0o700})
const lock=fs.openSync(`${file}.lock`,'wx',0o600)
const temp=`${file}.${process.pid}.tmp`
try {
  readCredentials(file)
  const original=fs.readFileSync(file,'utf8'),entries=JSON.parse(original), existing=entries.find(e=>e.id===id)
  if(existing) {
    if(existing.appId!==appId || existing.environment!==environment || existing.scopes.length!==1 || existing.scopes[0]!=='reports.read')throw Error('Credential ID already has another identity/scope; no changes made')
    console.log('Existing reporting credential retained; secret hidden.')
  } else {
    entries.push({id,appId,environment,secret:randomBytes(32).toString('hex'),scopes:['reports.read']})
    fs.writeFileSync(temp,JSON.stringify(entries,null,2)+'\n',{mode:0o600,flag:'wx'})
    readCredentials(temp)
    if(fs.readFileSync(file,'utf8')!==original)throw Error('Credentials changed concurrently; retry without overwriting')
    fs.renameSync(temp,file)
    console.log(`Added read-only reporting credential ${id}. Deploy to load it; secret remains in the private file.`)
  }
} finally {
  if(fs.existsSync(temp))fs.unlinkSync(temp)
  fs.closeSync(lock);fs.unlinkSync(`${file}.lock`)
}
