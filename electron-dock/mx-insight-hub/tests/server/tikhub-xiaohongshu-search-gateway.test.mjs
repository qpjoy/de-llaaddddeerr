import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TikHubUpstreamError } from '../../server/adapters/tikhub.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { isNightAllLegacyEnvelope } from '../../server/contracts/night-all-legacy.mjs'
import {
  normalizeTikHubXiaohongshuSearchResponse,
  normalizeXiaohongshuSearchRequest,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
} from '../../server/contracts/tikhub-xiaohongshu-search.mjs'
import { TIKHUB_XIAOHONGSHU_ENDPOINT_KEY } from '../../server/contracts/tikhub-xiaohongshu.mjs'
import { TikHubGateway } from '../../server/external-platforms/tikhub-gateway.mjs'

const FIRST_NOTE_ID = '675d277d000000000600e655'
const SECOND_NOTE_ID = '675d277d000000000600e658'
const SEARCH_PATH = '/api/v1/search'
const RAW_SEARCH_PATH = '/api/v1/search/raw'
const CAPTURED_AT = new Date().toISOString()
const PEPPER = 'direct-xhs-search-test-pepper-with-enough-entropy'

function note(id, text, extras = {}) {
  return {
    id,
    title: `note-${id}`,
    desc: text,
    timestamp: 1_782_212_583,
    user: { user_id: `author-${id}`, nickname: `作者-${id}` },
    interact_info: {
      liked_count: '12', collected_count: '3', comment_count: '4', share_count: '5',
    },
    ...extras,
  }
}

function searchEnvelope(notes, {
  hasMore = false,
  page = 1,
  searchId = null,
  searchSessionId = null,
} = {}) {
  return {
    code: 200,
    request_id: 'tikhub-search-upstream-request',
    data: {
      page,
      next_page: hasMore ? page + 1 : null,
      ...(searchId ? { search_id: searchId } : {}),
      ...(searchSessionId ? { search_session_id: searchSessionId } : {}),
      data: {
        items: notes.map((item) => ({ model_type: 'note', note: item })),
      },
    },
  }
}

function detailResult(id, text) {
  const responseHash = '2'.repeat(64)
  const rawPayload = { code: 200, request_id: `tikhub-detail-${id}`, data: { id } }
  return {
    publicBody: {
      contractVersion: 'mx-insight-hub.social-post.v1',
      data: {
        item: {
          id: `xiaohongshu:${id}`,
          externalId: id,
          platform: 'xiaohongshu',
          contentType: 'post',
          url: `https://www.xiaohongshu.com/explore/${id}`,
          title: `detail-${id}`,
          text,
          tags: [],
          author: { id: `detail-author-${id}`, name: '详情作者', avatarUrl: null },
          metrics: { liked: 999, collected: 998, comments: 997, shared: 996 },
          media: [],
          publishedAt: '2026-09-07T16:00:00.000Z',
          collectedAt: CAPTURED_AT,
        },
      },
      meta: { capturedAt: CAPTURED_AT },
    },
    responseArchive: {
      contractState: 'accepted',
      capturedAt: CAPTURED_AT,
      httpStatus: 200,
      businessCode: 200,
      contentType: 'application/json',
      bodySize: 128,
      payloadSha256: responseHash,
      rawPayload,
    },
    upstreamEvidence: { requestId: `tikhub-detail-${id}` },
    archiveObjects: [{
      kind: 'response',
      marketplace: 'xiaohongshu',
      endpointVersion: 'app_v2',
      capturedDate: CAPTURED_AT.slice(0, 10),
      archivePath: `external/tikhub/xiaohongshu/${CAPTURED_AT.slice(0, 10)}/responses/${responseHash}.json`,
      envelopePointer: '$',
      sourceKey: responseHash,
      payloadSha256: responseHash,
      rawPayload,
    }],
    records: [],
  }
}

