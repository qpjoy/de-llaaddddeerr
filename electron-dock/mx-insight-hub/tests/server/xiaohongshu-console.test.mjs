import test from 'node:test'
import assert from 'node:assert/strict'
import { XHS_CONSOLE_ENDPOINTS as endpoints, consoleBody, consoleCurl, consoleRequestIdentity, visibleConsoleEndpoints } from '../../src/xiaohongshu-console.js'
import { demoAccessIssues } from '../../src/demo-access.js'
import { spawnSync } from 'node:child_process'
import { PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'
test('console exposes only fixed Hub POST contracts with known parameters', () => {
  assert.equal(endpoints.length, 8)
  for (const endpoint of endpoints) {
    const operation = PUBLIC_OPENAPI_DOCUMENT.paths[endpoint.path.replace('/api/v1', '')]?.post
    assert.ok(operation, endpoint.path)
    let schema = operation.requestBody.content['application/json'].schema
    if (schema.$ref) schema = PUBLIC_OPENAPI_DOCUMENT.components.schemas[schema.$ref.split('/').pop()]
    for (const [key] of endpoint.fields) assert.ok(schema.properties[key], `${endpoint.id}:${key}`)
  }
  assert.throws(() => consoleBody({ id: 'https://example.com' }, {}))
})
test('required parameters, mutually alternative IDs and bounded page values validate before sending', () => {
  const search = endpoints.find(item => item.id === 'search_notes')
  assert.throws(() => consoleBody(search, {}), /关键词/)
  for (const page of [0, 16, 1.5, 'oops']) assert.throws(() => consoleBody(search, { keyword: '牛奶', page }))
  assert.deepEqual(consoleBody(search, { keyword: '牛奶', page: '2', url: 'https://elsewhere.test' }), { keyword: '牛奶', page: 2 })
  assert.throws(() => consoleBody(endpoints.find(item => item.id === 'get_user_info'), {}), /ID/)
})
test('the same business request keeps its retry identity, but a new page changes it', () => {
  const search = endpoints[1]
  assert.equal(consoleRequestIdentity(search, { keyword: '牛奶', page: 1 }), consoleRequestIdentity(search, { page: 1, keyword: '牛奶' }))
  assert.notEqual(consoleRequestIdentity(search, { page: 1 }), consoleRequestIdentity(search, { page: 2 }))
  assert.deepEqual(consoleBody(endpoints[0], { url: 'https://www.xiaohongshu.com/explore/test' }), { platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/test' })
})

test('admin can inspect new APIs with an old Key without bypassing tenant grants or runtime checks', () => {
  const access = {
    platforms: ['xiaohongshu'], consumerPlatforms: ['xiaohongshu'],
    capabilities: ['social.posts.resolve'],
    consumerCapabilities: ['social.posts.resolve', 'social.posts.analytics', 'social.comments.list'],
    operations: Object.fromEntries(['social.posts.analytics', 'social.comments.list'].map(key => [key, { ready: false, effectiveState: 'disabled' }])),
  }
  assert.equal(visibleConsoleEndpoints(access, true).length, 8)
  assert.deepEqual(visibleConsoleEndpoints(access).map(endpoint => endpoint.id), ['post'])
  for (const capability of ['social.posts.analytics', 'social.comments.list']) {
    const issues = demoAccessIssues(access, capability)
    assert.deepEqual(issues.map(issue => issue.kind), ['authorization', 'runtime'])
    assert.match(issues[0].message, /业务已开通.*当前 Key 未包含/)
    assert.match(issues[1].message, /运行开关关闭/)
  }
  const granted = { ...access, capabilities: access.consumerCapabilities }
  assert.ok(visibleConsoleEndpoints(granted).some(endpoint => endpoint.id === 'note_detail'))
  assert.ok(demoAccessIssues(granted, 'social.posts.analytics').every(issue => issue.kind === 'runtime'))
  assert.deepEqual(visibleConsoleEndpoints(undefined), [])
  assert.equal(visibleConsoleEndpoints(undefined, true).length, 8)
  assert.equal(visibleConsoleEndpoints(null).length, 8) // Manual keys are checked by the API.
})

test('external cURL uses the Hub contract and preserves shell-sensitive input as literal JSON', () => {
  const endpoint = endpoints.find(entry => entry.id === 'search_notes')
  const body = { keyword: "摄影's $HOME `uname` $(uname)\n下一行" }
  // Replace curl with printf; never send a request. Shell metacharacters must
  // remain in the one --data argument instead of being expanded or executed.
  const command = `curl() { printf '%s\\0' "$@"; }\n${consoleCurl(endpoint, body)}`
  const result = spawnSync('/bin/sh', ['-c', command], { env: { HUB_URL: 'https://hub.example', HUB_KEY: 'synthetic-key' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const args = result.stdout.split('\0')
  assert.equal(args[2], `https://hub.example${endpoint.path}`)
  assert.deepEqual(JSON.parse(args[args.indexOf('--data') + 1]), body)
  for (const id of ['note_detail', 'note_comments']) {
    const api = endpoints.find(entry => entry.id === id)
    assert.match(consoleCurl(api, { note_id: '6a20edfa0000000021020951' }), new RegExp(api.path))
    assert.doesNotMatch(consoleCurl(api, {}), /tikhub|api\.tikhub/i)
  }
})
