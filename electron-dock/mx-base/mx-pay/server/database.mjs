import pg from 'pg'

export function createPool(config) {
  return new pg.Pool({ connectionString: config.databaseUrl, max: config.maxConnections || 10,
    application_name: 'mx-pay', connectionTimeoutMillis: 5000, statement_timeout: 10000,
    lock_timeout: 5000, idle_in_transaction_session_timeout: 15000, idleTimeoutMillis: 30000 })
}