function adapterFor({
  notes,
  detailById = new Map(),
  failingDetailIds = new Set(),
  beforeDetail = null,
  searchEnvelopeForRequest = null,
  searchError = null,
}) {
  const calls = { credential: 0, search: [], normalizedSearch: [], detail: [] }
  return {
    calls,
    async resolveCredential() {
      calls.credential += 1
      return 'provider-key-not-exposed'
    },
    async searchXiaohongshuNotes(body, options) {
      calls.search.push(structuredClone(body))
      if (searchError) throw searchError
      const request = normalizeXiaohongshuSearchRequest(body, {
        decodeCursor: options.decodeCursor,
        maxPageSize: options.maxPageSize,
      })
      calls.normalizedSearch.push(request)
      const rawPayload = searchEnvelopeForRequest?.(request) ?? searchEnvelope(notes)
      const normalized = normalizeTikHubXiaohongshuSearchResponse(
        rawPayload,
        request,
        { encodeCursor: options.encodeCursor, capturedAt: CAPTURED_AT },
      )
      const responseHash = '1'.repeat(64)
      return {
        ...normalized,
        responseArchive: {
          contractState: 'accepted',
          capturedAt: CAPTURED_AT,
          httpStatus: 200,
          businessCode: 200,
          contentType: 'application/json',
          bodySize: 256,
          payloadSha256: responseHash,
          rawPayload,
        },
        upstreamEvidence: { requestId: 'tikhub-search-upstream-request' },
        archiveObjects: [{
          kind: 'response',
          marketplace: 'xiaohongshu',
          endpointVersion: 'app_v2',
          capturedDate: CAPTURED_AT.slice(0, 10),
          archivePath: `external/tikhub/xiaohongshu/${CAPTURED_AT.slice(0, 10)}/responses/${responseHash}.json`,
          envelopePointer: '$',
          sourceKey: responseHash,
          payloadSha256: responseHash,
          rawPayload,
        }],
        records: [],
      }
    },
    async getXiaohongshuPost(body) {
      const id = new URL(body.url).pathname.split('/').filter(Boolean).at(-1)
      calls.detail.push({ ...body, id })
      await beforeDetail?.({ ...body, id })
      if (failingDetailIds.has(id)) {
        throw new TikHubUpstreamError('detail unavailable', {
          outcome: 'rejected',
          httpStatus: 503,
          businessCode: 503,
          billed: false,
          errorCode: 'upstream_business_error',
          affectsCircuit: false,
          retryable: false,
        })
      }
      const result = detailById.get(id)
      assert.ok(result, `missing detail fixture for ${id}`)
      return result
    },
  }
}

class UsageStoreMock {
  constructor() {
    this.reservations = []
    this.released = []
    this.unknown = []
  }

  async listEffectiveGrants() { return ['xiaohongshu'] }

  async getPolicy() {
    return { maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 20 }
  }

  async getApiKeyPlatformEntitlement() { return null }

  async reapStaleReservations() {}

  async reserve(input) {
    this.reservations.push(input)
    return { kind: 'reserved', request: { id: input.requestId } }
  }

  async releaseRequest(requestId, reason) { this.released.push({ requestId, reason }) }

  async markRequestUnknown(requestId, reason) { this.unknown.push({ requestId, reason }) }
}

class PlatformStoreMock {
  constructor() {
    this.providerCalls = []
    this.stagedEvidence = []
    this.stageProviderEvidenceFailures = []
    this.liveCommits = []
    this.providerSteps = []
    this.providerFailures = []
    this.cacheCommits = []
    this.snapshots = new Map()
    this.nextCall = 1
    this.finishProviderStepFailures = []
    this.persistenceUnknown = []
    this.events = []
    this.costReservations = []
    this.releasedCostReservations = []
    this.costReservationError = null
    this.providerRateAdmissions = 0
  }

  #snapshotKey(operation, fingerprint) { return `${operation}:${fingerprint}` }

  async reapStaleCalls() {}

