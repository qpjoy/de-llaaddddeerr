import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPostCommentProbe, loadPostCommentProbeSample, runPostCommentProbe } from '../../server/ops/probe-post-comment-contract.mjs'

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'post-comment-probe-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('saved request selects only a fixed comment endpoint and first-page identity', () => {
  const plan = planPostCommentProbe('twitter', { method: 'DELETE', url: 'https://untrusted.example/steal',
    headers: { Authorization: 'private-key' }, body: { platform: 'twitter', postId: '2117082385997250767', contentId: '2117082385997250767',
      count: 100, params: { token: 'private-secret', cursor: 'private-cursor' }, cursor: 'private-cursor' } })
  assert.deepEqual(plan, { platform: 'twitter', path: '/api/v1/data/native/j.api_bcedccd1a73cc8f2',
    body: { params: { tweetId: '2117082385997250767' }, deliveryMode: 'live_only' } })
  assert.deepEqual(planPostCommentProbe('reddit', { platform: 'reddit', postId: 't3_abc123', contentId: 'abc123' }).body.params,
    { postId: 't3_abc123' })
  assert.deepEqual(planPostCommentProbe('kuaishou', { platform: 'kuaishou', url: 'https://www.kuaishou.com/short-video/3xabc' }).body.params,
    { videoId: '3xabc' })
  for (const body of [{ platform: 'twitter', postId: 2117082385997250767 }, { platform: 'twitter', postId: '123', contentId: '124' },
    { platform: 'twitter', postId: '123', page: 2 }, { platform: 'twitter', url: 'https://untrusted.example/status/123' }]) {
    assert.throws(() => planPostCommentProbe('twitter', body), /invalid_sample/)
  }
})

test('sample directory selects one stable identity, ignores later pages, and rejects ambiguity', async t => {
  const path = await directory(t)
  await writeFile(join(path, 'twitter-page-1.request.json'), JSON.stringify({ body: { platform: 'twitter', contentId: '123' } }))
  await writeFile(join(path, 'twitter-page-2.request.json'), JSON.stringify({ body: { platform: 'twitter', contentId: '456', page: 2 } }))
  assert.equal((await loadPostCommentProbeSample(path, 'twitter')).body.params.tweetId, '123')
  await writeFile(join(path, 'twitter-alternate.request.json'), JSON.stringify({ body: { platform: 'twitter', postId: '456' } }))
  await assert.rejects(loadPostCommentProbeSample(path, 'twitter'), /ambiguous_sample/)
})

test('preview makes no HTTP and a durable marker prevents duplicate purchases including simultaneous runs', async t => {
  const path = await directory(t), plan = planPostCommentProbe('reddit', { platform: 'reddit', postId: 'abc123' })
  const calls = [], requestId = 'af456ad4-2523-4f73-a1fc-c95104b329a4'
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const receipt = JSON.parse(await readFile(join(path, '.hub-comment-contract-probes-v1/reddit.json'), 'utf8'))
    assert.equal(receipt.state, 'dispatch_started')
    assert.equal(receipt.idempotencyKey, options.headers['idempotency-key'])
    return { status: 200, headers: new Headers({ 'x-mx-insight-request-id': requestId }), body: { async cancel() {} } }
  }
  const preview = await runPostCommentProbe({ plan, sampleDirectory: path }, { fetchImpl })
  assert.equal(preview.hubRequestsMade, 0); assert.equal(calls.length, 0)
  const inputs = { plan, sampleDirectory: path, apiKey: 'private-key', apply: true }
  const results = await Promise.all([runPostCommentProbe(inputs, { fetchImpl }), runPostCommentProbe(inputs, { fetchImpl })])
  assert.equal(calls.length, 1)
  assert.deepEqual(results.map(row => row.state).sort(), ['already_attempted', 'http_response'])
  assert.equal(calls[0].url, 'http://127.0.0.1:18150/api/v1/data/native/j.api_9f1806a48fde0794')
  assert.equal(calls[0].options.redirect, 'error')
  assert.deepEqual(JSON.parse(calls[0].options.body), { params: { postId: 't3_abc123' }, deliveryMode: 'live_only' })
  assert.equal(results.find(row => row.requestId)?.requestId, requestId)
  const receipt = await readFile(join(path, '.hub-comment-contract-probes-v1/reddit.json'), 'utf8')
  assert.equal(receipt.includes('private-key'), false); assert.equal(receipt.includes('abc123'), false)
  assert.equal(JSON.stringify(results).includes('private-key'), false)
})

test('transport failures keep the marker and never print sensitive error messages or redispatch', async t => {
  const path = await directory(t), plan = planPostCommentProbe('twitter', { platform: 'twitter', postId: '123' })
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('private-secret-response') }
  const input = { plan, sampleDirectory: path, apiKey: 'private-key', apply: true }
  const result = await runPostCommentProbe(input, { fetchImpl })
  assert.equal(result.state, 'outcome_unknown'); assert.equal(result.hubRequestsMade, 1)
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal((await runPostCommentProbe(input, { fetchImpl })).state, 'already_attempted')
  assert.equal(calls, 1)
})

test('HTTP refusals expose only allowlisted codes and request UUIDs, never error text', async t => {
  const path = await directory(t), plan = planPostCommentProbe('kuaishou', { platform: 'kuaishou', postId: '3xabc' })
  const requestId = 'af456ad4-2523-4f73-a1fc-c95104b329a4'
  const result = await runPostCommentProbe({ plan, sampleDirectory: path, apiKey: 'private-key', apply: true }, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'upstream_balance_exhausted', message: 'private-secret',
      details: { requestId, token: 'private-secret' } }, requestId }), { status: 503 }),
  })
  assert.equal(result.state, 'http_response')
  assert.equal(result.requestId, requestId)
  assert.equal(result.errorCode, 'upstream_balance_exhausted')
  assert.equal(JSON.stringify(result).includes('private'), false)
})
