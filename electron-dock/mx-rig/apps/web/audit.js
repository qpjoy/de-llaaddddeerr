// 审计（docs/21 M6）：谁在什么时候改了什么。管理员可见。
//
// The records come from the service's audit log; credential-shaped values
// were scrubbed when they were written. An update shows only what changed.

import { h, ago, empty, panel } from './views.js'

const ACTION = {
  'app.create': '登记项目',
  'app.delete': '删除项目',
  'project.access_change': '修改项目成员与访问',
  'suite.create': '新建执行方式',
  'suite.update': '修改执行方式',
  'suite.delete': '删除执行方式',
  'task.create': '新建执行计划',
  'task.update': '修改执行计划',
  'task.delete': '删除执行计划',
  'secret.put': '保存密钥',
  'secret.delete': '删除密钥',
  'case.promote': '提升用例到用例库',
  'package.publish': '登记安装包',
  'onboarding.compass_reconcile': '对齐 Compass（旧接口）',
  'onboarding.pack_apply': '从验收包建立项目',
  'member.local_create': '新建账号',
  'member.role_change': '修改账号权限',
  'member.password_reset': '重置密码',
  'member.password_change': '修改自己的密码',
  'runner.register': '注册执行机',
  'runner.enroll': '执行机用接入码接入',
  'runner.enroll_code': '生成接入码',
  'runner.remove': '移除执行机',
  'channel.create': '登记通知渠道',
  'channel.delete': '删除通知渠道',
  'run.record': '记录外部执行结果',
  'webhook.secret_set': '设置 Webhook 密钥'
}

const RESOURCE = {
  app: '项目',
  suite: '执行方式',
  task: '执行计划',
  secret: '密钥',
  case: '用例',
  package: '安装包',
  onboarding: '验收包',
  member: '账号',
  runner: '执行机',
  channel: '通知渠道',
  run: '执行'
}

const text = (value) => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value))

/** For an update, the fields that changed; otherwise everything recorded. */
export function auditChanges(event) {
  const before = event.before && typeof event.before === 'object' ? event.before : null
  const after = event.after && typeof event.after === 'object' ? event.after : null
  if (before && after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => ({ key, from: text(before[key]), to: text(after[key]) }))
  }
  const only = after ?? before ?? {}
  return Object.keys(only).map((key) => ({ key, from: before ? text(only[key]) : null, to: after ? text(only[key]) : null }))
}

function row(event, appsById) {
  const changes = auditChanges(event)
  return h(
    'details',
    { class: 'rig-audit-row', 'data-action': event.action },
    h(
      'summary',
      { class: 'rig-audit-row__summary' },
      h('span', { class: 'qp-caption qp-muted', text: ago(event.createdAt), title: new Date(event.createdAt).toLocaleString() }),
      h('strong', { class: 'qp-body-2', text: event.actorName ?? event.actorId ?? '系统' }),
      h('span', { class: 'qp-body-2', text: ACTION[event.action] ?? event.action }),
      h('span', { class: 'rig-chip', text: `${RESOURCE[event.resourceType] ?? event.resourceType}${event.resourceId ? ` · ${String(event.resourceId).slice(0, 24)}` : ''}` }),
      event.appId ? h('span', { class: 'qp-caption qp-muted', text: appsById.get(event.appId)?.displayName ?? event.appId }) : null
    ),
    h(
      'div',
      { class: 'rig-audit-row__body' },
      changes.length
        ? h(
            'table',
            { class: 'rig-audit-changes' },
            h('thead', {}, h('tr', {}, h('th', { text: '字段' }), h('th', { text: '之前' }), h('th', { text: '之后' }))),
            h(
              'tbody',
              {},
              ...changes.map((change) =>
                h('tr', {}, h('td', { text: change.key }), h('td', { text: change.from ?? '—' }), h('td', { text: change.to ?? '—' }))
              )
            )
          )
        : h('p', { class: 'qp-caption qp-muted', text: '没有记录字段变化。' }),
      h('p', { class: 'qp-caption qp-muted', text: `动作 ${event.action}${event.sourceIp ? ` · 来源 ${event.sourceIp}` : ''}` })
    )
  )
}

export async function audit(ctx, mount) {
  if (ctx.state.principal?.role !== 'admin') {
    mount.append(empty('审计只对部署管理员开放。'))
    return
  }
  const filter = (ctx.state.auditFilter ??= { app: '', resource: '' })
  const [{ events = [] }, { apps = [] }] = await Promise.all([
    ctx.api('audit', { app: filter.app || undefined, resource: filter.resource || undefined, limit: 200 }),
    ctx.api('apps').catch(() => ({ apps: [] }))
  ])
  const appsById = new Map(apps.map((app) => [app.id, app]))
  const appSelect = h(
    'select',
    { class: 'qp-select', id: 'audit-app', 'aria-label': '项目' },
    h('option', { value: '', text: '全部项目' }),
    ...apps.map((app) => h('option', { value: app.slug, text: app.displayName }))
  )
  appSelect.value = filter.app
  const resourceSelect = h(
    'select',
    { class: 'qp-select', id: 'audit-resource', 'aria-label': '对象类型' },
    h('option', { value: '', text: '全部对象' }),
    ...Object.entries(RESOURCE).map(([value, label]) => h('option', { value, text: label }))
  )
  resourceSelect.value = filter.resource
  const apply = () => {
    filter.app = appSelect.value
    filter.resource = resourceSelect.value
    ctx.render()
  }
  appSelect.onchange = apply
  resourceSelect.onchange = apply
  mount.append(
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '项目、执行方式、执行计划（含定时）、密钥、账号、执行机、通知渠道和安装包的每次改动都记在这里；密码、令牌这类值在写入时已去掉。最近 200 条。'
    }),
    panel(
      '审计记录',
      h('div', { class: 'qp-row rig-audit-filters' }, appSelect, resourceSelect),
      events.length
        ? h('div', { class: 'rig-audit-list', id: 'audit-list' }, ...events.map((event) => row(event, appsById)))
        : empty('没有符合条件的记录。')
    )
  )
}
