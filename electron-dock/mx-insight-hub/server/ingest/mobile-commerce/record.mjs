import { SOURCE_CATALOG_SEED } from '../../data/source-catalog-seed.mjs'
import {
  MOBILE_COMMERCE_SOURCE_KEY,
} from './source-contract.mjs'

const COMMERCE_CATEGORY = '国内电商与本地生活'

function normalizedLabel(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
}

const REVIEWED_CONTEXT_ALIASES = new Map([
  ['抖音', 'source-catalog-0062'],
  ['抖音小店', 'source-catalog-0062'],
  ['快手', 'source-catalog-0063'],
  ['快手小店', 'source-catalog-0063'],
].map(([label, sourceKey]) => [normalizedLabel(label), sourceKey]))

function marketplaceView(entry) {
  return Object.freeze({
    status: 'mapped',
    entryId: entry.id,
    sourceKey: entry.sourceKey,
    revision: entry.revision,
    canonicalName: entry.canonicalName,
    majorCategory: entry.majorCategory,
    scenarios: [...(entry.scenarios || [])],
    regions: [...(entry.regions || [])],
  })
}

export function createMobileMarketplaceClassifier(entries = SOURCE_CATALOG_SEED) {
  const result = new Map()
  const bySourceKey = new Map()
  for (const entry of entries || []) {
    if (entry.majorCategory !== COMMERCE_CATEGORY || entry.archivedAt) continue
    bySourceKey.set(entry.sourceKey, entry)
    for (const label of [entry.canonicalName, ...(entry.aliases || [])]) {
      const normalized = normalizedLabel(label)
      if (!normalized || result.has(normalized)) continue
      result.set(normalized, marketplaceView(entry))
    }
  }
  // These source-context aliases are part of the reviewed fixed contract, but
  // only resolve when their governed target still exists and is not archived.
  for (const [label, sourceKey] of REVIEWED_CONTEXT_ALIASES) {
    const target = bySourceKey.get(sourceKey)
    if (target) result.set(label, marketplaceView(target))
  }
  return (value) => {
    const sourceValue = optionalValue(value)
    const matched = result.get(normalizedLabel(sourceValue))
    return matched
      ? { ...matched, sourceValue }
      : {
          status: 'unmapped',
          sourceValue,
          entryId: null,
          sourceKey: null,
          revision: null,
          canonicalName: null,
          majorCategory: null,
          scenarios: [],
          regions: [],
        }
  }
}

const DEFAULT_MARKETPLACE_CLASSIFIER = createMobileMarketplaceClassifier()

function optionalValue(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function normalizedMetadata(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizedTagList(value) {
  const text = optionalValue(value)
  if (!text) return []
  return [...new Set(text.split(/[;,，、]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 50)
}

export function classifyMobileMarketplace(value) {
  return DEFAULT_MARKETPLACE_CLASSIFIER(value)
}

/**
 * Add the fixed mobile-commerce business contract after declarative mapping.
 *
 * The canonical top-level platform remains `mobile_commerce`, which is the
 * authorization boundary.  The row's marketplace is a governed catalog facet,
 * not a public grant and not a product category.  Named-but-ambiguous source
 * fields are preserved as source labels instead of being promoted to claims
 * such as a normalized brand or verified URL.
 */
export function enrichMobileCommerceRecord(record, raw, source, {
  classifyMarketplace = DEFAULT_MARKETPLACE_CLASSIFIER,
} = {}) {
  if (source?.sourceKey !== MOBILE_COMMERCE_SOURCE_KEY || !record) return record
  const marketplace = classifyMarketplace(raw?.platform)
  const goodsId = optionalValue(raw?.goods_id)
  const commerce = {
    contractVersion: 'mx-insight-hub.mobile-commerce-capture.v1',
    captureId: optionalValue(raw?.id),
    task: {
      id: optionalValue(raw?.task_id),
      keyword: optionalValue(raw?.keyword),
      // The sample's `brand` values look like monitoring campaign labels. Keep
      // the source name without asserting that it is a normalized brand.
      sourceBrandLabel: optionalValue(raw?.brand),
    },
    product: {
      goodsId,
      title: optionalValue(raw?.title),
      shareText: optionalValue(raw?.product_link),
      price: optionalValue(raw?.price),
      resolution: goodsId ? 'source-goods-id' : 'capture-only',
    },
    shop: {
      id: optionalValue(raw?.shop_id),
      name: optionalValue(raw?.shop_name),
      shareText: optionalValue(raw?.shop_link),
      level: optionalValue(raw?.shop_level),
      fans: optionalValue(raw?.shop_fans),
      reputation: optionalValue(raw?.shop_reputation),
    },
    signals: {
      sales: optionalValue(raw?.sales),
      shipFrom: optionalValue(raw?.ship_from),
      commentCount: optionalValue(raw?.comment_count),
      goodRate: optionalValue(raw?.good_rate),
      tagsText: optionalValue(raw?.tags),
    },
    marketplace,
    // Parsed only for internal typed storage. Dedicated public projections do
    // not expose arbitrary metadata keys.
    metadata: normalizedMetadata(raw?.metadata_json),
  }
  record.stableFields = {
    ...(record.stableFields || {}),
    attributes: {
      ...(record.stableFields?.attributes || {}),
      sourcePlatform: optionalValue(raw?.platform),
      sourceCatalogEntryId: marketplace.entryId,
      sourceCatalogSourceKey: marketplace.sourceKey,
      sourceCatalogMappingStatus: marketplace.status,
    },
    commerce,
    tags: normalizedTagList(raw?.tags),
  }
  return record
}
