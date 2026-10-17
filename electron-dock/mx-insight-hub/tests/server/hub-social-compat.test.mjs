import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHubSocialCompatRequest as normalize, buildHubSocialCompatDispatch as dispatch, projectHubSocialCompatResponse as project, HUB_SOCIAL_COMPAT_PLATFORMS } from '../../server/contracts/hub-social-compat.mjs'
import { normalizeHubSocialRequest, normalizeTwitterResponse } from '../../server/contracts/hub-social.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'

const capturedAt = '2026-10-15T01:00:00.000Z'
const profile = { rest_id: '42', legacy: { screen_name: 'ui_batch_019', name: 'Test account', followers_count: 0, friends_count: 5 } }
const tweet = id => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { rest_id: String(id), legacy: { full_text: 'Full body\n完整正文', favorite_count: 0, bookmark_count: 2 }, core: { user_results: { result: profile } } } } } } })
const timeline = (ids, cursor) => ({ data: { user: { result: { ...profile, timeline: { timeline: { instructions: [{ entries: [ ...ids.map(tweet), ...(cursor ? [{ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: cursor } }] : []) ] }] } } } } } })
const resolved = (kind, value, username) => ({ kind, value, username: username || null, lookupComplete: true, profileReady: true })
const request = (platform, operation = 'crawl', extra = {}) => normalize(operation, { platform, userId: '42', ...extra })

test('screenshot aliases preserve nonnumeric Twitter user_id as username and large count; same aliases produce same jobs', () => {
  const first = normalize('crawl', { platform: 'x', user_id: 'ui_batch_019', page_size: '500' })
  const second = normalize('crawl', { platform: 'twitter', username: '@UI_BATCH_019', count: 500 })
  assert.equal(first.pageSize, 500)
  assert.deepEqual(first.jobs, second.jobs)
  assert.deepEqual(first.jobs[0].identity, { kind: 'username', value: 'ui_batch_019' })
  assert.equal(request('twitter', 'crawl', { count: 20, limit: 10 }).pageSize, 20)
  assert.equal(request('twitter', 'user-info', { count: 20, limit: 10 }).pageSize, 10)
  assert.equal(request('rednote').platform, 'xiaohongshu')
})

test('numeric Twitter handles keep their explicit identity through aliases, URLs and dispatch', () => {
  for (const operation of ['crawl', 'user-info']) {
    const expected = normalize(operation, { platform: 'twitter', username: '12345' })
    for (const alias of [
      { username: '12345' }, { username: '@12345' }, { usernames: ['12345'] },
      { params: { screen_name: '12345' } }, { params: { screenName: '@12345' } },
      { url: 'https://x.com/12345' }, { profileUrl: 'https://twitter.com/%31%32%33%34%35' },
      { user_id: '@12345' },
    ]) {
      const actual = normalize(operation, { platform: 'twitter', ...alias })
      assert.deepEqual(actual.jobs, expected.jobs, JSON.stringify(alias))
      assert.deepEqual(actual.jobs[0].identity, { kind: 'username', value: '12345' })
      const profile = dispatch(actual.jobs[0])
      assert.equal(profile.endpointPath, '/user/by/username/12345')
      assert.equal(profile.userId, null)
      assert.deepEqual(profile.upstreamQuery, {})
    }
  }
  const posts = dispatch(normalize('crawl', { platform: 'twitter', username: '12345' }).jobs[0], {
    resolvedIdentity: resolved('username', '12345'), pageSize: 5,
  })
  assert.equal(posts.endpointPath, '/user/-1/tweets')
  assert.deepEqual(posts.upstreamQuery, { count: 5, username: '12345' })
})

