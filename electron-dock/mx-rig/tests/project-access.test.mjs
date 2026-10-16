import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { verifyProjectAccess } from './fixtures/project-access.mjs'

export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rig-project-acl-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'project-test-only',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: dir,
      MX_RIG_ARTIFACTS_DIR: join(dir, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body, token = 'project-test-only') => {
    const res = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let result
    try {
      result = JSON.parse(text)
    } catch {
      result = text
    }
    return { status: res.status, body: result }
  }
  return { runtime, api }
}

test('project policies protect nested resources and reject stale or revoked access', async (t) => {
  await verifyProjectAccess(await fixture(t))
})

test('an existing SSE stream stops sending private events after membership removal', async (t) => {
  const f = await fixture(t)
  const { app, tokens, ids, run, privateBase } = await verifyProjectAccess(f)
  const policy = (await f.api(privateBase + '/access', undefined, tokens.owner)).body.access
  await f.api(
    privateBase + '/access',
    {
      expectedRevision: policy.revision,
      visibility: 'members',
      members: [{ principalId: ids.editor, role: 'viewer' }]
    },
    tokens.owner
  )
  const response = await fetch(f.runtime.origin + `/api/v1/runs/${run.id}/events`, {
    headers: { authorization: `Bearer ${tokens.editor}` },
    signal: AbortSignal.timeout(5000)
  })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))
  const current = (await f.api(privateBase + '/access', undefined, tokens.owner)).body.access
  await f.api(
    privateBase + '/access',
    { expectedRevision: current.revision, visibility: 'private', members: [] },
    tokens.owner
  )
  f.runtime.kernel.runEvents.publish(run.id, [
    { seq: 1, kind: 'step', payload: { text: 'must-not-arrive' } }
  ])
  let text = ''
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    text += new TextDecoder().decode(result.value)
  }
  assert.equal(text.includes('must-not-arrive'), false)
})
