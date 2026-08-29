import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { AppError } from '../core/errors.mjs'

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CONSUMER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
const KINDS = new Set(['chat', 'embedding'])
const EGRESS_MODES = new Set(['inherit', 'system-egress', 'proxy-sequence'])
const MAX_SEQUENCE_PROVIDERS = 32
const MAX_PROXY_ENDPOINTS = 16

function invalid(code, message) {
  throw new AppError(400, code, message)
}

function assertKind(kind) {
  if (!KINDS.has(kind)) invalid('invalid_agent_sequence', 'kind must be chat or embedding')
  return kind
}

function assertKey(value, field = 'key') {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    invalid('invalid_agent_sequence', `${field} must be a lowercase identifier`)
  }
  return value
}

function normalizedName(value, field = 'displayName') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    invalid('invalid_agent_sequence', `${field} must be a non-empty string of at most 120 characters`)
  }
  return value.trim()
}

function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    invalid('invalid_agent_sequence', 'expectedRevision must be a non-negative integer')
  }
  return value
}

function uniqueKeys(values, { field, minimum = 0, maximum }) {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
    invalid('invalid_agent_sequence', `${field} must contain ${minimum}-${maximum} identifiers`)
  }
  const normalized = values.map((value) => assertKey(value, field))
  if (new Set(normalized).size !== normalized.length) {
    invalid('invalid_agent_sequence', `${field} must not contain duplicates`)
  }
  return normalized
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null
}

