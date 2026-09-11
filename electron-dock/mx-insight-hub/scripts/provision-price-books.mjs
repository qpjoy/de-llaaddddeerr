#!/usr/bin/env node
// Seed the reviewed default price book for each paid provider operation, once.
//
// Cost evidence cannot come from a SQL migration: a migration runs before the
// app, cannot read the deployment's configuration, and writing `status =
// 'reviewed'` from SQL would manufacture the very review the control plane
// exists to require. It comes from a file in this repository instead, so the
// numbers move through code review and stay in git history. It lives under
// seeds/ rather than deploy/ because deployment manifests stay free of any
// individual provider's name.
//
// The seed is one-directional. Once an operation's price book has source
// `database` -- because this script seeded it, or because someone published a
// new one from Admin -- this script leaves it alone forever. A redeploy can
// therefore never walk back a price somebody set in the UI.
//
// It also never changes desiredState: whatever the operation is set to now
// (including a deliberate `paused`) is what it is set to after seeding.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const priceBookDir = join(projectRoot, 'seeds', 'pricebooks')

const base = (process.env.MX_INSIGHT_ADMIN_BASE_URL || 'http://127.0.0.1:18151').replace(/\/$/, '')
const adminToken = process.env.MX_INSIGHT_ADMIN_TOKEN

const PRICE_BOOK_FIELDS = ['currency', 'pricingAsOf']

// The control plane stores budgets in minor currency units, but an operator
// reasons in calls and the provider bills in calls. A file may therefore state
// either: `monthlyBudgetCalls` is multiplied by the operation's highest unit
// price, while `monthlyBudgetMinor` is passed through unchanged. Deriving from
// calls means a later price change moves the money ceiling rather than silently
// shrinking how many calls the budget buys.
const BUDGET_FIELDS = Object.freeze([
  ['monthlyBudgetMinor', 'monthlyBudgetCalls'],
  ['monthlySubsidyBudgetMinor', 'monthlySubsidyBudgetCalls'],
])

function budgetMinor(file, minorField, callsField, unitCostMinor) {
  const calls = file[callsField]
  if (Number.isSafeInteger(calls) && calls >= 0) return calls * unitCostMinor
  return file[minorField]
}

function say(message) {
  // Seeding must not die because whoever is reading stopped reading. The deploy
  // pipes this into its own log, and a closed pipe there would abort the run
  // partway through with some operations seeded and others not.
  try {
    process.stdout.write(`[price-book-seed] ${message}\n`)
  } catch {
    // Losing a progress line is never worth failing a deploy over.
  }
}

async function admin(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const code = payload?.error?.code || `http_${response.status}`
    const detail = payload?.error?.message || ''
    throw new Error(`${method} ${path} failed: ${code}${detail ? ` (${detail})` : ''}`)
  }
  return payload?.data
}

export function priceBookForOperation(file, endpointKeys) {
  const unitCosts = file.unitCostMinorByEndpoint || {}
  const missing = endpointKeys.filter((endpointKey) => !(
    Number.isSafeInteger(unitCosts[endpointKey]) && unitCosts[endpointKey] > 0
  ))
  if (missing.length > 0) {
    return { ok: false, missing }
  }
  // A call budget buys the same number of calls whichever endpoint is hit, so
  // it is priced at this operation's most expensive one.
  const unitCostMinor = Math.max(...endpointKeys.map((endpointKey) => unitCosts[endpointKey]))
  return {
    ok: true,
    // The control plane accepts exactly this operation's endpoint keys, so the
    // flat repository file is narrowed per operation rather than sent whole.
    priceBook: {
      ...Object.fromEntries(PRICE_BOOK_FIELDS.map((field) => [field, file[field]])),
      ...Object.fromEntries(BUDGET_FIELDS.map(([minorField, callsField]) => [
        minorField,
        budgetMinor(file, minorField, callsField, unitCostMinor),
      ])),
      unitCostMinorByEndpoint: Object.fromEntries(
        endpointKeys.map((endpointKey) => [endpointKey, unitCosts[endpointKey]]),
      ),
    },
  }
}

