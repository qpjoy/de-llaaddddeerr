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

const PRICE_BOOK_FIELDS = ['currency', 'pricingAsOf', 'monthlyBudgetMinor', 'monthlySubsidyBudgetMinor']

function say(message) {
  process.stdout.write(`[price-book-seed] ${message}\n`)
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
  return {
    ok: true,
    // The control plane accepts exactly this operation's endpoint keys, so the
    // flat repository file is narrowed per operation rather than sent whole.
    priceBook: {
      ...Object.fromEntries(PRICE_BOOK_FIELDS.map((field) => [field, file[field]])),
      unitCostMinorByEndpoint: Object.fromEntries(
        endpointKeys.map((endpointKey) => [endpointKey, unitCosts[endpointKey]]),
      ),
    },
  }
}

async function seedProvider(providerKey, file) {
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
      await seedProvider(providerKey, file)
    } catch (error) {
      say(`WARNING ${providerKey}: ${error.message}`)
    }
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    say(`WARNING price-book seeding failed: ${error.message}`)
    process.exit(0)
  })
}