function sequenceRow(row) {
  const proxySequenceKey = row.proxy_sequence_key ?? null
  return {
    sequenceKey: row.sequence_key,
    displayName: row.display_name,
    kind: row.kind,
    providerIds: row.provider_ids || [],
    enabled: row.enabled !== false,
    source: row.source,
    egressMode: row.egress_mode || (proxySequenceKey ? 'proxy-sequence' : 'inherit'),
    proxySequenceKey,
    providerRevision: Number(row.provider_revision),
    verifiedProxyFingerprint: row.verified_proxy_fingerprint ?? null,
    revision: Number(row.revision),
    verifiedAt: iso(row.verified_at),
    verifiedBy: row.verified_by ?? null,
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function normalizedEgressMode(value, proxySequenceKey, field = 'egressMode') {
  const inferred = value == null
    ? (proxySequenceKey ? 'proxy-sequence' : 'inherit')
    : value
  if (!EGRESS_MODES.has(inferred)) {
    invalid('invalid_agent_proxy', `${field} must be inherit, system-egress, or proxy-sequence`)
  }
  if (inferred === 'proxy-sequence' && !proxySequenceKey) {
    invalid('invalid_agent_proxy', `${field}=proxy-sequence requires a Proxy Sequence`)
  }
  if (inferred !== 'proxy-sequence' && proxySequenceKey) {
    invalid('invalid_agent_proxy', `${field}=${inferred} cannot select a Proxy Sequence`)
  }
  return inferred
}

export function egressRouteOverride(egressMode, proxySequenceKey = null) {
  const mode = normalizedEgressMode(egressMode, proxySequenceKey)
  if (mode === 'inherit') return undefined
  if (mode === 'system-egress') return null
  return proxySequenceKey
}

function bindingRow(row) {
  return {
    consumerKey: row.consumer_key,
    kind: row.kind,
    sequenceKey: row.sequence_key,
    revision: Number(row.revision),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function proxyEndpointRow(row) {
  return {
    proxyKey: row.proxy_key,
    displayName: row.display_name,
    proxyUrl: row.proxy_url,
    enabled: row.enabled !== false,
    revision: Number(row.revision),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function proxySequenceRow(row) {
  return {
    sequenceKey: row.sequence_key,
    displayName: row.display_name,
    proxyKeys: row.proxy_keys || [],
    directFallback: row.direct_fallback === true,
    enabled: row.enabled !== false,
    revision: Number(row.revision),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function proxyPolicyRow(row = {}) {
  const sequenceKey = row.global_sequence_key ?? null
  return {
    egressMode: row.egress_mode || (sequenceKey ? 'proxy-sequence' : 'inherit'),
    sequenceKey,
    globalSequenceKey: sequenceKey,
    revision: Number(row.revision ?? 0),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function normalizedNoProxyEntries(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function splitNoProxyHostPort(entry) {
  if (entry.startsWith('[')) {
    const closing = entry.indexOf(']')
    if (closing < 0) return { host: '', port: '' }
    const suffix = entry.slice(closing + 1)
    if (suffix && !/^:\d+$/.test(suffix)) return { host: '', port: '' }
    return { host: entry.slice(1, closing), port: suffix ? suffix.slice(1) : '' }
  }
  const colonCount = [...entry].filter((character) => character === ':').length
  if (colonCount === 1) {
    const separator = entry.lastIndexOf(':')
    const possiblePort = entry.slice(separator + 1)
    if (/^\d+$/.test(possiblePort)) {
      return { host: entry.slice(0, separator), port: possiblePort }
    }
  }
  return { host: entry, port: '' }
}

function ipBytes(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '').split('%', 1)[0]
  const family = isIP(host)
  if (family === 4) return { family, bytes: host.split('.').map(Number) }
  if (family !== 6) return null
  const halves = host.split('::')
  if (halves.length > 2) return null
  const parseHalf = (half) => {
    if (!half) return []
    const groups = half.split(':')
    const last = groups.at(-1)
    if (last?.includes('.')) {
      const ipv4 = ipBytes(last)
      if (!ipv4 || ipv4.family !== 4) return null
      groups.splice(-1, 1,
        ((ipv4.bytes[0] << 8) | ipv4.bytes[1]).toString(16),
        ((ipv4.bytes[2] << 8) | ipv4.bytes[3]).toString(16))
    }
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null
    return groups.map((group) => Number.parseInt(group, 16))
  }
  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] || '')
  if (!left || !right) return null
  const omitted = 8 - left.length - right.length
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null
  const groups = [...left, ...Array(omitted).fill(0), ...right]
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff])
  if (bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { family: 4, bytes: bytes.slice(12) }
  }
  return { family, bytes }
}

function cidrMatches(host, entry) {
  const separator = entry.lastIndexOf('/')
  if (separator <= 0) return false
  const network = ipBytes(entry.slice(0, separator))
  const target = ipBytes(host)
  const bits = Number(entry.slice(separator + 1))
  if (!network || !target || network.family !== target.family
    || !Number.isInteger(bits) || bits < 0 || bits > network.bytes.length * 8) return false
  const fullBytes = Math.floor(bits / 8)
  const remainingBits = bits % 8
  for (let index = 0; index < fullBytes; index += 1) {
    if (network.bytes[index] !== target.bytes[index]) return false
  }
  if (remainingBits === 0) return true
  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (network.bytes[fullBytes] & mask) === (target.bytes[fullBytes] & mask)
}

function loopbackHost(host) {
  if (host === 'localhost') return true
  const parsed = ipBytes(host)
  if (!parsed) return false
  return parsed.family === 4
    ? parsed.bytes[0] === 127
    : parsed.bytes.slice(0, 15).every((byte) => byte === 0) && parsed.bytes[15] === 1
}

function noProxyMatches(target, value) {
  let url
  try { url = new URL(target) } catch { return false }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (loopbackHost(hostname)) return true
  if (!value) return false
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '')
  const targetIp = ipBytes(hostname)
  for (const entry of normalizedNoProxyEntries(value)) {
    if (entry === '*') return true
    if (cidrMatches(hostname, entry)) return true
    const { host: rawHost, port: entryPort } = splitNoProxyHostPort(entry)
    if (!rawHost) continue
    if (entryPort && entryPort !== port) continue
    const entryIp = ipBytes(rawHost)
    if (targetIp || entryIp) {
      if (targetIp && entryIp
        && targetIp.family === entryIp.family
        && targetIp.bytes.every((byte, index) => byte === entryIp.bytes[index])) return true
      continue
    }
    const wildcard = rawHost.startsWith('*.')
    const leadingDot = wildcard || rawHost.startsWith('.')
    const rawDomain = rawHost.replace(/^\*?\./, '')
    const domain = domainToASCII(rawDomain) || rawDomain
    if (!domain || domain.includes('://')) continue
    if (hostname.endsWith(`.${domain}`) || (!leadingDot && hostname === domain)) return true
  }
  return false
}

function deploymentEgressRoute(provider, deploymentEgress) {
  const target = provider?.baseUrl || ''
  const protocol = (() => {
    try { return new URL(target).protocol } catch { return null }
  })()
  const noProxyMatched = noProxyMatches(target, deploymentEgress?.noProxy)
  const proxyUrl = noProxyMatched
    ? null
    : protocol === 'https:'
      ? deploymentEgress?.httpsProxy || deploymentEgress?.httpProxy || null
      : protocol === 'http:'
        ? deploymentEgress?.httpProxy || null
        : null
  if (!proxyUrl) {
    return {
      proxyUrls: [],
      directFallback: true,
      source: noProxyMatched ? 'docker-no-proxy' : 'system',
      fingerprintRoute: {
        mode: 'system-egress',
        ...(noProxyMatched ? { inheritedFrom: 'docker-no-proxy', noProxyMatched: true } : {}),
      },
    }
  }
  return {
    proxyUrls: [proxyUrl],
    directFallback: false,
    source: 'docker-daemon',
    fingerprintRoute: {
      mode: 'docker-daemon-proxy',
      protocol,
      proxyUrl,
      noProxyMatched: false,
    },
  }
}

function redactedProxyUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    // Public control evidence must not contain URL userinfo, even masked.
    url.username = ''
    url.password = ''
    return url.toString().replace(/\/$/, '')
  } catch { return null }
}

function proxyHasCredentials(value) {
  if (!value) return false
  try {
    const url = new URL(value)
    return Boolean(url.username || url.password)
  } catch { return false }
}

function publicDeploymentEgress(deploymentEgress = {}) {
  return {
    version: Number(deploymentEgress.version ?? 1),
    configured: deploymentEgress.configured === true,
    sourceKind: deploymentEgress.sourceKind ?? null,
    runtimeKind: deploymentEgress.runtimeKind ?? null,
    httpProxy: redactedProxyUrl(deploymentEgress.httpProxy),
    httpsProxy: redactedProxyUrl(deploymentEgress.httpsProxy),
    noProxy: deploymentEgress.noProxy ?? null,
    sourceLocations: Array.isArray(deploymentEgress.sourceLocations)
      ? [...deploymentEgress.sourceLocations]
      : [],
    nodeName: deploymentEgress.nodeName ?? null,
    observedAt: deploymentEgress.observedAt ?? null,
    httpProxyCredentials: proxyHasCredentials(deploymentEgress.httpProxy),
    httpsProxyCredentials: proxyHasCredentials(deploymentEgress.httpsProxy),
  }
}

function routeFingerprint(route) {
  return createHash('sha256').update(JSON.stringify(route)).digest('hex')
}

export function resolveProviderProxyRoute(provider, control, routeOverride = undefined) {
  const globalSequenceKey = control?.globalProxySequenceKey ?? control?.proxyPolicy?.sequenceKey ?? null
  const globalEgressMode = control?.globalEgressMode
    || control?.proxyPolicy?.egressMode
    || (globalSequenceKey ? 'proxy-sequence' : 'inherit')
  const source = routeOverride !== undefined
    ? (routeOverride == null ? 'system' : 'override')
    : provider?.proxySequenceKey
      ? 'provider'
      : globalEgressMode === 'proxy-sequence'
        ? 'global'
        : globalEgressMode === 'system-egress'
          ? 'global-system'
          : null
  const sequenceKey = routeOverride !== undefined
    ? routeOverride
    : provider?.proxySequenceKey
      || (globalEgressMode === 'proxy-sequence' ? globalSequenceKey : null)
  if (!sequenceKey) {
    if (source === 'system' || source === 'global-system') {
      return {
        proxyUrls: [],
        directFallback: true,
        source,
        fingerprint: routeFingerprint({ mode: 'system-egress' }),
      }
    }
    const deploymentRoute = deploymentEgressRoute(provider, control?.deploymentEgress)
    return {
      proxyUrls: deploymentRoute.proxyUrls,
      directFallback: deploymentRoute.directFallback,
      source: deploymentRoute.source,
      fingerprint: routeFingerprint(deploymentRoute.fingerprintRoute),
    }
  }
  const sequence = (control?.proxySequences || [])
    .find((candidate) => candidate.sequenceKey === sequenceKey)
  const endpoints = new Map(
    (control?.proxyEndpoints || []).map((endpoint) => [endpoint.proxyKey, endpoint]),
  )
  let route
  let proxyUrls = []
  let directFallback = false
  if (!sequence) route = { mode: 'missing-proxy-sequence', sequenceKey }
  else if (sequence.enabled === false) route = { mode: 'disabled-proxy-sequence', sequenceKey }
  else {
    const proxyRoutes = (sequence.proxyKeys || []).flatMap((proxyKey) => {
      const endpoint = endpoints.get(proxyKey)
      return !endpoint?.enabled
        ? []
        : [{ proxyKey, proxyUrl: endpoint.proxyUrl }]
    })
    route = proxyRoutes.length > 0
      ? {
          mode: 'proxy-sequence',
          sequenceKey,
          proxyRoutes,
          directFallback: sequence.directFallback === true,
        }
      : { mode: 'proxy-sequence-no-route', sequenceKey }
    proxyUrls = proxyRoutes.map(({ proxyUrl }) => proxyUrl)
    directFallback = proxyRoutes.length > 0 && sequence.directFallback === true
  }
  return {
    proxyUrls,
    directFallback,
    source,
    fingerprint: routeFingerprint(route),
  }
}

export function providerProxyRouteFingerprint(provider, control, routeOverride = undefined) {
  return resolveProviderProxyRoute(provider, control, routeOverride).fingerprint
}

function fingerprintValue(fingerprints, providerId) {
  return fingerprints instanceof Map
    ? fingerprints.get(providerId)
    : fingerprints?.[providerId]
}

export function aggregateProviderProxyRouteFingerprint(providerIds, fingerprints) {
  const orderedRoutes = providerIds.map((providerId) => {
    const fingerprint = fingerprintValue(fingerprints, providerId)
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      invalid('invalid_agent_sequence', `verification fingerprint is unavailable for Provider ${providerId}`)
    }
    return [providerId, fingerprint]
  })
  return routeFingerprint(orderedRoutes)
}

export function projectSequenceRouteProof(sequence, providerSetting, control) {
  const currentProviderRevision = Number(providerSetting?.revision ?? 0)
  const providerIds = Array.isArray(sequence.providerIds) ? sequence.providerIds : []
  const catalog = new Map(
    (Array.isArray(providerSetting?.providers) ? providerSetting.providers : [])
      .map((provider) => [provider?.id, provider]),
  )

  let routeProofStatus = 'valid'
  if (sequence.providerRevision !== currentProviderRevision) {
    routeProofStatus = 'provider-revision-changed'
  } else if (providerIds.length === 0
    || new Set(providerIds).size !== providerIds.length
    || providerIds.some((providerId) => {
      const provider = catalog.get(providerId)
      return !provider || provider.enabled === false
    })) {
    routeProofStatus = 'provider-unavailable'
  } else if (typeof sequence.verifiedProxyFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(sequence.verifiedProxyFingerprint)) {
    routeProofStatus = 'missing-proof'
  } else {
    try {
      const routeOverride = egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey)
      const fingerprints = new Map(providerIds.map((providerId) => [
        providerId,
        providerProxyRouteFingerprint(catalog.get(providerId), control, routeOverride),
      ]))
      const currentAggregate = aggregateProviderProxyRouteFingerprint(providerIds, fingerprints)
      if (currentAggregate !== sequence.verifiedProxyFingerprint) {
        routeProofStatus = 'route-changed'
      }
    } catch {
      // Persisted rows are protected by database constraints, but a partially
      // upgraded or manually repaired database must degrade to revalidation
      // instead of making the public control endpoint unavailable.
      routeProofStatus = 'route-changed'
    }
  }

  const routeProofValid = routeProofStatus === 'valid'
  return {
    ...sequence,
    routeProofStatus,
    routeProofValid,
    needsRevalidation: !routeProofValid,
  }
}

function relationMissing(error) {
  return error?.code === '42P01' || error?.code === '3F000'
}

function sequenceProxyColumnsMissing(error) {
  if (error?.code !== '42703') return false
  const detail = `${error?.column || ''} ${error?.message || ''}`
  return /\b(proxy_sequence_key|verified_proxy_fingerprint)\b/.test(detail)
}

function egressModeColumnsMissing(error) {
  if (error?.code !== '42703') return false
  const detail = `${error?.column || ''} ${error?.message || ''}`
  return /\begress_mode\b/.test(detail)
}

async function lockControlKey(client, namespace, key) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`mx-insight-agent:${namespace}:${key}`],
  )
}

