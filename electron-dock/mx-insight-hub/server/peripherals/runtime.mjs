import pg from 'pg'
import { PeripheralStore } from './store.mjs'
import { PeripheralService } from './service.mjs'
import { createPeripheralTransport } from './transport.mjs'

export function createPeripheralRuntime(config, env = process.env) {
  if (config.storeDriver !== 'postgres' || config.listenerMode === 'public') return null
  let transport
  try { transport = createPeripheralTransport({ origins: (env.MX_INSIGHT_PERIPHERAL_ORIGINS || '').split(',').map(s => s.trim()) }) }
  catch { console.warn('peripheral_origin_configuration_invalid'); return null }
  // Separate bounded pool: slow/failing peripherals never exhaust the Hub request pool.
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10_000, application_name: 'mx-insight-hub-peripherals' })
  pool.on('error', () => console.warn('peripheral_storage_connection_error'))
  const service = new PeripheralService({ store: new PeripheralStore(pool), transport })
  const close = service.close.bind(service)
  service.close = async () => { await close(); await pool.end() }
  return service
}
