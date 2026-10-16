import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Run against both the single-process service and two PG replicas. These are
// real accounts/sessions, not a stub that hands callers a convenient role.
export async function verifyProjectVisibility(apiA, apiB = apiA) {
  const suffix = randomUUID().slice(0, 8)
  const login = async (api, account) => {
    const response = await api('/api/rig/v1/native-login', {
      account, password: 'visibility-password-1'
    }, '')
    assert.equal(response.status, 200)
    return response.body.token
  }
  const tokens = {}
  for (const [label, role] of [['a', 'admin'], ['b', 'operator'], ['c', 'admin']]) {
    const account = `${label}-${suffix}`
    const response = await apiA('/api/v1/members', {
      account, role, password: 'visibility-password-1'
    })
    assert.equal(response.status, 201)
    tokens[label] = await login(apiB, account)
  }
  const secondA = await login(apiB, `a-${suffix}`)
  const slug = `visibility-${suffix}`
  const created = await apiA('/api/v1/apps', {
    slug, displayName: 'Shared project, private test tasks', surfaces: ['web'], visibility: 'legacy-shared'
  }, tokens.a)
  assert.equal(created.status, 201)
  assert.ok((await apiB('/api/v1/apps', undefined, tokens.b)).body.apps
    .some((row) => row.id === created.body.app.id), 'project catalog is deployment-wide today')
  assert.equal((await apiB('/api/v1/apps', {
    slug: `${slug}-denied`, displayName: 'Operator cannot create projects'
  }, tokens.b)).status, 403)
  const tasks = await Promise.all([
    apiA('/api/rig/v1/test-tasks', { app: slug, goal: 'A private task' }, tokens.a),
    apiB('/api/rig/v1/test-tasks', { app: slug, goal: 'B private task' }, tokens.b)
  ])
  for (const row of tasks) assert.equal(row.status, 201)
  const [taskA, taskB] = tasks.map((row) => row.body.mission)
  assert.equal(taskA.workbench.appId, taskB.workbench.appId)
  const path = `/api/rig/v1/missions/${taskA.id}`
  for (const token of [tokens.b, tokens.c]) {
    const listed = await apiB('/api/rig/v1/missions', undefined, token)
    assert.equal(listed.body.missions.some((row) => row.id === taskA.id), false)
    for (const endpoint of ['/cases', '/implementation', '/executions', '/export'])
      assert.equal((await apiB(path + endpoint, undefined, token)).status, 404, endpoint)
    assert.equal((await apiB(path + '/cases', {
      expectedRevision: 0, cases: []
    }, token)).status, 404, 'another admin is not automatically a task collaborator')
  }
  const entry = { caseId: 'LOGIN-1', title: 'Login', steps: 'Sign in', expected: 'Home', platforms: ['web'] }
  const raced = await Promise.all([
    apiA(path + '/cases', { expectedRevision: 0, cases: [entry] }, tokens.a),
    apiB(path + '/cases', { expectedRevision: 0, cases: [{ ...entry, expected: 'Workspace' }] }, secondA)
  ])
  assert.deepEqual(raced.map((row) => row.status).sort(), [200, 409])
  const winner = raced.find((row) => row.status === 200).body.book
  assert.deepEqual((await apiB(path + '/cases', undefined, secondA)).body.book, winner)
  assert.equal((await apiB(path + '/cases:confirm', { expectedRevision: 1 }, secondA)).status, 200)
  assert.equal((await apiA(path + '/cases', undefined, tokens.a)).body.book.confirmedBy, `local:a-${suffix}`)
  const ownB = `/api/rig/v1/missions/${taskB.id}/cases`
  assert.equal((await apiB(ownB, { expectedRevision: 0, cases: [entry] }, tokens.b)).status, 200)
  assert.equal((await apiA(path + '/cases', undefined, tokens.a)).body.book.revision, 1)
  assert.equal((await apiA(ownB, undefined, tokens.a)).status, 404)
}
