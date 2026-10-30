import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PlatformSearchPolicyStore } from '../../server/external-platforms/platform-search-policy.mjs'

export async function facebookQuotaFixture(t) {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  const baseline = await readFile(new URL('../../migrations/143_facebook_platform_search.sql', import.meta.url), 'utf8')
  await db.exec(baseline.slice(baseline.indexOf('CREATE TABLE'), baseline.indexOf('ALTER TABLE')))
  for (const name of ['149_facebook_billing_window.sql', '151_facebook_rapid_admission_queue.sql', '169_facebook_supplier_quota.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  // PGlite has one session. Serialize client lifetimes to exercise the actual
  // SQL/transactions without pretending this tests real multi-session locks.
  let tail = Promise.resolve()
  const pool = { async connect() {
    let release
    const gate = new Promise(resolve => { release = resolve }), previous = tail
    tail = previous.then(() => gate); await previous
    return { query: (sql, params) => db.query(sql, params), release }
  }, async query(sql, params) { const client = await this.connect(); try { return await client.query(sql, params) } finally { client.release() } } }
  return { db, pool, store: new PlatformSearchPolicyStore(pool), replica: new PlatformSearchPolicyStore(pool) }
}
