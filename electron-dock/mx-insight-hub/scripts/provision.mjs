// Idempotently ensure a default tenant/consumer exist and mint one API key.
// Called by scripts/manage.sh only when no bootstrap key is stored yet, so the
// freshly minted plaintext key (returned once by the admin API) can be captured
// and persisted into the mx-insight-hub-bootstrap Secret.
//
// Output (stdout), three lines: <apiKey>\n<tenantId>\n<consumerId>
const base = (process.env.MX_INSIGHT_ADMIN_BASE_URL || 'http://127.0.0.1:18151').replace(/\/$/, '')
const adminToken = process.env.MX_INSIGHT_ADMIN_TOKEN
const name = process.env.MX_INSIGHT_BOOTSTRAP_NAME || 'bootstrap'
const nightAllBase = (process.env.NIGHT_ALL_BASE_URL || '').replace(/\/$/, '')
const nightAllToken = process.env.NIGHT_ALL_SERVICE_TOKEN || ''
const platformsOverride = (process.env.MX_INSIGHT_BOOTSTRAP_PLATFORMS || '')
  .split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)

if (!adminToken) {
  process.stderr.write('MX_INSIGHT_ADMIN_TOKEN is required\n')
  process.exit(1)
}

// Platforms the bootstrap key should be entitled to. Prefer an explicit operator
// list; otherwise discover what Night-All actually serves (this runs on the host,
// so it can reach host-local Night-All directly). Best-effort: on any failure the
// key is still minted, just without grants, and the operator can add them later.
async function discoverPlatforms() {
  if (platformsOverride.length) return platformsOverride
  if (!nightAllBase) return []
  try {
    const response = await fetch(`${nightAllBase}/api/v1/data/capabilities`, {
      headers: nightAllToken ? { authorization: `Bearer ${nightAllToken}` } : {},
    })
    if (!response.ok) return []
    const payload = await response.json().catch(() => ({}))
    const list = payload?.data?.platforms
    if (!Array.isArray(list)) return []
    return [...new Set(list
      .map((entry) => (typeof entry === 'string' ? entry : entry?.platform))
      .filter(Boolean)
      .map((platform) => String(platform).toLowerCase()))]
  } catch {
    return []
  }
}

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'x-mx-insight-admin-token': adminToken,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`)
  }
  return payload.data
}

function asList(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  return []
}

// Reuse the bootstrap tenant/consumer when they already exist so repeated
// provisioning (e.g. after the Secret was deleted) does not pile up duplicates.
const tenants = await api('GET', '/internal/v1/admin/tenants')
const tenant = asList(tenants).find((entry) => entry?.name === name)
  || await api('POST', '/internal/v1/admin/tenants', { name })

const consumers = await api('GET', `/internal/v1/admin/consumers?tenantId=${encodeURIComponent(tenant.id)}`)
const consumer = asList(consumers).find((entry) => entry?.name === name)
  || await api('POST', '/internal/v1/admin/consumers', { tenantId: tenant.id, name })

// Grant the discovered/overridden platforms to the bootstrap consumer so the key
// can immediately pull data (search asserts the platform is granted).
const platforms = await discoverPlatforms()
const granted = []
for (const platform of platforms) {
  try {
    await api('PUT', `/internal/v1/admin/platforms/${encodeURIComponent(platform)}`, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
    })
    granted.push(platform)
  } catch (error) {
    process.stderr.write(`warn: could not grant platform "${platform}": ${error.message}\n`)
  }
}
process.stderr.write(`bootstrap platforms granted: ${granted.join(', ') || '(none)'}\n`)

// The plaintext key is only returned at creation, so always mint a fresh one
// here; the caller persists it for reuse across deploys.
const apiKey = await api('POST', '/internal/v1/admin/api-keys', { consumerId: consumer.id, name })
if (!apiKey?.secret) throw new Error('admin api-keys response did not include a plaintext secret')

process.stdout.write(`${apiKey.secret}\n${tenant.id}\n${consumer.id}\n`)