async function seedProvider(providerKey, file, blocked) {
  const detail = await admin(`/internal/v1/admin/external-platforms/${providerKey}`)
  const operations = detail?.operations || []
  if (operations.length === 0) {
    say(`${providerKey}: the control plane reports no operations; nothing to seed`)
    return
  }

  for (const operation of operations) {
    const endpointKeys = operation.release?.endpointKeys || []
    const label = `${providerKey}/${operation.operationKey}`

    if (operation.priceBook?.source === 'database') {
      say(`${label}: already has a database price book (v${operation.priceBook.version}); leaving it untouched`)
      // Untouched is not the same as healthy: a hand-edited price book can
      // still leave an operation blocked, and that must not go unreported.
      if (operation.effectiveState === 'blocked') {
        blocked.push({ label, effectiveState: operation.effectiveState, blockers: operation.blockers || [] })
      }
      continue
    }
    if (endpointKeys.length === 0) {
      say(`${label}: release declares no endpoint keys; skipped`)
      continue
    }

    const narrowed = priceBookForOperation(file, endpointKeys)
    if (!narrowed.ok) {
      say(`${label}: WARNING seeds/pricebooks/${providerKey}.json has no positive price for ${narrowed.missing.join(', ')}; operation stays blocked`)
      continue
    }

    try {
      const updated = await admin(
        `/internal/v1/admin/external-platforms/${providerKey}/operations/${operation.operationKey}/policy`,
        {
          method: 'PUT',
          body: {
            // Preserve the operation's current desired state. Seeding a price
            // must never resume something an operator paused.
            desiredState: operation.desiredState,
            expectedRevision: operation.revision,
            reason: `Seeded reviewed default price book from seeds/pricebooks/${providerKey}.json`,
            ...(operation.desiredState === 'canary'
              ? { canaryConsumerIds: operation.canaryConsumerIds || [] }
              : {}),
            priceBook: narrowed.priceBook,
          },
        },
      )
      say(`${label}: seeded price book v${updated?.priceBook?.version ?? '?'} (${updated?.effectiveState ?? 'unknown'})`)
      if (updated?.effectiveState === 'blocked') {
        blocked.push({ label, effectiveState: updated.effectiveState, blockers: updated.blockers || [] })
      }
    } catch (error) {
      // One operation failing must not stop the others or fail the deploy.
      say(`${label}: WARNING could not seed price book: ${error.message}`)
    }
  }
}

export async function main() {
  if (!adminToken) {
    say('MX_INSIGHT_ADMIN_TOKEN is not set; skipping price-book seeding')
    return 0
  }
  let files
  try {
    files = (await readdir(priceBookDir)).filter((name) => name.endsWith('.json'))
  } catch {
    say('no seeds/pricebooks directory; nothing to seed')
    return 0
  }
  const blocked = []
  for (const name of files.sort()) {
    const providerKey = name.replace(/\.json$/u, '')
    let file
    try {
      file = JSON.parse(await readFile(join(priceBookDir, name), 'utf8'))
    } catch (error) {
      say(`WARNING ${name} is not valid JSON: ${error.message}`)
      continue
    }
    try {
      await seedProvider(providerKey, file, blocked)
    } catch (error) {
      say(`WARNING ${providerKey}: ${error.message}`)
    }
  }
  // The pre-deploy pricing check can only predict, because it runs before the
  // app exists. This reads what the control plane actually ended up with, which
  // is the only statement worth acting on.
  if (blocked.length === 0) {
    say('every paid operation reports a usable state; nothing is blocked on cost evidence')
  } else {
    say(`WARNING ${blocked.length} operation(s) remain blocked after seeding:`)
    for (const entry of blocked) {
      say(`  ${entry.label} -> ${entry.effectiveState}`)
      for (const blocker of entry.blockers) {
        say(`    ${blocker.code}${blocker.message ? `: ${blocker.message}` : ''}`)
      }
    }
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Node raises EPIPE as an unhandled stream error rather than a throw, so the
  // try/catch in say() alone is not enough.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  main().then((code) => process.exit(code)).catch((error) => {
    say(`WARNING price-book seeding failed: ${error.message}`)
    process.exit(0)
  })
}
