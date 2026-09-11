import { randomUUID } from 'node:crypto'

import { AppError } from '../core/errors.mjs'
import {
  ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
  JUSTONE_ENDPOINTS,
  JUSTONE_OPERATION,
} from '../contracts/justone.mjs'
import {
  JUSTONE_RESOURCE_CONTRACT_VERSION,
  justoneResourceOperations,
} from '../contracts/justone-resources.mjs'
import {
  SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
  SOCIAL_ACCOUNT_SEARCH_OPERATION,
  socialAccountEndpointKeys,
} from '../contracts/social-accounts.mjs'
import {
  TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
  XIAOHONGSHU_POST_CONTRACT_VERSION,
  XIAOHONGSHU_POST_OPERATION,
} from '../contracts/tikhub-xiaohongshu.mjs'
import {
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
  XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
  XIAOHONGSHU_SEARCH_OPERATION,
} from '../contracts/tikhub-xiaohongshu-search.mjs'
import {
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
  XIAOHONGSHU_USER_INFO_CONTRACT_VERSION,
  XIAOHONGSHU_USER_INFO_OPERATION,
} from '../contracts/tikhub-xiaohongshu-user-info.mjs'
import {
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
  XIAOHONGSHU_CRAWL_CONTRACT_VERSION,
  XIAOHONGSHU_CRAWL_OPERATION,
} from '../contracts/tikhub-xiaohongshu-user-posts.mjs'

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,127}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DESIRED_STATES = new Set(['disabled', 'shadow', 'canary', 'active', 'paused'])
const UPDATE_FIELDS = new Set([
  'desiredState',
  'expectedRevision',
  'reason',
  'canaryConsumerIds',
  'priceBook',
])
const PRICE_BOOK_FIELDS = new Set([
  'currency',
  'pricingAsOf',
  'monthlyBudgetMinor',
  'monthlySubsidyBudgetMinor',
  'unitCostMinorByEndpoint',
])

function uniqueEndpointKeys() {
  return [...new Set(Object.values(JUSTONE_ENDPOINTS).map(({ endpointKey }) => endpointKey))]
}

// The resource operations share the provider's single contract gate rather
// than adding a gate each. Their release control is the per-endpoint price:
// an operation whose endpoint key has no reviewed price is `blocked`, so
// turning one on is one line in the pricebook and nothing else. A second gate
// would only add a second thing to forget.
function justoneResourceOperationEntries() {
  return [...justoneResourceOperations()].map(([operationKey, resources]) => Object.freeze({
    operationKey,
    label: resources.map((entry) => entry.label).join(' / '),
    legacyGate: 'contractVerified',
    contractVersion: JUSTONE_RESOURCE_CONTRACT_VERSION,
    endpointKeys: Object.freeze([...new Set(resources.map((entry) => entry.endpointKey))]),
  }))
}

export const EXTERNAL_PLATFORM_OPERATION_CATALOG = Object.freeze({
  justone: Object.freeze([
    Object.freeze({
      operationKey: JUSTONE_OPERATION,
      label: '电商商品搜索',
      legacyGate: 'contractVerified',
      contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
      endpointKeys: Object.freeze(uniqueEndpointKeys()),
    }),
    ...justoneResourceOperationEntries(),
    Object.freeze({
      operationKey: SOCIAL_ACCOUNT_SEARCH_OPERATION,
      label: '社交账号搜索',
      legacyGate: 'contractVerified',
      contractVersion: SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
      // Only this provider's platforms. The same operation also exists under
      // TikHub with its own two platforms, priced independently, because each
      // provider bills its own endpoints.
      endpointKeys: socialAccountEndpointKeys('justone'),
    }),
  ]),
  tikhub: Object.freeze([
    Object.freeze({
      operationKey: SOCIAL_ACCOUNT_SEARCH_OPERATION,
      label: '社交账号搜索',
      legacyGate: 'contractVerified',
      contractVersion: SOCIAL_ACCOUNT_SEARCH_CONTRACT_VERSION,
      // The same operation key exists under the other provider with its own two
      // platforms. Each vendor prices and gates the endpoints it actually
      // serves, so one vendor being blocked never silences the other's.
      endpointKeys: socialAccountEndpointKeys('tikhub'),
    }),
    Object.freeze({
      operationKey: XIAOHONGSHU_POST_OPERATION,
      label: '小红书笔记详情',
      legacyGate: 'contractVerified',
      contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
      endpointKeys: Object.freeze([TIKHUB_XIAOHONGSHU_ENDPOINT_KEY]),
    }),
    Object.freeze({
      operationKey: XIAOHONGSHU_SEARCH_OPERATION,
      label: '小红书笔记搜索',
      legacyGate: 'searchContractVerified',
      legacyCanary: 'searchCanaryConsumerIds',
      contractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
      endpointKeys: Object.freeze([TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY]),
    }),
    Object.freeze({
      operationKey: XIAOHONGSHU_USER_INFO_OPERATION,
      label: '小红书用户检索与资料',
      legacyGate: 'userActivityContractVerified',
      contractVersion: XIAOHONGSHU_USER_INFO_CONTRACT_VERSION,
      endpointKeys: Object.freeze([
        TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
        TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
      ]),
    }),
    Object.freeze({
      operationKey: XIAOHONGSHU_CRAWL_OPERATION,
      label: '小红书用户发布笔记',
      legacyGate: 'userActivityContractVerified',
      contractVersion: XIAOHONGSHU_CRAWL_CONTRACT_VERSION,
      endpointKeys: Object.freeze([
        TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
        TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
        TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
      ]),
    }),
  ]),
})

