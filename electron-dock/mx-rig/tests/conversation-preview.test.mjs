import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createConversation,
  validateContext,
  confirmContext,
  recordSmoke,
  saveFlow,
  recordReplay,
  createTask,
  setTaskEnabled
} from '../apps/web/conversation-preview-model.js'

const context = (extra = {}) => ({ directory: '/workspace/luopan', branch: 'feat/login', environment: 'dev', targetUrl: 'http://localhost:9000/', ...extra })
function prepared(id = 'chat-1') {
  const conversation = createConversation('luopan', id)
  confirmContext(conversation, context())
  conversation.messages.push({ role: 'user', content: '验证登录后主界面可见。' })
  return conversation
}
function replayed() {
  const conversation = prepared()
  recordSmoke(conversation, 'passed')
  saveFlow(conversation)
  recordReplay(conversation, 'passed')
  return conversation
}

test('context requires an absolute local directory, a concrete branch and an explicit dev/prod environment', () => {
  assert.match(validateContext(null), /绝对目录/)
  for (const directory of ['/workspace/my project', 'C:\\work\\luopan', 'D:/work/luopan', '\\\\server\\share\\luopan'])
    assert.equal(validateContext(context({ directory })), '')
  for (const directory of ['', './luopan', '~/luopan', 'C:luopan', '/bad\npath'])
    assert.match(validateContext(context({ directory })), /绝对目录/)
  for (const branch of ['', 'HEAD', '@', 'feature..old', 'main~1', 'refs//main', '/main', 'main/', '.hidden', 'feature/.hidden', 'main.lock', 'main.', 'branch@{1}', 'has space', 'bad\\ref', '-option', 'bad?ref', 'bad[ref'])
    assert.match(validateContext(context({ branch })), /Git 分支/, branch)
  for (const branch of ['main', 'release/1.0', 'feat/用户登录'])
    assert.equal(validateContext(context({ branch })), '')
  assert.match(validateContext(context({ environment: 'test' })), /dev 或 prod/)
  assert.equal(validateContext(context({ environment: 'prod' })), '')
})

test('target addresses cannot carry credentials, query strings or fragments', () => {
  for (const targetUrl of ['file:///tmp/site.html', 'javascript:alert(1)', 'https:example.test', 'https://example.test/has space', 'https://example.test/has\nnewline', 'https://a:b@example.test/', 'https://example.test/?token=x', 'https://example.test/#secret', 'https://example.test/?', 'https://example.test/#', 'not-a-url'])
    assert.ok(validateContext(context({ targetUrl })), targetUrl)
  assert.equal(validateContext(context({ targetUrl: 'https://example.test/path/to/app' })), '')
})

test('a confirmed context is fixed, and invalid replacement leaves the current conversation intact', () => {
  const conversation = prepared()
  assert.equal(conversation.context.revision, 1)
  assert.equal(Object.isFrozen(conversation.context), true)
  assert.throws(() => { conversation.context.branch = 'changed' }, TypeError)
  const previous = conversation.context
  assert.throws(() => confirmContext(conversation, context({ branch: 'HEAD' })), /Git 分支/)
  assert.equal(conversation.context, previous)
  assert.equal(conversation.messages.length, 1)
})

test('missing goals, missing evidence and failures block later steps', () => {
  const conversation = createConversation('luopan', 'empty')
  assert.throws(() => recordSmoke(conversation, 'passed'), /先确认/)
  confirmContext(conversation, context())
  conversation.messages.push({ role: 'assistant', content: '准备好了' }, { role: 'user', content: '  ' })
  assert.throws(() => recordSmoke(conversation, 'passed'), /描述测试目标/)
  conversation.messages.push({ role: 'user', content: '检查入口' })
  assert.throws(() => saveFlow(conversation), /冒烟演示通过/)
  assert.throws(() => recordReplay(conversation, 'passed'), /先固化/)
  assert.throws(() => recordSmoke(conversation, 'flaky'), /passed 或 failed/)
  recordSmoke(conversation, 'failed')
  assert.throws(() => saveFlow(conversation), /冒烟演示通过/)
  recordSmoke(conversation, 'passed')
  saveFlow(conversation)
  assert.throws(() => createTask(conversation, { name: '夜间冒烟', schedule: 'daily' }), /重放演示通过/)
  recordReplay(conversation, 'failed')
  assert.throws(() => createTask(conversation, { name: '夜间冒烟', schedule: 'daily' }), /重放演示通过/)
})

