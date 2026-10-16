import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { freeStandaloneIndex, launcherPlan, standaloneShape } from '../scripts/launcher-plan.mjs'

// docs/25 §3.4: what Rig needs registered in Launcher, worked out from
// Launcher's own data and written only through its public ops-token API.

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/launcher-register.mjs', import.meta.url))
// Shapes as Launcher seeds them: MX-H2I, Luopan (standalone index 1), AppCenter and H2O (embed).
const PRODUCTS = [
  { productId: 'mx-h2i', mode: 'standalone', networkScope: 'owner', serviceVip: '10.88.100.1', userCidr: '10.89.0.0/16', anonymousCidr: '10.89.0.0/16' },
  { productId: 'luopan', mode: 'standalone', networkScope: 'owner', productIndex: 1, serviceVip: '10.88.100.3', userCidr: '10.91.0.0/16', anonymousCidr: '10.91.0.0/16' },
  { productId: 'appcenter', mode: 'embed', networkScope: 'broker-session', serviceVip: '10.88.100.9', userCidr: '10.92.0.0/16' },
  { productId: 'h2o', mode: 'embed', networkScope: 'broker-session', serviceVip: '10.88.100.10', userCidr: '10.90.0.0/16' }
]

test('a new standalone product takes the first range and VIP nobody uses', () => {
  assert.deepEqual(standaloneShape(1), { productIndex: 1, serviceVip: '10.88.100.3', leaseCidr: '10.91.0.0/16' }, "Launcher's own formula, as Luopan has it")
  assert.equal(freeStandaloneIndex(PRODUCTS), 3, '1 is Luopan, 2 would collide with AppCenter 10.92')
  const plan = launcherPlan({ products: PRODUCTS, rigUrl: 'http://10.0.0.5:30891' })
  assert.deepEqual(plan.network, { productIndex: 3, serviceVip: '10.88.100.5', leaseCidr: '10.93.0.0/16' })
  const state = Object.fromEntries(plan.steps.map((step) => [step.id, step.state]))
  assert.deepEqual(state, { 'product-network': 'create', 'service-vip': 'manual', 'gateway-route': 'manual', 'app-center': 'create', 'release-center': 'later' })
  const product = plan.steps.find((step) => step.id === 'product-network')
  assert.deepEqual([product.body.mode, product.body.networkScope, product.body.productIndex], ['standalone', 'owner', 3])
  assert.match(plan.steps.find((step) => step.id === 'gateway-route').detail, /host 10\.88\.100\.5 → http:\/\/10\.0\.0\.5:30891/)
})

test('what is already registered as needed is left alone', () => {
  const products = [...PRODUCTS, { productId: 'mx-rig', mode: 'standalone', networkScope: 'owner', enabled: true, productIndex: 3, serviceVip: '10.88.100.5', anonymousCidr: '10.93.0.0/16' }]
  const plan = launcherPlan({
    products,
    app: { appId: 'mx-rig', launcherMode: 'standalone', productNetworkId: 'mx-rig' },
    routes: [{ host: '10.88.100.5', targetUrl: 'http://10.0.0.5:30891/', enabled: true }],
    rigUrl: 'http://10.0.0.5:30891'
  })
  const state = Object.fromEntries(plan.steps.map((step) => [step.id, step.state]))
  assert.deepEqual([state['product-network'], state['app-center'], state['gateway-route']], ['ok', 'ok', 'ok'])
  // Registered as an embed by mistake: corrected, never silently accepted.
  const wrong = launcherPlan({ products: [...PRODUCTS, { productId: 'mx-rig', mode: 'embed', networkScope: 'broker-session', serviceVip: '10.88.100.12' }] })
  assert.equal(wrong.steps[0].state, 'update')
})

test('the command reads for plan, and writes only the two ops-token registrations for apply', async (t) => {
  const writes = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && req.url === '/internal/v1/launcher-network/products') return json(200, { products: PRODUCTS })
    if (req.method === 'GET' && req.url === '/internal/v1/app-center/apps/mx-rig') return json(404, { message: 'not found' })
    if (req.method === 'GET' && req.url === '/internal/v1/dns/reverse-proxy/routes') return json(200, { routes: [] })
    if (req.method === 'POST') {
      writes.push({ url: req.url, token: req.headers['x-mx-ops-token'], body: JSON.parse(body) })
      return json(200, req.url.includes('products') ? { product: { productId: 'mx-rig', serviceVip: '10.88.100.5' } } : { app: { appId: 'mx-rig' } })
    }
    json(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, MX_LAUNCHER_OPS_TOKEN: '' }
  const plan = await run(process.execPath, [script, 'plan', '--url', url, '--rig-url', 'http://10.0.0.5:30891'], { env })
  assert.match(plan.stdout, /VIP 10\.88\.100\.5, lease range 10\.93\.0\.0\/16/)
  assert.equal(writes.length, 0, 'plan only reads')
  await assert.rejects(run(process.execPath, [script, 'apply', '--url', url], { env }), /MX_LAUNCHER_OPS_TOKEN/)
  assert.equal(writes.length, 0)
  const applied = await run(process.execPath, [script, 'apply', '--url', url, '--rig-url', 'http://10.0.0.5:30891'], { env: { ...env, MX_LAUNCHER_OPS_TOKEN: 'ops-secret' } })
  assert.deepEqual(writes.map((write) => write.url), ['/internal/v1/launcher-network/products/mx-rig', '/internal/v1/app-center/apps/mx-rig'])
  assert.ok(writes.every((write) => write.token === 'ops-secret'))
  assert.deepEqual([writes[0].body.mode, writes[0].body.networkScope, writes[0].body.productIndex], ['standalone', 'owner', 3])
  assert.equal(writes[1].body.launcherMode, 'standalone')
  assert.doesNotMatch(applied.stdout, /ops-secret/, 'the token is never printed')
  assert.match(applied.stdout, /Still to do in Launcher Admin/)
})
