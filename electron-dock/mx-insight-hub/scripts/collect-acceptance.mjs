#!/usr/bin/env node
// Deployment acceptance for the collection engines (spider_man 06/07, phases
// 1-6). Runbook: docs/operations/collect-engines-rollout.md
//
//   node scripts/collect-acceptance.mjs plan            read-only: standard engines vs what exists
//   node scripts/collect-acceptance.mjs apply           create missing standard engines, STOPPED
//   node scripts/collect-acceptance.mjs runner-token    store the runner token (k8s Secret) as credential collect-runner
//   node scripts/collect-acceptance.mjs probe           read-only connectivity probe of every engine
//   node scripts/collect-acceptance.mjs enable --engines a,b | --healthy
//   node scripts/collect-acceptance.mjs smoke [--only key,...] [--include-paid] [--key-file F | --create-key F]
//
// Options: --admin URL (default http://10.88.88.88:18151), --public URL
// (default http://10.88.88.88:18150), --runner-url URL (default
// http://127.0.0.1:18190), --token-file F (runner token instead of kubectl).
// The admin token comes from MX_INSIGHT_ADMIN_TOKEN or, if unset, from
// .env.internal in this directory. Nothing secret is ever printed.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { COLLECT_CAPABILITIES, COLLECT_KINDS, COLLECT_RUNNER_SLOTS, collectCapability } from '../shared/collect-engines.mjs'
import { normalizeJobRequest } from '../server/collect/catalog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REASON = '采集引擎上线验收（collect-acceptance）'

// The standard engine set, derived from the capability catalog so it never
// drifts: one runner engine per reviewed package slot, one engine each for
// the native, Shodan and Apify kinds. Every route of every capability is
// covered exactly once.
export function standardEngines({ runnerUrl = 'http://127.0.0.1:18190' } = {}) {
  const routesFor = predicate => COLLECT_CAPABILITIES.flatMap(capability => (capability.routeBy
    ? capability.routes.filter(route => predicate(capability, route)).map(route => ({ capability: capability.key, routeKey: route.key }))
    : predicate(capability, null) ? [{ capability: capability.key, routeKey: '' }] : []))
  const engines = Object.entries(COLLECT_RUNNER_SLOTS).map(([slotRef, slot]) => ({
    id: `runner.${slotRef}`, kind: 'runner', displayName: `${slot.label} runner`, slotRef, baseUrl: runnerUrl, credentialProvider: 'collect-runner', capacity: 1,
    routes: routesFor((capability, route) => capability.kinds.includes('runner') && (route ? route.slotRef === slotRef : capability.slotRef === slotRef)),
  }))
  engines.push({ id: 'native.main', kind: 'native', displayName: 'Hub 原生查询', capacity: 4, routes: routesFor(capability => capability.kinds.includes('native')) })
  engines.push({ id: 'shodan.main', kind: 'shodan', displayName: 'Shodan', capacity: 1, credentialProvider: COLLECT_KINDS.shodan.defaultCredentialProvider,
    routes: routesFor(capability => capability.kinds.includes('shodan')) })
  // One Apify run at a time until the account's concurrency is known (Q9).
  engines.push({ id: 'apify.main', kind: 'apify', displayName: 'Apify', capacity: 1, credentialProvider: COLLECT_KINDS.apify.defaultCredentialProvider,
    routes: routesFor(capability => capability.kinds.includes('apify')) })
  return engines
}

