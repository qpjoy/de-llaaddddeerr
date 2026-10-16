// Register MX Rig in Launcher (docs/25 §3.4), from this repository.
//
//   node scripts/launcher-register.mjs plan  --url <Launcher Internal> [--rig-url <Rig service>]
//   MX_LAUNCHER_OPS_TOKEN=… node scripts/launcher-register.mjs apply --url … [--rig-url …]
//
// `plan` only reads. `apply` writes what Launcher's public, ops-token API
// accepts — the ProductNetwork and the AppCenter catalog entry — and prints
// the steps only Launcher Admin can do. Run through `scripts/manage.sh
// launcher`, which finds both URLs in the cluster. The token is read from the
// environment and never printed.

import { launcherPlan } from './launcher-plan.mjs'

const args = process.argv.slice(2)
const command = args[0]
const option = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const base = (option('url') ?? process.env.MX_LAUNCHER_URL ?? '').replace(/\/+$/, '')
const rigUrl = option('rig-url') ?? process.env.MX_RIG_PUBLIC_URL ?? null
if (!['plan', 'apply'].includes(command) || !base) {
  console.error('usage: launcher-register.mjs plan|apply --url <Launcher Internal URL> [--rig-url <Rig service URL>]')
  process.exit(2)
}

async function call(method, path, body, headers = {}) {
  const answer = await fetch(`${base}${path}`, {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await answer.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {}
  return { status: answer.status, ok: answer.ok, payload, text }
}

const products = await call('GET', '/internal/v1/launcher-network/products')
if (!products.ok) throw new Error(`reading Launcher products failed: HTTP ${products.status} ${products.text.slice(0, 200)}`)
const app = await call('GET', '/internal/v1/app-center/apps/mx-rig')
const routes = await call('GET', '/internal/v1/dns/reverse-proxy/routes')
const plan = launcherPlan({
  products: products.payload?.products ?? [],
  app: app.ok ? app.payload?.app ?? null : null,
  routes: routes.ok ? routes.payload?.routes ?? [] : [],
  rigUrl
})

const MARK = { ok: '✓', create: '+', update: '~', manual: '!', 'manual-check': '?', later: '·' }
console.log(`MX Rig in Launcher at ${base}`)
console.log(`  network: VIP ${plan.network.serviceVip}, lease range ${plan.network.leaseCidr}`)
for (const step of plan.steps) console.log(`  ${MARK[step.state] ?? ' '} ${step.title}\n      ${step.detail}`)

if (command === 'plan') {
  console.log('\n+ / ~ : scripts/manage.sh launcher apply does these (needs MX_LAUNCHER_OPS_TOKEN)')
  console.log('!     : in Launcher Admin, as written above')
  process.exit(0)
}

const token = process.env.MX_LAUNCHER_OPS_TOKEN?.trim()
if (!token) throw new Error('apply needs Launcher\'s Internal Ops Token in MX_LAUNCHER_OPS_TOKEN')
const ops = { 'x-mx-ops-token': token }
const requested = { requestedBy: 'mx-rig-manage', requestId: `mx-rig-register-${Date.now()}` }
for (const step of plan.steps) {
  if (!['create', 'update'].includes(step.state)) continue
  const path = step.id === 'product-network' ? '/internal/v1/launcher-network/products/mx-rig' : step.id === 'app-center' ? '/internal/v1/app-center/apps/mx-rig' : null
  if (!path) continue
  const written = await call('POST', path, { ...step.body, ...requested }, ops)
  if (!written.ok) throw new Error(`${step.title}: HTTP ${written.status} ${written.text.slice(0, 300)}`)
  const saved = written.payload?.product ?? written.payload?.app ?? {}
  console.log(`  done: ${step.title}${saved.serviceVip ? ` (VIP ${saved.serviceVip})` : ''}`)
}
const left = plan.steps.filter((step) => step.state === 'manual' || step.state === 'manual-check')
if (left.length) {
  console.log('\nStill to do in Launcher Admin:')
  for (const step of left) console.log(`  ! ${step.title}\n      ${step.detail}`)
}
