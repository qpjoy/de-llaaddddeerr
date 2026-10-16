// What a project's pages decide from its data, apart from drawing it: whether
// a plan has been verified, and how far the project is from its first
// scheduled run (docs/21 M6). No DOM here, so the tests can load it in Node.

const FINISHED = ['passed', 'failed', 'flaky', 'blocked', 'expired', 'timeout', 'cancelled']
const ACTIVE = ['queued', 'pending-runner', 'running']
const at = (run) => run.finishedAt ?? run.startedAt ?? run.queuedAt ?? ''

/**
 * A plan is verified when its latest finished run passed. Scheduling is only
 * offered then: a plan that has never passed would fire every night into a
 * result nobody can act on. A cancelled or expired run says nothing about the
 * plan and is skipped.
 */
export function planVerification(plan, runs) {
  const own = runs.filter((run) => run.taskId === plan.id).sort((a, b) => String(at(b)).localeCompare(String(at(a))))
  const active = own.find((run) => ACTIVE.includes(run.status)) ?? null
  const latest = own.find((run) => FINISHED.includes(run.status) && !['cancelled', 'expired'].includes(run.status)) ?? null
  const state = !latest ? 'unverified' : ['passed', 'flaky'].includes(latest.status) ? 'verified' : latest.status === 'blocked' ? 'blocked' : 'failed'
  return { state, run: latest, active }
}

export const VERIFICATION_TEXT = {
  verified: '已验证',
  failed: '最近一次失败',
  blocked: '最近一次受阻',
  unverified: '未验证'
}

const machineNeeded = (plan) => plan.runsOn !== 'server'

/**
 * The steps from a registered project to its first scheduled run, each with
 * whether it is done. `required` steps block the next ones in practice;
 * optional ones are advice.
 */
export function checklistSteps({ suites = [], cases = [], plans = [], runners = [], runs = [] }) {
  const runnable = suites.filter((suite) => suite.engine !== 'rig-procedure')
  const ownPlans = plans.filter((plan) => runnable.some((suite) => suite.id === plan.suiteId))
  const liveCases = cases.filter((entry) => entry.automationState !== 'reference' && !entry.retiredAt)
  const online = runners.filter((runner) => runner.online)
  const needMachine = ownPlans.filter(machineNeeded)
  const machineReady =
    needMachine.length === 0 ||
    needMachine.some((plan) => (plan.runsOn === 'pinned-runner' ? online.some((runner) => runner.id === plan.runnerId) : online.length > 0))
  const verdicts = ownPlans.map((plan) => ({ plan, ...planVerification(plan, runs) }))
  const verified = verdicts.filter((entry) => entry.state === 'verified')
  const scheduled = ownPlans.filter((plan) => plan.scheduleKind === 'cron' && plan.enabled !== false)
  return [
    {
      key: 'suite',
      title: '执行方式',
      required: true,
      done: runnable.length > 0,
      detail: runnable.length ? `${runnable.length} 个：${runnable.map((suite) => suite.displayName).join('、')}` : '说明测试怎么跑：引擎、代码从哪里来、执行命令。由管理员在「设置」里建。'
    },
    {
      key: 'cases',
      title: '用例',
      required: false,
      done: liveCases.length > 0,
      detail: liveCases.length ? `用例库有 ${liveCases.length} 条` : '建议先写下要验证什么；没有用例也能跑，但报告说不出漏了什么。'
    },
    {
      key: 'plan',
      title: '执行计划',
      required: true,
      done: ownPlans.length > 0,
      detail: ownPlans.length ? `${ownPlans.length} 个` : '选执行方式、环境、跑哪些、在哪跑。新计划先是手动的。'
    },
    {
      key: 'machine',
      title: '执行机',
      required: true,
      done: ownPlans.length > 0 && machineReady,
      detail: !ownPlans.length
        ? '有了执行计划再看'
        : needMachine.length === 0
          ? '计划都在服务器上跑'
          : machineReady
            ? `${online.length} 台在线`
            : '计划要在执行机上跑，但现在没有能接手的在线执行机。'
    },
    {
      key: 'verify',
      title: '试跑通过',
      required: true,
      done: verified.length > 0,
      detail: verified.length
        ? `已验证：${verified.map((entry) => entry.plan.name).join('、')}`
        : verdicts.some((entry) => entry.active)
          ? '有一次执行正在进行'
          : verdicts.some((entry) => entry.state === 'failed' || entry.state === 'blocked')
            ? '最近一次没有通过：看执行详情，修好后再跑'
            : '立即执行一次，确认结果是你期望的。'
    },
    {
      key: 'schedule',
      title: '定时',
      required: false,
      done: scheduled.length > 0,
      detail: scheduled.length ? `已定时：${scheduled.map((plan) => plan.name).join('、')}` : '验证过的计划才能开启定时。'
    }
  ]
}

/**
 * The latest run that tested `commit` of a test repository, and whether it
 * proves it (passed). A workspace run records the commit it checked out; a
 * pack run records the source commit and the QA commit as its version.
 */
export function commitVerdict(runs, commit) {
  if (!commit) return { state: 'unverified', run: null }
  const short = `QA ${commit.slice(0, 7)}`
  const own = runs
    .filter((run) => run.sourceRef?.gitSha === commit || run.sourceRef?.version === short)
    .sort((a, b) => String(at(b)).localeCompare(String(at(a))))
  const finished = own.find((run) => FINISHED.includes(run.status) && !['cancelled', 'expired'].includes(run.status)) ?? null
  const active = own.find((run) => ACTIVE.includes(run.status)) ?? null
  const state = !finished ? 'unverified' : ['passed', 'flaky'].includes(finished.status) ? 'verified' : finished.status === 'blocked' ? 'blocked' : 'failed'
  return { state, run: finished, active }
}
