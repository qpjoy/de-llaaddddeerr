import { PaymentManagement } from './management.mjs'
import { createServer } from 'node:http'
import { createPool, createReportingPool } from './database.mjs'
import { assertPaymentDatabase, assertSchema } from './migrate.mjs'
import { PaymentCenter } from './service.mjs'
import { readConsoleConfig } from './console-config.mjs'
import { createPaymentConsole } from './console.mjs'

// Separate process, listener and bounded pools: Auth availability never gates
// machine payment requests, Alipay notifications or payment API readiness.
let sessionPool, readPool
try {
  const config = readConsoleConfig(process.env.MX_PAY_SSO_PROFILE, process.env.MX_PAY_CONSOLE_ACCESS_FILE)
  if (!config || !process.env.MX_PAY_DATABASE_URL) throw new Error('Payment console needs explicit SSO, access and dedicated database configuration')
  const port = Number(process.env.MX_PAY_CONSOLE_PORT || 18231)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid console port')
  sessionPool = createPool({ databaseUrl: process.env.MX_PAY_DATABASE_URL, maxConnections: 2 })
  readPool = createReportingPool({ databaseUrl: process.env.MX_PAY_DATABASE_URL })
  for (const pool of [sessionPool, readPool]) pool.on('error', () => console.error('Payment console database unavailable'))
  await assertPaymentDatabase(sessionPool); await assertSchema(sessionPool)
  const management = process.env.MX_PAY_CONTROL_KEY_FILE ? new PaymentManagement(sessionPool,process.env.MX_PAY_CONTROL_KEY_FILE,{readPool}) : null
  if (management) await management.bootstrap({access:config.access})
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 3000 },
    createPaymentConsole({ ...config, sessionPool, management, service: new PaymentCenter(readPool) }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, process.env.MX_PAY_CONSOLE_HOST || '0.0.0.0', resolve) })
  console.log(JSON.stringify({ service: 'mx-pay-console', port, status: 'listening' }))
  let stopping = false
  async function stop() {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => server.closeAllConnections(), 15000); deadline.unref()
    await new Promise(resolve => server.close(resolve))
    await Promise.all([sessionPool.end(), readPool.end()]); clearTimeout(deadline)
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
} catch {
  console.error('Payment console startup refused; payment API runs independently')
  await Promise.all([sessionPool?.end(), readPool?.end()]); process.exitCode = 1
}
