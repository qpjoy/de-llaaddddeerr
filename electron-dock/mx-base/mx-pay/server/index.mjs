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
  await service.channelPayments.bind()
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 3000 }, createApp({ service, credentials, state }))
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