  async snapshotFor({ operation, fingerprint }, now) {
    const snapshot = this.snapshots.get(this.#snapshotKey(operation, fingerprint)) || null
    if (!snapshot || new Date(snapshot.staleUntil) < now) return null
    return structuredClone(snapshot)
  }

  async providerState() { return {} }

  async acquireDispatchLease() { return { kind: 'acquired' } }

  async releaseDispatchLease() {}

  async acquireProviderRateLimit() {
    this.providerRateAdmissions += 1
    return { allowed: true, retryAfterMs: 0 }
  }

  async reserveProviderCostWorkflow(input) {
    this.costReservations.push(structuredClone(input))
    if (this.costReservationError) throw this.costReservationError
    return { id: `cost-reservation-${this.costReservations.length}` }
  }

  async releaseProviderCostWorkflow(input) {
    this.releasedCostReservations.push(structuredClone(input))
    return true
  }

  async beginProviderCall(input) {
    const call = { id: `provider-call-${this.nextCall++}`, ...structuredClone(input) }
    this.providerCalls.push(call)
    return call
  }

  async stageProviderEvidence(input) {
    this.stagedEvidence.push(structuredClone(input))
    this.events.push({ kind: 'stage', callId: input.callId })
    const failure = this.stageProviderEvidenceFailures.shift()
    if (failure) throw failure
    return { staged: true, reconciled: false, alreadySettled: false }
  }

  async finishProviderStep(input) {
    this.providerSteps.push(structuredClone(input))
    this.events.push({ kind: 'finish-step', callId: input.callId, outcome: input.outcome })
    const failure = this.finishProviderStepFailures.shift()
    if (failure) throw failure
    if (input.snapshot) {
      this.snapshots.set(
        this.#snapshotKey(input.delivery.operation, input.delivery.snapshotFingerprint),
        structuredClone(input.snapshot),
      )
    }
  }

  async commitLiveDelivery(input) {
    this.liveCommits.push(structuredClone(input))
    this.events.push({ kind: 'commit-live', callId: input.callId })
    this.snapshots.set(
      this.#snapshotKey(input.delivery.operation, input.delivery.snapshotFingerprint),
      {
        responseBody: structuredClone(input.snapshotBody),
        capturedAt: new Date(input.capturedAt),
        freshUntil: new Date(input.freshUntil),
        staleUntil: new Date(input.staleUntil),
      },
    )
  }

  async commitSnapshotDelivery(input) { this.cacheCommits.push(structuredClone(input)) }

  async finishFailure(input) {
    this.providerFailures.push(structuredClone(input))
    this.events.push({ kind: 'finish-failure', callId: input.callId, outcome: input.outcome })
  }

  async rejectWithoutDispatch() {}

  async markPersistenceUnknown(input) { this.persistenceUnknown.push(structuredClone(input)) }
}

function config(overrides = {}) {
  return {
    searchContractVerified: true,
    maxConcurrency: 8,
    maxConsumerConcurrency: 4,
    maxRequestsPerMinute: 120,
    freshTtlMs: 60_000,
    staleTtlMs: 86_400_000,
    searchFreshTtlMs: 60_000,
    searchStaleTtlMs: 86_400_000,
    searchMaxEnrichItems: 20,
    billing: {
      unitCostMinor: 5,
      currency: 'CNY',
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 100_000,
    },
    ...overrides,
  }
}

function fixture(adapter, overrides = {}) {
  const usageStore = new UsageStoreMock()
  const platformStore = new PlatformStoreMock()
  const gateway = new TikHubGateway({
    usageStore,
    platformStore,
    adapter,
    config: config(overrides),
    apiKeyPepper: PEPPER,
    reservationLeaseMs: 150_000,
    logger: { warn() {}, error() {} },
  })
  const context = {
    tenant: { id: 'tenant-1', name: 'Tenant One' },
    consumer: { id: 'consumer-1', name: 'Consumer One' },
    apiKey: { id: 'api-key-1', environment: 'live', prefix: 'mih_live_' },
  }
  return { gateway, usageStore, platformStore, adapter, context }
}

function request(overrides = {}) {
  return {
    body: { platform: 'xiaohongshu', query: '便携相机', pageSize: 1 },
    idempotencyKey: 'direct-search-request-01',
    path: SEARCH_PATH,
    ...overrides,
  }
}

test('direct XHS search returns the strict modern envelope and records a primary provider call', async () => {
  const adapter = adapterFor({ notes: [note(FIRST_NOTE_ID, '完整正文，不在预览边界')] })
  const state = fixture(adapter)
  const response = await state.gateway.searchNotes(state.context, request())

  assert.equal(response.status, 200)
  assert.equal(response.sourceMode, 'live')
  assert.equal(isNightAllDataSearchV1Envelope(response.body), true)
  assert.equal(response.body.data.items[0].externalId, FIRST_NOTE_ID)
  assert.equal(response.body.data.items[0].text, '完整正文，不在预览边界')
  assert.equal(response.body.data.meta.providerCalls, 1)
  assert.equal(response.body.requestId, response.requestId)
  assert.notEqual(response.body.requestId, 'tikhub-search-upstream-request')
  assert.equal(adapter.calls.search.length, 1)
  assert.equal(adapter.calls.detail.length, 0)
  assert.equal(state.platformStore.stagedEvidence.length, 1)
  assert.equal(state.platformStore.stagedEvidence[0].callId, 'provider-call-1')
  assert.equal(state.platformStore.stagedEvidence[0].billed, true)
  assert.equal(state.platformStore.stagedEvidence[0].costMinor, 5)
  assert.equal(state.platformStore.stagedEvidence[0].itemCount, 1)
  assert.equal(state.platformStore.stagedEvidence[0].responseArchive.payloadSha256, '1'.repeat(64))
  assert.equal(state.platformStore.stagedEvidence[0].archiveObjects.length, 1)
  assert.deepEqual(state.platformStore.providerCalls.map((call) => ({
    operation: call.operation,
    callOrdinal: call.callOrdinal,
    callRole: call.callRole,
  })), [{
    operation: 'social.posts.search',
    callOrdinal: 0,
    callRole: 'primary',
  }])
})

test('search and detail dispatches use their endpoint prices before the legacy fallback', async () => {
  const snippet = '价'.repeat(60)
  const adapter = adapterFor({
    notes: [note(FIRST_NOTE_ID, snippet)],
    detailById: new Map([[FIRST_NOTE_ID, detailResult(FIRST_NOTE_ID, `${snippet}完整正文`)]]),
  })
  const state = fixture(adapter, {
    billing: {
      unitCostMinor: 5,
      unitCostMinorByEndpoint: {
        [TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY]: 7,
        [TIKHUB_XIAOHONGSHU_ENDPOINT_KEY]: 11,
      },
      currency: 'CNY',
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 100_000,
    },
  })

  await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-endpoint-cost-request-01',
  }))

  assert.deepEqual(
    state.platformStore.stagedEvidence.map(({ callId, costMinor }) => ({ callId, costMinor })),
    [
      { callId: 'provider-call-1', costMinor: 7 },
      { callId: 'provider-call-2', costMinor: 11 },
    ],
  )
  assert.equal(state.platformStore.providerSteps[0].costMinor, 11)
  assert.equal(state.platformStore.liveCommits[0].costMinor, 7)
  assert.deepEqual(state.platformStore.costReservations.map(({ costControls }) => costControls), [[{
    costMinor: 7,
    costKind: 'estimated',
    currency: 'CNY',
    monthlyBudgetMinor: 100_000,
    monthlySubsidyBudgetMinor: 100_000,
  }], [{
    costMinor: 11,
    costKind: 'estimated',
    currency: 'CNY',
    monthlyBudgetMinor: 100_000,
    monthlySubsidyBudgetMinor: 100_000,
  }]])
  assert.equal(state.platformStore.providerCalls[0].costReservationId, 'cost-reservation-1')
  assert.equal(state.platformStore.providerCalls[1].costReservationId, 'cost-reservation-2')
  assert.equal(state.platformStore.releasedCostReservations.length, 2)
})

