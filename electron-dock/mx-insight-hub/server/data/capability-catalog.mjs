import { createHash } from 'node:crypto'
import { implementedRoutes } from './source-connections.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../external-platforms/control-store.mjs'
import { PRODUCT_BUNDLES } from '../../shared/product-catalog.mjs'
import { BILLING_FEATURES } from '../../shared/billing-composition.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Inventory only; never use a metadata row as permission to dispatch.
export function capabilityCatalog(sources = []) {
  const routes = implementedRoutes(sources)
  const entries = [
    ...routes.map(row => ({ id: `route:${row.id}`, kind: 'route', definition: row })),
    ...Object.entries(EXTERNAL_PLATFORM_OPERATION_CATALOG).flatMap(([provider, operations]) => operations.map(row => ({
      id: `connector:${provider}:${row.operationKey}`, kind: 'connector', definition: {
        provider, operation: row.operationKey, label: row.label, contractVersion: row.contractVersion,
        endpointKeys: [...row.endpointKeys], dispatchBlock: row.dispatchBlock || null,
      },
    }))),
    ...PRODUCT_BUNDLES.map(product => ({ id: `product:${product.key}`, kind: 'product', definition: {
      ...product, pricing: BILLING_FEATURES.find(feature => feature.key === product.featureKey),
    } })),
  ].sort((a, b) => a.id.localeCompare(b.id))
  const issues = []
  const ids = new Set()
  for (const row of entries) {
    if (ids.has(row.id)) issues.push({ id: row.id, code: 'duplicate_id' })
    ids.add(row.id)
    row.hash = hash(row.definition)
  }
  for (const product of PRODUCT_BUNDLES) {
    const feature = BILLING_FEATURES.find(row => row.key === product.featureKey)
    if (!feature) issues.push({ id: product.key, code: 'missing_price_template' })
    for (const capability of product.capabilities) {
      if (!routes.some(row => row.operation === capability)) issues.push({ id: `${product.key}:${capability}`, code: 'missing_route' })
    }
  }
  return { contractVersion: 'mx-insight-hub.capability-catalog.v1', hash: hash(entries), entries, issues,
    summary: { entries: entries.length, routes: routes.length, connectors: entries.filter(row => row.kind === 'connector').length, products: PRODUCT_BUNDLES.length } }
}

export function catalogDifference(snapshot, persisted = []) {
  const prior = new Map(persisted.map(row => [row.id, row]))
  const active = new Set(snapshot.entries.map(row => row.id))
  return [
    ...snapshot.entries.filter(row => prior.get(row.id)?.hash !== row.hash || prior.get(row.id)?.status !== 'registered')
      .map(row => ({ id: row.id, action: prior.has(row.id) ? 'update' : 'register', hash: row.hash })),
    ...persisted.filter(row => row.status !== 'retired' && !active.has(row.id)).map(row => ({ id: row.id, action: 'retire', hash: row.hash })),
  ]
}

export async function syncCapabilityCatalog(client, { dryRun = true, sources = null } = {}) {
  sources ??= (await client.query('SELECT source_key AS "sourceKey" FROM catalog.external_sources')).rows
  const snapshot = capabilityCatalog(sources)
  if (snapshot.issues.length) throw new Error(`Capability catalog validation failed: ${JSON.stringify(snapshot.issues)}`)
  let rows = [], migrationRequired = false
  try { ({ rows } = await client.query('SELECT id, definition_hash AS hash, status FROM control.capability_inventory')) }
  catch (error) {
    if (!dryRun || error.code !== '42P01') throw error
    migrationRequired = true
  }
  const differences = catalogDifference(snapshot, rows)
  if (!dryRun) {
    // Caller owns the migration transaction and advisory lock. This writes ONLY
    // generated inventory: no accounts, keys, grants, prices, policies or ledger.
    for (const row of snapshot.entries) await client.query(
      `INSERT INTO control.capability_inventory (id, kind, definition, definition_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET
       definition = excluded.definition, definition_hash = excluded.definition_hash,
       status = 'registered', revision = control.capability_inventory.revision + 1, updated_at = now()
       WHERE control.capability_inventory.definition_hash IS DISTINCT FROM excluded.definition_hash
          OR control.capability_inventory.status <> 'registered'`, [row.id, row.kind, row.definition, row.hash])
    await client.query(`UPDATE control.capability_inventory SET status = 'retired', revision = revision + 1, updated_at = now()
      WHERE NOT (id = ANY($1::text[])) AND status <> 'retired'`, [snapshot.entries.map(row => row.id)])
  }
  return { ...snapshot, differences, dryRun, migrationRequired }
}