// One minimal, real, public call per capability (route). Inputs are the
// ones used in local acceptance. `paid` calls spend supplier money or quota.
export const SMOKE_CASES = Object.freeze([
  ...[['xiaomi', ['1359']], ['vivo', ['40439']], ['tencent', ['com.tencent.mobileqq']], ['baidu', ['com.tencent.mobileqq']], ['lenovo', ['com.tencent.mobileqq']],
    ['wandoujia', ['566489']], ['googleplay', ['com.google.android.apps.translate']]]
    .map(([market, appIds]) => ({ capability: 'collect.app.details', input: { market, appIds } })),
  { capability: 'collect.app.googleplay.search', input: { term: 'translator', num: 3 } },
  { capability: 'collect.app.googleplay.reviews', input: { appId: 'com.google.android.apps.translate' } },
  { capability: 'collect.app.googleplay.charts', input: { collection: 'TOP_FREE', num: 5 } },
  { capability: 'collect.app.googleplay.developer', input: { developerId: 'Google LLC', num: 5 } },
  { capability: 'collect.app.googleplay.suggest', input: { term: 'pay' } },
  { capability: 'collect.app.googleplay.similar', input: { appId: 'com.google.android.apps.translate' } },
  { capability: 'collect.app.googleplay.permissions', input: { appId: 'com.google.android.apps.translate' } },
  { capability: 'collect.app.googleplay.datasafety', input: { appId: 'com.google.android.apps.translate' } },
  ...['https://www.pinterest.com/pin/858146903966145189/', 'https://medium.com/@sarperavci/two-million-hackthebox-write-up-7433944c2efa',
    'https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYZGtpbXFpZnZqAZUFGkyWAZUFGkx8AAAAAQ', 'https://www.dailymotion.com/video/xhfpjn',
    'https://kick.com/mxddy?clip=clip_01GYXVB5Y8PWAPWCWMSBCFB05X', 'https://oneusefulthing.substack.com', 'https://19thcentury.wordpress.com']
    .map(url => ({ capability: 'collect.web.url.details', input: { url } })),
  { capability: 'collect.audio.shows', input: { platform: 'xiaoyuzhou', podcastIds: ['5e4ee557418a84a0466737b7'] } },
  { capability: 'collect.audio.shows', input: { platform: 'ximalaya', trackIds: ['3558286'] } },
  { capability: 'collect.audio.shows', input: { platform: 'apple', mode: 'charts', genreId: 1318, limit: 3 } },
  { capability: 'collect.audio.shows', input: { platform: 'librivox', limit: 2 } },
  { capability: 'collect.audio.episodes', input: { platform: 'xiaoyuzhou', podcastIds: ['5e4ee557418a84a0466737b7'], episodesPerShow: 3 } },
  { capability: 'collect.audio.episodes', input: { platform: 'ximalaya', trackIds: ['3558286'], episodesPerShow: 3 } },
  { capability: 'collect.audio.episodes', input: { platform: 'apple', keyword: 'BBC Minute', limit: 1, episodesPerShow: 3 } },
  { capability: 'collect.audio.episodes', input: { platform: 'librivox', limit: 1, episodesPerShow: 3 } },
  { capability: 'collect.intel.dns.lookup', input: { name: 'iana.org', types: ['A', 'MX'] } },
  { capability: 'collect.intel.rdap.domain', input: { domain: 'iana.org' } },
  { capability: 'collect.intel.ct.issuances', input: { domain: 'iana.org', maxItems: 5 } },
  { capability: 'collect.intel.subdomains', input: { domain: 'iana.org', maxIssuances: 50 } },
  // Paid: Shodan query credits, Apify compute and per-result charges.
  { capability: 'collect.intel.shodan.count', input: { query: 'product:nginx country:SG' }, paid: true },
  { capability: 'collect.intel.shodan.host', input: { ip: '8.8.8.8', minify: true }, paid: true },
  { capability: 'collect.ecommerce.temu.search', input: { keyword: 'phone case', maxItems: 10 }, paid: true },
  { capability: 'collect.ads.meta.library', input: { urls: ['https://www.facebook.com/nasa'], resultsLimit: 10 }, paid: true },
  { capability: 'collect.web.similarweb.overview', input: { domains: ['iana.org'] }, paid: true },
])

const label = item => `${item.capability.replace(/^collect\./, '')}${item.input.market || item.input.platform ? `:${item.input.market || item.input.platform}` : ''}${item.input.url ? `:${new URL(item.input.url).hostname}` : ''}`

function adminToken() {
  if (process.env.MX_INSIGHT_ADMIN_TOKEN) return process.env.MX_INSIGHT_ADMIN_TOKEN
  const file = join(ROOT, '.env.internal')
  if (existsSync(file)) {
    const line = readFileSync(file, 'utf8').split('\n').find(row => /^\s*(export\s+)?MX_INSIGHT_ADMIN_TOKEN=/.test(row))
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  throw new Error('MX_INSIGHT_ADMIN_TOKEN is not set and .env.internal has none')
}

function client(base, token) {
  return async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const payload = await response.json().catch(() => null)
    return { status: response.status, data: payload?.data, error: payload?.error, retryAfter: response.headers.get('retry-after') }
  }
}

