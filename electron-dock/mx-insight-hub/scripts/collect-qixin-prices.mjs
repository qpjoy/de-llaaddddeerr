// Public catalogue metadata only. This never calls api.qixin.com, reads a Key,
// modifies a published price book, or dispatches a customer query.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
const output = process.argv[2]
if (!output) throw new Error('Usage: node scripts/collect-qixin-prices.mjs /tmp/qixin-price-candidate.json')
const rows = [], pagesSha256 = [], seen = new Set()
const pageSize = 10
let total = null
for (let page = 0; page < 100; page++) {
  const url = `https://data.qixin.com/api-op/user/apis/get_api_list?offset=${page * pageSize}&page=${pageSize}`
  const raw = execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '30', url], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  const data = JSON.parse(raw).data
  if (!Number.isSafeInteger(data?.total) || data.total < 1 || !Array.isArray(data.list) || !data.list.length) throw new Error('Invalid catalogue page')
  total ??= data.total
  if (total !== data.total) throw new Error('Catalogue changed during pagination; discard candidate and rerun')
  pagesSha256.push(createHash('sha256').update(raw).digest('hex'))
  for (const item of data.list) {
    if (!/^\d+\.\d+$/.test(item.api_id) || seen.has(item.api_id)) throw new Error('Invalid or duplicate API ID')
    seen.add(item.api_id)
    const publicPrice = item.price_show === 1 && typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0
    const minor = publicPrice ? Math.round(item.price * 100) : null
    if (publicPrice && (!Number.isSafeInteger(minor) || Math.abs(item.price * 100 - minor) > 1e-6)) throw new Error('Price cannot be represented exactly in CNY minor units')
    rows.push({ apiId: item.api_id, name: item.api_name, unitPriceMinor: minor })
  }
  if (rows.length >= total) break
}
if (rows.length !== total) throw new Error('Incomplete catalogue')
await writeFile(output, JSON.stringify({ source: 'https://data.qixin.com/api-list?from=qxb-navigation-data',
  observedAt: new Date().toISOString(), pageSize, pageCount: pagesSha256.length, total, currency: 'CNY', pagesSha256, entries: rows }, null, 2) + '\n')
console.log(`Saved ${total} public catalogue entries to ${output}; review before publishing a new immutable version.`)