function unavailable() {
  return new AppError(
    503,
    'external_platform_control_store_unavailable',
    'External platform operation control is unavailable',
  )
}

function invalid(message) {
  throw new AppError(400, 'invalid_external_platform_operation_policy', message)
}

function databaseSafeInteger(value, field, { minimum = 0, nullable = false } = {}) {
  if (value == null) {
    if (nullable) return null
    throw unavailable()
  }
  let parsed = null
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'bigint') {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
      parsed = Number(value)
    }
  } else if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    const exact = BigInt(value)
    if (exact <= BigInt(Number.MAX_SAFE_INTEGER) && exact >= BigInt(Number.MIN_SAFE_INTEGER)) {
      parsed = Number(exact)
    }
  }
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new AppError(
      503,
      'external_platform_control_evidence_invalid',
      `External platform control ${field} exceeds the JavaScript safe integer range`,
    )
  }
  return parsed
}

function catalogFor(providerKey) {
  const catalog = EXTERNAL_PLATFORM_OPERATION_CATALOG[providerKey]
  if (!catalog) throw new AppError(404, 'external_platform_not_found', 'External platform not found')
  return catalog
}

function definitionFor(providerKey, operationKey) {
  if (!IDENTIFIER.test(operationKey)) {
    throw new AppError(404, 'external_platform_operation_not_found', 'External platform operation not found')
  }
  const definition = catalogFor(providerKey).find((entry) => entry.operationKey === operationKey)
  if (!definition) {
    throw new AppError(404, 'external_platform_operation_not_found', 'External platform operation not found')
  }
  return definition
}

function normalizeCanaryConsumerIds(value, { required = false } = {}) {
  if (value == null) {
    if (required) invalid('canaryConsumerIds is required when desiredState is canary')
    return null
  }
  if (!Array.isArray(value)) invalid('canaryConsumerIds must be an array of consumer UUIDs')
  const normalized = [...new Set(value.map((entry) => String(entry).trim().toLowerCase()))]
  if (normalized.some((entry) => !UUID.test(entry))) {
    invalid('canaryConsumerIds must contain only consumer UUIDs')
  }
  if (required && normalized.length === 0) {
    invalid('canaryConsumerIds must not be empty when desiredState is canary')
  }
  return normalized.sort()
}

