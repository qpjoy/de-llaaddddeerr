import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizePriceBook } from './control-store.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = message => { throw new AppError(400, 'invalid_request', message) }

async function metadata(store, provider) {
  if (!store.pool) return store.pricingTemplates?.get(provider) || { templates: [], bindings: [] }
  const [templates, bindings] = await Promise.all([
    store.pool.query(`SELECT version, spec_hash AS hash, specification AS spec, reason, created_at AS "createdAt"
      FROM control.external_platform_pricing_templates WHERE provider_key = $1 ORDER BY version DESC LIMIT 50`, [provider]),
    store.pool.query(`SELECT operation_key AS "operationKey", template_version AS version, operation_revision AS revision
      FROM control.external_platform_pricing_bindings WHERE provider_key = $1`, [provider]),
  ])
  return { templates: templates.rows, bindings: bindings.rows.map(row => ({ ...row, revision: Number(row.revision) })) }
}

async function saveTemplate(store, provider, spec, reason) {
  const digest = hash(spec)
  if (!store.pool) {
    store.pricingTemplates ||= new Map()
    if (!store.pricingTemplates.has(provider)) store.pricingTemplates.set(provider, { templates: [], bindings: [] })
    const value = store.pricingTemplates.get(provider)
    let row = value.templates.find(row => row.hash === digest)
    if (!row) { row = { version: (value.templates[0]?.version || 0) + 1, hash: digest, spec, reason, createdAt: new Date().toISOString() }; value.templates.unshift(row) }
    return row
  }
  const client = await store.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider-pricing-template:${provider}`])
    const existing = await client.query(`SELECT version FROM control.external_platform_pricing_templates WHERE provider_key=$1 AND spec_hash=$2`, [provider, digest])
    const row = existing.rows[0] || (await client.query(`INSERT INTO control.external_platform_pricing_templates
      (provider_key, version, spec_hash, specification, reason)
      SELECT $1, coalesce(max(version),0)+1, $2, $3, $4 FROM control.external_platform_pricing_templates WHERE provider_key=$1 RETURNING version`, [provider, digest, spec, reason])).rows[0]
    await client.query('COMMIT')
    return { ...row, spec, hash: digest }
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

async function bind(store, provider, operationKey, version, revision) {
  if (store.pool) await store.pool.query(`INSERT INTO control.external_platform_pricing_bindings (provider_key,operation_key,template_version,operation_revision)
    VALUES ($1,$2,$3,$4) ON CONFLICT (provider_key,operation_key) DO UPDATE SET template_version=excluded.template_version,operation_revision=excluded.operation_revision`, [provider, operationKey, version, revision])
  else {
    const data = store.pricingTemplates.get(provider)
    data.bindings = [...data.bindings.filter(row => row.operationKey !== operationKey), { operationKey, version, revision }]
  }
}

export async function providerPricingTemplate(store, provider, operations, input, runtime) {
  const current = await metadata(store, provider)
  if (input == null) return current
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('JSON object is required')
  const allowed = ['currency', 'pricingAsOf', 'unitCostMinor', 'monthlyBudgetMinor', 'monthlySubsidyBudgetMinor', 'reason', 'operationKeys', 'overrideExisting', 'dryRun', 'previewToken']
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid('Unsupported pricing template field')
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) invalid('reason is required (max 1000)')
  if (!Number.isSafeInteger(input.unitCostMinor) || input.unitCostMinor <= 0) invalid('unitCostMinor must be a positive safe integer')
  if (!Array.isArray(input.operationKeys) || !input.operationKeys.length || input.operationKeys.some(key => !operations.some(op => op.operationKey === key))) invalid('Select reviewed operationKeys')
  if (input.overrideExisting != null && (!Array.isArray(input.overrideExisting) || input.overrideExisting.some(key => !input.operationKeys.includes(key)))) invalid('overrideExisting must be selected operation keys')
  const selected = new Set(input.operationKeys), overrides = new Set(input.overrideExisting || [])
  const rows = operations.filter(op => selected.has(op.operationKey)).map(op => {
    const binding = current.bindings.find(row => row.operationKey === op.operationKey)
    const inherited = binding?.revision === op.revision
    const existing = Object.values(op.priceBook.endpointPrices || {}).some(value => Number.isSafeInteger(value) && value >= 0)
    const action = existing && !inherited && !overrides.has(op.operationKey) ? 'preserve' : 'apply'
    const priceBook = { currency: input.currency, pricingAsOf: input.pricingAsOf,
      monthlyBudgetMinor: input.monthlyBudgetMinor, monthlySubsidyBudgetMinor: input.monthlySubsidyBudgetMinor,
      unitCostMinorByEndpoint: Object.fromEntries(op.release.endpointKeys.map(key => [key, input.unitCostMinor])),
    }
    normalizePriceBook(priceBook, { endpointKeys: op.release.endpointKeys })
    return { operationKey: op.operationKey, label: op.label, revision: op.revision, desiredState: op.desiredState,
      action, inherited, previous: op.priceBook, priceBook, contractVersion: op.release.contractVersion,
      canaryConsumerIds: op.canaryConsumerIds }
  }).sort((a, b) => a.operationKey.localeCompare(b.operationKey))
  const spec = { currency: input.currency, pricingAsOf: input.pricingAsOf, unitCostMinor: input.unitCostMinor,
    monthlyBudgetMinor: input.monthlyBudgetMinor, monthlySubsidyBudgetMinor: input.monthlySubsidyBudgetMinor,
    operations: rows.filter(row => row.action === 'apply').map(row => ({ operationKey: row.operationKey, contractVersion: row.contractVersion, endpointKeys: Object.keys(row.priceBook.unitCostMinorByEndpoint) })) }
  const previewToken = hash({ spec, rows, reason: input.reason.trim() })
  if (input.dryRun === true) return { rows, previewToken, spec, dryRun: true }
  if (input.previewToken !== previewToken) throw new AppError(409, 'pricing_preview_changed', '配置或操作版本已变化，请重新预览后提交')
  const targets = rows.filter(row => row.action === 'apply')
  if (!targets.length) return { applied: [], skipped: rows.map(row => ({ operationKey: row.operationKey, reason: 'existing_exception_preserved' })), templateVersion: null }
  const template = await saveTemplate(store, provider, spec, input.reason.trim())
  const applied = [], skipped = []
  for (const row of rows) {
    if (row.action === 'preserve') { skipped.push({ operationKey: row.operationKey, reason: 'existing_exception_preserved' }); continue }
    let priceApplied = false
    try {
      const next = await store.updatePolicy(provider, row.operationKey, { expectedRevision: row.revision, desiredState: row.desiredState,
        canaryConsumerIds: row.canaryConsumerIds, priceBook: row.priceBook, reason: `基础方案 v${template.version}：${input.reason.trim()}`.slice(0, 1000),
      }, { actor: 'admin-token', runtime })
      applied.push({ operationKey: row.operationKey, revision: next.revision })
      priceApplied = true
      await bind(store, provider, row.operationKey, template.version, next.revision)
    } catch (error) { skipped.push({ operationKey: row.operationKey, reason: priceApplied ? 'price_applied_binding_failed' : error.code || 'apply_failed' }) }
  }
  return { templateVersion: template.version, applied, skipped }
}
