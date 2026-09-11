#!/usr/bin/env node
// Deploy-time preflight for paid external-platform operations.
//
// A released operation is admitted only when every endpoint key bound to it has
// a positive reviewed unit price. When one endpoint is unpriced the operation's
// effectiveState becomes `blocked`, and because Hub still serves stored
// snapshots the symptom reaching a tenant is a stale body -- not an error. That
// is expensive to trace backwards, so the same rule is checked here, against
// the same catalog the runtime uses, before the ConfigMap is written.
//
// This reports; it does not gate. A pricing gap must never stop an operator
// from shipping an unrelated change.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../server/external-platforms/control-store.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// This check runs before the app is deployed, so it cannot read the control
// plane. It must therefore account for the seed that runs later in the same
// deploy: an endpoint priced in seeds/pricebooks/<provider>.json will be
// priced by the time anyone can call it, and warning about it here would be a
// false alarm -- the kind that teaches operators to ignore this output.
function seededPrices(providerKey) {
  try {
    const file = JSON.parse(
      readFileSync(join(projectRoot, 'seeds', 'pricebooks', `${providerKey}.json`), 'utf8'),
    )
    return file.unitCostMinorByEndpoint || {}
  } catch {
    return {}
  }
}

const PROVIDERS = Object.freeze({
  justone: {
    label: 'JustOne',
    billingVar: 'MX_INSIGHT_JUSTONE_BILLING_JSON',
    // Each gate names the deployment flag that must be on for the operation to
    // dispatch at all. An operation behind a closed gate is `disabled`, and its
    // pricing is not yet the thing standing in the way.
    gateVars: { contractVerified: 'MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED' },
    // JustOne prices per endpoint only; there is no provider-wide fallback.
    flatUnitCost: false,
  },
  tikhub: {
    label: 'TikHub',
    billingVar: 'MX_INSIGHT_TIKHUB_BILLING_JSON',
    gateVars: {
      contractVerified: 'MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED',
      searchContractVerified: 'MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED',
      userActivityContractVerified: 'MX_INSIGHT_TIKHUB_USER_ACTIVITY_CONTRACT_VERIFIED',
    },
    flatUnitCost: true,
  },
})

function positive(value) {
  return Number.isSafeInteger(value) && value > 0
}

function parseBilling(raw, billingVar) {
  if (raw == null || String(raw).trim() === '') return { present: false, billing: null, error: null }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { present: true, billing: null, error: `${billingVar} must be a JSON object` }
    }
    return { present: true, billing: value, error: null }
  } catch {
    return { present: true, billing: null, error: `${billingVar} is not valid JSON` }
  }
}

// `seedPrices` is injectable so a test can exercise the env-only path without
// the repository's own seed files masking the gap it is checking for.
export function inspectExternalPlatformPricing(environment = process.env, {
  seedPrices = seededPrices,
} = {}) {
  const findings = []
  for (const [providerKey, provider] of Object.entries(PROVIDERS)) {
    const operations = EXTERNAL_PLATFORM_OPERATION_CATALOG[providerKey] || []
    const { present, billing, error } = parseBilling(environment[provider.billingVar], provider.billingVar)
    const seeded = seedPrices(providerKey)
    const coveredBySeed = (endpointKey) => (
      Number.isSafeInteger(seeded[endpointKey]) && seeded[endpointKey] > 0
    )
    const openGates = new Set(
      Object.entries(provider.gateVars)
        .filter(([, envVar]) => environment[envVar] === '1')
        .map(([gate]) => gate),
    )
    if (openGates.size === 0) continue

    for (const operation of operations) {
      if (!openGates.has(operation.legacyGate)) continue
      const context = {
        provider: provider.label,
        providerKey,
        operationKey: operation.operationKey,
        label: operation.label,
        billingVar: provider.billingVar,
      }
      if (error) {
        findings.push({ ...context, kind: 'invalid_billing_json', detail: error })
        continue
      }
      if (!present) {
        // Endpoints the seed file prices are not a gap: seeding runs later in
        // this same deploy and will cover them.
        const missingEndpointKeys = operation.endpointKeys.filter((key) => !coveredBySeed(key))
        if (missingEndpointKeys.length === 0) continue
        findings.push({
          ...context,
          kind: 'billing_absent',
          detail: `${provider.billingVar} is not set while ${provider.gateVars[operation.legacyGate]}=1`,
          missingEndpointKeys,
        })
        continue
      }
      const costs = billing.unitCostMinorByEndpoint || {}
      const flat = provider.flatUnitCost && positive(billing.unitCostMinor)
      const missingEndpointKeys = flat
        ? []
        : operation.endpointKeys.filter((endpointKey) => (
            !positive(costs[endpointKey]) && !coveredBySeed(endpointKey)
          ))
      const missingEvidence = [
        ['currency', typeof billing.currency === 'string' && /^[A-Za-z]{3}$/u.test(billing.currency)],
        ['pricingAsOf', Boolean(billing.pricingAsOf)],
        ['monthlyBudgetMinor', Number.isSafeInteger(billing.monthlyBudgetMinor)],
        ['monthlySubsidyBudgetMinor', Number.isSafeInteger(billing.monthlySubsidyBudgetMinor)],
      ].filter(([, ok]) => !ok).map(([field]) => field)

      if (missingEndpointKeys.length > 0 || missingEvidence.length > 0) {
        findings.push({
          ...context,
          kind: 'price_control_incomplete',
          missingEndpointKeys,
          missingEvidence,
        })
      }
    }
  }
  return findings
}

function report(findings) {
  if (findings.length === 0) {
    console.log('[pricing-preflight] every released paid operation behind an open gate has complete price evidence')
    return
  }
  console.log('[pricing-preflight] WARNING: these operations will report effectiveState=blocked')
  console.log('[pricing-preflight] Hub keeps serving stored snapshots, so tenants see stale data, not an error.')
  for (const finding of findings) {
    console.log(`[pricing-preflight]   ${finding.provider} / ${finding.operationKey} (${finding.label})`)
    if (finding.detail) console.log(`[pricing-preflight]     - ${finding.detail}`)
    if (finding.missingEvidence?.length) {
      console.log(`[pricing-preflight]     - missing reviewed fields: ${finding.missingEvidence.join(', ')}`)
    }
    if (finding.missingEndpointKeys?.length) {
      console.log(`[pricing-preflight]     - unpriced endpoint keys: ${finding.missingEndpointKeys.join(', ')}`)
    }
    console.log(`[pricing-preflight]     fix: set ${finding.billingVar} in .env.internal, then redeploy`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  report(inspectExternalPlatformPricing())
}