const sameRoutes = (a, b) => JSON.stringify([...a].map(r => `${r.capability}:${r.routeKey ?? ''}`).sort()) === JSON.stringify([...b].map(r => `${r.capability}:${r.routeKey ?? ''}`).sort())

async function plan(admin, options, { quiet = false } = {}) {
  const catalog = await admin('GET', '/internal/v1/admin/collect/catalog')
  if (catalog.status !== 200) throw new Error(`collect admin API unavailable (HTTP ${catalog.status} ${catalog.error?.code || ''}); is this Hub version deployed?`)
  const missingKinds = ['runner', 'native', 'shodan', 'apify'].filter(kind => !catalog.data.kinds.some(row => row.kind === kind && row.available))
  if (missingKinds.length) throw new Error(`deployed Hub lacks engine kinds: ${missingKinds.join(', ')}`)
  const existing = (await admin('GET', '/internal/v1/admin/collect/engines')).data?.engines || []
  const rows = standardEngines(options).map(spec => {
    const found = existing.find(engine => engine.id === spec.id)
    if (!found) return { spec, state: 'missing' }
    const drift = []
    if (found.kind !== spec.kind) drift.push(`kind ${found.kind}`)
    if ((found.slotRef ?? null) !== (spec.slotRef ?? null)) drift.push(`slot ${found.slotRef}`)
    if (!sameRoutes(found.routes || [], spec.routes)) drift.push('routes differ')
    return { spec, found, state: drift.length ? `differs (${drift.join(', ')})` : found.enabled ? 'enabled' : 'stopped' }
  })
  if (!quiet) {
    for (const row of rows) console.log(`${row.spec.id.padEnd(28)} ${row.spec.kind.padEnd(7)} ${String(row.spec.routes.length).padStart(2)} routes  ${row.state}`)
    const extra = existing.filter(engine => !rows.some(row => row.spec.id === engine.id))
    if (extra.length) console.log(`other engines (left alone): ${extra.map(engine => engine.id).join(', ')}`)
  }
  return rows
}

async function apply(admin, options) {
  const rows = await plan(admin, options, { quiet: true })
  for (const row of rows) {
    if (row.state !== 'missing') { console.log(`${row.spec.id.padEnd(28)} exists (${row.state}), not changed`); continue }
    const created = await admin('POST', '/internal/v1/admin/collect/engines', { ...row.spec, enabled: false, reason: REASON })
    console.log(`${row.spec.id.padEnd(28)} ${created.status === 201 ? 'created, stopped' : `FAILED ${created.status} ${created.error?.code}: ${created.error?.message}`}`)
  }
}

async function runnerToken(admin, options) {
  let token
  if (options['token-file']) token = readFileSync(options['token-file'], 'utf8').trim()
  else {
    const encoded = execFileSync('kubectl', ['-n', 'mx-insight-hub', 'get', 'secret', 'mx-crawler-runner-token', '-o', 'jsonpath={.data.token}'], { encoding: 'utf8' })
    token = Buffer.from(encoded.trim(), 'base64').toString('utf8').trim()
  }
  if (token.length < 24) throw new Error('runner token missing or too short')
  const engine = (await admin('GET', '/internal/v1/admin/collect/engines')).data?.engines?.find(row => row.kind === 'runner' && row.credentialProvider === 'collect-runner')
  if (!engine) throw new Error('no runner engine uses credential collect-runner; run apply first')
  const detail = await admin('GET', `/internal/v1/admin/collect/engines/${engine.id}`)
  const saved = await admin('PUT', `/internal/v1/admin/collect/engines/${engine.id}/credential`,
    { apiKey: token, expectedRevision: detail.data.credential?.revision ?? 0, reason: REASON })
  if (saved.status !== 200) throw new Error(`credential not saved: ${saved.status} ${saved.error?.code}`)
  console.log(`collect-runner credential stored (revision ${saved.data.revision}); shared by every runner engine`)
}