test('the successful path produces only simulated local records, with an initially disabled task', () => {
  const conversation = replayed()
  const task = createTask(conversation, { name: '  夜间冒烟  ', schedule: 'daily' })
  assert.equal(conversation.flow.revision, 1)
  assert.equal(conversation.flow.steps.length, 3)
  assert.equal(task.name, '夜间冒烟')
  assert.equal(task.enabled, false)
  assert.equal(task.localOnly, true)
  for (const record of [conversation.smoke, conversation.flow, conversation.replay, task]) {
    assert.equal(record.simulated, true)
    assert.equal(record.contextRevision, 1)
    assert.equal(Object.hasOwn(record, 'runId'), false)
    assert.equal(Object.hasOwn(record, 'commit'), false)
  }
  assert.equal(setTaskEnabled(conversation, true).enabled, true)
  assert.equal(setTaskEnabled(conversation, false).enabled, false)
  assert.throws(() => createTask(conversation, { name: '', schedule: 'manual' }), /任务名称/)
  assert.throws(() => createTask(conversation, { name: '冒烟', schedule: '* * * * *' }), /手动或每日/)
  assert.throws(() => setTaskEnabled(conversation, 'true'), /布尔值/)
})

test('changing any context invalidates all evidence and tasks while preserving chat messages', () => {
  for (const change of [{ directory: '/workspace/other' }, { branch: 'main' }, { environment: 'prod' }, { targetUrl: 'http://localhost:9001/' }]) {
    const conversation = replayed()
    createTask(conversation, { name: '冒烟', schedule: 'manual' })
    setTaskEnabled(conversation, true)
    const messages = conversation.messages
    confirmContext(conversation, context(change))
    assert.equal(conversation.context.revision, 2)
    assert.equal(conversation.messages, messages)
    for (const key of ['smoke', 'flow', 'replay', 'task']) assert.equal(conversation[key], null)
    assert.throws(() => setTaskEnabled(conversation, true), /先创建/)
  }
})

test('prod allows context and conversation analysis but no simulated execution or activation', () => {
  const conversation = replayed()
  const task = createTask(conversation, { name: '冒烟', schedule: 'manual' })
  confirmContext(conversation, context({ environment: 'prod' }))
  conversation.messages.push({ role: 'user', content: '仅分析线上验收范围' })
  for (const action of [() => recordSmoke(conversation, 'passed'), () => saveFlow(conversation), () => recordReplay(conversation, 'passed'), () => createTask(conversation, { name: 'prod', schedule: 'daily' })])
    assert.throws(action, /prod.*仅供分析/)
  // Even restoring an old local task must not enable it against prod.
  conversation.task = task
  assert.throws(() => setTaskEnabled(conversation, true), /prod.*仅供分析/)
  assert.equal(setTaskEnabled(conversation, false).enabled, false)
})

test('new smoke, changed flow and failed replay invalidate downstream eligibility', () => {
  const conversation = replayed()
  createTask(conversation, { name: '冒烟', schedule: 'manual' })
  setTaskEnabled(conversation, true)
  recordReplay(conversation, 'failed')
  assert.equal(conversation.task.enabled, false)
  assert.throws(() => setTaskEnabled(conversation, true), /重放演示通过/)
  recordReplay(conversation, 'passed')
  const oldReplay = conversation.replay
  saveFlow(conversation)
  assert.equal(conversation.flow.revision, 2)
  assert.equal(conversation.replay, null)
  assert.equal(conversation.task, null)
  conversation.replay = oldReplay
  assert.throws(() => createTask(conversation, { name: '过期', schedule: 'manual' }), /重放演示通过/)
  recordSmoke(conversation, 'failed')
  assert.equal(conversation.flow, null)
  assert.equal(conversation.replay, null)
  assert.equal(conversation.task, null)
})

test('records from an older context do not authorize its replacement', () => {
  const conversation = replayed()
  const smoke = conversation.smoke
  const flow = conversation.flow
  const replay = conversation.replay
  confirmContext(conversation, context({ branch: 'main' }))
  conversation.smoke = smoke
  assert.throws(() => saveFlow(conversation), /冒烟演示通过/)
  conversation.flow = flow
  conversation.replay = replay
  assert.throws(() => recordReplay(conversation, 'passed'), /先固化/)
  assert.throws(() => createTask(conversation, { name: '过期', schedule: 'manual' }), /先固化/)
})

test('different conversations have independent context, goals and evidence', () => {
  const first = replayed()
  const second = createConversation('luopan', 'chat-2')
  assert.notEqual(first.messages, second.messages)
  assert.equal(second.context, null)
  assert.equal(second.smoke, null)
  assert.equal(second.flow, null)
  assert.throws(() => createTask(second, { name: '不能沿用', schedule: 'daily' }), /先确认/)
  confirmContext(second, context())
  assert.throws(() => recordSmoke(second, 'passed'), /描述测试目标/)
  assert.equal(first.context.revision, 1)
  assert.equal(first.replay.outcome, 'passed')
})
