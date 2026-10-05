import { readFileSync } from 'node:fs'
import { PaymentManagement } from './management.mjs'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig, readCredentials } from './config.mjs'
import { createPool, createReportingPool } from './database.mjs'
import { assertPaymentDatabase, assertSchema } from './migrate.mjs'
import { PaymentCenter } from './service.mjs'
import { createApp } from './app.mjs'
import { readChannels } from './channel-config.mjs'

const config = loadConfig(), pool = createPool(config), reportingPool = createReportingPool(config), state = { draining: false }
for (const p of [pool,reportingPool]) p.on('error', error => console.error(JSON.stringify({ service: 'mx-pay', code: error.code || 'pool_error' })))
const closePools=()=>Promise.all([pool.end(),reportingPool.end()])
try {
  await assertPaymentDatabase(pool)
  await assertSchema(pool)
  const credentials = readCredentials(config.credentialsFile)
  const service = new PaymentCenter(pool, { reportingPool, channels: readChannels(process.env.MX_PAY_CHANNELS_FILE) })
  const management = process.env.MX_PAY_CONTROL_KEY_FILE ? new PaymentManagement(pool,process.env.MX_PAY_CONTROL_KEY_FILE) : null
  if (management) {
    await management.bootstrap({channels:readChannels(process.env.MX_PAY_CHANNELS_FILE),credentials,
      drafts:process.env.MX_PAY_CHANNEL_DRAFTS_FILE ? JSON.parse(readFileSync(process.env.MX_PAY_CHANNEL_DRAFTS_FILE,'utf8')) : []})
    await management.syncChannels(service,process.env.MX_PAY_CHECKOUT_PAUSED==='1')
  } else await service.channelPayments.bind()
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 3000 }, createApp({ service, credentials, management, state }))
  server.on('error', () => { console.error('mx-pay listener failed'); process.exitCode = 1; void closePools() })
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ service: 'mx-pay', port: config.port, status: 'listening' })))
  async function stop() {
    if (state.draining) return
    state.draining = true
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1) }, 25000)
    deadline.unref()
    await delay(config.drainMs)
    await new Promise(resolve => server.close(resolve))
    await closePools()
    clearTimeout(deadline)
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
} catch (error) {
  console.error('mx-pay startup refused; check database, migrations and credential configuration.', error.code || error.name)
  await closePools(); process.exitCode = 1
}