test('numeric Twitter IDs retain ID lookup and never deduplicate with an equal handle', () => {
  for (const alias of [
    { userId: '12345' }, { user_id: '12345' }, { uid: '12345' }, { userIds: ['12345'] },
    { params: { rest_id: '12345' } },
  ]) {
    const job = normalize('user-info', { platform: 'twitter', ...alias }).jobs[0]
    assert.deepEqual(job.identity, { kind: 'id', value: '12345' })
    assert.equal(dispatch(job).endpointPath, '/user/users/by/ids')
    assert.deepEqual(dispatch(job).upstreamQuery, { ids: '12345' })
  }
  const combined = normalize('user-info', { platform: 'twitter', username: '12345', userId: '12345' })
  assert.deepEqual(combined.jobs.map(job => job.identity), [
    { kind: 'id', value: '12345' }, { kind: 'username', value: '12345' },
  ])
  assert.notEqual(combined.jobs[0].id, combined.jobs[1].id)
})

test('Twitter handles retain official bounds and report specific input errors before dispatch', () => {
  for (const username of ['a', 'A_1234567890123', '123456789012345']) {
    assert.equal(normalize('crawl', { platform: 'twitter', username: `@${username}` }).jobs[0].identity.kind, 'username')
  }
  for (const username of ['mx_health_probe_202607', '1234567890123456']) {
    assert.throws(() => normalize('crawl', { platform: 'twitter', username: `@${username}` }), error => {
      assert.equal(error.status, 400)
      assert.equal(error.code, 'invalid_social_request')
      assert.match(error.message, new RegExp(`15-character.*received ${username.length} characters`))
      assert.equal(error.message.includes(username), false)
      assert.deepEqual(error.details, { platform: 'twitter', field: 'username', reason: 'username_too_long',
        actualLength: username.length, maxLength: 15 })
      return true
    })
  }
  for (const username of ['Alice Smith', 'name-with-dash', '中文账号', '@']) {
    assert.throws(() => normalize('crawl', { platform: 'twitter', username }), error => {
      assert.equal(error.code, 'invalid_social_request')
      assert.equal(error.details.reason, 'username_invalid_characters')
      assert.match(error.message, /letters.*digits.*underscores/)
      return true
    })
  }
  const id = '1234567890123456789'
  assert.deepEqual(normalize('crawl', { platform: 'twitter', userId: id }).jobs[0].identity, { kind: 'id', value: id })
  assert.throws(() => normalize('crawl', { platform: 'twitter', username: 'valid', params: { screen_name: 'invalid name' } }),
    { code: 'invalid_social_request' })
})

test('original Twitter contract uses the same actionable handle error without changing numeric handles', () => {
  const numeric = normalizeHubSocialRequest('user-info', { platform: 'twitter', username: '12345' })
  assert.equal(numeric.endpointPath, '/user/by/username/12345')
  for (const username of ['mx_health_probe_202607', 'name-with-dash']) {
    let expected
    try { normalize('user-info', { platform: 'twitter', username }) } catch (error) { expected = error }
    assert.throws(() => normalizeHubSocialRequest('user-info', { platform: 'twitter', username }), error => {
      assert.equal(error.message, expected.message)
      assert.deepEqual(error.details, expected.details)
      return true
    })
  }
})

test('legacy numeric-handle normalization is only available to internal receipt verification', () => {
  const body = { platform: 'twitter', username: '12345' }
  const old = normalize('crawl', body, { legacyTwitterIdentity: true })
  const id = normalize('crawl', { platform: 'twitter', userId: '12345' })
  assert.deepEqual(old.fingerprintBody, id.fingerprintBody)
  assert.notDeepEqual(normalize('crawl', body).fingerprintBody, old.fingerprintBody)
  assert.throws(() => normalize('crawl', { ...body, legacyTwitterIdentity: true }), { code: 'unsupported_fields' })
  assert.throws(() => normalize('crawl', { ...body, params: { legacyTwitterIdentity: true } }), { code: 'unsupported_fields' })
})

