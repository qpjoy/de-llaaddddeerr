import pg from 'pg'

export function createPool(config) {
  return new pg.Pool({ connectionString: config.databaseUrl, max: config.maxConnections || 10,
    application_name: 'mx-pay', connectionTimeoutMillis: 5000, statement_timeout: 10000,
    lock_timeout: 5000, idle_in_transaction_session_timeout: 15000, idleTimeoutMillis: 30000 })
}
// Separate, bounded readers cannot exhaust the transaction connection pool.
export function createReportingPool(config) {
  return new pg.Pool({connectionString:config.databaseUrl,max:2,application_name:'mx-pay-reporting',
    connectionTimeoutMillis:2000,statement_timeout:2000,lock_timeout:1000,
    idle_in_transaction_session_timeout:5000,idleTimeoutMillis:30000,
    options:'-c default_transaction_read_only=on'})
}