function normalizePriceBook(value, definition) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('priceBook must be an object')
  }
  const unsupported = Object.keys(value).filter((field) => !PRICE_BOOK_FIELDS.has(field))
  if (unsupported.length > 0) invalid(`priceBook contains unsupported field ${unsupported[0]}`)
  const currency = typeof value.currency === 'string' ? value.currency.trim().toUpperCase() : ''
  if (!/^[A-Z]{3}$/u.test(currency)) invalid('priceBook.currency must be an ISO-style three-letter currency')
  const parsedPricingAsOf = typeof value.pricingAsOf === 'string'
    ? new Date(value.pricingAsOf)
    : new Date(Number.NaN)
  if (!Number.isFinite(parsedPricingAsOf.getTime())) {
    invalid('priceBook.pricingAsOf must be a valid timestamp')
  }
  for (const field of ['monthlyBudgetMinor', 'monthlySubsidyBudgetMinor']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      invalid(`priceBook.${field} must be a non-negative safe integer`)
    }
  }
  const unitCosts = value.unitCostMinorByEndpoint
  if (!unitCosts || typeof unitCosts !== 'object' || Array.isArray(unitCosts)) {
    invalid('priceBook.unitCostMinorByEndpoint must be an object')
  }
  const unsupportedEndpoints = Object.keys(unitCosts).filter((endpointKey) => (
    !definition.endpointKeys.includes(endpointKey)
  ))
  if (unsupportedEndpoints.length > 0) {
    invalid(`priceBook contains unsupported endpoint ${unsupportedEndpoints[0]}`)
  }
  const endpointPrices = Object.fromEntries(definition.endpointKeys.map((endpointKey) => {
    const valueForEndpoint = unitCosts[endpointKey]
    if (!Number.isSafeInteger(valueForEndpoint) || valueForEndpoint <= 0) {
      invalid(`priceBook requires a positive safe-integer unit cost for ${endpointKey}`)
    }
    return [endpointKey, valueForEndpoint]
  }))
  return {
    source: 'database',
    status: 'reviewed',
    currency,
    pricingAsOf: parsedPricingAsOf.toISOString(),
    monthlyBudgetMinor: value.monthlyBudgetMinor,
    monthlySubsidyBudgetMinor: value.monthlySubsidyBudgetMinor,
    endpointPrices,
    missingEndpointKeys: [],
    ready: true,
  }
}

function normalizeUpdate(input, definition) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('request body must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !UPDATE_FIELDS.has(field))
  if (unsupported.length > 0) invalid(`request contains unsupported field ${unsupported[0]}`)
  if (!DESIRED_STATES.has(input.desiredState)) {
    invalid('desiredState must be disabled, shadow, canary, active, or paused')
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    invalid('expectedRevision must be a non-negative safe integer')
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1_000) {
    invalid('reason must be a non-empty string of at most 1000 characters')
  }
  const canaryConsumerIds = normalizeCanaryConsumerIds(input.canaryConsumerIds, {
    required: input.desiredState === 'canary',
  })
  const priceBook = normalizePriceBook(input.priceBook, definition)
  return {
    desiredState: input.desiredState,
    expectedRevision: input.expectedRevision,
    reason: input.reason.trim(),
    canaryConsumerIds,
    priceBook,
  }
}

function legacyPolicyState(definition, config) {
  if (!config?.[definition.legacyGate]) return { desiredState: 'disabled', canaryConsumerIds: [] }
  const canary = definition.legacyCanary && Array.isArray(config?.[definition.legacyCanary])
    ? config[definition.legacyCanary].map((entry) => String(entry).toLowerCase())
    : []
  return canary.length > 0
    ? { desiredState: 'canary', canaryConsumerIds: canary }
    : { desiredState: 'active', canaryConsumerIds: [] }
}

function unitCostFor(billing, endpointKey) {
  const mapped = billing?.unitCostMinorByEndpoint?.[endpointKey]
  return Number.isSafeInteger(mapped) && mapped > 0
    ? mapped
    : Number.isSafeInteger(billing?.unitCostMinor) && billing.unitCostMinor > 0
      ? billing.unitCostMinor
      : null
}

