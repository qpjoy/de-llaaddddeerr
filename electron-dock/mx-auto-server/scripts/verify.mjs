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

async function checkAdminWebLogin() {
  const label = 'service administrator can establish a Web session'
  try {
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminToken })
    })
    const payload = await login.json().catch(() => ({}))
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    if (login.status !== 200 || payload?.member?.role !== 'admin' || !cookie) {
      failures += 1
      console.error(`  FAIL ${label} — HTTP ${login.status} or invalid session contract`)
      return
    }

    const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } })
    const identity = await me.json().catch(() => ({}))
    if (me.status !== 200 || identity?.member?.id !== 'service-admin') {
      failures += 1
      console.error(`  FAIL ${label} — session check returned HTTP ${me.status}`)
      return
    }
    console.log(`  ok   ${label}`)
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
await checkAdminWebLogin()

if (failures > 0) {
  console.error(`verify FAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('verify passed')
