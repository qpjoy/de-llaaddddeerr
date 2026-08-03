import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const baseUrl = process.env.MX_INSIGHT_ADMIN_URL || 'http://127.0.0.1:18180'
const adminToken = process.env.MX_INSIGHT_ADMIN_TOKEN || 'local-admin-change-me'
const output = resolve(process.env.MX_INSIGHT_BOOTSTRAP_KEY_FILE || '.runtime/local-api-key')

async function admin(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-mx-insight-admin-token': adminToken,
      ...init.headers,
    },
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload.data
}

let [tenant] = await admin('/internal/v1/admin/tenants')
if (!tenant) {
  tenant = await admin('/internal/v1/admin/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: 'Local Development' }),
  })
}

let [consumer] = await admin(`/internal/v1/admin/consumers?tenantId=${encodeURIComponent(tenant.id)}`)
if (!consumer) {
  consumer = await admin('/internal/v1/admin/consumers', {
    method: 'POST',
    body: JSON.stringify({ tenantId: tenant.id, name: 'Local Terminal' }),
  })
}

for (const platform of ['xiaohongshu', 'weibo']) {
  await admin(`/internal/v1/admin/platforms/${platform}`, {
    method: 'PUT',
    body: JSON.stringify({
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 1000,
      windowSeconds: 3600,
      maxPageSize: 100,
    }),
  })
}

const keys = await admin(`/internal/v1/admin/api-keys?consumerId=${encodeURIComponent(consumer.id)}`)
const keyFileExists = await access(output).then(() => true, () => false)
if (keyFileExists && keys.some((key) => key.status === 'active' && key.name === 'Local CLI')) {
  console.log(`Bootstrap already exists. Reuse or rotate the active key from the Admin UI.`)
  process.exit(0)
}

for (const key of keys.filter((candidate) => candidate.status === 'active' && candidate.name === 'Local CLI')) {
  await admin(`/internal/v1/admin/api-keys/${encodeURIComponent(key.id)}/revoke`, { method: 'POST' })
}

const key = await admin('/internal/v1/admin/api-keys', {
  method: 'POST',
  body: JSON.stringify({ consumerId: consumer.id, name: 'Local CLI', environment: 'test' }),
})
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${key.secret}\n`, { mode: 0o600 })
await chmod(output, 0o600)
console.log(`Local tenant, consumer, xiaohongshu/weibo grants, and API key are ready.`)
console.log(`The one-time secret was written with mode 0600 to ${output}.`)
