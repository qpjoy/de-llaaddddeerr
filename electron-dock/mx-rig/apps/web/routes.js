// The workbench's project and administration actions as HTTP requests — one
// table for both surfaces (docs/21 M1, M2). The browser sends them from the
// page with its cookie; the desktop's main process sends them with the
// member's token. Every identifier that goes into a path is checked here, so
// neither surface can be talked into naming a path the table does not list.
//
// The service decides who may do what; this table only decides what may be
// asked.

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9_-]{4,80}$/
const PRINCIPAL = /^[A-Za-z0-9:._@-]{1,128}$/
const MISSION = /^[a-f0-9-]{36}$/
const SEQ = /^\d{1,9}$/

function check(pattern, value, what) {
  const text = String(value ?? '')
  if (!pattern.test(text)) throw new Error(`${what}无效`)
  return encodeURIComponent(text)
}

/** Copy only the listed fields that are present: a request carries nothing it was not meant to. */
function pick(body, keys) {
  const out = {}
  for (const key of keys) if (body && Object.hasOwn(body, key) && body[key] !== undefined) out[key] = body[key]
  return out
}

const SUITE_FIELDS = [
  'displayName',
  'engine',
  'surface',
  'runnerKind',
  'runnerImage',
  'workingDir',
  'targetMode',
  'repoUrl',
  'defaultBranch',
  'command',
  'requirements',
  'secretRefs',
  'writesData',
  'retryPolicy'
]
const CASE_FIELDS = ['title', 'priority', 'preconditions', 'requirementRef', 'steps', 'notes', 'tags', 'suite']

