import pg from 'pg'
import { capabilityCatalog, syncCapabilityCatalog } from '../server/data/capability-catalog.mjs'

// Always read-only. Normal migrations apply the validated metadata snapshot.
if (!process.env.DATABASE_URL) console.log(JSON.stringify(capabilityCatalog(), null, 2))
else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try { console.log(JSON.stringify(await syncCapabilityCatalog(pool), null, 2)) }
  finally { await pool.end() }
}
