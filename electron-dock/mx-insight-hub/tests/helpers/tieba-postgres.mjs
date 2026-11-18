import { readdir, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

// Actual PostgreSQL SQL in one local WASM session. This verifies transactions
// and schema compatibility, not PostgreSQL multi-process lock contention.
export async function createTiebaPostgresFixture(t) {
  const moduleUrl = pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE)
  const { PGlite } = await import(moduleUrl.href)
  const { pg_trgm } = await import(new URL('./contrib/pg_trgm.js', moduleUrl))
  const db = new PGlite({ extensions: { pg_trgm } })
  t.after(() => db.close())
  for (const directory of [new URL('../../../mx-common/migrations/', import.meta.url), new URL('../../migrations/', import.meta.url)]) {
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec('BEGIN')
      await db.exec(await readFile(new URL(file, directory), 'utf8'))
      await db.exec('COMMIT')
    }
  }
  const query = async (sql, params) => {
    const answer = await db.query(sql, params)
    return { ...answer, rowCount: answer.rows.length || answer.affectedRows || 0 }
  }
  let tail = Promise.resolve()
  const pool = { async connect() {
    let release
    const gate = new Promise(resolve => { release = resolve }), previous = tail
    tail = previous.then(() => gate)
    await previous
    return { query, release }
  }, async query(sql, params) {
    const client = await this.connect()
    try { return await client.query(sql, params) } finally { client.release() }
  } }
  return { db, pool, store: new PostgresStore(pool) }
}