async function probe(admin) {
  const engines = (await admin('GET', '/internal/v1/admin/collect/engines')).data?.engines || []
  const results = []
  let runnerCapacity = null
  for (const engine of engines) {
    const result = await admin('POST', `/internal/v1/admin/collect/engines/${engine.id}/probe`, {})
    const p = result.data || {}
    const detail = [p.slot ? `package ${p.slot.available ? 'runnable' : `NOT runnable (${p.slot.reason})`}` : '', p.error ? `error ${p.error}` : '',
      p.credential ? `credential ${p.credential}` : '', p.usage?.queryCredits !== undefined ? `query credits ${p.usage.queryCredits}` : '',
      p.usage?.monthlyUsageUsd !== undefined ? `month $${p.usage.monthlyUsageUsd}/${p.usage.maxMonthlyUsageUsd}` : '',
      p.checks ? `dns ${p.checks.dns} rdap ${p.checks.rdapBootstrap}` : ''].filter(Boolean).join(' · ')
    console.log(`${engine.id.padEnd(28)} ${result.status !== 200 ? `HTTP ${result.status} ${result.error?.code}` : p.healthy ? 'healthy' : 'UNHEALTHY'}  ${detail}`)
    results.push({ engine, healthy: result.status === 200 && p.healthy === true })
    if (engine.kind === 'runner' && Number.isInteger(p.capacity)) runnerCapacity = p.capacity
  }
  // Hub engines hold the queue; the runner refuses (429) beyond its capacity.
  const runnerSlots = engines.filter(engine => engine.kind === 'runner').reduce((sum, engine) => sum + engine.capacity, 0)
  if (runnerCapacity !== null) {
    console.log(`runner capacity ${runnerCapacity}; Hub runner engine slots ${runnerSlots}${runnerSlots > runnerCapacity ? ' — TOO MANY: bursts will fail with runner_busy; lower engine capacities' : ''}`)
  }
  return results
}

async function enable(admin, options) {
  const names = options.engines ? options.engines.split(',').map(name => name.trim()).filter(Boolean) : null
  if (!names && !options.healthy) throw new Error('enable needs --engines a,b or --healthy')
  const results = await probe(admin)
  for (const { engine, healthy } of results) {
    if (names ? !names.includes(engine.id) : !healthy) continue
    if (!healthy && !options.force) { console.log(`${engine.id}: not enabled, probe is not healthy (use --force to override)`); continue }
    if (engine.enabled) { console.log(`${engine.id}: already enabled`); continue }
    const changed = await admin('PUT', `/internal/v1/admin/collect/engines/${engine.id}`, { enabled: true, expectedRevision: engine.revision, reason: REASON })
    console.log(`${engine.id}: ${changed.status === 200 ? 'enabled' : `FAILED ${changed.status} ${changed.error?.code}`}`)
  }
}