async function lockEnabledProxyEndpoints(client, sequences, code = 'invalid_agent_proxy') {
  const proxyKeys = [...new Set(sequences.flatMap((sequence) => (
    Array.isArray(sequence?.proxy_keys) ? sequence.proxy_keys : []
  )))]
  const endpoints = proxyKeys.length > 0
    ? await client.query(
        `SELECT proxy_key
           FROM control.agent_proxy_endpoints
          WHERE enabled = true
            AND proxy_key = ANY($1::text[])
          FOR SHARE`,
        [proxyKeys],
      )
    : { rows: [] }
  const enabledKeys = new Set(endpoints.rows.map((row) => row.proxy_key))
  for (const sequence of sequences) {
    if (!sequence.proxy_keys.some((proxyKey) => enabledKeys.has(proxyKey))) {
      invalid(code, `Proxy Sequence ${sequence.sequence_key} has no enabled endpoint`)
    }
  }
}

function expectedProviderFingerprint(verification, providerId) {
  const fingerprint = fingerprintValue(verification?.proxyFingerprints, providerId)
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    invalid('invalid_agent_sequence', `verification fingerprint is unavailable for Provider ${providerId}`)
  }
  return fingerprint
}

async function lockAndVerifyProviderRoutes(client, {
  kind,
  providerIds,
  providerRevision,
  verification,
  routeOverride,
  deploymentEgress,
}) {
  if (!verification || verification.settingsRevision !== providerRevision) {
    invalid('invalid_agent_sequence', 'Provider verification proof is unavailable')
  }

  // Keep the same dependency order used by Proxy binding mutations:
  // global binding -> Provider settings -> Proxy Sequences -> endpoints.
  // Advisory locks cover missing legacy rows, which PostgreSQL row locks cannot.
  await lockControlKey(client, 'proxy-settings', 'global')
  const globalSetting = await client.query(
    `SELECT global_sequence_key, egress_mode
       FROM control.agent_proxy_settings
      WHERE singleton = true
      FOR SHARE`,
  )
  const setting = await client.query(
    `SELECT revision, providers
       FROM control.agent_provider_settings
      WHERE kind = $1
      FOR SHARE`,
    [kind],
  )
  const currentProviderRevision = Number(setting.rows[0]?.revision ?? 0)
  if (currentProviderRevision !== providerRevision) {
    throw new AppError(409, 'provider_revision_conflict', 'Provider catalog changed during Sequence verification')
  }

  const catalog = new Map((setting.rows[0]?.providers || []).map((provider) => [provider.id, provider]))
  const providers = providerIds.map((providerId) => {
    const provider = catalog.get(providerId)
    if (!provider) invalid('invalid_agent_sequence', `Unknown ${kind} provider: ${providerId}`)
    if (provider.enabled === false) invalid('invalid_agent_sequence', `Provider ${providerId} is disabled`)
    return provider
  })
  const globalProxySequenceKey = globalSetting.rows[0]?.global_sequence_key ?? null
  const globalEgressMode = globalSetting.rows[0]?.egress_mode
    || (globalProxySequenceKey ? 'proxy-sequence' : 'inherit')
  const sequenceKeys = routeOverride !== undefined
    ? (routeOverride == null ? [] : [routeOverride])
    : [...new Set(providers
      .map((provider) => provider.proxySequenceKey
        || (globalEgressMode === 'proxy-sequence' ? globalProxySequenceKey : null))
      .filter(Boolean))].sort()
  for (const sequenceKey of sequenceKeys) {
    await lockControlKey(client, 'proxy-sequence', sequenceKey)
  }
  const sequences = sequenceKeys.length > 0
    ? await client.query(
        `SELECT sequence_key, proxy_keys, direct_fallback, enabled
           FROM control.agent_proxy_sequences
          WHERE sequence_key = ANY($1::text[])
          ORDER BY sequence_key
          FOR SHARE`,
        [sequenceKeys],
      )
    : { rows: [] }
  const proxyKeys = [...new Set(sequences.rows.flatMap((sequence) => (
    Array.isArray(sequence.proxy_keys) ? sequence.proxy_keys : []
  )))].sort()
  for (const proxyKey of proxyKeys) {
    await lockControlKey(client, 'proxy-endpoint', proxyKey)
  }
  const endpoints = proxyKeys.length > 0
    ? await client.query(
        `SELECT proxy_key, proxy_url, enabled
           FROM control.agent_proxy_endpoints
          WHERE proxy_key = ANY($1::text[])
          ORDER BY proxy_key
          FOR SHARE`,
        [proxyKeys],
      )
    : { rows: [] }
  const control = {
    globalProxySequenceKey,
    globalEgressMode,
    proxySequences: sequences.rows.map(proxySequenceRow),
    proxyEndpoints: endpoints.rows.map(proxyEndpointRow),
    deploymentEgress,
  }
  const currentFingerprints = new Map()
  for (const provider of providers) {
    const currentFingerprint = providerProxyRouteFingerprint(provider, control, routeOverride)
    currentFingerprints.set(provider.id, currentFingerprint)
    if (currentFingerprint !== expectedProviderFingerprint(verification, provider.id)) {
      throw new AppError(
        409,
        'agent_provider_verification_stale',
        'Provider or Proxy routing changed during verification; reload and retry',
      )
    }
  }
  const aggregateProxyFingerprint = aggregateProviderProxyRouteFingerprint(
    providerIds,
    currentFingerprints,
  )
  if (typeof verification.aggregateProxyFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(verification.aggregateProxyFingerprint)) {
    invalid('invalid_agent_sequence', 'aggregate Provider verification fingerprint is unavailable')
  }
  if (aggregateProxyFingerprint !== verification.aggregateProxyFingerprint) {
    throw new AppError(
      409,
      'agent_provider_verification_stale',
      'Provider or Proxy routing changed during verification; reload and retry',
    )
  }
  return { catalog, currentProviderRevision, aggregateProxyFingerprint }
}

