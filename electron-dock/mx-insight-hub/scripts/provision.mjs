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
const capabilitiesOverride = (process.env.MX_INSIGHT_BOOTSTRAP_CAPABILITIES || '')
  .split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
const bootstrapPlanKey = (process.env.MX_INSIGHT_BOOTSTRAP_PLAN_KEY || 'launch-1m')
  .trim().toLowerCase()

if (!adminToken) {
  process.stderr.write('MX_INSIGHT_ADMIN_TOKEN is required\n')
  process.exit(1)
}
if (!/^[a-z][a-z0-9._-]{0,63}$/.test(bootstrapPlanKey)) {
  process.stderr.write('MX_INSIGHT_BOOTSTRAP_PLAN_KEY must be a valid plan key\n')
  process.exit(1)
}

// Platforms the bootstrap key should be entitled to. Prefer an explicit operator
// list; otherwise discover what Night-All actually serves (this runs on the host,
// so it can reach host-local Night-All directly).
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

const platforms = await discoverPlatforms()

// A reused consumer may still carry the grandfathered legacy plan. Reconcile
// the operator-selected published version before granting or minting Xiaohongshu
// scope, so a failed CAS can never leave behind a newly issued unmetered key.
if (platforms.includes('xiaohongshu') || process.env.MX_INSIGHT_BOOTSTRAP_PLAN_KEY) {
  const planState = await api(
    'GET',
    `/internal/v1/admin/plans?consumerId=${encodeURIComponent(consumer.id)}`,
  )
  const currentPlan = planState?.currentPlan
  const targetPlan = asList(planState?.catalog).find((plan) => (
    plan?.key === bootstrapPlanKey
    && plan?.status === 'active'
    && plan?.versionStatus === 'published'
  ))
  if (!targetPlan) {
    throw new Error(`bootstrap plan is not an active published version: ${bootstrapPlanKey}`)
  }
  if (!currentPlan || !Number.isInteger(currentPlan.revision) || currentPlan.revision <= 0) {
    throw new Error('bootstrap consumer has no revisioned plan assignment')
  }
  if (currentPlan.versionId !== targetPlan.versionId) {
    await api('PUT', `/internal/v1/admin/consumers/${encodeURIComponent(consumer.id)}/plan`, {
      planVersionId: targetPlan.versionId,
      expectedRevision: currentPlan.revision,
    })
    process.stderr.write(`bootstrap plan assigned: ${bootstrapPlanKey} v${targetPlan.version}\n`)
  } else {
    process.stderr.write(`bootstrap plan unchanged: ${bootstrapPlanKey} v${targetPlan.version}\n`)
  }
}

// Grant the discovered/overridden platforms to the bootstrap consumer so the key
// can immediately pull data (search asserts the platform is granted).
const granted = []
const grantFailures = []
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
    grantFailures.push(`platform:${platform}`)
  }
}
process.stderr.write(`bootstrap platforms granted: ${granted.join(', ') || '(none)'}\n`)

// The public Xiaohongshu note route deliberately requires both the platform
// and operation grants. Keep nlp.tokenize as the historical bootstrap default,
// while an explicit capability list can narrow other optional capabilities.
const requestedCapabilities = new Set(
  capabilitiesOverride.length ? capabilitiesOverride : ['nlp.tokenize'],
)
if (granted.includes('xiaohongshu')) requestedCapabilities.add('social.posts.resolve')
const grantedCapabilities = []
for (const capability of requestedCapabilities) {
  try {
    await api('PUT', `/internal/v1/admin/capabilities/${encodeURIComponent(capability)}`, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
    })
    grantedCapabilities.push(capability)
  } catch (error) {
    process.stderr.write(`warn: could not grant capability "${capability}": ${error.message}\n`)
    grantFailures.push(`capability:${capability}`)
  }
}
process.stderr.write(`bootstrap capabilities granted: ${grantedCapabilities.join(', ') || '(none)'}\n`)

// Partial grants followed by key issuance create a credential that looks
// deliverable but cannot perform the promised operation. Leave the idempotent
// grants in place and fail before minting; the next deploy can safely retry.
if (grantFailures.length) {
  throw new Error(`bootstrap scope grants failed: ${grantFailures.join(', ')}`)
}

// The plaintext key is only returned at creation, so always mint a fresh one
// here; the caller persists it for reuse across deploys.
const apiKey = await api('POST', '/internal/v1/admin/api-keys', {
  consumerId: consumer.id,
  name,
  platforms: granted,
  capabilities: grantedCapabilities,
})
if (!apiKey?.secret) throw new Error('admin api-keys response did not include a plaintext secret')

process.stdout.write(`${apiKey.secret}\n${tenant.id}\n${consumer.id}\n`)
