#!/usr/bin/env node
// Explicit recovery or deployment-managed defaults. All writes use revision CAS.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = '/internal/v1/admin/external-platforms'
const MONEY_FIELDS = ['monthlyBudgetMinor', 'monthlySubsidyBudgetMinor']
const PRICE_BLOCKERS = new Set(['price_control_incomplete', 'database_price_book_required', 'deployment_gate_closed'])
// Existing Hub defaults from seeds/pricebooks/{tikhub,justone}.json. These are
// procurement-ledger currencies, not a claim about actual supplier settlement.
// The running Pod does not contain seeds/. Never guess other providers' currency.
const PROVIDER_SEED_CURRENCIES = { tikhub: 'USD', justone: 'CNY' }
const DEFAULT_PRICE_REASON = 'Automatic default procurement estimate: missing endpoint prices 0.01 in ledger currency; preserve explicit prices, budgets and operator states'
// These registry entries explicitly do not implement operation procurement
// policies. Night-All-A has an unrelated collector "operations" array.
const NON_PRICING_PROVIDERS = new Set(['ipsearch', 'baidu-ip', 'night-all', 'night-all-a'])
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
const currencyCode = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value)

class MigrationError extends Error {
  constructor(stage, message) { super(message); this.stage = stage }
}

const diagnosticCode = value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(value) ? value : 'unavailable'
export function failureDiagnostic(error) {
  // Only messages authored here are safe to print. Driver/fetch messages may
  // contain DSNs or headers; report their error codes without those messages.
  if (error instanceof MigrationError) return `[${error.stage}] ${error.message}`
  return `[unexpected] ${diagnosticCode(error?.cause?.code || error?.code || error?.name)}; error details withheld`
}

// Audit the entire chain: a price seed after a manual pause/disable is not consent
// to undo that decision. CAS on the policy write fences changes after this read.
export function bootstrapOnly(operation, events, provider) {
  if (!events.length || Number(events.at(-1).revision) !== operation.revision) return false
  let previous = null
  for (const event of events) {
    if (previous !== null && (Number(event.previous_revision) !== previous || Number(event.revision) !== previous + 1)) return false
    if (previous === null && event.previous_revision !== null) return false
    const migration = /^migration-\d+$/.test(event.actor) && event.previous_revision === null
    const priceSeed = event.actor === 'admin-token'
      && (event.reason === `Seeded reviewed default price book from seeds/pricebooks/${provider}.json`
        || event.reason === DEFAULT_PRICE_REASON)
    if (!migration && !priceSeed) return false
    if (['paused', 'shadow', 'canary'].includes(event.desired_state)) return false
    previous = Number(event.revision)
  }
  return events.at(-1).desired_state === operation.desiredState
    || operation.controlSource === 'legacy_environment'
}