test('preserves identity lists and prevents hidden supplier work controls before a dispatch', () => {
  const input = normalize('crawl', { platform: 'twitter', userIds: ['42', 'ui_batch_019'], usernames: ['@ui_batch_019'], pageSize: 2 })
  assert.equal(input.jobs.length, 2)
  for (const extra of [{ platforms: ['twitter'] }, { includeRaw: true }, { provider: 'rapidapi' }, { params: { endpoint: 'foo' } }, { params: { apiKey: 'secret' } }, { params: { after: 'supplier-secret' } }, { params: { count: 300 } }, { params: { page: 2 } }, { page: 2 }, { pageSize: 10, page_size: 11 }]) {
    assert.throws(() => request('twitter', 'crawl', extra), { status: 400 })
  }
  assert.throws(() => normalize('crawl', { platform: 'twitter', username: 'test', pageSize: 101 }, { maxPageSize: 100 }), { status: 400 })
  assert.throws(() => normalize('crawl', { platform: 'twitter', userIds: Array.from({length: 11}, (_, n) => String(n)), pageSize: 500 }), { code: 'social_work_limit_exceeded' })
  assert.throws(() => request('twitter', 'crawl', { url: 'https://twitter.com.evil.invalid/example' }), { status: 400 })
  assert.throws(() => normalize('crawl', { platform: 'weibo', userId: '42', params: { feature: [] } }), { status: 400 }, 'invalid eventual content params fail before the profile request')
})

test('all advertised platforms have reviewed independent profile and content descriptors', () => {
  for (const platform of HUB_SOCIAL_COMPAT_PLATFORMS) {
    const input = request(platform), job = input.jobs[0]
    const first = dispatch(job)
    assert.equal(first.socialCompat.stage, 'resolve', platform)
    assert.ok(first.endpointKey && first.endpointVersion && first.endpointContractVersion, platform)
    const data = dispatch(job, { resolvedIdentity: resolved(job.identity.kind, job.identity.value, 'sample') })
    assert.equal(data.socialCompat.stage, 'data', platform)
    assert.ok(data.endpointPath.startsWith(platform === 'twitter' ? '/user/' : '/api/'), platform)
    assert.notEqual(data.provider, 'night-all')
  }
})

test('Twitter profile-first projection preserves zero and raw aliases; one short page keeps its advancing token', () => {
  const job = normalize('crawl', { platform: 'twitter', user_id: 'ui_batch_019', page_size: 500 }).jobs[0]
  const profileStep = dispatch(job)
  const account = project({ data: { user: { result: profile } } }, profileStep, { capturedAt })
  assert.equal(account.resolvedIdentity.value, '42')
  assert.equal(account.profiles[0].followers_count, 0)
  assert.equal(account.profiles[0].following_count, 5)
  const step = dispatch(job, { resolvedIdentity: account.resolvedIdentity, pageSize: 500 })
  assert.equal(step.upstreamQuery.count, 50)
  const result = project(timeline(['101'], 'next-1'), step, { capturedAt })
  assert.equal(result.acquiredItems.length, 1)
  assert.equal(result.acquiredItems[0].like_count, 0)
  assert.equal(result.acquiredItems[0].bookmark_count, 2)
  assert.equal(result.acquiredItems[0].text, 'Full body\n完整正文')
  assert.deepEqual(result.providerPage, { hasMore: true, nextParams: { cursor: 'next-1' }, nextPage: 2 })
  assert.ok(isPostgresSafeJsonValue(result))
})

