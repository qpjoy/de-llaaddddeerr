import { readFileSync, statSync } from 'node:fs'
import { parseReportingSources } from '@qpjoy/mx-pay/reporting'

try {
  const file=process.argv[2],env={}
  if(!file || (statSync(file).mode & 0o077))throw Error()
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)) {
    if(!line.trim() || line.trimStart().startsWith('#'))continue
    const match=/^(MX_INSIGHT_PAYMENT_REPORTING_SOURCES|MX_INSIGHT_PAYMENT_REPORTING_DATABASE_URL)=(.*)$/.exec(line)
    if(!match || Object.hasOwn(env,match[1]))throw Error()
    env[match[1]]=match[2]
  }
  if(!Object.hasOwn(env,'MX_INSIGHT_PAYMENT_REPORTING_SOURCES'))throw Error()
  parseReportingSources(env.MX_INSIGHT_PAYMENT_REPORTING_SOURCES)
  if(env.MX_INSIGHT_PAYMENT_REPORTING_DATABASE_URL) {
    const url=new URL(env.MX_INSIGHT_PAYMENT_REPORTING_DATABASE_URL)
    if(!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length<2)throw Error()
  }
} catch {
  console.error('Invalid payment reporting env file: require mode 0600, plain KEY=value, sources JSON and optional reporting PostgreSQL URL. No secrets printed.')
  process.exitCode=1
}