test('primary search budget rejection occurs before consuming provider RPM or creating a provider call', async () => {
  const adapter = adapterFor({ notes: [note(FIRST_NOTE_ID, '不会调用上游')] })
  const state = fixture(adapter)
  state.platformStore.costReservationError = new AppError(
    429,
    'external_platform_cost_budget_exhausted',
    'Procurement budget exhausted',
  )

  await assert.rejects(
    state.gateway.searchNotes(state.context, request({
      idempotencyKey: 'direct-primary-budget-exhausted-01',
    })),
    (error) => error?.code === 'external_platform_cost_budget_exhausted',
  )

  assert.equal(state.platformStore.providerRateAdmissions, 0)
  assert.equal(state.platformStore.providerCalls.length, 0)
  assert.equal(adapter.calls.search.length, 0)
  assert.equal(state.usageStore.released.length, 1)
})

test('an irrecoverable primary evidence-stage failure stops before detail enrichment and retains paid evidence', async () => {
  const snippet = '预'.repeat(60)
  const adapter = adapterFor({
    notes: [note(FIRST_NOTE_ID, snippet)],
    detailById: new Map([[FIRST_NOTE_ID, detailResult(FIRST_NOTE_ID, `${snippet}完整正文`)]]),
  })
  const state = fixture(adapter)
  state.platformStore.stageProviderEvidenceFailures.push(new Error('evidence store unavailable'))

  await assert.rejects(
    state.gateway.searchNotes(state.context, request({
      idempotencyKey: 'direct-stage-failure-request-01',
    })),
    (error) => error?.code === 'internal_error',
  )
  assert.equal(adapter.calls.search.length, 1)
  assert.equal(adapter.calls.detail.length, 0)
  assert.equal(state.platformStore.liveCommits.length, 0)
  assert.equal(state.platformStore.persistenceUnknown.length, 1)
  const unknown = state.platformStore.persistenceUnknown[0]
  assert.equal(unknown.billed, true)
  assert.equal(unknown.costMinor, 5)
  assert.equal(unknown.responseArchive.payloadSha256, '1'.repeat(64))
  assert.equal(unknown.archiveObjects.length, 1)
  assert.equal(state.usageStore.released.length, 0)
})

test('an unreconciled begin-call COMMIT marks usage unknown instead of releasing it', async () => {
  const adapter = adapterFor({ notes: [note(FIRST_NOTE_ID, '不会被调用')] })
  const state = fixture(adapter)
  state.platformStore.beginProviderCall = async () => {
    throw new AppError(
      503,
      'external_platform_call_persistence_unknown',
      'Provider-call persistence could not be reconciled; do not retry automatically',
    )
  }

  await assert.rejects(
    state.gateway.searchNotes(state.context, request({
      idempotencyKey: 'direct-begin-call-unknown-01',
    })),
    (error) => error?.status === 503
      && error?.code === 'external_platform_call_persistence_unknown',
  )
  assert.equal(adapter.calls.search.length, 0)
  assert.equal(state.usageStore.released.length, 0)
  assert.equal(state.usageStore.unknown.length, 1)
  assert.equal(state.usageStore.unknown[0].reason, 'external_platform_call_persistence_unknown')
})