function priceEvidence(row, definition, config) {
  const databasePriceBook = row.priceBook?.source === 'database'
  const billing = databasePriceBook ? null : config?.billing
  const endpointPrices = databasePriceBook
    ? row.priceBook.endpointPrices || {}
    : Object.fromEntries(definition.endpointKeys.map((endpointKey) => [
        endpointKey,
        unitCostFor(billing, endpointKey),
      ]))
  const missingEndpointKeys = definition.endpointKeys.filter((endpointKey) => (
    !Number.isSafeInteger(endpointPrices[endpointKey]) || endpointPrices[endpointKey] <= 0
  ))
  const currency = databasePriceBook ? row.priceBook.currency : billing?.currency
  const pricingAsOf = databasePriceBook ? row.priceBook.pricingAsOf : billing?.pricingAsOf
  const monthlyBudgetMinor = databasePriceBook
    ? row.priceBook.monthlyBudgetMinor
    : billing?.monthlyBudgetMinor
  const monthlySubsidyBudgetMinor = databasePriceBook
    ? row.priceBook.monthlySubsidyBudgetMinor
    : billing?.monthlySubsidyBudgetMinor
  const reviewed = databasePriceBook
    ? row.priceBook.status === 'reviewed'
    : billing?.source === 'manual'
  return {
    source: databasePriceBook ? 'database' : 'legacy_environment',
    version: row.priceBook?.version ?? 0,
    status: databasePriceBook ? row.priceBook.status : reviewed ? 'reviewed' : 'incomplete',
    currency: /^[A-Z]{3}$/u.test(currency || '') ? currency : null,
    pricingAsOf: pricingAsOf || null,
    monthlyBudgetMinor: Number.isSafeInteger(monthlyBudgetMinor) ? monthlyBudgetMinor : null,
    monthlySubsidyBudgetMinor: Number.isSafeInteger(monthlySubsidyBudgetMinor)
      ? monthlySubsidyBudgetMinor
      : null,
    endpointPrices,
    missingEndpointKeys,
    ready: reviewed
      && /^[A-Z]{3}$/u.test(currency || '')
      && Boolean(pricingAsOf)
      && Number.isSafeInteger(monthlyBudgetMinor)
      && monthlyBudgetMinor >= 0
      && Number.isSafeInteger(monthlySubsidyBudgetMinor)
      && monthlySubsidyBudgetMinor >= 0
      && missingEndpointKeys.length === 0,
  }
}

function blocker(code, message, details = {}) {
  return { code, message, ...details }
}

function operationView(row, definition, { config = {}, credentialConfigured = false } = {}) {
  const storedCanary = Array.isArray(row.canaryConsumerIds) ? row.canaryConsumerIds : []
  const legacy = legacyPolicyState(definition, config)
  const desiredState = row.controlSource === 'legacy_environment'
    ? legacy.desiredState
    : row.desiredState
  const canaryConsumerIds = row.controlSource === 'legacy_environment'
    ? legacy.canaryConsumerIds
    : storedCanary
  const blockers = []
  if (config?.configurationError) {
    blockers.push(blocker(
      'provider_configuration_invalid',
      config.configurationError.message || 'Provider deployment configuration is invalid',
    ))
  }
  // This parent gate remains an emergency/deployment ceiling even after the
  // operation policy switches from legacy env mode to database mode.
  if (!config?.contractVerified || !config?.[definition.legacyGate]) {
    blockers.push(blocker(
      'deployment_gate_closed',
      'The deployment-level provider or operation gate is closed',
      { gate: definition.legacyGate },
    ))
  }
  if (!credentialConfigured) {
    blockers.push(blocker('credential_missing', 'No usable provider credential is configured'))
  }
  if (row.releaseStatus !== 'released') {
    blockers.push(blocker('release_not_active', 'The bound provider operation release is not released'))
  }
  const pricing = priceEvidence(row, definition, config)
  if (!pricing.ready) {
    blockers.push(blocker(
      'price_control_incomplete',
      'Reviewed upstream price and budget evidence is incomplete',
      { endpointKeys: pricing.missingEndpointKeys },
    ))
  }
  if (
    row.controlSource === 'database'
    && ['active', 'canary'].includes(desiredState)
    && (pricing.source !== 'database' || pricing.status !== 'reviewed')
  ) {
    blockers.push(blocker(
      'database_price_book_required',
      'Database-controlled active or canary mode must bind a reviewed database price book',
    ))
  }
  if (desiredState === 'canary' && canaryConsumerIds.length === 0) {
    blockers.push(blocker('canary_allowlist_empty', 'Canary mode requires at least one consumer UUID'))
  }
  const effectiveState = ['disabled', 'paused'].includes(desiredState)
    ? desiredState
    : blockers.length > 0 ? 'blocked' : desiredState
  return {
    operationKey: definition.operationKey,
    label: definition.label,
    controlSource: row.controlSource,
    desiredState,
    effectiveState,
    revision: Number(row.revision),
    canaryConsumerIds,
    release: {
      revision: Number(row.releaseRevision),
      status: row.releaseStatus,
      contractVersion: row.contractVersion,
      endpointKeys: row.endpointKeys,
    },
    priceBook: pricing,
    blockers,
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt ?? null,
  }
}

function revisionConflict(expectedRevision, currentRevision) {
  return new AppError(
    409,
    'external_platform_operation_revision_conflict',
    'External platform operation policy changed; reload and retry',
    { expectedRevision, currentRevision },
  )
}

