// Design preview only: these records describe a simulated local interaction.
// They are not execution evidence or production authorization gates. This module
// never calls a network, IPC, filesystem or storage API.

export function createConversation(projectId, id) {
  return {
    id,
    projectId,
    title: '新对话',
    context: null,
    messages: [],
    smoke: null,
    flow: null,
    replay: null,
    task: null
  }
}

export function validateContext(input = {}) {
  input ??= {}
  const directory = typeof input.directory === 'string' ? input.directory.trim() : ''
  const branch = typeof input.branch === 'string' ? input.branch.trim() : ''
  const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : ''
  const absoluteDirectory = directory.startsWith('/') || /^[A-Za-z]:[\\/]/.test(directory) || /^\\\\[^\\]+\\[^\\]+/.test(directory)
  if (!absoluteDirectory || /[\x00-\x1f\x7f]/.test(directory)) return '请填写本机绝对目录，支持 Unix 或 Windows 路径。'
  const invalidBranch = !branch || branch === 'HEAD' || branch === '@' || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.includes('//') || branch.includes('..') || branch.includes('@{') || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  if (invalidBranch) return '请填写明确、合法的 Git 分支，不使用 HEAD 或相对引用。'
  if (!['dev', 'prod'].includes(input.environment)) return '请选择 dev 或 prod 环境。'
  try {
    const url = new URL(targetUrl)
    if (!/^https?:\/\//i.test(targetUrl) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#\\\x00-\x20\x7f]/.test(targetUrl))
      return '目标地址须为 HTTP(S)，且不能含账号密码、查询参数或片段。'
  } catch {
    return '请填写完整的 HTTP(S) 目标地址。'
  }
  return ''
}

export function confirmContext(conversation, input) {
  const error = validateContext(input)
  if (error) throw new Error(error)
  conversation.context = Object.freeze({
    directory: input.directory.trim(),
    branch: input.branch.trim(),
    environment: input.environment,
    targetUrl: input.targetUrl.trim(),
    revision: (conversation.context?.revision ?? 0) + 1
  })
  conversation.smoke = null
  conversation.flow = null
  conversation.replay = null
  conversation.task = null
  return conversation.context
}

function devContext(conversation) {
  if (!conversation.context) throw new Error('请先确认项目目录、分支和环境。')
  if (conversation.context.environment !== 'dev') throw new Error('prod 在此预览中仅供分析，不能模拟执行或启用任务。')
  return conversation.context
}

function checkedOutcome(outcome) {
  if (!['passed', 'failed'].includes(outcome)) throw new Error('演示结果只能是 passed 或 failed。')
  return outcome
}

export function recordSmoke(conversation, outcome) {
  const context = devContext(conversation)
  if (!conversation.messages.some((message) => message.role === 'user' && String(message.content ?? message.text ?? '').trim()))
    throw new Error('请先在当前对话描述测试目标。')
  checkedOutcome(outcome)
  conversation.smoke = {
    outcome,
    simulated: true,
    contextRevision: context.revision,
    evidence: '本地交互演示，未运行浏览器、执行机或真实测试。'
  }
  conversation.flow = null
  conversation.replay = null
  conversation.task = null
  return conversation.smoke
}

export function saveFlow(conversation) {
  const context = devContext(conversation)
  if (conversation.smoke?.outcome !== 'passed' || conversation.smoke.contextRevision !== context.revision)
    throw new Error('当前上下文的冒烟演示通过后，才能固化流程。')
  conversation.flow = {
    revision: (conversation.flow?.revision ?? 0) + 1,
    contextRevision: context.revision,
    simulated: true,
    steps: [
      { id: 'entry', title: '打开目标页面', expected: '页面加载完成，入口可见。' },
      { id: 'core', title: '执行一条核心流程', expected: '关键操作到达预期状态。' },
      { id: 'assert', title: '核对断言并清理', expected: '关键断言通过，测试数据完成清理。' }
    ]
  }
  conversation.replay = null
  conversation.task = null
  return conversation.flow
}

function currentFlow(conversation) {
  const context = devContext(conversation)
  if (!conversation.flow || conversation.flow.contextRevision !== context.revision)
    throw new Error('请先固化当前上下文的流程。')
  return conversation.flow
}

export function recordReplay(conversation, outcome) {
  const flow = currentFlow(conversation)
  checkedOutcome(outcome)
  conversation.replay = {
    outcome,
    simulated: true,
    contextRevision: conversation.context.revision,
    flowRevision: flow.revision
  }
  // A failed replay immediately stops a previously enabled local demo task.
  if (outcome === 'failed' && conversation.task) conversation.task.enabled = false
  return conversation.replay
}

function verifiedReplay(conversation) {
  const flow = currentFlow(conversation)
  const replay = conversation.replay
  if (replay?.outcome !== 'passed' || replay.contextRevision !== conversation.context.revision || replay.flowRevision !== flow.revision)
    throw new Error('当前上下文和流程版本的重放演示通过后，才能创建或启用任务。')
  return flow
}

export function createTask(conversation, { name, schedule } = {}) {
  const flow = verifiedReplay(conversation)
  if (typeof name !== 'string' || !name.trim()) throw new Error('请填写任务名称。')
  if (!['manual', 'daily'].includes(schedule)) throw new Error('请选择手动或每日演示计划。')
  conversation.task = {
    name: name.trim(),
    schedule,
    enabled: false,
    simulated: true,
    localOnly: true,
    contextRevision: conversation.context.revision,
    flowRevision: flow.revision
  }
  return conversation.task
}

export function setTaskEnabled(conversation, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('任务启用状态须为布尔值。')
  if (!conversation.task) throw new Error('请先创建本地演示任务。')
  if (enabled) {
    const flow = verifiedReplay(conversation)
    if (conversation.task.contextRevision !== conversation.context.revision || conversation.task.flowRevision !== flow.revision)
      throw new Error('任务上下文或流程版本已变化，请重新创建任务。')
  }
  conversation.task.enabled = enabled
  return conversation.task
}