const ROUTES = {
  // -- 项目里的读取 ------------------------------------------------------------
  'app-cases': (b) => ['GET', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/cases`],
  'app-tasks': (b) => ['GET', `/api/v1/tasks?app=${check(SLUG, b.app, '项目标识')}`],
  'app-runs': (b) => ['GET', `/api/v1/runs?app=${check(SLUG, b.app, '项目标识')}&limit=50`],
  // -- 账号与成员（M1）--------------------------------------------------------
  'member-create': (b) => ['POST', '/api/v1/members', pick(b, ['account', 'displayName', 'role'])],
  'member-update': (b) => ['PATCH', `/api/v1/members/${check(PRINCIPAL, b.principalId, '成员标识')}`, pick(b, ['role', 'disabled'])],
  'member-reset': (b) => ['POST', `/api/v1/members/${check(PRINCIPAL, b.principalId, '成员标识')}:resetPassword`, {}],
  // -- 执行机与工位（M1）------------------------------------------------------
  'machine-enroll': () => ['POST', '/api/v1/runners:enroll', {}],
  'machine-enrollment': (b) => ['GET', `/api/v1/enrollments/${check(ID, b.id, '接入码标识')}`],
  'machine-remove': (b) => ['DELETE', `/api/v1/runners/${check(ID, b.id, '执行机标识')}`],
  // -- 项目设置：执行方式（M2，管理员）----------------------------------------
  'app-suites': (b) => ['GET', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/suites`],
  'suite-create': (b) => ['POST', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/suites`, pick(b, ['slug', ...SUITE_FIELDS])],
  'suite-update': (b) => [
    'PATCH',
    `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/suites/${check(SLUG, b.suite, '执行方式标识')}`,
    pick(b, SUITE_FIELDS)
  ],
  'suite-delete': (b) => [
    'DELETE',
    `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/suites/${check(SLUG, b.suite, '执行方式标识')}${b.force === true ? '?force=true' : ''}`
  ],
  // 规程回放的执行方式由服务端按固定定义建立，不接收命令。
  'procedure-suite': (b) => ['POST', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/procedure-suite`, {}],
  // -- 项目设置：密钥（M2，管理员，只写不读）----------------------------------
  'app-secrets': (b) => ['GET', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/secrets`],
  'secret-put': (b) => [
    'PUT',
    `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/secrets/${check(SECRET, b.name, '密钥名')}`,
    pick(b, ['value', 'description'])
  ],
  'secret-delete': (b) => ['DELETE', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/secrets/${check(SECRET, b.name, '密钥名')}`],
  // -- 项目设置：删除项目（M2，管理员）----------------------------------------
  'project-delete': (b) => ['DELETE', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}${b.force === true ? '?force=true' : ''}`],
  // -- 用例库（M2）------------------------------------------------------------
  'case-create': (b) => ['POST', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/cases`, pick(b, ['caseId', ...CASE_FIELDS])],
  'case-update': (b) => [
    'PUT',
    `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/cases/${check(CASE_ID, b.caseId, '用例编号')}`,
    pick(b, CASE_FIELDS)
  ],
  'case-retire': (b) => ['DELETE', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/cases/${check(CASE_ID, b.caseId, '用例编号')}`],
  'case-history': (b) => ['GET', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/cases/${check(CASE_ID, b.caseId, '用例编号')}/history`],
  'cases-export': (b) => ['GET', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/cases:export`],
  'catalog-sync': (b) => ['POST', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/catalog:sync`, b.catalog ?? {}],
  'task-cases-promote': (b) => [
    'POST',
    `/api/rig/v1/missions/${check(MISSION, b.id, '任务标识')}/cases:promote`,
    pick(b, ['expectedRevision', 'caseIds'])
  ],
  // -- 执行计划（M3）----------------------------------------------------------
  'plan-create': (b) => [
    'POST',
    '/api/v1/tasks',
    pick(b, ['app', 'suite', 'name', 'profile', 'track', 'targetUrl', 'caseFilter', 'runsOn', 'runnerId', 'schedule', 'enabled'])
  ],
  'plan-update': (b) => [
    'PATCH',
    `/api/v1/tasks/${check(ID, b.id, '执行计划标识')}`,
    pick(b, ['name', 'profile', 'track', 'targetUrl', 'caseFilter', 'runsOn', 'runnerId', 'schedule', 'enabled'])
  ],
  'plan-delete': (b) => ['DELETE', `/api/v1/tasks/${check(ID, b.id, '执行计划标识')}`],
  'plan-run': (b) => ['POST', `/api/v1/tasks/${check(ID, b.id, '执行计划标识')}:run`, pick(b, ['caseFilter'])],
  // -- 测试仓库（M7）：服务器上的发布版本 --------------------------------------
  'repository-versions': (b) => ['GET', `/api/rig/v1/projects/${check(SLUG, b.app, '项目标识')}/test-versions`],
  // 已发布版本的固定执行方式（M7b）：任何执行机都能跑，团队的定时计划用它。
  'published-suite': (b) => ['POST', `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/published-suite`, {}],
  // -- 安装包（M6）：桌面端执行下载并校验的发行包 ------------------------------
  'package-publish': (b) => [
    'POST',
    `/api/v1/apps/${check(SLUG, b.app, '项目标识')}/packages`,
    pick(b, ['url', 'sha256', 'filename', 'version', 'gitSha'])
  ],
  // -- 审计（M6，管理员）------------------------------------------------------
  audit: (b) => {
    const query = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(b.limit) || 200))) })
    if (b.app) query.set('app', check(SLUG, b.app, '项目标识'))
    if (b.resource) query.set('resource', check(/^[a-z][a-z_-]{0,31}$/, b.resource, '对象类型'))
    return ['GET', `/api/v1/audit?${query}`]
  },
  // -- 验收包（M5）------------------------------------------------------------
  packs: () => ['GET', '/api/v1/onboarding/packs'],
  'pack-apply': (b) => ['POST', `/api/v1/onboarding/packs/${check(SLUG, b.pack, '验收包标识')}:apply`, pick(b, ['runnerId'])],
  // -- 执行详情（M4）----------------------------------------------------------
  run: (b) => ['GET', `/api/v1/runs/${check(ID, b.id, '执行标识')}`],
  'run-cases': (b) => ['GET', `/api/v1/runs/${check(ID, b.id, '执行标识')}/cases`],
  'run-artifacts': (b) => ['GET', `/api/v1/runs/${check(ID, b.id, '执行标识')}/artifacts`],
  'run-progress': (b) => [
    'GET',
    `/api/v1/runs/${check(ID, b.id, '执行标识')}/progress?afterSeq=${check(SEQ, b.afterSeq ?? 0, '进度位置')}`
  ],
  'run-cancel': (b) => ['POST', `/api/v1/runs/${check(ID, b.id, '执行标识')}:cancel`, {}],
  // -- 通知渠道（M2，管理员）--------------------------------------------------
  channels: () => ['GET', '/api/v1/notification-channels'],
  'channel-create': (b) => ['POST', '/api/v1/notification-channels', pick(b, ['kind', 'name', 'app', 'events', 'config', 'enabled'])],
  'channel-delete': (b) => ['DELETE', `/api/v1/notification-channels/${check(ID, b.id, '渠道标识')}`],
  'channel-test': (b) => ['POST', `/api/v1/notification-channels/${check(ID, b.id, '渠道标识')}:test`, {}]
}

/** The request an action makes, or null when the action is not one of these. */
export function routeAction(action, body = {}) {
  const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : null
  if (!route) return null
  const [method, path, payload] = route(body ?? {})
  return { method, path, body: payload }
}

export const ROUTED_ACTIONS = Object.freeze(Object.keys(ROUTES))