export function planOperation(operation, { provider, events = [], defaultCurrency, defaultCurrencySource,
  missingBudgetMinor, pricingAsOf, defaults = false }) {
  const skip = reason => ({ operationKey: operation.operationKey, action: 'skip', reason,
    ...(defaults ? { effectiveState: operation.effectiveState, blockers: (operation.blockers || []).map(row => row.code) } : {}) })
  const book = operation.priceBook || {}
  if (!(defaults ? ['disabled', 'active', 'canary', 'paused', 'shadow'] : ['disabled', 'active', 'canary']).includes(operation.desiredState)) return skip('operator_state_preserved')
  if (operation.migrationRequired || operation.release?.status !== 'released') return skip('release_unavailable')
  const required = [...new Set([...(operation.release.endpointKeys || []), ...(defaults ? operation.release.optionalEndpointKeys || [] : [])])]
  if (!required.length) return skip('no_endpoints')
  // Existing zero prices (including free demos) are decisions, never "missing".
  const prices = book.endpointPrices || {}
  const missing = required.filter(key => prices[key] == null)
  const bootstrap = bootstrapOnly(operation, events, provider)
  const activate = operation.desiredState === 'disabled' && bootstrap
  if (!missing.length && !(defaults && activate && book.ready)) return skip('existing_prices_preserved')
  if (required.some(key => prices[key] != null && !nonnegative(prices[key]))) return skip('invalid_existing_price')
  if (!operation.allowZeroCost && required.some(key => prices[key] === 0)) return skip('explicit_zero_price_preserved')
  if (book.status === 'retired') return skip('retired_price_book')
  if (!defaults && (!Array.isArray(operation.blockers)
    || !operation.blockers.some(row => row.code === 'price_control_incomplete'))) return skip('no_price_blocker')
  const otherBlockers = (operation.blockers || []).filter(row => !PRICE_BLOCKERS.has(row.code))
  if (!defaults && otherBlockers.length) return skip(`other_blockers:${otherBlockers.map(row => row.code).join(',')}`)
  if (!defaults && operation.desiredState === 'disabled' && !bootstrap) return skip('manual_or_unproven_disable')
  if (!book.currency && Object.values(prices).some(nonnegative)) return skip('currency_unknown_for_existing_prices')
  const currency = book.currency ?? defaultCurrency
  if (!currencyCode(currency)) return skip('currency_unknown')
  // Hub procurement uses hundredths. Do not silently misprice a non-cent currency.
  if (new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits !== 2) {
    return skip('currency_not_two_decimal')
  }
  if (!nonnegative(missingBudgetMinor)) return skip('missing_budget_policy_required')
  if (MONEY_FIELDS.some(field => book[field] != null && !nonnegative(book[field]))) return skip('invalid_existing_budget')
  if (!Number.isSafeInteger(operation.revision) || operation.revision < 0) return skip('invalid_revision')
  const endpointKeys = [...new Set([...required, ...(operation.release.optionalEndpointKeys || [])])]
  const unitCostMinorByEndpoint = Object.fromEntries(endpointKeys
    .filter(key => required.includes(key) || nonnegative(prices[key]))
    .map(key => [key, missing.includes(key) ? 1 : prices[key]]))
  return {
    operationKey: operation.operationKey, action: 'apply', previousState: operation.desiredState,
    currencySource: book.currency ? 'operation' : defaultCurrencySource,
    filledEndpointKeys: missing,
    filledBudgetFields: MONEY_FIELDS.filter(field => book[field] == null),
    body: {
      expectedRevision: operation.revision,
      desiredState: activate ? 'active' : operation.desiredState,
      ...(operation.desiredState === 'canary' ? { canaryConsumerIds: operation.canaryConsumerIds } : {}),
      reason: defaults ? DEFAULT_PRICE_REASON : 'User-authorized missing-price recovery: provisional procurement estimate 0.01 in original currency; preserve existing prices/budgets; no customer pricing or grants changed',
      priceBook: {
        currency, pricingAsOf,
        ...Object.fromEntries(MONEY_FIELDS.map(field => [field, book[field] ?? missingBudgetMinor])),
        unitCostMinorByEndpoint,
      },
    },
  }
}

export function parseArgs(args) {
  const options = { apply: false, all: false, provider: null, missingBudgetMinor: null, operations: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') return { help: true }
    if (arg === '--apply') options.apply = true
    else if (arg === '--defaults') options.defaults = true
    else if (arg === '--all') options.all = true
    else if (arg === '--provider') {
      options.provider = args[++i]
      if (!/^[a-z][a-z0-9_-]*$/.test(options.provider || '')) throw new MigrationError('arguments', 'Invalid --provider')
    } else if (arg === '--operation') {
      const operation = args[++i]
      if (!/^[a-z][a-z0-9._-]{0,127}$/.test(operation || '')) throw new MigrationError('arguments', 'Invalid --operation')
      if (!options.operations.includes(operation)) options.operations.push(operation)
    } else if (arg === '--missing-budget-minor') {
      const value = args[++i]
      if (!/^\d+$/.test(value || '') || !nonnegative(Number(value))) throw new MigrationError('arguments', 'Invalid --missing-budget-minor')
      options.missingBudgetMinor = Number(value)
    } else throw new MigrationError('arguments', 'Unknown argument; use --help')
  }
  if (options.all === Boolean(options.provider)) throw new MigrationError('arguments', 'Choose --all or --provider NAME')
  if (options.operations.length && !options.provider) throw new MigrationError('arguments', '--operation requires --provider')
  if (options.missingBudgetMinor == null) throw new MigrationError('arguments', '--missing-budget-minor is required (100000 = 100000 calls at 0.01)')
  return options
}

