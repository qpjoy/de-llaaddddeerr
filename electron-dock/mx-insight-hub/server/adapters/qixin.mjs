import { createHash } from 'node:crypto'
import { JustOneUpstreamError } from './justone.mjs'
import { ENTERPRISE_VERSION, normalizeEnterpriseRequest } from '../contracts/enterprise.mjs'
import { canonicalJson } from '../ingest/normalizers.mjs'
import { createCredentialEchoRedactor } from '../core/credential-redaction.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const accepted = new Set([200, 201, 202, 203, 206])

export class QixinAdapter {
  constructor({ fetchImpl = fetch, timeoutMs = 30000, maxResponseBytes = 16 * 1024 * 1024, clock = Date.now } = {}) {
    Object.assign(this, { fetchImpl, timeoutMs, maxResponseBytes, clock })
  }
  async resolveCredential() { return null }
  async query(apiId, input, { credential }) {
    const normalized = normalizeEnterpriseRequest(apiId, input)
    const { api, method, query, body } = normalized
    const url = new URL(api.interface)
    if (url.origin !== 'https://api.qixin.com' || url.username || url.password || url.search || url.hash) throw new Error('Enterprise endpoint is not allowlisted')
    if (!credential?.appkey || !credential?.secret_key) throw new Error('Enterprise credential is unavailable')
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const timestamp = String(this.clock())
    const sign = createHash('md5').update(credential.appkey + timestamp + credential.secret_key).digest('hex')
    const redactors = [credential.appkey, credential.secret_key, sign].map(createCredentialEchoRedactor)
    let responseArchive = null, restrictedResponseArchive = null
    let httpStatus = null, businessCode = null
    const fail = (outcome, code, affectsCircuit = true) => {
      const error = new JustOneUpstreamError('EnterpriseUpstreamError', 'Enterprise query could not be completed',
        { outcome, errorCode: code, httpStatus, businessCode, billed: null, affectsCircuit,
          circuitCategory: outcome === 'unknown' ? 'transport' : 'upstream' }, [], restrictedResponseArchive)
      Object.defineProperty(error, 'responseArchive', { value: responseArchive, enumerable: false })
      return error
    }
    try {
      const response = await this.fetchImpl(url.toString(), { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Auth-Version': '2.0', appkey: credential.appkey, timestamp, sign, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      httpStatus = response.status
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > this.maxResponseBytes) throw fail('unknown', 'enterprise_response_too_large')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      const capturedAt = new Date(this.clock())
      let text = null, payload = null
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch {}
      // Only exact credential echoes are removed. Business keys named sign,
      // token, url, etc. and complete nested business payloads stay intact.
      let cleanText = text == null ? null : redactors.reduce((value, redact) => redact(value), text)
      try {
        payload = JSON.parse(cleanText)
        const clean = value => {
          if (typeof value === 'string') return redactors.reduce((text, redact) => redact(text), value)
          if (Array.isArray(value)) return value.map(clean)
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [clean(key), clean(entry)]))
          return value
        }
        const cleanedPayload = clean(payload)
        // Decode JSON escapes before checking echoes, while retaining original
        // bytes whenever no credential was present.
        if (JSON.stringify(cleanedPayload) !== JSON.stringify(payload)) cleanText = JSON.stringify(cleanedPayload)
        payload = cleanedPayload
      } catch {}
      const storedBytes = cleanText === text ? bytes : Buffer.from(cleanText)
      const digest = hash(storedBytes)
      restrictedResponseArchive = { bodyBytes: storedBytes, bodySize: storedBytes.length, bodySha256: digest, capturedAt,
        bodyText: isPostgresSafeText(cleanText) ? cleanText : null,
        parsedPayload: isPostgresSafeJsonValue(payload) ? payload : null, jsonParsed: payload != null }
      businessCode = /^\d{3}$/.test(String(payload?.status)) ? Number(payload.status) : null
      responseArchive = { httpStatus, businessCode, contractState: 'verified', payloadSha256: digest,
        bodySize: storedBytes.length, capturedAt, rawPayload: null, contentType: response.headers.get('content-type') }
      if (httpStatus >= 500 || !payload || businessCode == null) throw fail('unknown', 'enterprise_outcome_unknown')
      if (httpStatus !== 200 || !accepted.has(businessCode)) throw fail('rejected', 'enterprise_query_rejected', ![208, 105].includes(businessCode))
      if (!isPostgresSafeJsonValue(payload)) throw fail('succeeded_unusable', 'enterprise_response_unusable')
      const identity = hash(canonicalJson(normalized.fingerprintBody))
      const record = {
        platform: 'enterprise', objectType: 'enterprise_response', externalId: `${apiId}:${identity}`, contentType: 'enterprise_response',
        title: `${api.api_name} · ${query.keyword || query.name || apiId}`, body: null, url: null,
        authorExternalId: null, authorName: null, eventTime: null, collectedAt: capturedAt, editedAt: null, deletedAt: null,
        latitude: null, longitude: null, countryCode: 'CN', admin1Code: null, admin2Code: null,
        stableFields: { source: { connectorId: 'external-platform:qixin', connectorContractVersion: ENTERPRISE_VERSION,
          endpointKey: normalized.endpointKey }, enterprise: { apiId, category: api.category_name, request: { method, query, body } } },
        extensions: { response: payload }, metrics: {}, rank: 0, parserVersion: 'mxih-enterprise-response.v1', sourcePointer: '$',
        rawItem: payload, rawPayloadSha256: digest, payloadSha256: hash(canonicalJson({ apiId, query, body, payload })),
      }
      return { publicBody: { contractVersion: ENTERPRISE_VERSION, apiId, data: payload,
        meta: { capturedAt: capturedAt.toISOString(), resultState: [202, 203].includes(businessCode) ? 'pending' : [201, 206].includes(businessCode) ? 'no_data' : 'completed' } },
        items: [record], records: [record], responseArchive, restrictedResponseArchive, archiveObjects: [] }
    } catch (error) {
      if (error instanceof JustOneUpstreamError) throw error
      // Fetch/database error strings may contain the signed URL or headers.
      throw fail('unknown', 'enterprise_outcome_unknown')
    }
  }
}
