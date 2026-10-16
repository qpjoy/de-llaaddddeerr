import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

export async function verifyProjectAccess(a, b = a) {
  const suffix = randomUUID().slice(0, 8)
  const tokens = {},
    ids = {}
  for (const [name, role] of [
    ['owner', 'admin'],
    ['editor', 'operator'],
    ['stranger', 'admin']
  ]) {
    const account = `${name}-${suffix}`
    const created = await a.api('/api/v1/members', {
      account,
      role,
      password: 'project-test-password-1'
    })
    assert.equal(created.status, 201)
    ids[name] = created.body.member.principalId
    const login = await b.api(
      '/api/rig/v1/native-login',
      { account, password: 'project-test-password-1' },
      ''
    )
    assert.equal(login.status, 200)
    tokens[name] = login.body.token
  }
  const slug = `private-${suffix}`
  const created = await a.api(
    '/api/v1/apps',
    { slug, displayName: `Private ${suffix}`, surfaces: ['web'] },
    tokens.owner
  )
  assert.equal(created.status, 201)
  const app = created.body.app
  assert.equal(app.access.visibility, 'private', 'new human projects are private by default')
  assert.equal(app.access.ownerId, ids.owner)
  const privateBase = `/api/v1/apps/${slug}`
  const taskA = (
    await a.api('/api/rig/v1/test-tasks', { app: slug, goal: 'Owner private task' }, tokens.owner)
  ).body.mission
  assert.ok(taskA)
  const procedure = {
    title: 'Private procedure',
    app: slug,
    steps: [{ do: 'open', url: 'https://example.test/' }]
  }
  const madeProcedure = await a.api('/api/rig/v1/procedures', { procedure }, tokens.owner)
  assert.equal(madeProcedure.status, 201)
  const procedurePath = '/api/rig/v1/procedures/' + madeProcedure.body.procedure.id
  const channel = await a.runtime.kernel.store.createNotificationChannel({
    appId: app.id,
    name: 'Private channel',
    kind: 'webhook',
    enabled: false
  })
  const notification = await a.runtime.kernel.store.createNotification({
    channelId: channel.id,
    event: 'recovery',
    payload: { title: 'Private test message' }
  })
  const shared = await a.runtime.kernel.store.createApp({
    slug: `shared-${suffix}`,
    displayName: 'Legacy project',
    surfaces: ['web']
  })
  const olderRun = await a.runtime.kernel.store.createRun({
    appId: shared.id,
    engine: 'playwright',
    profile: 'mock',
    track: 'functional',
    trigger: 'manual'
  })
  const run = await a.runtime.kernel.store.createRun({
    appId: app.id,
    engine: 'playwright',
    profile: 'mock',
    track: 'functional',
    trigger: 'manual',
    createdBy: ids.owner
  })
  await a.runtime.kernel.artifacts.write(run.id, 'proof.txt', Readable.from(['private-evidence']), {
    minFreeBytes: 0
  })
  const runBase = `/api/v1/runs/${run.id}`
  const proof = await fetch(a.runtime.origin + runBase + '/artifacts/proof.txt', {
    headers: { authorization: `Bearer ${tokens.owner}` }
  })
  assert.equal(proof.status, 200)
  assert.equal(await proof.text(), 'private-evidence')
  for (const token of [tokens.editor, tokens.stranger]) {
    assert.equal(
      (await b.api('/api/v1/notifications', undefined, token)).body.notifications.some(
        (row) => row.id === notification.id
      ),
      false
    )
    assert.equal(
      (await b.api('/api/v1/apps', undefined, token)).body.apps.some((row) => row.id === app.id),
      false
    )
    for (const path of [
      privateBase + '/access',
      privateBase + '/cases',
      privateBase + '/suites',
      runBase,
      runBase + '/report',
      runBase + '/events',
      runBase + '/artifacts/proof.txt',
      procedurePath
    ])
      assert.equal((await b.api(path, undefined, token)).status, 404, path)
    assert.equal(
      (await b.api('/api/v1/runs', undefined, token)).body.runs.some((row) => row.id === run.id),
      false
    )
    assert.equal(
      (await b.api('/api/rig/v1/test-tasks', { app: slug, goal: 'denied' }, token)).status,
      404
    )
    assert.equal(
      (await b.api('/api/rig/v1/procedures', undefined, token)).body.procedures.some(
        (row) => row.id === madeProcedure.body.procedure.id
      ),
      false
    )
    assert.equal((await b.api('/api/rig/v1/procedures', { procedure }, token)).status, 404)
  }
  const latestVisible = await b.api('/api/v1/runs?limit=1', undefined, tokens.editor)
  assert.equal(
    latestVisible.body.runs[0]?.id,
    olderRun.id,
    'private runs do not consume the visible page limit'
  )
  await assert.rejects(
    a.runtime.kernel.app.invoke({
      method: 'DELETE',
      path: privateBase,
      principal: { kind: 'local', id: ids.owner, role: 'admin' }
    }),
    { status: 409 }
  )
  const landing = await b.api('/api/v1', undefined, '')
  assert.equal(JSON.stringify(landing.body).includes(slug), false)
  await assert.rejects(
    b.runtime.kernel.app.invoke({
      method: 'GET',
      path: runBase,
      principal: { kind: 'local', id: ids.editor, role: 'operator' }
    }),
    { status: 404 }
  )
  const simultaneous = await Promise.all(
    [tokens.owner, tokens.editor, tokens.stranger, tokens.owner].map((token) =>
      b.api('/api/v1/apps', undefined, token)
    )
  )
  assert.deepEqual(
    simultaneous.map((row) => row.body.apps.some((value) => value.id === app.id)),
    [true, false, false, true],
    'request scopes never borrow another caller'
  )
  const policyPath = privateBase + '/access'
  await a.runtime.kernel.app.invoke({
    method: 'PATCH',
    path: '/api/v1/members/' + ids.stranger,
    principal: { kind: 'local', id: ids.owner, role: 'admin' },
    body: { disabled: true }
  })
  assert.equal(
    (
      await a.api(
        policyPath,
        {
          expectedRevision: 1,
          visibility: 'members',
          members: [{ principalId: ids.stranger, role: 'viewer' }]
        },
        tokens.owner
      )
    ).status,
    400,
    'disabled accounts cannot be invited'
  )
  const share = {
    expectedRevision: 1,
    visibility: 'members',
    members: [{ principalId: ids.editor, role: 'operator' }]
  }
  assert.equal((await a.api(policyPath, share, tokens.owner)).status, 200)
  assert.ok(
    (await b.api('/api/v1/apps', undefined, tokens.editor)).body.apps.some(
      (row) => row.id === app.id
    )
  )
  assert.equal((await b.api(runBase, undefined, tokens.editor)).status, 200)
  assert.equal((await b.api(procedurePath, undefined, tokens.editor)).status, 200)
  assert.equal(
    (
      await b.api(
        procedurePath + ':revise',
        { procedure: { ...procedure, app: shared.slug }, expectedRevision: 1 },
        tokens.editor
      )
    ).status,
    409,
    'cannot move private history into a shared project'
  )
  // The project's new access grant does not expose the owner's private Mission.
  assert.equal(
    (await b.api(`/api/rig/v1/missions/${taskA.id}/cases`, undefined, tokens.editor)).status,
    404
  )
  assert.equal(
    (await b.api(policyPath, { ...share, expectedRevision: 2 }, tokens.editor)).status,
    403
  )
  const taskB = (
    await b.api('/api/rig/v1/test-tasks', { app: slug, goal: 'Editor task' }, tokens.editor)
  ).body.mission
  assert.ok(taskB)
  const bookPath = `/api/rig/v1/missions/${taskB.id}/cases`
  const edited = await b.api(
    bookPath,
    {
      expectedRevision: 0,
      cases: [{ caseId: 'T1', title: 'Case', steps: 'Open', expected: 'Shown' }]
    },
    tokens.editor
  )
  assert.equal(edited.status, 200)
  const race = await Promise.all([
    a.api(
      policyPath,
      { ...share, expectedRevision: 2, members: [{ principalId: ids.editor, role: 'viewer' }] },
      tokens.owner
    ),
    b.api(
      policyPath,
      { ...share, expectedRevision: 2, members: [{ principalId: ids.editor, role: 'viewer' }] },
      tokens.owner
    )
  ])
  assert.deepEqual(race.map((row) => row.status).sort(), [200, 409])
  assert.equal((await b.api(bookPath, undefined, tokens.editor)).status, 200)
  assert.equal(
    (await b.api(bookPath + ':confirm', { expectedRevision: 1 }, tokens.editor)).status,
    403
  )
  assert.equal(
    (await b.api(`/api/rig/v1/missions/${taskB.id}/project-access`, undefined, tokens.editor))
      .status,
    403
  )
  assert.equal(
    (await b.api(procedurePath + ':revise', { procedure, expectedRevision: 1 }, tokens.editor))
      .status,
    403
  )
  const before = await b.api(policyPath, undefined, tokens.owner)
  const removed = await a.api(
    policyPath,
    { expectedRevision: before.body.access.revision, visibility: 'private', members: [] },
    tokens.owner
  )
  assert.equal(removed.status, 200)
  assert.equal((await b.api(bookPath, undefined, tokens.editor)).status, 404)
  assert.equal(
    (await b.api(runBase + '/artifacts/proof.txt', undefined, tokens.editor)).status,
    404
  )
  assert.equal(
    (await b.api('/api/rig/v1/missions', undefined, tokens.editor)).body.missions.some(
      (row) => row.id === taskB.id
    ),
    false
  )
  assert.equal((await b.api('/api/rig/v1/insights', undefined, tokens.editor)).status, 200)
  const audit = await a.runtime.kernel.store.listAuditEvents({ appId: app.id })
  assert.equal(
    audit.filter((row) => row.action === 'project.access_change').length,
    3,
    'only committed policy changes enter audit'
  )
  return { app, tokens, ids, run, privateBase }
}
