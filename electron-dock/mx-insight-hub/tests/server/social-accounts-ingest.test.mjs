import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeSocialAccountSearchRequest,
  normalizeSocialAccountSearchResponse,
} from '../../server/contracts/social-accounts.mjs'
import {
  SOCIAL_ACCOUNT_DATASET_ID,
  normalizeSocialAccountArchiveObjects,
} from '../../server/ingest/social-accounts.mjs'

const XHS_USER = {
  id: 'u1', name: '示例账号', red_id: 'rid-1', fans: 1164,
  desc: '简介', red_official_verified: true, image: 'https://example.invalid/a.jpg',
}

function collect(keyword, { page = 1, user = XHS_USER, capturedAt = '2026-09-11T00:00:00Z' } = {}) {
  const request = normalizeSocialAccountSearchRequest({ platform: 'xiaohongshu', keyword, page })
  const response = normalizeSocialAccountSearchResponse(
    { code: 0, data: { users: [user] } }, request,
  )
  return normalizeSocialAccountArchiveObjects(response.archiveObjects, request, {
    capturedAt: new Date(capturedAt),
  })
}

test('an account lands in the accounts dataset keyed by platform and user id', () => {
  const { datasetId, records } = collect('示例')
  assert.equal(datasetId, SOCIAL_ACCOUNT_DATASET_ID)
  assert.equal(records.length, 1)

  const [record] = records
  assert.equal(record.externalId, 'xiaohongshu:u1')
  assert.equal(record.platform, 'xiaohongshu')
  // `profile` is the canonical object type Hub already uses for accounts.
  assert.equal(record.objectType, 'profile')
  assert.equal(record.url, 'https://www.xiaohongshu.com/user/profile/u1')
  assert.deepEqual(record.metrics, { followers: 1164 })
  assert.equal(record.stableFields.profile.verified, true)
  assert.equal(record.stableFields.attributes.servedByProvider, 'justone')
})

test('the same account found by another keyword is one row, not two', () => {
  const first = collect('关键词甲').records[0]
  const second = collect('关键词乙', { page: 7, capturedAt: '2026-09-12T00:00:00Z' }).records[0]

  assert.equal(first.externalId, second.externalId)
  // Discovery provenance is not content: a keyword rotation must not rewrite
  // every stored account as if it had changed.
  assert.equal(first.payloadSha256, second.payloadSha256)
  assert.equal(second.stableFields.discovery.keyword, '关键词乙')
  assert.equal(second.stableFields.discovery.page, 7)
})

test('a real profile change does move the content digest', () => {
  const before = collect('示例').records[0]
  const after = collect('示例', { user: { ...XHS_USER, name: '改名后' } }).records[0]

  assert.equal(before.externalId, after.externalId)
  assert.notEqual(before.payloadSha256, after.payloadSha256)
})

test('an unstated follower count is absent from metrics rather than zero', () => {
  const { records } = collect('示例', { user: { ...XHS_USER, fans: undefined, sub_title: '粉丝 1.2万' } })
  assert.deepEqual(records[0].metrics, {})
  assert.equal(records[0].stableFields.profile.followers, null)
})

test('a profile URL is only produced where its format is attested', () => {
  const douyinRequest = normalizeSocialAccountSearchRequest({ platform: 'douyin', keyword: 'x' })
  const withSecUid = normalizeSocialAccountSearchResponse({
    code: 0,
    data: {
      business_data: [{
        data: { raw_data: JSON.stringify({ user_info: { uid: 'd1', nickname: 'n', sec_uid: 'SEC1' } }) },
      }],
    },
  }, douyinRequest)
  const withoutSecUid = normalizeSocialAccountSearchResponse({
    code: 0,
    data: {
      business_data: [{
        data: { raw_data: JSON.stringify({ user_info: { uid: 'd2', nickname: 'n' } }) },
      }],
    },
  }, douyinRequest)

  const opts = { capturedAt: new Date('2026-09-11T00:00:00Z') }
  const linked = normalizeSocialAccountArchiveObjects(withSecUid.archiveObjects, douyinRequest, opts)
  const unlinked = normalizeSocialAccountArchiveObjects(withoutSecUid.archiveObjects, douyinRequest, opts)

  // Douyin profile URLs need sec_uid; without it Hub records null rather than
  // fabricating a link that would 404.
  assert.equal(linked.records[0].url, 'https://www.douyin.com/user/SEC1')
  assert.equal(unlinked.records[0].url, null)
  assert.deepEqual(unlinked.records[0].stableFields.links, [])
})

test('response-level evidence never becomes an account row', () => {
  const request = normalizeSocialAccountSearchRequest({ platform: 'xiaohongshu', keyword: 'x' })
  const { records, skipped } = normalizeSocialAccountArchiveObjects([
    { kind: 'response', rawItem: { code: 0 } },
  ], request, { capturedAt: new Date() })

  assert.deepEqual(records, [])
  assert.equal(skipped, 1)
})
