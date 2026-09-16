/**
 * Built-in orchestrations — the seed contents of the 编排中心.
 *
 * Each one answers a question a tester actually asks, and each one stops at
 * the point where a person has to decide. They are data: an admin can edit
 * every node, reorder the branches, or disable the whole thing, without any
 * of it becoming code that runs.
 */
export const BUILTIN_ORCHESTRATIONS = Object.freeze([
  {
    key: 'guarded-dispatch',
    displayName: '有人接才派发',
    summary:
      '先确认有在线执行机，再派发测试计划；没有执行机就直接说清楚，不制造一条永远排队的 Run。',
    enabled: true,
    inputs: [{ name: 'taskId', label: '测试计划', kind: 'task', required: true }],
    entry: 'read_runners',
    nodes: [
      {
        id: 'read_runners',
        type: 'tool',
        title: '读取执行机',
        tool: 'tests_runners',
        args: {},
        capture: { onlineRunners: { from: 'runners', select: 'count', where: 'online' } },
        next: 'has_runner'
      },
      {
        id: 'has_runner',
        type: 'branch',
        title: '有在线执行机吗',
        test: { var: 'onlineRunners', op: 'gt', value: '0' },
        then: 'dispatch',
        otherwise: 'no_runner'
      },
      {
        id: 'dispatch',
        type: 'tool',
        title: '派发测试计划',
        tool: 'tests_run',
        args: { taskId: '{{taskId}}' },
        capture: { runId: { from: 'run.id' }, runStatus: { from: 'run.status' } },
        next: 'report'
      },
      {
        id: 'report',
        type: 'finish',
        title: '已派发',
        message:
          '已派发，Run ID 记录在变量 runId 中，当前原始状态见 runStatus。派发成功不代表测试通过，最终结论请到测试中心查看。'
      },
      {
        id: 'no_runner',
        type: 'finish',
        title: '没有可用执行机',
        message:
          '没有在线执行机，本次没有派发任何测试。请先让管理员注册或上线一台执行机，再重跑这条编排。'
      }
    ]
  },
  {
    key: 'failure-triage',
    displayName: '失败定级链',
    summary:
      '拉齐一次执行的结论、用例级结果与产物，再交给失败定级员给出四选一的判断和下一步；报告前停下来让人看一眼。',
    enabled: true,
    inputs: [{ name: 'runId', label: '测试 Run ID', kind: 'run', required: true }],
    entry: 'read_run',
    nodes: [
      {
        id: 'read_run',
        type: 'tool',
        title: '读取执行结论',
        tool: 'tests_result',
        args: { runId: '{{runId}}' },
        capture: { runStatus: { from: 'run.status' } },
        next: 'decided'
      },
      {
        id: 'decided',
        type: 'branch',
        title: '这次执行出结论了吗',
        test: { var: 'runStatus', op: 'in', values: ['failed', 'flaky', 'blocked', 'expired'] },
        then: 'read_cases',
        otherwise: 'not_failed'
      },
      {
        id: 'read_cases',
        type: 'tool',
        title: '读取用例级结果',
        tool: 'tests_case_results',
        args: { runId: '{{runId}}' },
        capture: {},
        next: 'read_artifacts'
      },
      {
        id: 'read_artifacts',
        type: 'tool',
        title: '读取产物清单',
        tool: 'tests_artifacts',
        args: { runId: '{{runId}}' },
        capture: {},
        next: 'triage'
      },
      {
        id: 'triage',
        type: 'analyze',
        title: '交给失败定级员',
        agentKey: 'failure-triage',
        instruction:
          '基于上面读到的执行结论、用例级结果和产物清单，给出产品缺陷 / 环境受阻 / 用例问题 / 不稳定 四选一的定级，写出支持它的具体证据和一条最能推翻它的反证据，最后给一条可执行的下一步。证据不足就说证据不足。',
        next: 'review'
      },
      {
        id: 'review',
        type: 'approval',
        title: '人工复核定级',
        message:
          '模型给出的定级只是建议。确认之前请核对它引用的用例 ID 与产物是否真的支持这个结论。',
        next: 'done'
      },
      {
        id: 'done',
        type: 'finish',
        title: '定级完成',
        message: '定级已复核。若要据此提缺陷或复跑，请在测试中心执行，本编排不替你操作。'
      },
      {
        id: 'not_failed',
        type: 'finish',
        title: '这次执行没有失败结论',
        message:
          '这次执行的原始状态不是 failed / flaky / blocked / expired，没有需要定级的失败。若它仍在排队或执行中，请等它出结论后再跑一次。'
      }
    ]
  }
])
