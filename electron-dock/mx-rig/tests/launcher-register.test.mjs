import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assert.deepEqual(state, {
    'product-network': 'create',
    'service-vip': 'manual',
    'gateway-route': 'manual',
    'app-center': 'create',
    'release-identity': 'create',
    'release-credentials': 'create',
    'sso-application': 'manual',
    'sso-entrance': 'manual'
  })
  // Browser SSO (docs/25 P4): what to enter in Launcher Internal, word for word.
  const sso = plan.steps.find((step) => step.id === 'sso-application')
  assert.match(sso.detail, /统一认证 → 接入应用: 公网认证, MX Rig, mx-rig, https:\/\/rig\.minsight-ai\.com, Audience mx-rig/)
  assert.match(plan.steps.find((step) => step.id === 'sso-entrance').detail, /10\.88\.88\.88:80 → Internal Nginx → http:\/\/10\.0\.0\.5:30891/)
  const product = plan.steps.find((step) => step.id === 'product-network')
  assert.deepEqual([product.body.mode, product.body.networkScope, product.body.productIndex], ['standalone', 'owner', 3])
  assert.match(plan.steps.find((step) => step.id === 'gateway-route').detail, /host 10\.88\.100\.5 → http:\/\/10\.0\.0\.5:30891/)
})

test('what is already registered as needed is left alone', () => {
  const products = [...PRODUCTS, { productId: 'mx-rig', mode: 'standalone', networkScope: 'owner', enabled: true, productIndex: 3, serviceVip: '10.88.100.5', anonymousCidr: '10.93.0.0/16' }]
  const app = { appId: 'mx-rig', launcherMode: 'standalone', productNetworkId: 'mx-rig', packageName: '@qpjoy/mx-rig', channels: ['shadow', 'beta', 'stable'] }
  const plan = launcherPlan({
    products,
    app,
    routes: [{ host: '10.88.100.5', targetUrl: 'http://10.0.0.5:30891/', enabled: true }],
    rigUrl: 'http://10.0.0.5:30891',
    resolved: { productId: 'mx-rig', packageName: '@qpjoy/mx-rig', channel: 'stable' },
    credentials: { publisher: true, approver: true },
    ssoProfile: '/var/lib/mx-launcher/identity/applications/public/mx-rig.json'
  })
  const state = Object.fromEntries(plan.steps.map((step) => [step.id, step.state]))
  assert.deepEqual(
    [state['product-network'], state['app-center'], state['gateway-route'], state['release-identity'], state['release-credentials'], state['sso-application']],
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']
  )
  // Updates find Rig by its package name: an entry with another one is corrected.
  const renamed = launcherPlan({ products, app: { ...app, packageName: 'mx-rig-desktop' } })
  assert.equal(renamed.steps.find((step) => step.id === 'app-center').state, 'update')
  // Right entry, but Release Center resolves the name elsewhere: a person must look.
  const shadowed = launcherPlan({ products, app, resolved: { productId: 'other', packageName: '@qpjoy/mx-rig' } })
  assert.equal(shadowed.steps.find((step) => step.id === 'release-identity').state, 'manual')
  // Registered as an embed by mistake: corrected, never silently accepted.
  const wrong = launcherPlan({ products: [...PRODUCTS, { productId: 'mx-rig', mode: 'embed', networkScope: 'broker-session', serviceVip: '10.88.100.12' }] })
  assert.equal(wrong.steps[0].state, 'update')
})

// A stand-in Launcher Internal: what it holds, and every write it was sent.
async function launcher(t, { app = null, publisherIssued = true, approverIssued = true } = {}) {
  const writes = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && req.url === '/internal/v1/launcher-network/products') return json(200, { products: PRODUCTS })
    if (req.method === 'GET' && req.url === '/internal/v1/app-center/apps/mx-rig') return app ? json(200, { app }) : json(404, { message: 'not found' })
    if (req.method === 'GET' && req.url === '/internal/v1/dns/reverse-proxy/routes') return json(200, { routes: [] })
    if (req.method === 'GET' && req.url.startsWith('/internal/v1/releases/products/resolve?')) return json(404, { message: 'not registered' })
    if (req.method === 'POST') {
      writes.push({ url: req.url, token: req.headers['x-mx-ops-token'], body: JSON.parse(body || '{}') })
      if (req.url.includes('/launcher-network/products/')) return json(200, { product: { productId: 'mx-rig', serviceVip: '10.88.100.5' } })
      if (req.url.includes('/app-center/apps/'))
        return json(200, {
          app: { appId: 'mx-rig' },
          publisher: {
            serviceAccount: { serviceAccountId: 'svc_mx-rig_release_publisher' },
            credential: publisherIssued ? { clientId: 'svc_mx-rig_release_publisher', clientSecret: 'mxsa1.publisher-once' } : null
          }
        })
      if (req.url === '/internal/v1/sdk/service-accounts')
        return json(200, { serviceAccount: { serviceAccountId: 'svc_mx-rig_release_approver' }, credential: approverIssued ? { clientId: 'svc_mx-rig_release_approver', clientSecret: 'mxsa1.approver-once' } : null })
      if (req.url.endsWith('/credentials/rotate')) {
        const id = decodeURIComponent(req.url.split('/')[5])
        return json(200, { credential: { clientId: id, clientSecret: `mxsa1.rotated-${id}` } })
      }
    }
    json(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, writes }
}

