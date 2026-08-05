import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const baseUrl = (process.env.MX_SMOKE_BASE_URL || 'http://127.0.0.1:18180').replace(/\/$/, '')
// The data plane may live on a different host/port than the admin plane (the
// internal k8s deploy exposes admin :18151 and public :18150 separately).
const publicBase = (process.env.MX_SMOKE_PUBLIC_BASE_URL || baseUrl).replace(/\/$/, '')
const adminToken = process.env.MX_INSIGHT_ADMIN_TOKEN || 'local-admin-change-me'

async function check(path, init = {}, apiBase = baseUrl) {
  const response = await fetch(`${apiBase}${path}`, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${apiBase}${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

await check('/health/live')
await check('/internal/v1/admin/dashboard', {
  headers: { 'x-mx-insight-admin-token': adminToken },
})

if (process.env.MX_SMOKE_DATA === '1') {
  const keyFile = process.env.MX_INSIGHT_API_KEY_FILE || '.runtime/local-api-key'
  const apiKey = (process.env.MX_INSIGHT_API_KEY || await readFile(keyFile, 'utf8')).trim()
  await check('/api/v1/data/capabilities', { headers: { authorization: `Bearer ${apiKey}` } }, publicBase)
  await check('/api/v1/data/search', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': `smoke-${randomUUID()}`,
    },
    body: JSON.stringify({ platform: process.env.MX_SMOKE_PLATFORM || 'xiaohongshu', query: process.env.MX_SMOKE_QUERY || 'AI Agent', pageSize: 1 }),
  }, publicBase)
}

console.log(`MX Insight Hub smoke passed at ${baseUrl}${process.env.MX_SMOKE_DATA === '1' ? ' (including Night-All data)' : ''}.`)
