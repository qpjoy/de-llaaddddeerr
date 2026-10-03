import { readFileSync, statSync } from 'node:fs'
import { parseRechargeSources } from '../server/payments/recharge-config.mjs'
try {
  const file=process.argv[2]
  if(!file || (statSync(file).mode & 0o077))throw Error()
  const lines=readFileSync(file,'utf8').split(/\r?\n/).filter(line=>line.trim()&&!line.trimStart().startsWith('#'))
  if(lines.length!==1 || !lines[0].startsWith('MX_INSIGHT_PAYMENT_DELIVERY_SOURCES='))throw Error()
  parseRechargeSources(lines[0].slice('MX_INSIGHT_PAYMENT_DELIVERY_SOURCES='.length))
} catch {
  console.error('Invalid payment delivery configuration: require private mode 0600 and one MX_INSIGHT_PAYMENT_DELIVERY_SOURCES JSON value. Values hidden.')
  process.exitCode=1
}
