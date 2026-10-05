// Import explicitly selected local defaults, never execute YAML or print secrets.
import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createPrivateKey, createPublicKey } from 'node:crypto'
const args = process.argv.slice(2), options = {}
try {
  for (let i=0;i<args.length;i+=2) {
    if (!['--source','--output','--seller-id','--pay-origin','--return-url'].includes(args[i]) || !args[i+1]) throw Error()
    options[args[i]] = args[i+1]
  }
  if (!options['--source']) throw Error()
  const source = fs.readFileSync(options['--source'],'utf8')
  const get = key => {
    const line = source.split(/\r?\n/).find(line=>new RegExp(`^\\s+${key}:`).test(line)) || ''
    return /\$\{[A-Z_]+:(.*)\}\s*$/.exec(line)?.[1] || ''
  }
  const privateKey = createPrivateKey({key:Buffer.from(get('merchant-private-key'),'base64'),format:'der',type:'pkcs8'}).export({format:'pem',type:'pkcs8'}).toString()
  const alipayPublicKey = createPublicKey({key:Buffer.from(get('public-key'),'base64'),format:'der',type:'spki'}).export({format:'pem',type:'spki'}).toString()
  const origin = new URL(options['--pay-origin'] || 'https://pay.minsight-ai.com')
  if (origin.protocol!=='https:' || origin.origin!==origin.href.replace(/\/$/,'')) throw Error()
  const channel = {id:'alipay-live',provider:'alipay',environment:'live',enabled:false,appId:get('app-id'),sellerId:options['--seller-id'] || get('seller-id'),
    allowedApps:['mx-insight-hub'],keyType:'PKCS8',privateKey,alipayPublicKey,
    notifyUrl:`${origin.origin}/v1/notifications/alipay/alipay-live`,returnUrl:options['--return-url'] || 'https://hub.minsight-ai.com/admin/'}
  if (!/^\d{16}$/.test(channel.appId) || channel.sellerId && !/^2088\d{12}$/.test(channel.sellerId)) throw Error()
  const output = resolve(options['--output'] || new URL('../secrets/channel-drafts.json',import.meta.url).pathname)
  fs.mkdirSync(dirname(output),{recursive:true,mode:0o700})
  const previous=fs.existsSync(output) ? JSON.parse(fs.readFileSync(output,'utf8')) : []
  if (!Array.isArray(previous) || previous.length>=32) throw Error()
  if (previous.some(c=>c.id===channel.id)) {
    console.log('Existing Alipay draft retained; no changes made. Update an imported channel through the management console.');process.exit(0)
  }
  const temp=`${output}.${process.pid}.tmp`
  fs.writeFileSync(temp,JSON.stringify([...previous,channel],null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,output)
  console.log(`Imported disabled Alipay draft to ${output}; seller ID ${channel.sellerId?'present':'missing'}. Local defaults only; live environment overrides were not inspected.`)
} catch {
  console.error('Import refused: check source/default values, HTTPS origins, or existing output. No key values were printed and no existing file was overwritten. Usage: node scripts/import-luopan-alipay.mjs --source /path/application.yml')
  process.exitCode=1
}