test('a billable primary TikHub error is staged before its stable failure settlement', async () => {
  const responseHash = '3'.repeat(64)
  const rawPayload = { code: 500, request_id: 'tikhub-search-failure', data: null }
  const responseArchive = {
    contractState: 'rejected',
    capturedAt: CAPTURED_AT,
    httpStatus: 503,
    businessCode: 500,
    contentType: 'application/json',
    bodySize: 96,
    payloadSha256: responseHash,
    rawPayload,
  }
  const archiveObjects = [{
    kind: 'response',
    marketplace: 'xiaohongshu',
    endpointVersion: 'app_v2',
    capturedDate: CAPTURED_AT.slice(0, 10),
    archivePath: `external/tikhub/xiaohongshu/${CAPTURED_AT.slice(0, 10)}/responses/${responseHash}.json`,
    envelopePointer: '$',
    sourceKey: responseHash,
    payloadSha256: responseHash,
    rawPayload,
  }]
  const adapter = adapterFor({
    notes: [],
    searchError: new TikHubUpstreamError('search rejected', {
      outcome: 'rejected',
      httpStatus: 503,
      businessCode: 500,
      billed: true,
      errorCode: 'upstream_business_error',
      affectsCircuit: false,
      retryable: false,
    }, {
      responseArchive,
      upstreamEvidence: { requestId: 'tikhub-search-failure' },
      archiveObjects,
    }),
  })
  const state = fixture(adapter)

  await assert.rejects(
    state.gateway.searchNotes(state.context, request({
      idempotencyKey: 'direct-billable-search-error-01',
    })),
    (error) => error?.code === 'external_platform_rejected',
  )
  assert.deepEqual(state.platformStore.events.map(({ kind }) => kind), [
    'stage',
    'finish-failure',
  ])
  assert.equal(state.platformStore.stagedEvidence[0].billed, true)
  assert.equal(state.platformStore.stagedEvidence[0].httpStatus, 503)
  assert.equal(state.platformStore.stagedEvidence[0].businessCode, 500)
  assert.equal(state.platformStore.stagedEvidence[0].errorCode, 'upstream_business_error')
  assert.deepEqual(state.platformStore.stagedEvidence[0].responseArchive, responseArchive)
  assert.deepEqual(state.platformStore.stagedEvidence[0].archiveObjects, archiveObjects)
  assert.equal(state.platformStore.providerFailures.length, 1)
  assert.equal(state.platformStore.liveCommits.length, 0)
  assert.equal(state.usageStore.released.length, 0)
})

test('UTF-16 length 60 candidate is enriched, while an equal-length detail cannot replace text', async () => {
  const utf16SixtyCodePointFiftyNine = `${'字'.repeat(58)}😀`
  assert.equal(utf16SixtyCodePointFiftyNine.length, 60)
  assert.equal([...utf16SixtyCodePointFiftyNine].length, 59)
  const equalLengthPreview = '预'.repeat(60)
  let state
  let detailsObservedAfterStage = 0
  const adapter = adapterFor({
    notes: [
      note(FIRST_NOTE_ID, utf16SixtyCodePointFiftyNine),
      note(SECOND_NOTE_ID, equalLengthPreview),
    ],
    detailById: new Map([
      [FIRST_NOTE_ID, detailResult(FIRST_NOTE_ID, `${utf16SixtyCodePointFiftyNine}补全正文`)],
      [SECOND_NOTE_ID, detailResult(SECOND_NOTE_ID, '等'.repeat(60))],
    ]),
    beforeDetail() {
      assert.equal(state.platformStore.stagedEvidence.length, 1)
      detailsObservedAfterStage += 1
    },
  })
  state = fixture(adapter, { searchMaxEnrichItems: 2 })
  const response = await state.gateway.searchNotes(state.context, request({
    body: { platform: 'xiaohongshu', query: '便携相机', pageSize: 2 },
  }))

  assert.equal(response.body.data.items[0].text, `${utf16SixtyCodePointFiftyNine}补全正文`)
  assert.equal(response.body.data.items[1].text, equalLengthPreview)
  assert.deepEqual(response.body.data.items[0].metrics, {
    likes: 12, comments: 4, shares: 5, views: null, bookmarks: 3,
  }, 'detail metrics must not replace the ranked search observation')
  assert.equal(response.body.data.status, 'partial')
  assert.equal(response.body.data.meta.providerCalls, 3)
  assert.deepEqual(adapter.calls.detail.map(({ id }) => id), [FIRST_NOTE_ID, SECOND_NOTE_ID])
  assert.equal(detailsObservedAfterStage, 2)
  assert.deepEqual(state.platformStore.providerCalls.map((call) => ({
    operation: call.operation,
    ordinal: call.callOrdinal,
    role: call.callRole,
  })), [
    { operation: 'social.posts.search', ordinal: 0, role: 'primary' },
    { operation: 'social.posts.resolve', ordinal: 1, role: 'enrichment' },
    { operation: 'social.posts.resolve', ordinal: 2, role: 'enrichment' },
  ])
})

test('the default quality budget repairs all twelve 60-character previews in a real search page', async () => {
  const ids = Array.from(
    { length: 12 },
    (_, index) => `675d277d000000000600e6${index.toString(16).padStart(2, '0')}`,
  )
  const preview = '预'.repeat(60)
  const adapter = adapterFor({
    notes: ids.map((id) => note(id, preview)),
    detailById: new Map(ids.map((id, index) => [
      id,
      detailResult(id, `${preview}完整正文-${index}`),
    ])),
  })
  const state = fixture(adapter)

  const response = await state.gateway.searchNotes(state.context, request({
    body: { platform: 'xiaohongshu', query: '十二条边界正文', pageSize: 12 },
  }))

  assert.equal(adapter.calls.detail.length, 12)
  assert.equal(response.body.data.meta.providerCalls, 13)
  assert.deepEqual(
    response.body.data.items.map((item) => item.text),
    ids.map((_id, index) => `${preview}完整正文-${index}`),
  )
  assert.equal(response.body.data.status, 'ok')
  assert.deepEqual(response.body.data.warnings, [])
})