export function adminClient(base, token, fetchImpl = fetch) {
  let url
  try { url = new URL(base) } catch { throw new MigrationError('configuration', 'Invalid Admin URL') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new MigrationError('configuration', 'Admin URL must be an origin')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new MigrationError('configuration', 'Admin URL must use HTTPS or loopback HTTP')
  }
  if (!token) throw new MigrationError('configuration', 'MX_INSIGHT_ADMIN_TOKEN is required')
  return async (path, body) => {
    // The script only constructs these credential-free, internal paths.
    if (!/^\/internal\/v1\/admin\/external-platforms(?:\/[a-z][a-z0-9._-]{0,63}(?:\/operations\/[a-z][a-z0-9._-]{0,127}\/policy)?)?(?:\?range=24h)?$/.test(path)) {
      throw new MigrationError('admin_request', 'Unsupported Admin request path')
    }
    const method = body ? 'PUT' : 'GET'
    let response
    try {
      response = await fetchImpl(`${url.origin}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (error) {
      throw new MigrationError('admin_request', `${method} ${path}: transport failure (${diagnosticCode(error?.cause?.code || error?.code || error?.name)})`)
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new MigrationError('admin_request', `${method} ${path}: HTTP ${response.status}, code=${diagnosticCode(payload?.error?.code)}`)
    if (!payload?.data) throw new MigrationError('admin_request', `${method} ${path}: HTTP ${response.status}, missing JSON data`)
    return payload.data
  }
}

export async function readAudit(databaseUrl) {
  if (!databaseUrl) throw new MigrationError('audit_read', 'DATABASE_URL is required for read-only policy audit')
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 })
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL lock_timeout = '2s'")
    const { rows } = await client.query(`SELECT provider_key, operation_key, revision,
      previous_revision, desired_state, actor, reason
      FROM control.external_platform_operation_policy_events
      ORDER BY provider_key, operation_key, revision`)
    await client.query('ROLLBACK')
    return rows
  } catch (error) {
    throw new MigrationError('audit_read', `Database audit read failed (${diagnosticCode(error?.code)}); check database access and policy event table`)
  } finally { await client.end() }
}

export async function migrate({ options, admin, audit, currencyFallback = provider => PROVIDER_SEED_CURRENCIES[provider],
  now = () => new Date().toISOString(), progress = () => {} }) {
  progress('stage=provider_inventory (read-only)')
  const overview = await admin(`${ROOT}?range=24h`)
  if (!Array.isArray(overview.providers) || overview.providers.some(row => !/^[a-z][a-z0-9._-]{0,63}$/.test(row?.key || ''))) {
    throw new MigrationError('provider_inventory', 'Missing or invalid provider inventory')
  }
  const providers = overview.providers.filter(row => options.all || row.key === options.provider)
  if (!providers.length) throw new MigrationError('provider_inventory', 'Provider not found')
  const events = new Map()
  for (const row of audit) {
    const key = `${row.provider_key}/${row.operation_key}`
    if (!events.has(key)) events.set(key, [])
    events.get(key).push(row)
  }
  const report = { mode: options.apply ? 'apply' : 'preview', generatedAt: now(),
    unitPrice: '0.01', missingBudgetMinor: options.missingBudgetMinor,
    plans: [], skipped: [], results: [], errors: [] }
  const selected = new Set(options.operations || [])
  const found = new Set()
  // Finish all reads and planning before any write. A failed inventory is not a
  // license to apply an incomplete, unreviewable batch.
  for (const provider of providers) {
    if (NON_PRICING_PROVIDERS.has(provider.key)) {
      report.skipped.push({ provider: provider.key, action: 'skip', reason: 'provider_has_no_operation_pricing' })
      continue
    }
    progress(`stage=operation_inventory provider=${provider.key} (read-only)`)
    const detail = await admin(`${ROOT}/${provider.key}?range=24h`)
    if (!Array.isArray(detail.operations)) throw new MigrationError('operation_inventory', `Missing operation inventory: ${provider.key}`)
    const configuredCurrency = detail.provider?.billing?.currency
    const seedCurrency = await currencyFallback(provider.key)
    const defaultCurrency = configuredCurrency ?? seedCurrency ?? (options.defaults ? 'CNY' : undefined)
    for (const operation of detail.operations) {
      if (selected.size && !selected.has(operation.operationKey)) continue
      found.add(operation.operationKey)
      const plan = planOperation(operation, {
        provider: provider.key, events: events.get(`${provider.key}/${operation.operationKey}`) || [],
        defaultCurrency, defaultCurrencySource: configuredCurrency ? 'provider_configuration'
          : seedCurrency ? 'provider_seed' : 'default_estimate_CNY',
        missingBudgetMinor: options.missingBudgetMinor, pricingAsOf: report.generatedAt, defaults: options.defaults,
      })
      report[plan.action === 'apply' ? 'plans' : 'skipped'].push({ provider: provider.key, ...plan })
    }
  }
  if ([...selected].some(key => !found.has(key))) {
    throw new MigrationError('operation_inventory', 'Selected operation not found; no writes attempted')
  }
  progress(`planned=${report.plans.length} skipped=${report.skipped.length} mode=${report.mode}`)
  const skippedCounts = new Map()
  for (const row of report.skipped) {
    const key = `${row.provider}/${row.reason}`
    skippedCounts.set(key, (skippedCounts.get(key) || 0) + 1)
  }
  for (const [reason, count] of skippedCounts) progress(`skip ${reason}: ${count}`)
  if (options.apply) {
    for (const plan of report.plans) {
      try {
        const updated = await admin(`${ROOT}/${plan.provider}/operations/${encodeURIComponent(plan.operationKey)}/policy`, plan.body)
        const result = { provider: plan.provider, operationKey: plan.operationKey, revision: updated.revision,
          priceBookVersion: updated.priceBook?.version, effectiveState: updated.effectiveState,
          blockers: updated.blockers }
        report.results.push(result)
        if (report.results.length % 25 === 0) progress(`confirmed=${report.results.length}/${report.plans.length}`)
        if (!options.defaults && !['active', 'canary'].includes(updated.effectiveState)) {
          report.errors.push({ ...result, reason: 'saved_but_not_ready' })
          break
        }
      } catch (error) {
        // An HTTP failure can occur after COMMIT. Stop, report uncertainty and
        // never automatically repeat the PUT. Rerunning re-reads current state.
        report.errors.push({ provider: plan.provider, operationKey: plan.operationKey,
          reason: 'write_not_confirmed', message: failureDiagnostic(error) })
        break
      }
    }
  }
  report.summary = { planned: report.plans.length, skipped: report.skipped.length,
    confirmedWrites: report.results.length, errors: report.errors.length,
    unattempted: options.apply ? report.plans.length - report.results.length - report.errors.filter(row => row.reason === 'write_not_confirmed').length : report.plans.length }
  progress(JSON.stringify(report.summary))
  return report
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.help) {
    console.log('Usage: node scripts/migrate-missing-operation-prices.mjs (--all | --provider NAME) [--operation KEY ...] --missing-budget-minor 100000 [--defaults] [--apply]\nDefault: read-only preview. --defaults fills missing prices even for unavailable/paused operations, preserves operator states, activates only audited bootstrap disables, and uses CNY when no ledger currency exists. JSON report on stdout; progress on stderr.')
    return 0
  }
  const admin = adminClient(process.env.MX_INSIGHT_ADMIN_BASE_URL || `http://127.0.0.1:${process.env.MX_INSIGHT_PORT || 18151}`, process.env.MX_INSIGHT_ADMIN_TOKEN)
  process.stderr.write('[missing-prices] stage=audit_read (read-only)\n')
  const audit = await readAudit(process.env.DATABASE_URL)
  const report = await migrate({ options, admin, audit, progress: message => process.stderr.write(`[missing-prices] ${message}\n`) })
  console.log(JSON.stringify(report, null, 2))
  return report.errors.length ? 1 : 0
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  main().then(code => { process.exitCode = code }).catch(error => {
    // Do not print connection strings, headers, provider credentials or stacks.
    console.error(`[missing-prices] Failed: ${failureDiagnostic(error)}. No automatic retry. Rerun preview after resolving this error.`)
    process.exitCode = 1
  })
}