function reviewedPriceBookRequired(pricing) {
  return new AppError(
    409,
    'external_platform_reviewed_price_book_required',
    'Active and canary modes require complete reviewed upstream price evidence',
    { missingEndpointKeys: pricing.missingEndpointKeys },
  )
}

function priceBookForUpdate(row, definition, normalized, runtime = {}) {
  if (normalized.priceBook) return normalized.priceBook
  if (row.priceBook?.source === 'database') {
    const current = priceEvidence(row, definition, runtime.config || {})
    if (current.ready && current.status === 'reviewed') return null
  }
  if (!['active', 'canary'].includes(normalized.desiredState)) return null
  const inheritedRow = {
    ...row,
    priceBook: { version: 0, source: 'legacy_environment', status: 'inherited' },
  }
  const pricing = priceEvidence(inheritedRow, definition, runtime.config || {})
  if (!pricing.ready) throw reviewedPriceBookRequired(pricing)
  return pricing
}

function dispatchRejected(state, details = undefined) {
  const messages = {
    disabled: 'This external platform operation is disabled',
    shadow: 'This external platform operation is in validation-only shadow mode',
    paused: 'This external platform operation is paused',
    canary: 'This external platform operation is limited to its canary consumers',
    blocked: 'This external platform operation is blocked by deployment prerequisites',
  }
  return new AppError(
    503,
    `external_platform_operation_${state}`,
    messages[state] || 'This external platform operation is unavailable',
    details,
  )
}

function defaultRow(definition) {
  return {
    controlSource: 'legacy_environment',
    desiredState: 'active',
    canaryConsumerIds: [],
    revision: 0,
    releaseRevision: 1,
    releaseStatus: 'released',
    contractVersion: definition.contractVersion,
    endpointKeys: [...definition.endpointKeys],
    priceBook: { version: 0, source: 'legacy_environment', status: 'inherited' },
    updatedBy: 'migration-060',
    updatedAt: null,
  }
}

function dispatchSnapshot(providerKey, row, definition, {
  config = {},
  consumerId,
  credentialConfigured = false,
  credentialRevision = null,
} = {}) {
  const legacy = legacyPolicyState(definition, config)
  const desiredState = row.controlSource === 'legacy_environment'
    ? legacy.desiredState
    : row.desiredState
  const canaryConsumerIds = row.controlSource === 'legacy_environment'
    ? legacy.canaryConsumerIds
    : row.canaryConsumerIds
  if (['disabled', 'shadow', 'paused'].includes(desiredState)) throw dispatchRejected(desiredState)
  if (desiredState === 'canary' && !canaryConsumerIds.some((id) => (
    String(id).toLowerCase() === String(consumerId).toLowerCase()
  ))) throw dispatchRejected('canary')
  const view = operationView(row, definition, { config, credentialConfigured })
  if (view.effectiveState === 'blocked') {
    throw dispatchRejected('blocked', { blockers: view.blockers })
  }
  const pricing = view.priceBook
  const admittedCredentialRevision = databaseSafeInteger(
    credentialRevision ?? 0,
    'credential revision',
  )
  return Object.freeze({
    providerKey,
    operationKey: definition.operationKey,
    policyRevision: Number(row.revision),
    releaseRevision: Number(row.releaseRevision),
    priceBookVersion: Number(pricing.version),
    // Revision zero is explicit evidence for the retained environment source;
    // database credentials start at their actual non-negative settings revision.
    credentialRevision: admittedCredentialRevision,
    desiredState,
    billing: Object.freeze({
      source: pricing.source,
      currency: pricing.currency,
      pricingAsOf: pricing.pricingAsOf,
      monthlyBudgetMinor: pricing.monthlyBudgetMinor,
      monthlySubsidyBudgetMinor: pricing.monthlySubsidyBudgetMinor,
      unitCostMinorByEndpoint: Object.freeze({ ...pricing.endpointPrices }),
    }),
  })
}

export class MemoryExternalPlatformControlStore {
  constructor() {
    this.rows = new Map()
    this.events = []
    for (const [providerKey, definitions] of Object.entries(EXTERNAL_PLATFORM_OPERATION_CATALOG)) {
      for (const definition of definitions) {
        this.rows.set(`${providerKey}:${definition.operationKey}`, defaultRow(definition))
      }
    }
  }