test('managed Twitter parser accepts full overflow and empty advancing pages but rejects cycle; legacy counts are unchanged', async () => {
  const job = request('twitter').jobs[0]
  const step = dispatch(job, { resolvedIdentity: resolved('id', '42'), pageSize: 1 })
  const result = project(timeline(['101', '102'], 'next-1'), step, { capturedAt })
  assert.equal(result.acquiredItems.length, 2)
  assert.equal(project(timeline([], 'next-2'), step, { capturedAt }).providerPage.hasMore, true)
  const stopped = project(timeline(['101'], 'next-1'), dispatch(job, { resolvedIdentity: resolved('id', '42'), nextParams: { cursor: 'next-1' } }))
  assert.equal(stopped.acquiredItems.length, 1)
  assert.equal(stopped.providerPage.stopReason, 'repeated_cursor')
  assert.equal(stopped.providerPage.hasMore, false)
  const legacy = normalizeHubSocialRequest('crawl', { platform: 'twitter', userId: '42', count: 1 })
  assert.throws(() => normalizeTwitterResponse(timeline(['101', '102']), legacy), /exceeds_requested_count/)
  let calls = 0
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-key', fetchImpl: async () => { calls++; return new Response(JSON.stringify(timeline(['101', '102'], 'next-1')), {status: 200}) } })
  const response = await adapter.execute(step, { encodeCursor: () => null })
  assert.equal(response.items.length, 2)
  assert.equal(calls, 1)
})

const fixtures = {
  facebook: { data: { results: [{ post_id: 'a1', message: 'full facebook', reactions_count: 0 }], nextCursor: 'next' } },
  instagram: { data: { items: [{ id: 'a1', caption: { text: 'caption' }, user: { id: '42', username: 'sample' } }], page_info: { has_next_page: true, end_cursor: 'next' } } },
  bilibili: { data: { list: { vlist: [{ aid: 1, id: 'a1', title: 'video', description: 'body', mid: 42 }] } } },
  douyin: { data: { aweme_list: [{ aweme_id: 'a1', desc: 'body', statistics: { digg_count: 0 } }], has_more: 1, max_cursor: 20 } },
  kuaishou: { data: { feeds: [{ photo_id: 'a1', caption: 'body' }], pcursor: 'next' } },
  weibo: { data: { list: [{ id: 'a1', text_raw: 'body' }], since_id: 'next' } },
  xiaohongshu: { data: { data: { notes: [{ note_id: 'a1', title: 'note', desc: 'body' }], has_more: true, cursor: 'next' } } },
  youtube: { data: { videos: [{ video_id: 'a1', title: 'video', thumbnail: 'https://image.invalid/test.jpg' }], continuation_token: 'next' } },
  zhihu: { data: { data: [{ id: 'a1', title: 'article', content: '<p>body</p>' }], paging: { is_end: false } } },
  tiktok: { data: { aweme_list: [{ aweme_id: 'a1', desc: 'body' }], has_more: 1, max_cursor: 20 } },
  linkedin: { data: { posts: [{ urn: 'a1', text: 'body' }], pagination_token: 'next' } },
  reddit: { data: { children: [{ kind: 't3', data: { name: 't3_a1', id: 'a1', title: 'post', selftext: 'body' } }], after: 't3_next' } },
}
for (const [platform, payload] of Object.entries(fixtures)) test(`explicit ${platform} collection retains all rows and normalizes safe native continuation`, () => {
  const job = request(platform).jobs[0]
  const step = dispatch(job, { resolvedIdentity: resolved(job.identity.kind, job.identity.value, 'sample'), pageSize: 1 })
  const result = project(payload, step, { capturedAt })
  assert.equal(result.acquiredItems.length, 1)
  assert.equal(result.acquiredItems[0].content_id, 'a1')
  assert.equal(result.acquiredItems[0].platform_name, platform)
  assert.ok(result.providerPage.nextParams, platform)
  assert.ok(isPostgresSafeJsonValue(result), platform)
  const next = dispatch(job, { resolvedIdentity: resolved(job.identity.kind, job.identity.value, 'sample'), nextParams: result.providerPage.nextParams, page: 2, pageSize: 1 })
  assert.notDeepEqual(next.upstreamQuery, step.upstreamQuery)
})

