// Register MX Rig in Launcher (docs/25 §3.4), from this repository.
//
//   node scripts/launcher-register.mjs plan  --url <Launcher Internal> [--rig-url <Rig service>]
//   MX_LAUNCHER_OPS_TOKEN=… node scripts/launcher-register.mjs apply --url … [--rig-url …] --secret-out <file>
//
// `plan` only reads. `apply` writes what Launcher's public, ops-token API
// accepts — the ProductNetwork, the AppCenter catalog entry and Rig's two
// release service accounts — and prints the steps only Launcher Admin can do.
// Run through `scripts/manage.sh launcher`, which finds both URLs in the
// cluster and keeps the release credentials. The ops token is read from the
// environment and never printed.
//
// Release credentials (docs/25 P2): Launcher shows a secret once, when it is
// issued — the Publisher's with the first AppCenter upsert, the Approver's
// when that account is created. Each is written straight into --secret-out
// (0600, a Kubernetes Secret patch manage.sh applies and deletes) and never
// printed. MX_RIG_RELEASE_HAVE names what the cluster already keeps
// ("publisher,approver"); only when it is known, a credential issued before
// but not kept is rotated to get one.

import { writeFileSync } from 'node:fs'
import { MANIFEST, launcherPlan } from './launcher-plan.mjs'

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

const RELEASE = MANIFEST.release
const products = await call('GET', '/internal/v1/launcher-network/products')
if (!products.ok) throw new Error(`reading Launcher products failed: HTTP ${products.status} ${products.text.slice(0, 200)}`)
const app = await call('GET', '/internal/v1/app-center/apps/mx-rig')
const routes = await call('GET', '/internal/v1/dns/reverse-proxy/routes')
const resolved = await call('GET', `/internal/v1/releases/products/resolve?${new URLSearchParams({ packageName: RELEASE.packageName, channel: RELEASE.channel })}`)
const have = process.env.MX_RIG_RELEASE_HAVE
const kept = have === undefined ? null : new Set(have.split(',').map((name) => name.trim()).filter(Boolean))
const plan = launcherPlan({
  products: products.payload?.products ?? [],
  app: app.ok ? app.payload?.app ?? null : null,
  routes: routes.ok ? routes.payload?.routes ?? [] : [],
  rigUrl,
  resolved: resolved.ok ? resolved.payload?.identity ?? null : null,
  credentials: kept ? { publisher: kept.has('publisher'), approver: kept.has('approver') } : null,
  // Found by scripts/manage.sh: a host file from the registration, or the Secret.
  ssoProfile: process.env.MX_RIG_SSO_PROFILE_FOUND || null
})

const MARK = { ok: '✓', create: '+', update: '~', manual: '!', 'manual-check': '?' }
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
// The first AppCenter upsert issues a secret Launcher never shows again: no
// apply without somewhere safe to put it.
const secretOut = option('secret-out') ?? process.env.MX_RIG_RELEASE_SECRET_OUT
if (!secretOut) throw new Error('apply needs --secret-out <file> for the release credentials Launcher issues once (scripts/manage.sh launcher apply passes it)')
const ops = { 'x-mx-ops-token': token }
const requested = { requestedBy: 'mx-rig-manage', requestId: `mx-rig-register-${Date.now()}` }
const secrets = {}
const keep = (role, credential, serviceAccountId) => {
  if (!credential?.clientSecret) return false
  const prefix = role === 'publisher' ? 'MX_RIG_RELEASE' : 'MX_RIG_RELEASE_APPROVER'
  secrets[`${prefix}_CLIENT_ID`] = credential.clientId ?? serviceAccountId
  secrets[`${prefix}_CLIENT_SECRET`] = credential.clientSecret
  // Written at once: a later step failing must not lose a secret shown only now.
  writeFileSync(secretOut, JSON.stringify({ stringData: secrets }), { mode: 0o600 })
  console.log(`  kept: the ${role} credential ${serviceAccountId} (not printed)`)
  return true
}
const rotate = async (role, serviceAccountId) => {
  const rotated = await call('POST', `/internal/v1/sdk/service-accounts/${encodeURIComponent(serviceAccountId)}/credentials/rotate`, { requestId: `mx-rig-rotate-${role}-${Date.now()}` }, ops)
  if (!rotated.ok) throw new Error(`rotating ${serviceAccountId}: HTTP ${rotated.status} ${rotated.text.slice(0, 200)}`)
  if (!keep(role, rotated.payload?.credential, serviceAccountId)) throw new Error(`rotating ${serviceAccountId} returned no credential`)
}
let publisherIssued = false
for (const step of plan.steps) {
  if (!['create', 'update'].includes(step.state)) continue
  const path = step.id === 'product-network' ? '/internal/v1/launcher-network/products/mx-rig' : step.id === 'app-center' ? '/internal/v1/app-center/apps/mx-rig' : null
  if (!path) continue
  const written = await call('POST', path, { ...step.body, ...requested }, ops)
  if (!written.ok) throw new Error(`${step.title}: HTTP ${written.status} ${written.text.slice(0, 300)}`)
  const saved = written.payload?.product ?? written.payload?.app ?? {}
  console.log(`  done: ${step.title}${saved.serviceVip ? ` (VIP ${saved.serviceVip})` : ''}`)
  if (step.id === 'app-center') publisherIssued = keep('publisher', written.payload?.publisher?.credential, RELEASE.publisher)
}
// The Publisher comes with the AppCenter entry; one issued earlier but not
// kept here can only be rotated.
if (!publisherIssued && kept && !kept.has('publisher')) await rotate('publisher', RELEASE.publisher)
// The Approver is its own account, so whoever builds cannot also approve.
if (!kept || !kept.has('approver')) {
  const approver = await call('POST', '/internal/v1/sdk/service-accounts', {
    serviceAccountId: RELEASE.approver,
    displayName: 'MX Rig Release Approver',
    roleIds: ['mx-release-approver'],
    scopes: ['sdk.release.read', 'sdk.release.approve'],
    allowedProductIds: [plan.productId],
    requestId: 'mx-rig-release-approver-v1'
  }, ops)
  if (!approver.ok) throw new Error(`release approver ${RELEASE.approver}: HTTP ${approver.status} ${approver.text.slice(0, 200)}`)
  if (!keep('approver', approver.payload?.credential, RELEASE.approver) && kept) await rotate('approver', RELEASE.approver)
}
if (!kept && !Object.keys(secrets).length)
  console.log('  release credentials: none newly issued (run through scripts/manage.sh launcher apply to keep or rotate them)')
const left = plan.steps.filter((step) => step.state === 'manual' || step.state === 'manual-check')
if (left.length) {
  console.log('\nStill to do in Launcher Admin:')
  for (const step of left) console.log(`  ! ${step.title}\n      ${step.detail}`)
}