  #row(providerKey, operationKey) {
    const definition = definitionFor(providerKey, operationKey)
    const row = this.rows.get(`${providerKey}:${operationKey}`)
    if (!row) throw unavailable()
    return { row, definition }
  }

  async describeProvider(providerKey, runtime = {}) {
    return Promise.all(catalogFor(providerKey).map(async (definition) => {
      const { row } = this.#row(providerKey, definition.operationKey)
      return operationView(row, definition, runtime)
    }))
  }

  async updatePolicy(providerKey, operationKey, input, { actor = 'admin-token', runtime = {} } = {}) {
    const { row, definition } = this.#row(providerKey, operationKey)
    const normalized = normalizeUpdate(input, definition)
    if (row.revision !== normalized.expectedRevision) {
      throw revisionConflict(normalized.expectedRevision, row.revision)
    }
    const previous = { ...row, canaryConsumerIds: [...row.canaryConsumerIds] }
    const promotedPricing = priceBookForUpdate(row, definition, normalized, runtime)
    const releaseRevision = promotedPricing ? row.releaseRevision + 1 : row.releaseRevision
    const nextPriceBookVersion = promotedPricing
      ? Math.max(
          1,
          ...[...this.rows.entries()]
            .filter(([key]) => key.startsWith(`${providerKey}:`))
            .map(([, value]) => Number(value.priceBook?.version || 0) + 1),
        )
      : null
    const updated = {
      ...row,
      controlSource: 'database',
      desiredState: normalized.desiredState,
      canaryConsumerIds: normalized.canaryConsumerIds ?? [...row.canaryConsumerIds],
      releaseRevision,
      ...(promotedPricing ? {
        priceBook: {
          version: nextPriceBookVersion,
          source: 'database',
          status: 'reviewed',
          currency: promotedPricing.currency,
          pricingAsOf: promotedPricing.pricingAsOf,
          monthlyBudgetMinor: promotedPricing.monthlyBudgetMinor,
          monthlySubsidyBudgetMinor: promotedPricing.monthlySubsidyBudgetMinor,
          endpointPrices: promotedPricing.endpointPrices,
        },
      } : {}),
      revision: row.revision + 1,
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    }
    this.rows.set(`${providerKey}:${operationKey}`, updated)
    this.events.push({
      eventId: randomUUID(),
      providerKey,
      operationKey,
      previousRevision: previous.revision,
      revision: updated.revision,
      previousState: previous.desiredState,
      desiredState: updated.desiredState,
      canaryConsumerIds: [...updated.canaryConsumerIds],
      actor,
      reason: normalized.reason,
      occurredAt: updated.updatedAt,
    })
    return operationView(updated, definition, runtime)
  }

  async authorizeDispatch(providerKey, operationKey, runtime = {}) {
    const { row, definition } = this.#row(providerKey, operationKey)
    return dispatchSnapshot(providerKey, row, definition, runtime)
  }
}

function rowFromPostgres(row) {
  const endpointPrices = Object.fromEntries(Object.entries(row.endpoint_prices || {}).map(
    ([endpointKey, value]) => [
      endpointKey,
      databaseSafeInteger(value, `unit price for ${endpointKey}`, { minimum: 1 }),
    ],
  ))
  return {
    controlSource: row.control_source,
    desiredState: row.desired_state,
    canaryConsumerIds: row.canary_consumer_ids || [],
    revision: databaseSafeInteger(row.revision, 'policy revision'),
    releaseRevision: databaseSafeInteger(row.release_revision, 'release revision', { minimum: 1 }),
    releaseStatus: row.release_status,
    contractVersion: row.contract_version,
    endpointKeys: row.endpoint_keys || [],
    priceBook: {
      version: databaseSafeInteger(row.price_book_version, 'price-book version'),
      source: row.price_book_source,
      status: row.price_book_status,
      currency: row.currency,
      pricingAsOf: row.pricing_as_of == null ? null : new Date(row.pricing_as_of).toISOString(),
      monthlyBudgetMinor: databaseSafeInteger(
        row.monthly_budget_minor,
        'monthly budget',
        { nullable: true },
      ),
      monthlySubsidyBudgetMinor: databaseSafeInteger(
        row.monthly_subsidy_budget_minor,
        'monthly subsidy budget',
        { nullable: true },
      ),
      endpointPrices,
    },
    updatedBy: row.updated_by,
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
  }
}