// A dedicated tenant/consumer/key holding only the tested capabilities. The
// key secret goes to a 0600 file, never to the terminal.
async function acceptanceKey(admin, file, capabilities) {
  const tenants = (await admin('GET', '/internal/v1/admin/tenants')).data || []
  const tenant = tenants.find(row => row.name === 'collect-acceptance') || (await admin('POST', '/internal/v1/admin/tenants', { name: 'collect-acceptance' })).data
  const consumers = (await admin('GET', `/internal/v1/admin/consumers?tenantId=${tenant.id}`)).data || []
  const consumer = consumers.find(row => row.name === 'collect-acceptance') || (await admin('POST', '/internal/v1/admin/consumers', { tenantId: tenant.id, name: 'collect-acceptance' })).data
  for (const capability of capabilities) await admin('PUT', `/internal/v1/admin/capabilities/${capability}`, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await admin('POST', '/internal/v1/admin/api-keys', { consumerId: consumer.id, name: `collect-acceptance ${new Date().toISOString().slice(0, 10)}`, platforms: [], capabilities })
  if (key.status !== 201) throw new Error(`api key not created: ${key.status} ${key.error?.code}`)
  writeFileSync(file, `${key.data.secret}\n`, { mode: 0o600 })
  console.log(`acceptance key created for tenant collect-acceptance (secret written to ${file}, mode 0600)`)
  return key.data.secret
}

async function smoke(admin, options) {
  const only = options.only ? options.only.split(',').map(value => value.trim()) : null
  const cases = SMOKE_CASES.filter(item => (options['include-paid'] || !item.paid) && (!only || only.some(prefix => item.capability.startsWith(prefix) || label(item).startsWith(prefix))))
  const capabilities = [...new Set(cases.map(item => item.capability))]
  let key
  if (options['key-file'] && existsSync(options['key-file'])) key = readFileSync(options['key-file'], 'utf8').trim()
  // One key for every smoke capability, so later filtered runs can reuse it.
  // Engines start with billing off, so acceptance calls write no usage ledger.
  else if (options['create-key']) key = await acceptanceKey(admin, options['create-key'], [...new Set(SMOKE_CASES.map(item => item.capability))])
  else throw new Error('smoke needs --key-file F (existing key with these capabilities) or --create-key F')
  const api = client(options.public, key)
  const started = []
  for (const item of cases) {
    const sync = collectCapability(item.capability)?.sync
    const idem = `acceptance-${label(item).replace(/[^A-Za-z0-9._:-]/g, '-')}-${Date.now()}`.slice(0, 120)
    const submitted = await api('POST', `/api/v1/data/collect/${sync ? 'query' : 'jobs'}`, { capability: item.capability, input: item.input }, { 'idempotency-key': idem })
    started.push({ item, submitted, at: Date.now() })
  }
  let failures = 0
  for (const run of started) {
    const { item, submitted } = run
    let job = submitted.data?.job || submitted.data
    if (submitted.status >= 400) {
      failures += 1
      const hint = submitted.error?.code === 'capability_not_granted' ? ' (key lacks it; use --create-key for a fresh acceptance key)'
        : submitted.error?.code === 'capability_not_routed' ? ' (no enabled engine; run apply/enable)' : ''
      console.log(`${label(item).padEnd(44)} REJECTED ${submitted.status} ${submitted.error?.code}: ${submitted.error?.message ?? ''}${hint}`)
      continue
    }
    for (let attempt = 0; attempt < 900 && job?.jobId && ['queued', 'running'].includes(job.status); attempt++) {
      await new Promise(done => setTimeout(done, 1_000))
      job = (await api('GET', `/api/v1/data/collect/jobs/${job.jobId}`)).data
    }
    const ok = job?.status === 'succeeded'
    if (!ok) failures += 1
    console.log(`${label(item).padEnd(44)} ${String(job?.status).padEnd(9)} ${String(job?.delivery?.dataStatus ?? job?.error?.code ?? '').padEnd(24)} items=${job?.delivery?.itemCount ?? '-'}  ${Math.round((Date.now() - run.at) / 1000)}s  ${ok ? '' : (job?.error?.message || '').slice(0, 100)}`)
  }
  console.log(`\n${started.length - failures}/${started.length} succeeded${options['include-paid'] ? '' : ' (paid Apify/Shodan cases skipped; add --include-paid)'}`)
  if (failures) process.exitCode = 1
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    admin: { type: 'string', default: 'http://10.88.88.88:18151' }, public: { type: 'string', default: 'http://10.88.88.88:18150' },
    'runner-url': { type: 'string', default: 'http://127.0.0.1:18190' }, 'token-file': { type: 'string' }, engines: { type: 'string' },
    healthy: { type: 'boolean', default: false }, force: { type: 'boolean', default: false }, only: { type: 'string' },
    'include-paid': { type: 'boolean', default: false }, 'key-file': { type: 'string' }, 'create-key': { type: 'string' },
  } })
  const command = positionals[0] || 'plan'
  const commands = { plan, apply, 'runner-token': runnerToken, probe, enable, smoke }
  if (!commands[command]) throw new Error(`unknown command ${command}; use ${Object.keys(commands).join(' | ')}`)
  const options = { ...values, runnerUrl: values['runner-url'], public: values.public.replace(/\/$/, '') }
  const admin = client(values.admin.replace(/\/$/, ''), adminToken())
  await commands[command](admin, options)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`collect-acceptance: ${error.message}`); process.exit(1) })
}

// Every smoke input must pass the same validation the API applies.
export function validateSmokeCases() {
  return SMOKE_CASES.map(item => normalizeJobRequest({ capability: item.capability, input: item.input }))
}