test('detail failure keeps the usable 60-character snippet and returns a partial response', async () => {
  const snippet = '片'.repeat(60)
  const adapter = adapterFor({
    notes: [note(FIRST_NOTE_ID, snippet)],
    failingDetailIds: new Set([FIRST_NOTE_ID]),
  })
  const search = adapter.searchXiaohongshuNotes.bind(adapter)
  adapter.searchXiaohongshuNotes = async (...args) => {
    const result = await search(...args)
    return {
      ...result,
      records: [{
        id: `xiaohongshu:${FIRST_NOTE_ID}`,
        externalId: FIRST_NOTE_ID,
        body: snippet,
        extensions: { bodyCompleteness: 'provider_preview' },
      }],
    }
  }
  const state = fixture(adapter)
  const response = await state.gateway.searchNotes(state.context, request())

  assert.equal(response.status, 200)
  assert.equal(response.body.data.items[0].text, snippet)
  assert.equal(response.body.data.status, 'partial')
  assert.equal(response.body.data.meta.providerCalls, 2)
  assert.deepEqual(response.body.data.warnings.map(({ code }) => code), [
    'xiaohongshu_detail_incomplete',
    'xiaohongshu_detail_unavailable',
  ])
  assert.equal(state.platformStore.providerSteps.length, 1)
  assert.equal(state.platformStore.providerSteps[0].outcome, 'rejected')
  assert.equal(state.platformStore.liveCommits.length, 1, 'search result remains commit-worthy')
  assert.equal(
    state.platformStore.liveCommits[0].ingestJob.payload.records[0].extensions.bodyCompleteness,
    'provider_preview',
    'failed detail repair must not drop the paid preview from PG/outbox/ES ingest',
  )
})

test('detail subsidy exhaustion returns the paid primary result without any partial fan-out', async () => {
  const snippet = '补'.repeat(60)
  const adapter = adapterFor({
    notes: [note(FIRST_NOTE_ID, snippet)],
    detailById: new Map([[FIRST_NOTE_ID, detailResult(FIRST_NOTE_ID, `${snippet}完整正文`)]]),
  })
  const state = fixture(adapter)
  const reserveCost = state.platformStore.reserveProviderCostWorkflow.bind(state.platformStore)
  let costAdmissions = 0
  state.platformStore.reserveProviderCostWorkflow = async (input) => {
    costAdmissions += 1
    if (costAdmissions === 2) {
      throw new AppError(
        429,
        'external_platform_subsidy_budget_exhausted',
        'Subsidy budget exhausted',
      )
    }
    return reserveCost(input)
  }

  const response = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-detail-subsidy-exhausted-01',
  }))

  assert.equal(response.status, 200)
  assert.equal(response.body.data.items[0].text, snippet)
  assert.equal(response.body.data.status, 'partial')
  assert.equal(response.body.data.meta.providerCalls, 1)
  assert.equal(adapter.calls.search.length, 1)
  assert.equal(adapter.calls.detail.length, 0)
  assert.equal(state.platformStore.providerCalls.length, 1)
  assert.equal(state.platformStore.costReservations.length, 1)
  assert.equal(state.platformStore.releasedCostReservations.length, 1)
  assert.equal(state.platformStore.liveCommits.length, 1)
})

test('a staged detail with an unconfirmed settlement closes unknown with identical evidence and no redispatch', async () => {
  const snippet = '证'.repeat(60)
  const adapter = adapterFor({
    notes: [note(FIRST_NOTE_ID, snippet)],
    detailById: new Map([[FIRST_NOTE_ID, detailResult(FIRST_NOTE_ID, `${snippet}完整正文`)]]),
  })
  const state = fixture(adapter)
  state.platformStore.finishProviderStepFailures.push(new Error('detail settlement acknowledgement unavailable'))

  const response = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-detail-settlement-unknown-01',
  }))

  assert.equal(response.status, 200)
  assert.equal(response.body.data.items[0].text, snippet)
  assert.equal(response.body.data.status, 'partial')
  assert.equal(adapter.calls.detail.length, 1, 'persistence recovery must not call TikHub again')
  assert.equal(state.platformStore.stagedEvidence.length, 2)
  assert.equal(state.platformStore.stagedEvidence[1].callId, 'provider-call-2')
  assert.deepEqual(state.platformStore.providerSteps.map(({ outcome }) => outcome), [
    'succeeded',
    'unknown',
  ])
  const [desired, unknown] = state.platformStore.providerSteps
  assert.equal(desired.costMinor, 5, 'legacy unitCostMinor remains the endpoint fallback')
  assert.equal(unknown.httpStatus, desired.httpStatus)
  assert.equal(unknown.businessCode, desired.businessCode)
  assert.equal(unknown.billed, true)
  assert.equal(unknown.costMinor, desired.costMinor)
  assert.deepEqual(unknown.responseArchive, desired.responseArchive)
  assert.deepEqual(unknown.upstreamEvidence, desired.upstreamEvidence)
  assert.deepEqual(unknown.archiveObjects, desired.archiveObjects)
  assert.equal(unknown.errorCode, desired.errorCode)
  assert.equal(unknown.snapshot, null)
  assert.equal(unknown.ingestJob, null)
  assert.equal(state.platformStore.liveCommits.length, 1, 'the independent search usage remains commit-worthy')
  assert.deepEqual(state.platformStore.events.map(({ kind }) => kind), [
    'stage',
    'stage',
    'finish-step',
    'finish-step',
    'commit-live',
  ])
  assert.equal(state.usageStore.released.length, 0)
  assert.equal(state.usageStore.unknown.length, 0)
})