test('profile projection preserves unknown metrics and prevents account cross-assignment', () => {
  const job = request('instagram', 'user-info', { userId: '42' }).jobs[0]
  const result = project({ data: { user: { pk: '42', username: 'sample', full_name: 'Sample', follower_count: 0 } } }, dispatch(job), { capturedAt })
  assert.equal(result.profiles[0].followers_count, 0)
  assert.equal(result.profiles[0].following_count, null)
  assert.ok(isPostgresSafeJsonValue(result))
  assert.throws(() => project({data:{user:{pk:'43',username:'sample'}}}, dispatch(job)), /does not match/)
  const usernameJob = normalize('user-info', { platform: 'instagram', username: 'expected' }).jobs[0]
  assert.throws(() => project({data:{user:{pk:'43',username:'other'}}}, dispatch(usernameJob)), /does not match/)
})

test('XHS exact unique username lookup resolves then fetches full profile before posts', () => {
  const job = normalize('crawl', { platform: 'xhs', username: 'example' }).jobs[0]
  const lookup = dispatch(job)
  assert.equal(lookup.socialCompat.kind, 'lookup')
  assert.throws(() => project({data:{data:{users:[{id:'42',name:'example'}]}}}, lookup), /ambiguous/, 'a display name is not an account identity')
  assert.throws(() => project({data:{data:{users:[{id:'42',red_id:'example'},{id:'43',red_id:'example'}]}}}, lookup), /ambiguous/)
  const found = project({data:{data:{users:[{id:'42',red_id:'other'},{id:'43',red_id:'example'}]}}}, lookup, {capturedAt})
  assert.equal(found.resolvedIdentity.value, '43')
  assert.equal(found.resolvedIdentity.profileReady, false)
  const profileStep = dispatch(job, {resolvedIdentity:found.resolvedIdentity})
  assert.equal(profileStep.socialCompat.kind, 'profile')
  const profile = project({data:{data:{user_id:'43',nickname:'example',followers:0}}}, profileStep, {capturedAt})
  assert.equal(dispatch(job,{resolvedIdentity:profile.resolvedIdentity}).socialCompat.kind, 'posts')
})

test('profiles reject malformed metrics, identity-only envelopes and different returned handles', () => {
  const job = request('instagram', 'user-info').jobs[0]
  const result = project({data:{user:{id:'42',username:'sample',follower_count:true,following_count:'',post_count:1.5}}},dispatch(job),{capturedAt})
  assert.equal(result.profiles[0].followers_count,null)
  assert.equal(result.profiles[0].following_count,null)
  assert.equal(result.profiles[0].statuses_count,null)
  assert.throws(()=>project({data:{user:{id:Number.MAX_SAFE_INTEGER+2,username:'sample'}}},dispatch(job)),/losslessly/)
  const handle = normalize('user-info',{platform:'instagram',username:'sample'}).jobs[0]
  assert.throws(()=>project({data:{id:'42'}},dispatch(handle)),/does not match/)
  const douyin = normalize('user-info',{platform:'douyin',username:'sample'}).jobs[0]
  assert.throws(()=>project({data:{user:{uid:'42',unique_id:'another'}}},dispatch(douyin)),/does not match/)
  const linkedin = normalize('crawl',{platform:'linkedin',url:'https://www.linkedin.com/company/example',activityTypes:['company_posts']}).jobs[0]
  const step = dispatch(linkedin)
  assert.equal(step.endpointPath,'/api/v1/linkedin/web_v2/get_company_profile')
  assert.throws(()=>project({data:{id:'42',universalName:'other'}},step),/does not match/)
  assert.equal(project({data:{id:'42',universalName:'example'}},step,{capturedAt}).resolvedIdentity.value,linkedin.identity.value)
  assert.throws(()=>normalize('user-info',{platform:'instagram',url:'https://instagram.com/%E0'}),{status:400})
})

