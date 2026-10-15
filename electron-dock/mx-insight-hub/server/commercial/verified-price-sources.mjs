import { createHash } from 'node:crypto'
import tikhub from '../data/tikhub-official-prices.json' with { type: 'json' }
import { QIXIN_OFFICIAL_PRICES as qixin } from '../../shared/qixin-official-prices.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG as catalog } from '../external-platforms/control-store.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS } from '../contracts/tikhub-xiaohongshu-official.mjs'
import { SOCIAL_ACCOUNT_PLATFORMS, socialAccountPlatform } from '../contracts/social-accounts.mjs'
import { enterpriseEndpoint } from '../contracts/enterprise.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = (provider, endpointKey) => `${provider}:${endpointKey}`
const decimal = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value)
const cents = value => `${BigInt(value) / 100n}.${String(BigInt(value) % 100n).padStart(2, '0')}`

function tikhubPaths() {
  const candidates = [
    ...NATIVE_FORWARDING_ENDPOINTS.filter(row => row.provider === 'tikhub'),
    ...Object.values(TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS).map(row => ({ ...row, path: row.providerPath || row.path })),
    ...SOCIAL_ACCOUNT_PLATFORMS.map(socialAccountPlatform).filter(row => row.providerKey === 'tikhub')
      .map(row => ({ ...row, path: row.upstreamPath })),
  ]
  const paths = new Map()
  for (const row of candidates) {
    if (!row.path?.startsWith('/api/v1/')) throw new Error('Invalid reviewed TikHub contract path')
    if (paths.has(row.endpointKey) && paths.get(row.endpointKey) !== row.path) throw new Error('Conflicting reviewed TikHub endpoint paths')
    paths.set(row.endpointKey, row.path)
  }
  return paths
}

// Local reviewed evidence only: never fetch supplier metadata or touch credentials
// during migration planning. Official catalogue rates are not account deductions.
export function verifiedPriceSources() {
  const rates = [], excluded = [], sources = []
  const snapshotHash = hash(tikhub)
  const byPath = new Map()
  for (const row of tikhub.rows) {
    if (!decimal(row.unitPrice) || ![0, 1].includes(row.allowDiscount)
      || ![0, 1].includes(row.allowFreeCredit)
      || (byPath.has(row.path) && hash(byPath.get(row.path)) !== hash(row))) {
      throw new Error('Invalid or duplicate reviewed TikHub price evidence')
    }
    byPath.set(row.path, row)
  }
  const paths = tikhubPaths()
  const registered = [...new Set(catalog.tikhub.flatMap(row => [...row.endpointKeys, ...(row.optionalEndpointKeys || [])]))].sort()
  for (const endpointKey of registered) {
    const path = paths.get(endpointKey), row = byPath.get(path)
    if (!row) {
      excluded.push({ provider: 'tikhub', endpointKey, reason: path ? 'official_catalog_path_missing' : 'reviewed_contract_path_missing' })
      continue
    }
    rates.push({ provider: 'tikhub', endpointKey, currency: tikhub.currency, unitPrice: row.unitPrice,
      sourceKind: 'official', sourceUrl: tikhub.sourceUrl, observedAt: tikhub.observedAt, sourceHash: tikhub.rawSha256,
      flags: { verified: true, inferred: false, priceBasis: 'official_catalog_base_rate', accountSpecific: false,
        actualChargeVerified: false, allowDiscount: row.allowDiscount === 1, allowFreeCredit: row.allowFreeCredit === 1,
        providerPath: path, endpointType: row.endpointType, snapshotHash } })
  }
  sources.push({ provider: 'tikhub', sourceUrl: tikhub.sourceUrl, observedAt: tikhub.observedAt,
    sourceHash: tikhub.rawSha256, sourceHashKind: 'raw_response_sha256', snapshotHash,
    currency: tikhub.currency, priceBasis: 'official_catalog_base_rate', accountSpecific: false,
    actualChargeVerified: false, catalogRows: tikhub.rows.length, mappedEndpoints: rates.length })

  const sourceHash = hash(qixin), sourceUrl = qixin.source.split('?')[0]
  const registeredQixin = new Set(catalog.qixin.flatMap(row => row.endpointKeys))
  for (const entry of qixin.entries) {
    const endpointKey = enterpriseEndpoint(entry.apiId)
    if (entry.unitPriceMinor === null || !registeredQixin.has(endpointKey)) {
      excluded.push({ provider: 'qixin', endpointKey, reason: entry.unitPriceMinor === null ? 'negotiated_price_unavailable' : 'endpoint_not_registered' })
      continue
    }
    if (!Number.isSafeInteger(entry.unitPriceMinor) || entry.unitPriceMinor < 0) throw new Error('Invalid reviewed Qixin price evidence')
    rates.push({ provider: 'qixin', endpointKey, currency: qixin.currency, unitPrice: cents(entry.unitPriceMinor),
      sourceKind: 'official', sourceUrl, observedAt: qixin.observedAt, sourceHash,
      flags: { verified: true, inferred: false, priceBasis: 'dated_public_catalog_rate', accountSpecific: false,
        actualChargeVerified: false, refreshStatus: 'latest_refresh_http_405', apiId: entry.apiId } })
  }
  sources.push({ provider: 'qixin', sourceUrl, observedAt: qixin.observedAt, sourceHash,
    sourceHashKind: 'normalized_snapshot_sha256', pagesSha256: [...qixin.pagesSha256], currency: qixin.currency,
    priceBasis: 'dated_public_catalog_rate', accountSpecific: false, actualChargeVerified: false,
    refreshStatus: 'latest_refresh_http_405', catalogRows: qixin.entries.length,
    mappedEndpoints: rates.filter(row => row.provider === 'qixin').length })
  for (const provider of Object.keys(catalog).filter(provider => !['qixin', 'tikhub'].includes(provider))) {
    excluded.push({ provider, reason: provider === 'justone' ? 'explicit_endpoint_price_evidence_missing' : 'account_or_endpoint_price_evidence_missing' })
  }
  return { rates: rates.sort((a, b) => identity(a.provider, a.endpointKey).localeCompare(identity(b.provider, b.endpointKey))), sources, excluded }
}

