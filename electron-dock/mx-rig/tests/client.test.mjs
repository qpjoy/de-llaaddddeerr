import test from 'node:test'
import assert from 'node:assert/strict'
import { RigClient } from '../packages/runtime/client.mjs'

// The desktop's API client: GET and POST for most actions, PATCH and DELETE
// for changing a member or removing a runner (docs/21 M1).

function fakeFetch(answer) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers })
    return answer(url, init)
  }
  return { calls, fetchImpl }
}

const client = (fetchImpl) =>
  new RigClient({ url: 'http://127.0.0.1:8791', token: 'session-token', fetchImpl, privateHttp: true })

test('request keeps GET without a body and POST with one', async () => {
  const { calls, fetchImpl } = fakeFetch(() => Response.json({ ok: true }))
  const rig = client(fetchImpl)
  await rig.request('/api/v1/runners')
  await rig.request('/api/v1/runners:enroll', {})
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST'])
  assert.equal(calls[0].headers.authorization, 'Bearer session-token')
})

test('send uses the method it is given, and a 204 is an empty answer', async () => {
  const { calls, fetchImpl } = fakeFetch((_url, init) =>
    init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ member: { role: 'viewer' } })
  )
  const rig = client(fetchImpl)
  assert.deepEqual(await rig.send('PATCH', '/api/v1/members/local%3Aalice', { role: 'viewer' }), { member: { role: 'viewer' } })
  assert.deepEqual(await rig.send('DELETE', '/api/v1/runners/rnr_abc123'), {})
  assert.deepEqual(calls.map((call) => [call.method, call.body ?? null]), [
    ['PATCH', '{"role":"viewer"}'],
    ['DELETE', null]
  ])
})

test('only member-API methods and paths are sent, and refusals keep their message', async () => {
  const { fetchImpl } = fakeFetch(() => Response.json({ error: { code: 'self_disable', message: '不能停用自己的账号' } }, { status: 409 }))
  const rig = client(fetchImpl)
  await assert.rejects(rig.send('OPTIONS', '/api/v1/members/x', {}), /不允许的请求方法/)
  await assert.rejects(rig.send('DELETE', '/elsewhere'), /不允许的 API 路径/)
  await assert.rejects(rig.send('PATCH', '/api/v1/members/local%3Aadmin', { disabled: true }), /不能停用自己的账号/)
})