test('a fresh search snapshot returns without any second search or detail provider call', async () => {
  const adapter = adapterFor({ notes: [note(FIRST_NOTE_ID, '可缓存的完整正文')] })
  const state = fixture(adapter)
  const first = await state.gateway.searchNotes(state.context, request())
  const cached = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-search-request-02',
  }))

  assert.equal(first.sourceMode, 'live')
  assert.equal(cached.sourceMode, 'fresh_cache')
  assert.notEqual(cached.requestId, first.requestId)
  assert.equal(cached.body.requestId, cached.requestId)
  assert.deepEqual(cached.body.data, first.body.data)
  assert.equal(adapter.calls.search.length, 1)
  assert.equal(adapter.calls.detail.length, 0)
  assert.equal(state.platformStore.providerCalls.length, 1)
  assert.equal(state.platformStore.cacheCommits.length, 1)
})

test('stale detail snapshots are not silently merged into a new search observation', async () => {
  const snippet = '旧'.repeat(60)
  const failingDetailIds = new Set()
  const adapter = adapterFor({
    notes: [note(FIRST_NOTE_ID, snippet)],
    detailById: new Map([[FIRST_NOTE_ID, detailResult(FIRST_NOTE_ID, `${snippet}首次完整正文`)]]),
    failingDetailIds,
  })
  const state = fixture(adapter)
  const first = await state.gateway.searchNotes(state.context, request())
  assert.equal(first.body.data.items[0].text, `${snippet}首次完整正文`)

  const detailSnapshot = [...state.platformStore.snapshots.entries()]
    .find(([key]) => key.startsWith('social.posts.resolve:'))
  assert.ok(detailSnapshot)
  detailSnapshot[1].freshUntil = new Date(Date.now() - 1_000)
  detailSnapshot[1].staleUntil = new Date(Date.now() + 60_000)
  failingDetailIds.add(FIRST_NOTE_ID)

  const second = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-search-stale-detail-02',
    body: { platform: 'xiaohongshu', query: '另一搜索', pageSize: 1 },
  }))

  assert.equal(second.body.data.items[0].text, snippet)
  assert.equal(second.body.data.status, 'partial')
  assert.deepEqual(second.body.data.warnings.map(({ code }) => code), [
    'xiaohongshu_detail_incomplete',
    'xiaohongshu_detail_unavailable',
  ])
  assert.equal(adapter.calls.search.length, 2)
  assert.equal(adapter.calls.detail.length, 2)
})

test('legacy mode projects the same direct result into a standard raw envelope', async () => {
  const text = 'legacy 调用获得的完整正文'
  const adapter = adapterFor({ notes: [note(FIRST_NOTE_ID, text)] })
  const state = fixture(adapter)
  const response = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-legacy-request-01',
    path: RAW_SEARCH_PATH,
    responseMode: 'legacy',
  }))
  const rows = JSON.parse(response.body.data.raw_data)

  assert.equal(isNightAllLegacyEnvelope(response.body), true)
  assert.equal(response.body.data.raw_info, '[]')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].content_id, FIRST_NOTE_ID)
  assert.equal(rows[0].text, text)
  assert.equal(rows[0].full_text, text)
  assert.equal(rows[0].content, text)
  assert.equal(response.body.data.meta.providerCalls, 1)
  assert.equal(response.body.data.page.nextParams, null)
  assert.equal(response.body.data.page.nextPage, null)
  assert.equal(response.body.data.page.paginationMode, 'cursor')
  assert.equal(adapter.calls.search.length, 1)
  assert.equal(adapter.calls.detail.length, 0)
})

