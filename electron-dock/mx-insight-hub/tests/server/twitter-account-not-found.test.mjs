import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch } from '../../server/contracts/hub-social-compat.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'

const account = normalizeHubSocialCompatRequest('crawl', { platform: 'twitter', username: 'Brain6ur', count: 30 })
const lookup = buildHubSocialCompatDispatch(account.jobs[0], { pageSize: account.pageSize })
const missing = { data: {}, userExists: false }
const adapterFor = (payload, status = 200) => new RapidApiAdapter({
  apiKey: 'offline-twitter-account-fixture',
  fetchImpl: async () => Response.json(payload, { status }),
})

test('account lookup recognizes the retained AIO negative result without claiming supplier billing', async () => {
  // Match the verified 30-byte receipt size without claiming its original
  // whitespace was returned by the operator's parsed JSON diagnostic.
  const bytes = Buffer.from(JSON.stringify(missing))
  assert.equal(bytes.length, 30)
  const adapter = new RapidApiAdapter({ apiKey: 'offline-twitter-account-fixture',
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) })
  await assert.rejects(adapter.execute(lookup), error => {
    assert.deepEqual(error.evidence, {
      outcome: 'rejected', billed: null, httpStatus: 200, businessCode: null,
      errorCode: 'social_account_not_found', affectsCircuit: false,
    })
    assert.equal(error.responseArchive.contractState, 'rejected')
    assert.deepEqual(JSON.parse(error.restrictedResponseArchive.bodyBytes.toString()), missing)
    assert.deepEqual(error.restrictedResponseArchive.bodyBytes, bytes)
    assert.equal(error.restrictedResponseArchive.bodySha256, createHash('sha256').update(bytes).digest('hex'))
    return true
  })
})

test('an empty profile alone or contradictory response is still unusable, not proof of a missing account', async () => {
  for (const payload of [
    { data: {} },
    { data: {}, userExists: 'false' },
    { data: {}, userExists: true },
    { data: null, userExists: false },
    { data: [], userExists: false },
    { data: {}, userExists: false, errors: [{ code: 88 }] },
    { data: {}, userExists: false, errors: 'unavailable' },
    { data: {}, userExists: false, errors: {} },
    { data: {}, userExists: false, error: 'unavailable' },
    { data: { user: { result: {} } }, userExists: false },
  ]) {
    await assert.rejects(adapterFor(payload).execute(lookup), error => {
      assert.equal(error.evidence.outcome, 'succeeded_unusable')
      assert.equal(error.evidence.errorCode, 'social_upstream_response_unusable')
      return true
    })
  }
})

test('HTTP failures keep their existing transport classification despite a negative account body', async () => {
  for (const [status, outcome] of [[429, 'rejected'], [503, 'unknown']]) {
    await assert.rejects(adapterFor(missing, status).execute(lookup), error => {
      assert.equal(error.evidence.httpStatus, status)
      assert.equal(error.evidence.outcome, outcome)
      assert.equal(error.evidence.errorCode, 'social_upstream_rejected')
      return true
    })
  }
})

test('explicit UserUnavailable lookup envelopes produce bounded account reasons and retain exact receipts', async () => {
  for (const [reason, expected] of [['Suspended', 'suspended'], ['Deactivated', 'deactivated'], ['Deleted', 'deleted'],
    ['Protected', 'protected'], ['NotFound', 'not_found'], ['NoReason', 'unavailable'], ['constructor', 'unavailable'],
    ['private-account-or-key', 'unavailable'], [undefined, 'unavailable']]) {
    const user = { __typename: 'UserUnavailable', reason, message: 'private upstream text' }
    for (const data of [{ users: [user] }, { users: [{ result: user }] }, { user: { result: user } },
      { user_result_by_screen_name: { result: user } }, { result: user }]) {
      await assert.rejects(adapterFor({ data }).execute(lookup), error => {
        assert.equal(error.evidence.errorCode, 'social_account_unavailable')
        assert.equal(error.evidence.accountReason, expected)
        assert.equal(error.evidence.outcome, 'rejected')
        assert.equal(error.evidence.affectsCircuit, false)
        assert.equal(error.evidence.billed, null)
        assert.doesNotMatch(JSON.stringify(error.evidence), /private/)
        assert.deepEqual(JSON.parse(error.restrictedResponseArchive.bodyBytes), JSON.parse(JSON.stringify({ data })))
        assert.equal(error.responseArchive.contractState, 'rejected')
        return true
      })
    }
  }
})

test('ambiguous, contradictory, nested, and HTTP-failed unavailable results are not account rejections', async () => {
  const user = { __typename: 'UserUnavailable', reason: 'Suspended' }
  for (const data of [{ users: user }, { result: [user] }, { users: [user, user] }, { users: [user], result: {} },
    { users: [{ ...user, legacy: {} }] }, { users: [{ ...user, error: 'failed' }] },
    { users: [{ __typename: 'User', reason: 'Suspended' }] }, { unknown: { result: user } }]) {
    await assert.rejects(adapterFor({ data }).execute(lookup), e => e.evidence.errorCode === 'social_upstream_response_unusable')
  }
  await assert.rejects(adapterFor({ data: { users: [user] }, errors: [{ code: 88 }] }).execute(lookup),
    e => e.evidence.errorCode === 'social_upstream_response_unusable')
  for (const status of [401, 429, 503]) await assert.rejects(adapterFor({ data: { users: [user] } }, status).execute(lookup),
    e => e.evidence.errorCode === 'social_upstream_rejected' && e.evidence.httpStatus === status)
  const oldLookup = normalizeHubSocialRequest('user-info', { platform: 'twitter', username: 'Brain6ur' })
  await assert.rejects(adapterFor({ data: { users: [user] } }).execute(oldLookup),
    e => e.evidence.errorCode === 'social_upstream_response_unusable')
})

test('the account-specific negative result does not reinterpret old social or search responses', async () => {
  const tweets = buildHubSocialCompatDispatch(account.jobs[0], {
    resolvedIdentity: { kind: 'id', value: '42', profileReady: true, lookupComplete: true },
  })
  for (const request of [
    normalizeHubSocialRequest('user-info', { platform: 'twitter', username: 'Brain6ur' }),
    normalizeHubSocialRequest('search', { platform: 'twitter', query: 'Brain6ur' }),
    tweets,
  ]) {
    await assert.rejects(adapterFor(missing).execute(request), error => {
      assert.equal(error.evidence.outcome, 'succeeded_unusable')
      assert.equal(error.evidence.errorCode, 'social_upstream_response_unusable')
      return true
    })
  }
})