export class AgentControlStore {
  constructor(pool, { deploymentEgress = null } = {}) {
    this.pool = pool
    this.deploymentEgress = deploymentEgress || {
      version: 1,
      configured: false,
      sourceKind: null,
      runtimeKind: null,
      httpProxy: null,
      httpsProxy: null,
      noProxy: null,
      sourceLocations: [],
      nodeName: null,
      observedAt: null,
    }
  }

  async ensureBootstrapSequence({ kind, providerIds, providerRevision = 0 }) {
    assertKind(kind)
    const ids = uniqueKeys(providerIds, {
      field: 'providerIds', minimum: 1, maximum: MAX_SEQUENCE_PROVIDERS,
    })
    const sequenceKey = `mx-default-${kind}`
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO control.agent_llm_sequences
           (sequence_key, display_name, kind, provider_ids, source,
            egress_mode, proxy_sequence_key, provider_revision, verified_proxy_fingerprint,
            updated_by)
         VALUES ($1, $2, $3, $4::text[], 'bootstrap', 'inherit', NULL, $5, NULL,
                 'environment-bootstrap')
         ON CONFLICT (sequence_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           provider_ids = EXCLUDED.provider_ids,
           egress_mode = EXCLUDED.egress_mode,
           proxy_sequence_key = EXCLUDED.proxy_sequence_key,
           provider_revision = EXCLUDED.provider_revision,
           verified_proxy_fingerprint = EXCLUDED.verified_proxy_fingerprint,
           revision = control.agent_llm_sequences.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         WHERE control.agent_llm_sequences.source = 'bootstrap'
           AND (control.agent_llm_sequences.display_name,
                control.agent_llm_sequences.provider_ids,
                control.agent_llm_sequences.egress_mode,
                control.agent_llm_sequences.proxy_sequence_key,
                control.agent_llm_sequences.provider_revision,
                control.agent_llm_sequences.verified_proxy_fingerprint)
               IS DISTINCT FROM
               (EXCLUDED.display_name, EXCLUDED.provider_ids, EXCLUDED.egress_mode,
                EXCLUDED.proxy_sequence_key, EXCLUDED.provider_revision,
                EXCLUDED.verified_proxy_fingerprint)`,
        [
          sequenceKey,
          kind === 'chat' ? 'MX Compatibility Chat' : 'MX Compatibility Embedding',
          kind,
          ids,
          providerRevision,
        ],
      )
      await client.query('COMMIT')
      return sequenceKey
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (relationMissing(error) || sequenceProxyColumnsMissing(error) || egressModeColumnsMissing(error)) return null
      throw error
    } finally {
      client.release()
    }
  }

  async loadRuntimeSnapshot(kind) {
    assertKind(kind)
    const client = await this.pool.connect()
    let legacyEgressSchema = false
    try {
      for (;;) {
        try {
          await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
          const sequences = await client.query(
            `SELECT sequence_key, display_name, kind, provider_ids, enabled, source,
                    ${legacyEgressSchema ? '' : 'egress_mode,'}
                    proxy_sequence_key, provider_revision,
                    verified_proxy_fingerprint, revision, verified_at,
                    verified_by, updated_by, updated_at
               FROM control.agent_llm_sequences
              WHERE kind = $1
              ORDER BY display_name, sequence_key`,
            [kind],
          )
          const binding = await client.query(
            `SELECT consumer_key, kind, sequence_key, revision, updated_by, updated_at
               FROM control.agent_consumer_bindings
              WHERE consumer_key = $1`,
            [`hub.${kind}.default`],
          )
          const providerSetting = await client.query(
            `SELECT revision, providers
               FROM control.agent_provider_settings
              WHERE kind = $1`,
            [kind],
          )
          const proxyEndpoints = await client.query(
            `SELECT proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at
               FROM control.agent_proxy_endpoints
              ORDER BY display_name, proxy_key`,
          )
          const proxySequences = await client.query(
            `SELECT sequence_key, display_name, proxy_keys, direct_fallback,
                    enabled, revision, updated_by, updated_at
               FROM control.agent_proxy_sequences
              ORDER BY display_name, sequence_key`,
          )
          const proxySetting = await client.query(
            `SELECT ${legacyEgressSchema ? '' : 'egress_mode,'}
                    global_sequence_key, revision, updated_by, updated_at
               FROM control.agent_proxy_settings
              WHERE singleton = true`,
          )
          await client.query('COMMIT')
          const policy = proxyPolicyRow(proxySetting.rows[0])
          const proxyControl = {
            globalProxySequenceKey: policy.sequenceKey,
            globalEgressMode: policy.egressMode,
            proxyPolicy: policy,
            proxyEndpoints: proxyEndpoints.rows.map(proxyEndpointRow),
            proxySequences: proxySequences.rows.map(proxySequenceRow),
            deploymentEgress: this.deploymentEgress,
          }
          return {
            controlAvailable: true,
            sequences: sequences.rows
              .map(sequenceRow)
              .map((sequence) => projectSequenceRouteProof(
                sequence,
                providerSetting.rows[0],
                proxyControl,
              )),
            defaultBinding: binding.rows[0] ? bindingRow(binding.rows[0]) : null,
            proxyEndpoints: proxyControl.proxyEndpoints,
            proxySequences: proxyControl.proxySequences,
            globalProxySequenceKey: policy.sequenceKey,
            globalEgressMode: policy.egressMode,
            proxyPolicy: policy,
            proxyRevision: policy.revision,
            deploymentEgress: this.deploymentEgress,
          }
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          if (!legacyEgressSchema && egressModeColumnsMissing(error)) {
            legacyEgressSchema = true
            continue
          }
          throw error
        }
      }
    } catch (error) {
      // An older database may briefly run new application code before the
      // migration Job completes. Sequence governance must degrade to the
      // legacy catalog order rather than taking down login/readiness.
      if (relationMissing(error) || sequenceProxyColumnsMissing(error)) {
        const policy = proxyPolicyRow()
        return {
          controlAvailable: false,
          sequences: [], defaultBinding: null, proxyEndpoints: [],
          proxySequences: [], globalProxySequenceKey: null,
          globalEgressMode: policy.egressMode, proxyPolicy: policy, proxyRevision: 0,
          deploymentEgress: this.deploymentEgress,
        }
      }
      throw error
    } finally {
      client.release()
    }
  }

  async listPublicControl() {
    const [chat, embedding, probes] = await Promise.all([
      this.loadRuntimeSnapshot('chat'),
      this.loadRuntimeSnapshot('embedding'),
      this.pool.query(
        `SELECT DISTINCT ON (kind, provider_id)
                kind, provider_id, settings_revision, proxy_fingerprint,
                model, protocol, ok,
                latency_ms, error_code, tested_by, tested_at
           FROM agent_center.agent_provider_probe_results
          ORDER BY kind, provider_id, tested_at DESC`,
      ).catch((error) => relationMissing(error) ? { rows: [] } : Promise.reject(error)),
    ])
    const sequences = [...chat.sequences, ...embedding.sequences]
    const bindings = [chat.defaultBinding, embedding.defaultBinding].filter(Boolean)
    const baseline = publicDeploymentEgress(chat.deploymentEgress)
    const policy = chat.proxyPolicy || proxyPolicyRow()
    const effective = policy.egressMode === 'proxy-sequence'
      ? {
          egressMode: 'proxy-sequence', source: 'hub-policy',
          sequenceKey: policy.sequenceKey, httpProxy: null, httpsProxy: null, noProxy: null,
        }
      : policy.egressMode === 'system-egress'
        ? {
            egressMode: 'system-egress', source: 'hub-policy',
            sequenceKey: null, httpProxy: null, httpsProxy: null, noProxy: null,
          }
        : baseline.configured
          ? {
              egressMode: 'docker-daemon', source: 'docker-daemon', sequenceKey: null,
              httpProxy: baseline.httpProxy, httpsProxy: baseline.httpsProxy,
              noProxy: baseline.noProxy,
            }
          : {
              egressMode: 'system-egress', source: 'system',
              sequenceKey: null, httpProxy: null, httpsProxy: null, noProxy: baseline.noProxy,
            }
    return {
      sequences,
      bindings,
      providerTests: probes.rows.map((row) => ({
        kind: row.kind,
        providerId: row.provider_id,
        settingsRevision: Number(row.settings_revision),
        proxyFingerprint: row.proxy_fingerprint,
        model: row.model,
        protocol: row.protocol,
        ok: row.ok === true,
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
        errorCode: row.error_code ?? null,
        testedBy: row.tested_by ?? null,
        testedAt: iso(row.tested_at),
      })),
      proxy: {
        endpoints: chat.proxyEndpoints,
        sequences: chat.proxySequences,
        globalSequenceKey: chat.globalProxySequenceKey,
        revision: chat.proxyRevision,
        policy,
        baseline,
        effective,
        precedence: [
          { rank: 1, layer: 'request-override', label: '单次请求覆盖' },
          { rank: 2, layer: 'llm-sequence', label: 'LLM Sequence 出网策略' },
          { rank: 3, layer: 'provider-compat', label: 'Provider 兼容绑定' },
          { rank: 4, layer: 'hub-policy', label: 'Hub 全局策略' },
          { rank: 5, layer: 'docker-daemon', label: 'Docker daemon 部署基线' },
          { rank: 6, layer: 'system', label: 'Pod/Node 系统出网' },
        ],
      },
    }
  }

  async recordProbe({ kind, providerId, settingsRevision, proxyFingerprint, model, protocol, ok, latencyMs = null, errorCode = null, testedBy = 'admin-token' }) {
    assertKind(kind)
    assertKey(providerId, 'providerId')
    if (typeof proxyFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(proxyFingerprint)) {
      invalid('invalid_agent_probe', 'proxyFingerprint must be a SHA-256 digest')
    }
    await this.pool.query(
      `INSERT INTO agent_center.agent_provider_probe_results
         (kind, provider_id, settings_revision, proxy_fingerprint, model,
          protocol, ok, latency_ms, error_code, tested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [kind, providerId, settingsRevision, proxyFingerprint, model, protocol, ok, latencyMs, errorCode, testedBy],
    )
  }

  async validateProxySequenceKeys(sequenceKeys) {
    const keys = uniqueKeys(sequenceKeys, {
      field: 'proxySequenceKeys', minimum: 0, maximum: MAX_SEQUENCE_PROVIDERS,
    })
    if (keys.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `SELECT sequence_key, proxy_keys
           FROM control.agent_proxy_sequences
          WHERE enabled = true
            AND sequence_key = ANY($1::text[])
          FOR SHARE`,
        [keys],
      )
      const available = new Map(result.rows.map((row) => [row.sequence_key, row]))
      for (const key of keys) {
        const sequence = available.get(key)
        if (!sequence || !Array.isArray(sequence.proxy_keys) || sequence.proxy_keys.length === 0) {
          invalid('invalid_provider_settings', `Proxy Sequence ${key} is missing, disabled, or contains no endpoints`)
        }
      }
      await lockEnabledProxyEndpoints(client, [...available.values()], 'invalid_provider_settings')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (relationMissing(error)) {
        throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require the Agent control migration')
      }
      throw error
    } finally {
      client.release()
    }
  }