test('profile activity rows keep real user identities and continuation distinguishes unknown, terminal and stuck', () => {
  const job = request('instagram','crawl',{activityTypes:['followers']}).jobs[0]
  const step = dispatch(job,{resolvedIdentity:resolved('id','42','example')})
  const users = project({data:{users:[{id:'51',username:'follower'}],has_more:false}},step,{capturedAt})
  assert.equal(users.acquiredItems[0].user_id,'51')
  assert.equal(users.acquiredItems[0].objectType,'user')
  assert.equal(Object.hasOwn(users.acquiredItems[0],'content_id'),false)
  const nativeJob = request('douyin').jobs[0], native = dispatch(nativeJob,{resolvedIdentity:resolved('id','42')})
  assert.equal(project({data:{aweme_list:[{aweme_id:'a1',desc:'body'}]}},native).providerPage.hasMore,null)
  assert.throws(()=>project({data:{aweme_list:[],has_more:true,max_cursor:0}},native),/terminal continuation/)
  assert.throws(()=>project({data:{aweme_list:[],is_end:'unknown'}},native),/Invalid upstream continuation flag/)
  assert.throws(()=>project({data:{aweme_list:[{aweme_id:'a'.repeat(257),desc:'body'}]}},native),/identity is invalid/)
})

test('unknown collections and unsafe IDs cannot become synthetic single posts; contradictory cursors fail closed', () => {
  const job = request('douyin').jobs[0], step = dispatch(job, { resolvedIdentity: resolved('id', '42') })
  assert.throws(() => project({data:{suggestions:[{id:'suggestion',title:'other'}]}}, step), /recognized collection/)
  assert.throws(() => project({data:{aweme_list:[{desc:'body without ID'}]}}, step), /stable upstream identity/)
  assert.throws(() => project({data:{aweme_list:[{aweme_id:Number.MAX_SAFE_INTEGER + 2,desc:'body'}]}}, step), /losslessly/)
  assert.throws(() => project({data:{aweme_list:[],has_more:1}}, step), /without a continuation/)
  assert.throws(() => project({hasMore:false,data:{aweme_list:[],has_more:1,max_cursor:20}}, step), /Conflicting/)
  const terminal = project({data:{aweme_list:[],has_more:0,max_cursor:20}}, step)
  assert.equal(terminal.providerPage.hasMore, false)
})

test('Xiaohongshu continues with the last note cursor and preserves Basic Info fields/interactions', () => {
  const userId = '507f1f77bcf86cd799439011'
  const job = request('xiaohongshu', 'crawl', {userId}).jobs[0]
  const info = project({code:200,data:{data:{basic_info:{userid:userId,nickname:'Example',red_id:'example',images:'https://image.invalid/profile.jpg'},interactions:[{type:'fans',count:0},{type:'follows',count:3}]}}},dispatch(job),{capturedAt})
  assert.equal(info.profiles[0].user_id, userId)
  assert.equal(info.profiles[0].followers_count, 0)
  assert.equal(info.profiles[0].following_count, 3)
  const step = dispatch(job,{resolvedIdentity:info.resolvedIdentity})
  const result = project({code:200,data:{data:{notes:[{id:'a1',title:'note',cursor:'per-note-cursor'}],has_more:true}}},step,{capturedAt})
  assert.deepEqual(result.providerPage.nextParams,{cursor:'per-note-cursor'})
})

test('Bilibili aid and Instagram pk are content IDs, never the author ID or username', () => {
  for(const [platform,item,collection] of [['bilibili',{aid:123,mid:99,title:'video'},'videos'],['instagram',{pk:123,username:'author',caption:{text:'body'}},'items']]) {
    const job=request(platform).jobs[0], step=dispatch(job,{resolvedIdentity:resolved('id','42','author')})
    assert.equal(project({data:{[collection]:[item],has_more:false}},step,{capturedAt}).acquiredItems[0].content_id,'123')
    assert.throws(()=>project({data:{[collection]:[{username:'author',title:'missing post ID'}],has_more:false}},step),/stable upstream identity/)
  }
})
