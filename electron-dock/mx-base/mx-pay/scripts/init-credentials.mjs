import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appId = process.argv[2]
if (!/^[A-Za-z0-9._-]{1,80}$/.test(appId || '')) throw new Error('Usage: node scripts/init-credentials.mjs <application-id> [output-file]')
const filename = resolve(process.argv[3] || fileURLToPath(new URL('../secrets/credentials.json', import.meta.url)))
const credentials = ['test','live'].flatMap(environment => [
  { id:`app-${environment}`,appId,environment,secret:randomBytes(32).toString('hex'),scopes:['orders.read','orders.write','events.read','events.ack'] },
  { id:`receipt-operator-${environment}`,appId,environment,secret:randomBytes(32).toString('hex'),scopes:['orders.read','receipts.confirm'] },
])
credentials.push({ id:'channel-operator',appId,environment:'live',secret:randomBytes(32).toString('hex'),scopes:['settings.write'] })
await mkdir(dirname(filename),{recursive:true,mode:0o700})
try {
  await writeFile(filename,JSON.stringify(credentials,null,2)+'\n',{mode:0o600,flag:'wx'})
  console.log(`Created credentials at ${filename}; secrets hidden. Live collection remains disabled.`)
} catch(error) {
  if(error.code!=='EEXIST')throw error
  console.log(`Retained existing credentials at ${filename}; no rotation performed.`)
}