const POLICY_SELECT = `
  SELECT policy.provider_key, policy.operation_key, policy.control_source,
         policy.desired_state, policy.canary_consumer_ids, policy.revision,
         policy.updated_by, policy.updated_at,
         release.release_revision, release.status AS release_status,
         release.contract_version, release.endpoint_keys,
         price.version AS price_book_version, price.source AS price_book_source,
         price.status AS price_book_status, price.currency, price.pricing_as_of,
         price.monthly_budget_minor, price.monthly_subsidy_budget_minor,
         COALESCE(
           jsonb_object_agg(entry.endpoint_key, entry.unit_cost_minor)
             FILTER (WHERE entry.endpoint_key IS NOT NULL),
           '{}'::jsonb
         ) AS endpoint_prices
    FROM control.external_platform_operation_policies policy
    JOIN control.external_platform_operation_releases release
      ON release.provider_key = policy.provider_key
     AND release.operation_key = policy.operation_key
     AND release.release_revision = policy.release_revision
    JOIN control.external_platform_provider_price_books price
      ON price.provider_key = release.provider_key
     AND price.version = release.price_book_version
    LEFT JOIN control.external_platform_provider_price_book_entries entry
      ON entry.provider_key = price.provider_key
     AND entry.price_book_version = price.version
`

const POLICY_GROUP = `
  GROUP BY policy.provider_key, policy.operation_key, policy.control_source,
           policy.desired_state, policy.canary_consumer_ids, policy.revision,
           policy.updated_by, policy.updated_at, release.release_revision,
           release.status, release.contract_version, release.endpoint_keys,
           price.version, price.source, price.status, price.currency,
           price.pricing_as_of, price.monthly_budget_minor,
           price.monthly_subsidy_budget_minor
`

export class PostgresExternalPlatformControlStore {
  constructor({ pool }) {
    this.pool = pool
  }