test('legacy direct pagination accepts its opaque cursor and keeps the second page on TikHub', async () => {
  const firstNote = note(FIRST_NOTE_ID, '第一页完整正文')
  const secondNote = note(SECOND_NOTE_ID, '第二页完整正文')
  const adapter = adapterFor({
    notes: [firstNote],
    searchEnvelopeForRequest(searchRequest) {
      return searchRequest.page === 1
        ? searchEnvelope([firstNote], {
            hasMore: true,
            searchId: 'provider-search-id-secret',
            searchSessionId: 'provider-session-id-secret',
          })
        : searchEnvelope([secondNote], { hasMore: false, page: searchRequest.page })
    },
  })
  const state = fixture(adapter)
  const first = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-legacy-page-one-01',
    path: RAW_SEARCH_PATH,
    responseMode: 'legacy',
  }))
  const cursor = first.body.data.page.nextCursor

  assert.match(cursor, /^mxec2\./u)
  assert.equal(first.body.data.page.nextParams, null)
  assert.equal(first.body.data.page.nextPage, null)
  assert.equal(first.body.data.page.paginationMode, 'cursor')
  assert.equal(cursor.includes('provider-search-id-secret'), false)

  const second = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-legacy-page-two-01',
    path: RAW_SEARCH_PATH,
    responseMode: 'legacy',
    body: {
      platform: 'xiaohongshu',
      query: '便携相机',
      pageSize: 1,
      cursor,
    },
  }))
  const rows = JSON.parse(second.body.data.raw_data)

  assert.equal(rows[0].content_id, SECOND_NOTE_ID)
  assert.equal(second.body.data.page.page, 2)
  assert.equal(second.body.data.page.nextCursor, null)
  assert.equal(second.body.data.page.nextParams, null)
  assert.equal(second.body.data.page.nextPage, null)
  assert.equal(second.body.data.page.paginationMode, 'cursor')
  assert.equal(adapter.calls.search.length, 2)
  assert.equal(adapter.calls.normalizedSearch[1].page, 2)
  assert.equal(adapter.calls.normalizedSearch[1].upstreamQuery.search_id, 'provider-search-id-secret')
  assert.equal(adapter.calls.normalizedSearch[1].upstreamQuery.search_session_id, 'provider-session-id-secret')
  assert.deepEqual(state.platformStore.providerCalls.map(({ operation, callRole }) => ({
    operation,
    callRole,
  })), [{
    operation: 'social.posts.search', callRole: 'primary',
  }, {
    operation: 'social.posts.search', callRole: 'primary',
  }])
})

test('turning off the search contract blocks an issued cursor before credential, cost, RPM, or provider dispatch', async () => {
  const firstNote = note(FIRST_NOTE_ID, '第一页完整正文')
  const adapter = adapterFor({
    notes: [firstNote],
    searchEnvelopeForRequest(searchRequest) {
      return searchEnvelope([firstNote], {
        hasMore: searchRequest.page === 1,
        page: searchRequest.page,
        searchId: 'disabled-rollout-provider-search',
      })
    },
  })
  const state = fixture(adapter)
  const first = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-rollout-page-one-01',
    path: RAW_SEARCH_PATH,
    responseMode: 'legacy',
  }))
  const cursor = first.body.data.page.nextCursor
  assert.match(cursor, /^mxec2\./u)

  state.gateway.config.searchContractVerified = false
  await assert.rejects(
    state.gateway.searchNotes(state.context, request({
      idempotencyKey: 'direct-rollout-page-two-01',
      path: RAW_SEARCH_PATH,
      responseMode: 'legacy',
      body: {
        platform: 'xiaohongshu',
        query: '便携相机',
        pageSize: 1,
        cursor,
      },
    })),
    (error) => error?.status === 503
      && error?.code === 'external_platform_contract_unverified',
  )

  assert.equal(adapter.calls.credential, 1)
  assert.equal(adapter.calls.search.length, 1)
  assert.equal(state.platformStore.costReservations.length, 1)
  assert.equal(state.platformStore.providerRateAdmissions, 1)
  assert.equal(state.platformStore.providerCalls.length, 1)
})

test('modern and legacy cursors are route-bound even when both projections share one snapshot', async () => {
  const firstNote = note(FIRST_NOTE_ID, '共享快照正文')
  const adapter = adapterFor({
    notes: [firstNote],
    searchEnvelopeForRequest() {
      return searchEnvelope([firstNote], {
        hasMore: true,
        searchId: 'route-bound-provider-search',
      })
    },
  })
  const state = fixture(adapter)
  const modern = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-modern-cursor-owner-01',
    path: SEARCH_PATH,
    responseMode: 'modern',
  }))
  const legacy = await state.gateway.searchNotes(state.context, request({
    idempotencyKey: 'direct-legacy-cursor-owner-01',
    path: RAW_SEARCH_PATH,
    responseMode: 'legacy',
  }))
  const modernCursor = modern.body.data.pageInfo.nextCursor
  const legacyCursor = legacy.body.data.page.nextCursor

  assert.equal(modern.sourceMode, 'live')
  assert.equal(legacy.sourceMode, 'fresh_cache')
  assert.match(modernCursor, /^mxec2\./u)
  assert.match(legacyCursor, /^mxec2\./u)
  assert.notEqual(modernCursor, legacyCursor)
  assert.equal(adapter.calls.search.length, 1, 'the route projection must not buy the shared first page twice')

  await assert.rejects(
    state.gateway.searchNotes(state.context, request({
      idempotencyKey: 'direct-modern-to-legacy-01',
      path: RAW_SEARCH_PATH,
      responseMode: 'legacy',
      body: { platform: 'xiaohongshu', query: '便携相机', pageSize: 1, cursor: modernCursor },
    })),
    (error) => error?.status === 400 && error?.code === 'invalid_cursor',
  )
  await assert.rejects(
    state.gateway.searchNotes(state.context, request({
      idempotencyKey: 'direct-legacy-to-modern-01',
      path: SEARCH_PATH,
      responseMode: 'modern',
      body: { platform: 'xiaohongshu', query: '便携相机', pageSize: 1, cursor: legacyCursor },
    })),
    (error) => error?.status === 400 && error?.code === 'invalid_cursor',
  )
  assert.equal(adapter.calls.search.length, 1)
})