// A procurement endpoint is not generally a customer meter: composite search,
// enrichment and provider fallback can consume several calls per delivery.
// Only the reviewed native and Qixin one-endpoint contracts are eligible here.
export function ratesByCustomerMeter(rates) {
  const index = new Map()
  for (const rate of rates) {
    const key = identity(rate.provider, rate.endpointKey)
    if (index.has(key)) throw new Error('Duplicate verified endpoint rate')
    index.set(key, rate)
  }
  const native = new Set(NATIVE_FORWARDING_ENDPOINTS.map(row => identity(row.provider, row.operation)))
  const byMeter = new Map()
  for (const [provider, operations] of Object.entries(catalog)) for (const operation of operations) {
    const rows = byMeter.get(operation.operationKey) || []
    rows.push({ provider, ...operation }); byMeter.set(operation.operationKey, rows)
  }
  const ratesByMeter = {}, skipped = []
  for (const [meterKey, definitions] of byMeter) {
    const candidates = definitions.flatMap(row => [...row.endpointKeys, ...(row.optionalEndpointKeys || [])]
      .map(endpointKey => index.get(identity(row.provider, endpointKey))).filter(Boolean))
    if (!candidates.length) continue
    const definition = definitions[0]
    let reason = null
    if (definitions.length !== 1) reason = 'shared_meter_multiple_provider_contracts'
    else if (definition.endpointKeys.length !== 1 || definition.optionalEndpointKeys?.length) reason = 'multiple_or_optional_upstream_endpoints'
    else if (definition.dispatchBlock) reason = 'operation_not_dispatchable'
    else if (definition.provider !== 'qixin' && !native.has(identity(definition.provider, meterKey))) reason = 'one_upstream_per_customer_request_not_verified'
    if (reason) { skipped.push({ meterKey, reason }); continue }
    const rate = candidates[0]
    ratesByMeter[meterKey] = { currency: rate.currency, unit: 'request', unitPrice: rate.unitPrice,
      source: { provider: rate.provider, endpointKey: rate.endpointKey, sourceKind: rate.sourceKind,
        sourceUrl: rate.sourceUrl, observedAt: rate.observedAt, sourceHash: rate.sourceHash, flags: { ...rate.flags } } }
  }
  return { ratesByMeter, skipped }
}