  async #row(providerKey, operationKey, executor = this.pool) {
    definitionFor(providerKey, operationKey)
    try {
      const { rows } = await executor.query(
        `${POLICY_SELECT}
          WHERE policy.provider_key = $1 AND policy.operation_key = $2
          ${POLICY_GROUP}`,
        [providerKey, operationKey],
      )
      if (!rows[0]) throw unavailable()
      return rowFromPostgres(rows[0])
    } catch (error) {
      if (error instanceof AppError) throw error
      throw unavailable()
    }
  }

  async describeProvider(providerKey, runtime = {}) {
    const definitions = catalogFor(providerKey)
    try {
      const { rows } = await this.pool.query(
        `${POLICY_SELECT}
          WHERE policy.provider_key = $1
          ${POLICY_GROUP}
          ORDER BY policy.operation_key`,
        [providerKey],
      )
      const byOperation = new Map(rows.map((row) => [row.operation_key, rowFromPostgres(row)]))
      return definitions.map((definition) => {
        const row = byOperation.get(definition.operationKey)
        if (!row) throw unavailable()
        return operationView(row, definition, runtime)
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      throw unavailable()
    }
  }

  async updatePolicy(providerKey, operationKey, input, { actor = 'admin-token', runtime = {} } = {}) {
    const definition = definitionFor(providerKey, operationKey)
    const normalized = normalizeUpdate(input, definition)
    let client
    try {
      client = await this.pool.connect()
      let committed = false
      let commitStarted = false
      let releaseError = null
      try {
        await client.query('BEGIN')
        const currentResult = await client.query(
          `SELECT control_source, desired_state, canary_consumer_ids, revision
             FROM control.external_platform_operation_policies
            WHERE provider_key = $1 AND operation_key = $2
            FOR UPDATE`,
          [providerKey, operationKey],
        )
        const current = currentResult.rows[0]
        if (!current) throw unavailable()
        const currentRevision = databaseSafeInteger(current.revision, 'policy revision')
        if (currentRevision !== normalized.expectedRevision) {
          throw revisionConflict(normalized.expectedRevision, currentRevision)
        }
        const currentFull = await this.#row(providerKey, operationKey, client)
        const promotedPricing = priceBookForUpdate(currentFull, definition, normalized, runtime)
        let releaseRevision = currentFull.releaseRevision
        if (promotedPricing) {
          await client.query(
            'LOCK TABLE control.external_platform_provider_price_books IN SHARE ROW EXCLUSIVE MODE',
          )
          const versionResult = await client.query(
            `SELECT COALESCE(MAX(version), 0) + 1 AS version
               FROM control.external_platform_provider_price_books
              WHERE provider_key = $1`,
            [providerKey],
          )
          const priceBookVersion = databaseSafeInteger(
            versionResult.rows[0]?.version,
            'next price-book version',
            { minimum: 1 },
          )
          await client.query(
            `INSERT INTO control.external_platform_provider_price_books
               (provider_key, version, source, status, currency, pricing_as_of,
                monthly_budget_minor, monthly_subsidy_budget_minor,
                reviewed_by, reviewed_at)
             VALUES ($1, $2, 'database', 'reviewed', $3, $4, $5, $6, $7, now())`,
            [
              providerKey, priceBookVersion, promotedPricing.currency,
              promotedPricing.pricingAsOf, promotedPricing.monthlyBudgetMinor,
              promotedPricing.monthlySubsidyBudgetMinor, actor,
            ],
          )
          for (const endpointKey of definition.endpointKeys) {
            await client.query(
              `INSERT INTO control.external_platform_provider_price_book_entries
                 (provider_key, price_book_version, endpoint_key, unit_cost_minor)
               VALUES ($1, $2, $3, $4)`,
              [providerKey, priceBookVersion, endpointKey, promotedPricing.endpointPrices[endpointKey]],
            )
          }
          const releaseResult = await client.query(
            `SELECT COALESCE(MAX(release_revision), 0) + 1 AS release_revision
               FROM control.external_platform_operation_releases
              WHERE provider_key = $1 AND operation_key = $2`,
            [providerKey, operationKey],
          )
          releaseRevision = databaseSafeInteger(
            releaseResult.rows[0]?.release_revision,
            'next release revision',
            { minimum: 1 },
          )
          await client.query(
            `INSERT INTO control.external_platform_operation_releases
               (provider_key, operation_key, release_revision, contract_version,
                endpoint_keys, price_book_version, status, created_by)
             VALUES ($1, $2, $3, $4, $5::text[], $6, 'released', $7)`,
            [
              providerKey, operationKey, releaseRevision, currentFull.contractVersion,
              currentFull.endpointKeys, priceBookVersion, actor,
            ],
          )
        }
        const canaryConsumerIds = normalized.canaryConsumerIds ?? current.canary_consumer_ids ?? []
        const updatedResult = await client.query(
          `UPDATE control.external_platform_operation_policies
              SET control_source = 'database',
                  desired_state = $3,
                  canary_consumer_ids = $4::uuid[],
                  release_revision = $5,
                  revision = revision + 1,
                  updated_by = $6,
                  updated_at = now()
            WHERE provider_key = $1 AND operation_key = $2 AND revision = $7
          RETURNING revision`,
          [
            providerKey, operationKey, normalized.desiredState, canaryConsumerIds,
            releaseRevision, actor, currentRevision,
          ],
        )
        if (!updatedResult.rows[0]) throw revisionConflict(currentRevision, currentRevision + 1)
        const nextRevision = databaseSafeInteger(
          updatedResult.rows[0].revision,
          'updated policy revision',
        )
        await client.query(
          `INSERT INTO control.external_platform_operation_policy_events
             (event_id, provider_key, operation_key, previous_revision, revision,
              previous_state, desired_state, canary_consumer_ids, actor, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10)`,
          [
            randomUUID(), providerKey, operationKey, currentRevision, nextRevision,
            current.desired_state, normalized.desiredState, canaryConsumerIds, actor, normalized.reason,
          ],
        )
        commitStarted = true
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        if (commitStarted && !committed) releaseError = error
        else {
          releaseError = await client.query('ROLLBACK').then(() => null, (rollbackError) => rollbackError)
        }
        throw error
      } finally {
        client.release(releaseError)
      }
      return operationView(
        await this.#row(providerKey, operationKey),
        definition,
        runtime,
      )
    } catch (error) {
      if (error instanceof AppError) throw error
      throw unavailable()
    }
  }

  async authorizeDispatch(providerKey, operationKey, runtime = {}) {
    const definition = definitionFor(providerKey, operationKey)
    const row = await this.#row(providerKey, operationKey)
    return dispatchSnapshot(providerKey, row, definition, runtime)
  }
}

export function createExternalPlatformControlStore({ pool = null } = {}) {
  return pool
    ? new PostgresExternalPlatformControlStore({ pool })
    : new MemoryExternalPlatformControlStore()
}
