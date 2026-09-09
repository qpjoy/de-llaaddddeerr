const HIDDEN_PROVIDER_IDENTITY = /tik[\s._-]*hub/iu

function compactFieldKey(value) {
  return String(value || '').normalize('NFKC').replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function isPrivateDataCenterField(key) {
  const compact = compactFieldKey(key)
  return compact.includes('provider')
    || compact.includes('connector')
    || compact.includes('archivepath')
    || compact === 'raw'
    || compact.startsWith('raw')
    || compact.includes('rawpayload')
    || compact.includes('rawenvelope')
}

export const HIDDEN_PROVIDER_LABEL = '上游接入（已隐藏）'

export function containsHiddenProviderIdentity(value) {
  return typeof value === 'string'
    && HIDDEN_PROVIDER_IDENTITY.test(value.normalize('NFKC'))
}

/**
 * Presentation-only safety net for Admin UI responses. The authoritative
 * source-catalog record remains unchanged and available from the raw
 * Admin-token API.
 */
export function sourceCatalogVisibleProjection(value) {
  if (typeof value === 'string') {
    return containsHiddenProviderIdentity(value) ? HIDDEN_PROVIDER_LABEL : value
  }
  if (Array.isArray(value)) return value.map(sourceCatalogVisibleProjection)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !containsHiddenProviderIdentity(key))
      .map(([key, child]) => [key, sourceCatalogVisibleProjection(child)]),
  )
}

/**
 * Presentation-only projection for the Data Center renderer. The raw
 * Admin-token API deliberately retains complete acquisition lineage, while a
 * browser response must not expose supplier identity, connector coordinates,
 * archive paths or raw envelopes. Apply this recursively because those fields
 * also occur inside stableFields, extensions and observation lineage.
 */
export function dataCenterVisibleProjection(value) {
  if (typeof value === 'string') {
    return containsHiddenProviderIdentity(value) ? HIDDEN_PROVIDER_LABEL : value
  }
  if (Array.isArray(value)) return value.map(dataCenterVisibleProjection)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => (
        !containsHiddenProviderIdentity(key) && !isPrivateDataCenterField(key)
      ))
      .map(([key, child]) => [key, dataCenterVisibleProjection(child)]),
  )
}
