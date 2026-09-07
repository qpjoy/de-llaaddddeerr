const baseUrl = (process.env.MX_AUTO_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/u, '')
const adminToken = process.env.MX_AUTO_ADMIN_TOKEN?.trim()

if (!adminToken) {
  console.error('MX_AUTO_ADMIN_TOKEN is required for verification')
  process.exit(1)
}

let failures = 0

async function check(label, path, expectedStatus, token = null) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
    if (response.status === expectedStatus) {
      console.log(`  ok   ${label}`)
      return
    }
    failures += 1
    console.error(`  FAIL ${label} — HTTP ${response.status}, expected ${expectedStatus}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${label} — ${error.message}`)
  }
}

console.log(`verifying ${baseUrl}`)
await check('process is healthy', '/healthz', 200)
await check('database is ready', '/readyz', 200)
await check('control plane rejects anonymous access', '/api/v1/apps', 401)
await check('service administrator can read the control plane', '/api/v1/apps', 200, adminToken)

if (failures > 0) {
  console.error(`verify FAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('verify passed')