test('plan only reads; apply writes the registrations and keeps the once-shown release secrets, unprinted', async (t) => {
  const { url, writes } = await launcher(t)
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-register-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const out = join(dir, 'release.json')
  const env = { ...process.env, MX_LAUNCHER_OPS_TOKEN: '', MX_RIG_RELEASE_HAVE: '' }
  const plan = await run(process.execPath, [script, 'plan', '--url', url, '--rig-url', 'http://10.0.0.5:30891'], { env })
  assert.match(plan.stdout, /VIP 10\.88\.100\.5, lease range 10\.93\.0\.0\/16/)
  assert.match(plan.stdout, /Release Center identity @qpjoy\/mx-rig/)
  assert.equal(writes.length, 0, 'plan only reads')
  await assert.rejects(run(process.execPath, [script, 'apply', '--url', url, '--secret-out', out], { env }), /MX_LAUNCHER_OPS_TOKEN/)
  await assert.rejects(run(process.execPath, [script, 'apply', '--url', url], { env: { ...env, MX_LAUNCHER_OPS_TOKEN: 'ops-secret' } }), /--secret-out/)
  assert.equal(writes.length, 0, 'nothing written without a place for the secrets')
  const applied = await run(process.execPath, [script, 'apply', '--url', url, '--rig-url', 'http://10.0.0.5:30891', '--secret-out', out], {
    env: { ...env, MX_LAUNCHER_OPS_TOKEN: 'ops-secret' }
  })
  assert.deepEqual(writes.map((write) => write.url), [
    '/internal/v1/launcher-network/products/mx-rig',
    '/internal/v1/app-center/apps/mx-rig',
    '/internal/v1/sdk/service-accounts'
  ])
  assert.ok(writes.every((write) => write.token === 'ops-secret'))
  assert.deepEqual([writes[0].body.mode, writes[0].body.networkScope, writes[0].body.productIndex], ['standalone', 'owner', 3])
  assert.deepEqual([writes[1].body.launcherMode, writes[1].body.packageName, writes[1].body.channels], ['standalone', '@qpjoy/mx-rig', ['stable']])
  assert.deepEqual([writes[2].body.scopes, writes[2].body.allowedProductIds], [['sdk.release.read', 'sdk.release.approve'], ['mx-rig']], 'the approver cannot publish')
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), {
    stringData: {
      MX_RIG_RELEASE_CLIENT_ID: 'svc_mx-rig_release_publisher',
      MX_RIG_RELEASE_CLIENT_SECRET: 'mxsa1.publisher-once',
      MX_RIG_RELEASE_APPROVER_CLIENT_ID: 'svc_mx-rig_release_approver',
      MX_RIG_RELEASE_APPROVER_CLIENT_SECRET: 'mxsa1.approver-once'
    }
  })
  assert.equal((await stat(out)).mode & 0o777, 0o600)
  for (const secret of ['ops-secret', 'mxsa1.']) assert.ok(!applied.stdout.includes(secret) && !applied.stderr.includes(secret), `${secret} is never printed`)
  assert.match(applied.stdout, /kept: the publisher credential/)
  assert.match(applied.stdout, /Still to do in Launcher Admin/)
})

test('a credential issued before but not kept in this cluster is rotated; unknown means nothing is rotated', async (t) => {
  const app = { appId: 'mx-rig', launcherMode: 'standalone', productNetworkId: 'mx-rig', packageName: '@qpjoy/mx-rig', channels: ['stable'] }
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-register-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ops = { ...process.env, MX_LAUNCHER_OPS_TOKEN: 'ops-secret' }
  // The cluster keeps neither, Launcher issued both long ago.
  const lost = await launcher(t, { app, publisherIssued: false, approverIssued: false })
  const out = join(dir, 'lost.json')
  await run(process.execPath, [script, 'apply', '--url', lost.url, '--secret-out', out], { env: { ...ops, MX_RIG_RELEASE_HAVE: '' } })
  assert.deepEqual(lost.writes.map((write) => write.url).filter((url) => !url.includes('/launcher-network/')), [
    '/internal/v1/sdk/service-accounts/svc_mx-rig_release_publisher/credentials/rotate',
    '/internal/v1/sdk/service-accounts',
    '/internal/v1/sdk/service-accounts/svc_mx-rig_release_approver/credentials/rotate'
  ])
  assert.deepEqual(Object.keys(JSON.parse(await readFile(out, 'utf8')).stringData).sort(), [
    'MX_RIG_RELEASE_APPROVER_CLIENT_ID',
    'MX_RIG_RELEASE_APPROVER_CLIENT_SECRET',
    'MX_RIG_RELEASE_CLIENT_ID',
    'MX_RIG_RELEASE_CLIENT_SECRET'
  ])
  // Both kept: neither touched.
  const kept = await launcher(t, { app })
  await run(process.execPath, [script, 'apply', '--url', kept.url, '--secret-out', join(dir, 'kept.json')], { env: { ...ops, MX_RIG_RELEASE_HAVE: 'publisher,approver' } })
  assert.ok(!kept.writes.some((write) => write.url.includes('/sdk/')))
  // Run by hand, without knowing what the cluster keeps: never rotate.
  const unknown = await launcher(t, { app, publisherIssued: false, approverIssued: false })
  const env = { ...ops }
  delete env.MX_RIG_RELEASE_HAVE
  const direct = await run(process.execPath, [script, 'apply', '--url', unknown.url, '--secret-out', join(dir, 'unknown.json')], { env })
  assert.ok(!unknown.writes.some((write) => write.url.endsWith('/rotate')))
  assert.match(direct.stdout, /none newly issued/)
})