  async saveSequence(sequenceKey, input, {
    providerRevision,
    verification,
    verifiedBy = 'admin-token',
    updatedBy = 'admin-token',
  } = {}) {
    assertKey(sequenceKey, 'sequenceKey')
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalid('invalid_agent_sequence', 'request body must be an object')
    }
    for (const field of Object.keys(input)) {
      if (![
        'expectedRevision', 'displayName', 'kind', 'providerIds', 'enabled',
        'egressMode', 'proxySequenceKey',
      ].includes(field)) {
        invalid('invalid_agent_sequence', `request contains unsupported field ${field}`)
      }
    }
    const expected = expectedRevision(input.expectedRevision)
    const kind = assertKind(input.kind)
    const providerIds = uniqueKeys(input.providerIds, {
      field: 'providerIds', minimum: 1, maximum: MAX_SEQUENCE_PROVIDERS,
    })
    const displayName = normalizedName(input.displayName)
    const enabled = input.enabled ?? true
    if (typeof enabled !== 'boolean') invalid('invalid_agent_sequence', 'enabled must be boolean')
    const requestedProxySequenceKey = Object.prototype.hasOwnProperty.call(input, 'proxySequenceKey')
      ? input.proxySequenceKey
      : undefined
    if (requestedProxySequenceKey !== undefined && requestedProxySequenceKey !== null) {
      assertKey(requestedProxySequenceKey, 'proxySequenceKey')
    }
    const proxySequenceKey = typeof requestedProxySequenceKey === 'string'
      ? requestedProxySequenceKey
      : null
    const egressMode = normalizedEgressMode(input.egressMode, proxySequenceKey)
    const routeOverride = egressRouteOverride(egressMode, proxySequenceKey)
    if (!Number.isInteger(providerRevision) || providerRevision < 0) {
      invalid('invalid_agent_sequence', 'provider revision is unavailable')
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const routeVerification = await lockAndVerifyProviderRoutes(client, {
        kind,
        providerIds,
        providerRevision,
        verification,
        routeOverride,
        deploymentEgress: this.deploymentEgress,
      })
      await lockControlKey(client, 'llm-sequence', sequenceKey)
      const current = await client.query(
        `SELECT revision, kind, egress_mode, proxy_sequence_key,
                verified_proxy_fingerprint
           FROM control.agent_llm_sequences
          WHERE sequence_key = $1 FOR UPDATE`,
        [sequenceKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'sequence_revision_conflict', 'LLM Sequence changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (current.rows[0] && current.rows[0].kind !== kind) {
        invalid('invalid_agent_sequence', 'An existing Sequence cannot change capability kind')
      }
      const saved = await client.query(
        `INSERT INTO control.agent_llm_sequences
           (sequence_key, display_name, kind, provider_ids, enabled, source,
            egress_mode, proxy_sequence_key, provider_revision, verified_proxy_fingerprint,
            revision, verified_at, verified_by, updated_by, updated_at)
         VALUES ($1, $2, $3, $4::text[], $5, 'database', $6, $7, $8, $9,
                 1, now(), $10, $11, now())
         ON CONFLICT (sequence_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           kind = EXCLUDED.kind,
           provider_ids = EXCLUDED.provider_ids,
           enabled = EXCLUDED.enabled,
           source = 'database',
           egress_mode = EXCLUDED.egress_mode,
           proxy_sequence_key = EXCLUDED.proxy_sequence_key,
           provider_revision = EXCLUDED.provider_revision,
           verified_proxy_fingerprint = EXCLUDED.verified_proxy_fingerprint,
           revision = control.agent_llm_sequences.revision + 1,
           verified_at = now(),
           verified_by = EXCLUDED.verified_by,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING sequence_key, display_name, kind, provider_ids, enabled,
                   source, egress_mode, proxy_sequence_key, provider_revision,
                   verified_proxy_fingerprint, revision, verified_at,
                   verified_by, updated_by, updated_at`,
        [
          sequenceKey,
          displayName,
          kind,
          providerIds,
          enabled,
          egressMode,
          proxySequenceKey,
          providerRevision,
          routeVerification.aggregateProxyFingerprint,
          verifiedBy,
          updatedBy,
        ],
      )
      await client.query('COMMIT')
      return sequenceRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async setDefaultSequence(kind, sequenceKey, {
    expectedRevision: expected,
    expectedSequenceRevision = null,
    verification = null,
    updatedBy = 'admin-token',
  } = {}) {
    assertKind(kind)
    if (sequenceKey != null) assertKey(sequenceKey, 'sequenceKey')
    expectedRevision(expected)
    const consumerKey = `hub.${kind}.default`
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'consumer-binding', consumerKey)
      const current = await client.query(
        `SELECT revision FROM control.agent_consumer_bindings
          WHERE consumer_key = $1 FOR UPDATE`,
        [consumerKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'binding_revision_conflict', 'Default Sequence binding changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (sequenceKey != null) {
        const sequenceRevision = expectedRevision(expectedSequenceRevision)
        // Read the candidate before taking Proxy locks, then lock and compare it
        // after proof validation. Taking the LLM row lock first would invert
        // saveSequence's Global -> Provider -> Proxy -> LLM order and deadlock.
        const candidate = await client.query(
          `SELECT enabled, provider_ids, egress_mode, proxy_sequence_key, provider_revision,
                  verified_proxy_fingerprint, revision
             FROM control.agent_llm_sequences
            WHERE sequence_key = $1 AND kind = $2`,
          [sequenceKey, kind],
        )
        if (!candidate.rows[0] || candidate.rows[0].enabled === false) {
          invalid('invalid_agent_binding', 'The selected Sequence is missing or disabled')
        }
        const providerIds = candidate.rows[0].provider_ids || []
        const proxySequenceKey = candidate.rows[0].proxy_sequence_key ?? null
        const egressMode = normalizedEgressMode(candidate.rows[0].egress_mode, proxySequenceKey)
        const providerRevision = Number(candidate.rows[0].provider_revision)
        if (Number(candidate.rows[0].revision) !== sequenceRevision) {
          throw new AppError(409, 'sequence_verification_stale', 'The selected Sequence changed during verification')
        }
        if (providerRevision !== verification?.settingsRevision) {
          throw new AppError(409, 'sequence_verification_stale', 'The selected Sequence must be tested against the current Provider catalog')
        }
        const routeVerification = await lockAndVerifyProviderRoutes(client, {
          kind,
          providerIds,
          providerRevision,
          verification,
          routeOverride: egressRouteOverride(egressMode, proxySequenceKey),
          deploymentEgress: this.deploymentEgress,
        })
        if (candidate.rows[0].verified_proxy_fingerprint
          !== routeVerification.aggregateProxyFingerprint) {
          throw new AppError(409, 'sequence_verification_stale', 'The selected Sequence changed during verification')
        }
        const sequence = await client.query(
          `SELECT enabled, provider_ids, egress_mode, proxy_sequence_key, provider_revision,
                  verified_proxy_fingerprint, revision
             FROM control.agent_llm_sequences
            WHERE sequence_key = $1 AND kind = $2
            FOR SHARE`,
          [sequenceKey, kind],
        )
        if (!sequence.rows[0] || sequence.rows[0].enabled === false
          || Number(sequence.rows[0].provider_revision) !== providerRevision
          || Number(sequence.rows[0].revision) !== sequenceRevision
          || normalizedEgressMode(sequence.rows[0].egress_mode,
            sequence.rows[0].proxy_sequence_key ?? null) !== egressMode
          || (sequence.rows[0].proxy_sequence_key ?? null) !== proxySequenceKey
          || sequence.rows[0].verified_proxy_fingerprint
            !== routeVerification.aggregateProxyFingerprint
          || JSON.stringify(sequence.rows[0].provider_ids || []) !== JSON.stringify(providerIds)) {
          throw new AppError(409, 'sequence_verification_stale', 'The selected Sequence changed during verification')
        }
      }
      const saved = await client.query(
        `INSERT INTO control.agent_consumer_bindings
           (consumer_key, kind, sequence_key, revision, updated_by, updated_at)
         VALUES ($1, $2, $3, 1, $4, now())
         ON CONFLICT (consumer_key) DO UPDATE SET
           kind = EXCLUDED.kind,
           sequence_key = EXCLUDED.sequence_key,
           revision = control.agent_consumer_bindings.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING consumer_key, kind, sequence_key, revision, updated_by, updated_at`,
        [consumerKey, kind, sequenceKey, updatedBy],
      )
      await client.query('COMMIT')
      return bindingRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async saveProxyEndpoint(proxyKey, input, { updatedBy = 'admin-token' } = {}) {
    assertKey(proxyKey, 'proxyKey')
    const expected = expectedRevision(input?.expectedRevision)
    const displayName = normalizedName(input?.displayName)
    const enabled = input?.enabled ?? true
    if (typeof enabled !== 'boolean') invalid('invalid_agent_proxy', 'enabled must be boolean')
    let url
    try { url = new URL(input?.proxyUrl) } catch { invalid('invalid_agent_proxy', 'proxyUrl must be a valid URL') }
    if (!['http:', 'https:'].includes(url.protocol)) {
      invalid('invalid_agent_proxy', 'proxyUrl must use http or https')
    }
    if (url.username || url.password) {
      invalid('invalid_agent_proxy', 'proxyUrl must not contain credentials')
    }
    if (url.search || url.hash) invalid('invalid_agent_proxy', 'proxyUrl must not contain query or fragment')
    if (url.pathname !== '/' && url.pathname !== '') invalid('invalid_agent_proxy', 'proxyUrl must not contain a path')
    const proxyUrl = url.toString().replace(/\/$/, '')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'proxy-endpoint', proxyKey)
      const current = await client.query(
        'SELECT revision FROM control.agent_proxy_endpoints WHERE proxy_key = $1 FOR UPDATE',
        [proxyKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_revision_conflict', 'Proxy endpoint changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (!enabled) {
        const references = await client.query(
          `SELECT sequence_key
             FROM control.agent_proxy_sequences
            WHERE $1 = ANY(proxy_keys)
            ORDER BY sequence_key
            FOR SHARE`,
          [proxyKey],
        )
        if (references.rows.length > 0) {
          throw new AppError(409, 'agent_proxy_endpoint_in_use', 'Remove the endpoint from every Proxy Sequence before disabling it', {
            sequenceKeys: references.rows.map((row) => row.sequence_key),
          })
        }
      }
      const saved = await client.query(
        `INSERT INTO control.agent_proxy_endpoints
           (proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, now())
         ON CONFLICT (proxy_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           proxy_url = EXCLUDED.proxy_url,
           enabled = EXCLUDED.enabled,
           revision = control.agent_proxy_endpoints.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at`,
        [proxyKey, displayName, proxyUrl, enabled, updatedBy],
      )
      await client.query('COMMIT')
      return proxyEndpointRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async deleteProxyEndpoint(proxyKey, input) {
    assertKey(proxyKey, 'proxyKey')
    const expected = expectedRevision(input?.expectedRevision)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'proxy-endpoint', proxyKey)
      const current = await client.query(
        `SELECT proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at
           FROM control.agent_proxy_endpoints
          WHERE proxy_key = $1
          FOR UPDATE`,
        [proxyKey],
      )
      if (!current.rows[0]) {
        throw new AppError(404, 'agent_proxy_endpoint_not_found', 'Proxy endpoint was not found')
      }
      const revision = Number(current.rows[0].revision)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_revision_conflict', 'Proxy endpoint changed; reload and retry', {
          currentRevision: revision,
        })
      }
      const references = await client.query(
        `SELECT sequence_key
           FROM control.agent_proxy_sequences
          WHERE $1 = ANY(proxy_keys)
          ORDER BY sequence_key
          FOR SHARE`,
        [proxyKey],
      )
      if (references.rows.length > 0) {
        throw new AppError(409, 'agent_proxy_endpoint_in_use', 'Remove the endpoint from every Proxy Sequence before deleting it', {
          sequenceKeys: references.rows.map((row) => row.sequence_key),
        })
      }
      const deleted = await client.query(
        `DELETE FROM control.agent_proxy_endpoints
          WHERE proxy_key = $1
        RETURNING proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at`,
        [proxyKey],
      )
      await client.query('COMMIT')
      return proxyEndpointRow(deleted.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async saveProxySequence(sequenceKey, input, { updatedBy = 'admin-token' } = {}) {
    assertKey(sequenceKey, 'sequenceKey')
    const expected = expectedRevision(input?.expectedRevision)
    const displayName = normalizedName(input?.displayName)
    const proxyKeys = uniqueKeys(input?.proxyKeys || [], {
      field: 'proxyKeys', minimum: 0, maximum: MAX_PROXY_ENDPOINTS,
    })
    const directFallback = input?.directFallback ?? true
    const enabled = input?.enabled ?? true
    if (typeof directFallback !== 'boolean' || typeof enabled !== 'boolean') {
      invalid('invalid_agent_proxy', 'directFallback and enabled must be boolean')
    }
    if (proxyKeys.length === 0) {
      invalid('invalid_agent_proxy', 'Proxy Sequence requires at least one endpoint')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      let globalSetting = null
      let providerSettings = null
      if (!enabled) {
        // Match setGlobalProxySequence/deleteProxySequence and Provider writes:
        // bindings are locked before the Sequence row, so a concurrent bind can
        // neither slip past this transition nor deadlock while holding the
        // Sequence lock that it still needs to validate.
        await lockControlKey(client, 'proxy-settings', 'global')
        globalSetting = await client.query(
          `SELECT global_sequence_key
             FROM control.agent_proxy_settings
            WHERE singleton = true
            FOR SHARE`,
        )
        providerSettings = await client.query(
          `SELECT kind, providers
             FROM control.agent_provider_settings
            FOR SHARE`,
        )
      }
      await lockControlKey(client, 'proxy-sequence', sequenceKey)
      const endpoints = await client.query(
        `SELECT proxy_key, enabled
           FROM control.agent_proxy_endpoints
          WHERE proxy_key = ANY($1::text[])
          FOR SHARE`,
        [proxyKeys],
      )
      const enabledKeys = new Set(endpoints.rows.filter((row) => row.enabled).map((row) => row.proxy_key))
      for (const key of proxyKeys) {
        if (!enabledKeys.has(key)) invalid('invalid_agent_proxy', `Proxy endpoint ${key} is missing or disabled`)
      }
      const current = await client.query(
        'SELECT revision, enabled FROM control.agent_proxy_sequences WHERE sequence_key = $1 FOR UPDATE',
        [sequenceKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_sequence_revision_conflict', 'Proxy Sequence changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (current.rows[0]?.enabled === true && !enabled) {
        if (globalSetting?.rows[0]?.global_sequence_key === sequenceKey) {
          throw new AppError(409, 'agent_proxy_sequence_in_use', 'Select a different global Proxy Sequence before disabling this one', {
            global: true,
            providers: [],
          })
        }
        const providers = (providerSettings?.rows || []).flatMap((row) => (
          Array.isArray(row.providers) ? row.providers : []
        ).filter((provider) => provider?.proxySequenceKey === sequenceKey)
          .map((provider) => ({ kind: row.kind, providerId: provider.id })))
        if (providers.length > 0) {
          throw new AppError(409, 'agent_proxy_sequence_in_use', 'Remove the Proxy Sequence from every Provider before disabling it', {
            global: false,
            providers,
          })
        }
      }
      if (!enabled) {
        const llmSequences = await client.query(
          `SELECT sequence_key, kind
             FROM control.agent_llm_sequences
            WHERE proxy_sequence_key = $1
            ORDER BY kind, sequence_key
            FOR SHARE`,
          [sequenceKey],
        )
        if (llmSequences.rows.length > 0) {
          throw new AppError(
            409,
            'agent_proxy_sequence_in_use',
            'Remove the Proxy Sequence from every LLM Sequence before disabling it',
            {
              global: false,
              providers: [],
              sequences: llmSequences.rows.map((row) => ({
                kind: row.kind,
                sequenceKey: row.sequence_key,
              })),
            },
          )
        }
      }
      const saved = await client.query(
        `INSERT INTO control.agent_proxy_sequences
           (sequence_key, display_name, proxy_keys, direct_fallback,
            enabled, revision, updated_by, updated_at)
         VALUES ($1, $2, $3::text[], $4, $5, 1, $6, now())
         ON CONFLICT (sequence_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           proxy_keys = EXCLUDED.proxy_keys,
           direct_fallback = EXCLUDED.direct_fallback,
           enabled = EXCLUDED.enabled,
           revision = control.agent_proxy_sequences.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING sequence_key, display_name, proxy_keys, direct_fallback,
                   enabled, revision, updated_by, updated_at`,
        [sequenceKey, displayName, proxyKeys, directFallback, enabled, updatedBy],
      )
      await client.query('COMMIT')
      return proxySequenceRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async deleteProxySequence(sequenceKey, input) {
    assertKey(sequenceKey, 'sequenceKey')
    const expected = expectedRevision(input?.expectedRevision)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Match setGlobalProxySequence's lock order so deleting a Sequence can
      // never race the global binding into ON DELETE SET NULL.
      await lockControlKey(client, 'proxy-settings', 'global')
      const globalSetting = await client.query(
        `SELECT global_sequence_key
           FROM control.agent_proxy_settings
          WHERE singleton = true
          FOR SHARE`,
      )
      const providerSettings = await client.query(
        `SELECT kind, providers
           FROM control.agent_provider_settings
          FOR SHARE`,
      )
      await lockControlKey(client, 'proxy-sequence', sequenceKey)
      const current = await client.query(
        `SELECT sequence_key, display_name, proxy_keys, direct_fallback,
                enabled, revision, updated_by, updated_at
           FROM control.agent_proxy_sequences
          WHERE sequence_key = $1
          FOR UPDATE`,
        [sequenceKey],
      )
      if (!current.rows[0]) {
        throw new AppError(404, 'agent_proxy_sequence_not_found', 'Proxy Sequence was not found')
      }
      const revision = Number(current.rows[0].revision)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_sequence_revision_conflict', 'Proxy Sequence changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (globalSetting.rows[0]?.global_sequence_key === sequenceKey) {
        throw new AppError(409, 'agent_proxy_sequence_in_use', 'Select a different global Proxy Sequence before deleting this one', {
          global: true,
          providers: [],
        })
      }
      const providers = providerSettings.rows.flatMap((row) => (
        Array.isArray(row.providers) ? row.providers : []
      ).filter((provider) => provider?.proxySequenceKey === sequenceKey)
        .map((provider) => ({ kind: row.kind, providerId: provider.id })))
      if (providers.length > 0) {
        throw new AppError(409, 'agent_proxy_sequence_in_use', 'Remove the Proxy Sequence from every Provider before deleting it', {
          global: false,
          providers,
        })
      }
      const llmSequences = await client.query(
        `SELECT sequence_key, kind
           FROM control.agent_llm_sequences
          WHERE proxy_sequence_key = $1
          ORDER BY kind, sequence_key
          FOR SHARE`,
        [sequenceKey],
      )
      if (llmSequences.rows.length > 0) {
        throw new AppError(
          409,
          'agent_proxy_sequence_in_use',
          'Remove the Proxy Sequence from every LLM Sequence before deleting it',
          {
            global: false,
            providers: [],
            sequences: llmSequences.rows.map((row) => ({
              kind: row.kind,
              sequenceKey: row.sequence_key,
            })),
          },
        )
      }
      const deleted = await client.query(
        `DELETE FROM control.agent_proxy_sequences
          WHERE sequence_key = $1
        RETURNING sequence_key, display_name, proxy_keys, direct_fallback,
                  enabled, revision, updated_by, updated_at`,
        [sequenceKey],
      )
      await client.query('COMMIT')
      return proxySequenceRow(deleted.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async setGlobalProxySequence(selection, options = {}) {
    const policy = selection && typeof selection === 'object' && !Array.isArray(selection)
      ? { ...selection, updatedBy: options.updatedBy ?? selection.updatedBy }
      : { ...options, sequenceKey: selection }
    const sequenceKey = policy.sequenceKey ?? null
    if (sequenceKey != null) assertKey(sequenceKey, 'sequenceKey')
    const egressMode = normalizedEgressMode(policy.egressMode, sequenceKey)
    const expected = policy.expectedRevision
    const updatedBy = policy.updatedBy ?? 'admin-token'
    expectedRevision(expected)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'proxy-settings', 'global')
      const current = await client.query(
        'SELECT revision FROM control.agent_proxy_settings WHERE singleton = true FOR UPDATE',
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_settings_revision_conflict', 'Global proxy setting changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (sequenceKey != null) {
        const selected = await client.query(
          'SELECT sequence_key, enabled, proxy_keys FROM control.agent_proxy_sequences WHERE sequence_key = $1 FOR SHARE',
          [sequenceKey],
        )
        if (!selected.rows[0] || selected.rows[0].enabled === false
          || !Array.isArray(selected.rows[0].proxy_keys) || selected.rows[0].proxy_keys.length === 0) {
          invalid('invalid_agent_proxy', 'The selected Proxy Sequence is missing, disabled, or contains no endpoints')
        }
        await lockEnabledProxyEndpoints(client, selected.rows)
      }
      const saved = await client.query(
        `INSERT INTO control.agent_proxy_settings
           (singleton, egress_mode, global_sequence_key, revision, updated_by, updated_at)
         VALUES (true, $1, $2, 1, $3, now())
         ON CONFLICT (singleton) DO UPDATE SET
           egress_mode = EXCLUDED.egress_mode,
           global_sequence_key = EXCLUDED.global_sequence_key,
           revision = control.agent_proxy_settings.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING egress_mode, global_sequence_key, revision, updated_by, updated_at`,
        [egressMode, sequenceKey, updatedBy],
      )
      await client.query('COMMIT')
      return proxyPolicyRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}
