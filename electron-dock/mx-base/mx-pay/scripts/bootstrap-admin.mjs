// Run on the deployment host after root registers in Launcher. No guessed identity.
import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { readApplicationSsoProfile } from '../../../mx-common/src/identity/profile.mjs'
import { validateConsoleAccess } from '../server/console-config.mjs'
try {
  const options = {}, args = process.argv.slice(2)
  for (let i=0;i<args.length;i+=2) {
    if (!['--subject','--profile','--access'].includes(args[i]) || !args[i+1]) throw Error()
    options[args[i]]=args[i+1]
  }
  const subject=options['--subject']
  if (!subject || subject==='root' || subject.length>200) throw Error()
  const root = new URL('../',import.meta.url).pathname
  const profile = readApplicationSsoProfile(resolve(options['--profile'] || `${root}/secrets/console/profile.json`))
  if (profile.appId!=='mx-pay') throw Error()
  const filename = resolve(options['--access'] || `${root}/secrets/console/access.json`)
  const access = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename,'utf8')) : []
  const grant = {issuer:profile.issuer,subject,clientId:profile.clientId,scope:'center',role:'administrator'}
  if (!access.some(e=>e.issuer===grant.issuer && e.subject===subject && e.clientId===grant.clientId && e.role==='administrator' && e.scope==='center')) access.push(grant)
  validateConsoleAccess(access)
  fs.mkdirSync(dirname(filename),{recursive:true,mode:0o700})
  const temp = `${filename}.${process.pid}.tmp`
  fs.writeFileSync(temp,JSON.stringify(access,null,2)+'\n',{flag:'wx',mode:0o600}); fs.renameSync(temp,filename)
  console.log('Payment administrator binding saved. Run scripts/manage.sh deploy to import it once. Launcher identity was not modified.')
} catch {
  console.error('Administrator bootstrap refused. Usage: node scripts/bootstrap-admin.mjs --subject <root immutable userId> [--profile private-profile.json] [--access private-access.json]. Register root in Launcher first; username is not userId.')
  process.exitCode=1
}
