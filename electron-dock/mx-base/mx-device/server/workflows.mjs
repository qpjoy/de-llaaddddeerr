import { randomUUID, createHash } from "node:crypto";
import {
  requireThat,
  str,
  uuid,
  register,
  owned,
  markDispatch,
  finish,
  checkpoint,
} from "./model.mjs";
import {
  commandByCode,
  adapterTestDefinition,
  BUILTIN_DEFINITIONS,
  DEMO_RACK,
} from "./workflow-catalog.mjs";
import {
  DEFAULT_LOOP_POLICY,
  loopPolicyFor,
  configureLoops,
} from "./loop-policy.mjs";
import { deviceApps, appBlockers, ensureApps } from "./apps.mjs";
import {
  compareJobs,
  matchesJob,
  policiesFor,
  insertionCost,
  insertionBlockers,
} from "./scheduling.mjs";
const event = (s, now, type, message, more = {}) =>
  s.events.push({
    id: randomUUID(),
    mode: "sim",
    at: now,
    type,
    message,
    ...more,
  });
export function definitions(s) {
  return s.definitions || BUILTIN_DEFINITIONS;
}
export function saveDefinition(s, now, mode, body) {
  requireThat(
    mode === "sim",
    "新指令组合仅允许模拟，真实 adapter 尚未通过执行契约",
    403,
  );
  const code = str(body.code, "定义代码", 60),
    name = str(body.name, "定义名称", 80);
  requireThat(/^[a-z][a-z0-9_.-]{2,59}$/.test(code), "定义代码格式无效", 400);
  requireThat(
    ["xhs", "weibo"].includes(body.appId) &&
      ["small", "large"].includes(body.loop),
    "无效 App 或循环类型",
    400,
  );
  requireThat(
    Array.isArray(body.steps) &&
      body.steps.length >= 1 &&
      body.steps.length <= 12,
    "定义须有 1–12 组指令",
    400,
  );
  let size = 0;
  const steps = body.steps.map((step) => {
    const c = commandByCode(step?.code);
    requireThat(
      c && !c.internal && (!c.appId || c.appId === body.appId),
      "指令未登记或不属于此 App",
      400,
    );
    requireThat(
      Number.isInteger(step.repeat) && step.repeat >= 1 && step.repeat <= 10,
      "每组重复次数为 1–10",
      400,
    );
    size += step.repeat;
    return { code: c.code, repeat: step.repeat };
  });
  requireThat(
    size <= (body.loop === "small" ? 4 : 30),
    "小任务最多 4 条指令，大任务最多 30 条",
    400,
  );
  requireThat(steps[0].code === "app.open", "第一条指令必须打开目标 App", 400);
  let hasSearch = false;
  for (const step of steps) {
    if (step.code === "xhs.search") hasSearch = true;
    if (step.code === "xhs.search.next")
      requireThat(hasSearch, "翻页前必须有搜索", 400);
  }
  s.definitions ||= structuredClone(BUILTIN_DEFINITIONS);
  requireThat(s.definitions.length < 128, "任务定义版本数量已达上限", 429);
  const latest = Math.max(
    0,
    ...s.definitions
      .filter((d) => d.mode === mode && d.code === code)
      .map((d) => d.version),
  );
  requireThat(
    body.expectedVersion === latest,
    "任务定义版本已更新，请刷新后重试",
  );
  requireThat(
    body.resumable === undefined || typeof body.resumable === "boolean",
    "resumable 须为布尔值",
    400,
  );
  const row = {
    id: `${mode}:${code}:${latest + 1}`,
    mode,
    code,
    name,
    version: latest + 1,
    appId: body.appId,
    loop: body.loop,
    steps,
    resumable: body.loop === "large" && body.resumable === true,
    executionModel: "checkpoint-session.v1",
    createdAt: now,
  };
  s.definitions.push(row);
  event(
    s,
    now,
    "definition",
    `保存任务定义 ${code} v${row.version}；既有任务保持原版本`,
  );
  return row;
}
export function addWorkflow(s, now, mode, body) {
  requireThat(mode === "sim", "组合指令仅模拟；真实派发未启用", 403);
  const def = definitions(s).find(
    (d) => d.mode === mode && d.id === body.definitionId,
  );
  requireThat(def, "任务定义版本不存在", 400);
  return enqueueWorkflow(s, now, mode, body, def);
}
function enqueueWorkflow(s, now, mode, body, def) {
  const params = {
    keyword: str(body.keyword || "演示关键词", "关键词", 200),
    target: str(body.target || "demo-note-1", "目标标识", 200),
  };
  const deviceId = body.deviceId ? uuid(body.deviceId) : null;
  const priority = Number(body.priority ?? 5);
  requireThat(
    Number.isInteger(priority) && priority >= 1 && priority <= 9,
    "优先级为 1–9",
    400,
  );
  const spec = {
    definitionId: def.id,
    params,
    deviceId,
    priority,
    rack: body.rack ? str(body.rack, "机架") : null,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(spec))
    .digest("hex");
  const key = str(body.key, "幂等键");
  const prior = s.jobs.find((j) => j.mode === mode && j.key === key);
  if (prior) {
    requireThat(
      prior.fingerprint === fingerprint,
      "同一幂等键不能用于不同任务",
    );
    return prior;
  }
  requireThat(
    s.jobs.filter(
      (j) => j.mode === mode && ["queued", "running"].includes(j.status),
    ).length < 200,
    "任务池已满（200）",
    429,
  );
  if (deviceId) {
    const d = s.devices.find((d) => d.id === deviceId && d.mode === mode);
    requireThat(
      d && d.enabled && d.state !== "quarantined",
      "目标设备尚未启用或待核验",
    );
    requireThat(!spec.rack || spec.rack === d.rack, "设备不属于所选机架", 400);
  }
  const plan = [];
  let page = 0;
  for (const step of def.steps)
    for (let n = 0; n < step.repeat; n++) {
      if (step.code === "xhs.search") page = 1;
      else if (step.code === "xhs.search.next") page++;
      plan.push({
        code: step.code,
        page: step.code.startsWith("xhs.search") ? page : null,
        ordinal: plan.length + 1,
      });
    }
  const j = {
    id: randomUUID(),
    mode,
    key,
    fingerprint,
    operation: "workflow",
    appId: def.appId,
    input: params,
    deviceId,
    priority,
    placement: spec.rack ? { rack: spec.rack, host: null } : undefined,
    estimatedDurationMs: plan.reduce(
      (n, step) => n + commandByCode(step.code).estimateMs,
      0,
    ),
    executionModel: def.executionModel,
    workflow: {
      definitionId: def.id,
      name: def.name,
      version: def.version,
      loop: def.loop,
      resumable: def.resumable,
      plan,
      nextStep: 0,
      receipts: [],
      insertions: 0,
      detourMs: 0,
      insertedEstimateMs: 0,
    },
    status: "queued",
    createdAt: now,
    notBefore: now,
    attemptCount: 0,
    lastDeviceId: null,
    reason: "等待匹配插槽",
    runId: body.runId || null,
  };
  s.jobs.push(j);
  event(
    s,
    now,
    "queued",
    `${def.name} v${def.version}：${plan.length} 条指令入池`,
    { jobId: j.id },
  );
  return j;
}
export function testAdapterCommand(s, now, mode, deviceId, body) {
  requireThat(
    mode === "sim",
    "控制指令试运行仅模拟；真实控制 adapter 尚未启用",
    403,
  );
  const device = s.devices.find((d) => d.id === deviceId && d.mode === mode);
  requireThat(device, "设备不存在", 404);
  const def = adapterTestDefinition(body.code, body.appId);
  requireThat(def, "指令未登记、仅供内部使用或不属于此 App", 400);
  const job = enqueueWorkflow(
    s,
    now,
    mode,
    {
      key: body.key,
      deviceId,
      keyword: body.keyword,
      target: body.target,
      priority: 5,
    },
    def,
  );
  job.adapterTest = { code: body.code, appId: body.appId };
  return job;
}
export function startWorkflow(s, now, device, job, attempt) {
  if (!job.workflow) return;
  const policy = loopPolicyFor(s, device) || DEFAULT_LOOP_POLICY;
  job.workflow.policySnapshot = { ...policy };
  attempt.loop = job.workflow.loop;
  attempt.executionGeneration = 1;
  if (job.workflow.loop === "large") device.workflowAttemptId = attempt.id;
}
export function claimContinuation(s, now, mode, workerId) {
  if (mode !== "sim") return null;
  for (const d of s.devices.filter(
    (d) => d.mode === mode && d.workflowAttemptId,
  )) {
    const a = s.attempts.find((a) => a.id === d.workflowAttemptId);
    const j = s.jobs.find((j) => j.id === a?.jobId);
    if (
      !a ||
      !j ||
      a.status !== "yielded" ||
      d.state === "quarantined" ||
      d.connected === "offline"
    )
      continue;
    if (s.attempts.some((a) => a.deviceId === d.id && a.status === "running"))
      continue;
    const w = j.workflow,
      p = w.policySnapshot;
    if (d.cooldownUntil > now) continue;
    const canInsert =
      w.safePoint &&
      w.resumable &&
      d.enabled &&
      !policiesFor(s, d).some((p) => p.draining) &&
      !["waiting", "held"].includes(d.session?.status) &&
      w.insertions < p.maxInsertions;
    const children = canInsert
      ? s.jobs
          .filter(
            (c) =>
              c.mode === mode &&
              c.status === "queued" &&
              c.notBefore <= now &&
              c.workflow?.loop === "small" &&
              matchesJob(d, c) &&
              !appBlockers(s, now, d, c).length &&
              !insertionBlockers(s, now, d, c).length,
          )
          .sort(compareJobs(now))
      : [];
    const child = children[0];
    if (child) {
      const binding = ensureApps(s, d).find((x) => x.appId === child.appId);
      const ca = {
        id: randomUUID(),
        mode,
        jobId: child.id,
        deviceId: d.id,
        appId: child.appId,
        accountKey: binding.accountKey,
        workerId,
        epoch: d.epoch,
        status: "running",
        createdAt: now,
        leaseUntil: now + 180000,
        dispatchedAt: null,
        checkpoints: [],
        loop: "small",
        parentAttemptId: a.id,
        estimatedDurationMs: child.estimatedDurationMs,
        executionModel: child.executionModel,
      };
      s.attempts.push(ca);
      child.status = "running";
      child.attemptCount++;
      child.startedAt = now;
      child.lastDeviceId = d.id;
      child.reason = `插入大任务检查点（${w.insertions + 1}/${p.maxInsertions}）`;
      w.insertions++;
      w.insertedEstimateMs += insertionCost(s, d, child);
      w.detourStartedAt ??= now;
      w.restorePending = true;
      d.revision++;
      d.lastClaimedAt = now;
      binding.lastClaimedAt = now;
      startWorkflow(s, now, d, child, ca);
      event(
        s,
        now,
        "workflow-insert",
        `${d.name} 插入 ${child.workflow.name}，大任务保留在第 ${w.nextStep}/${w.plan.length} 条；已插入 ${w.insertions}/${p.maxInsertions}`,
        { deviceId: d.id, jobId: child.id, parentJobId: j.id },
      );
      return { device: d, job: child, attempt: ca };
    }
    const app = deviceApps(s, d).find((x) => x.appId === j.appId);
    // A task's own dispatch reservation does not block its next step. Another task's rest does.
    if (app?.cooldownUntil > now && app.lastAttemptId !== a.id) {
      j.reason = `检查点等待 ${j.appId} 冷却，保留原插槽`;
      continue;
    }
    if (w.detourStartedAt != null) {
      w.detourMs += now - w.detourStartedAt;
      w.detourStartedAt = null;
    }
    a.status = "running";
    a.workerId = workerId;
    a.executionGeneration++;
    a.leaseUntil = now + 180000;
    d.revision++;
    j.reason = w.restorePending
      ? "恢复已保存上下文，再继续大循环"
      : "从已确认检查点继续";
    return { device: d, job: j, attempt: a };
  }
  return null;
}
export function beginCommand(s, now, a) {
  if (!owned(s, now, a)) return null;
  const j = s.jobs.find((j) => j.id === a.jobId),
    w = j.workflow;
  requireThat(j.mode === "sim" && w, "真实组合执行未启用", 403);
  requireThat(
    !(s.commands || []).some(
      (c) => c.deviceId === a.deviceId && c.status === "running",
    ),
    "插槽已有在途指令",
  );
  const step = w.restorePending
    ? { code: "session.restore", ordinal: w.nextStep + 1 }
    : w.plan[w.nextStep];
  if (!step) return null;
  markDispatch(s, now, a);
  const policy = w.policySnapshot || DEFAULT_LOOP_POLICY;
  const c = {
    id: randomUUID(),
    mode: "sim",
    jobId: j.id,
    attemptId: a.id,
    deviceId: a.deviceId,
    appId: j.appId,
    code: step.code,
    stepIndex: w.nextStep,
    page: step.page || null,
    params: j.input,
    status: "running",
    createdAt: now,
    epoch: a.epoch,
    estimatedDurationMs: commandByCode(step.code).estimateMs,
    simulationDurationMs: policy.commandDelayMs,
    restoring: step.code === "session.restore",
    loop: w.loop,
    definitionId: w.definitionId,
  };
  s.commands ||= [];
  s.commands.push(c);
  return c;
}
export function simulateCommand(c) {
  const receipt = {
    commandId: c.id,
    jobId: c.jobId,
    attemptId: c.attemptId,
    deviceId: c.deviceId,
    appId: c.appId,
    code: c.code,
    stepIndex: c.stepIndex,
    stopped: true,
    source: "simulator",
  };
  if (c.code === "session.restore")
    return {
      ...receipt,
      result: { restoredStep: c.stepIndex, appId: c.appId },
    };
  if (c.code === "app.open")
    return { ...receipt, result: { foregroundAppId: c.appId } };
  if (c.code === "session.home") return { ...receipt, result: { home: true } };
  if (c.code === "session.back")
    return { ...receipt, result: { backed: true } };
  if (c.code === "weibo.like")
    return { ...receipt, result: { target: c.params.target, liked: true } };
  if (c.code.includes("detail") || c.code.endsWith("ocr"))
    return {
      ...receipt,
      result: {
        target: c.params.target,
        fullText: "模拟正文：完整任务内容与 OCR 证据，仅用于演示。",
        complete: true,
      },
    };
  return {
    ...receipt,
    result: {
      keyword: c.params.keyword,
      page: c.page,
      items: [1, 2, 3].map((n) => ({
        id: `${c.id}-${n}`,
        title: `${c.params.keyword} · 合成内容 ${n}`,
      })),
    },
  };
}
export function validReceipt(c, r) {
  if (
    !r ||
    r.source !== "simulator" ||
    r.stopped !== true ||
    [
      "commandId",
      "jobId",
      "attemptId",
      "deviceId",
      "appId",
      "code",
      "stepIndex",
    ].some((k) => r[k] !== { commandId: c.id, ...c }[k])
  )
    return false;
  const x = r.result;
  if (c.code === "session.restore")
    return x?.restoredStep === c.stepIndex && x?.appId === c.appId;
  if (c.code === "app.open") return x?.foregroundAppId === c.appId;
  if (c.code === "session.home") return x?.home === true;
  if (c.code === "session.back") return x?.backed === true;
  if (c.code === "weibo.like")
    return x?.target === c.params.target && x?.liked === true;
  if (c.code.includes("detail") || c.code.endsWith("ocr"))
    return (
      x?.target === c.params.target &&
      x?.complete === true &&
      typeof x?.fullText === "string" &&
      x.fullText.length > 0
    );
  return (
    x?.keyword === c.params.keyword &&
    x?.page === c.page &&
    Array.isArray(x?.items) &&
    x.items.length > 0 &&
    x.items.every((i) => typeof i.id === "string")
  );
}
export function completeCommand(s, now, a, c, r) {
  const row = s.commands.find((x) => x.id === c.id);
  if (
    !row ||
    row.attemptId !== a.id ||
    row.jobId !== a.jobId ||
    row.deviceId !== a.deviceId
  )
    return false;
  if (row.status !== "running") {
    if (row.status === "unknown") row.lateEvidence = { at: now, receipt: r };
    return row.status === "succeeded";
  }
  if (!owned(s, now, a)) {
    row.lateEvidence = { at: now, receipt: r };
    return false;
  }
  const j = s.jobs.find((j) => j.id === a.jobId),
    w = j.workflow,
    d = s.devices.find((d) => d.id === a.deviceId);
  if (!validReceipt(row, r)) {
    row.status = "unknown";
    row.completedAt = now;
    finish(s, now, a, { error: "指令回执身份或完成条件不匹配" });
    cleanWorkflowFaults(s, now);
    return false;
  }
  row.status = "succeeded";
  row.completedAt = now;
  row.receipt = r;
  if (row.restoring) {
    w.restorePending = false;
  } else {
    w.receipts.push({
      commandId: row.id,
      code: row.code,
      stepIndex: row.stepIndex,
      page: row.page,
      count: r.result.items?.length || 0,
      completedAt: now,
    });
    w.nextStep++;
  }
  checkpoint(s, now, a, {
    status: `${commandByCode(row.code).name} · ${w.nextStep}/${w.plan.length}`,
    commandId: row.id,
    commandCode: row.code,
    detail: r.result.fullText
      ? { id: r.result.target, title: "模拟正文", content: r.result.fullText }
      : undefined,
    page: row.page,
    count: r.result.items?.length,
    items: r.result.items || [],
    keyword: j.input.keyword,
  });
  if (w.nextStep === w.plan.length) {
    finish(s, now, a, {
      result: {
        definitionId: w.definitionId,
        completedSteps: w.nextStep,
        receipts: w.receipts,
        stopped: true,
        completion: "all-command-receipts-validated",
      },
    });
    if (a.id === d.workflowAttemptId) delete d.workflowAttemptId;
    else if (a.parentAttemptId) {
      d.state = "running";
      d.revision++;
    }
    return true;
  }
  if (w.loop === "large") {
    const current = s.attempts.find((x) => x.id === a.id);
    current.status = "yielded";
    current.checkpointAt = now;
    w.safePoint = commandByCode(row.code).effect === "read" && !row.restoring;
    j.reason = `检查点 ${w.nextStep}/${w.plan.length}，保留插槽`;
  }
  return true;
}
export function cleanWorkflowFaults(s, now) {
  for (const d of s.devices.filter(
    (d) => d.state === "quarantined" && d.workflowAttemptId,
  )) {
    const a = s.attempts.find((a) => a.id === d.workflowAttemptId);
    if (a?.status === "yielded") {
      a.status = "unknown";
      a.completedAt = now;
      const j = s.jobs.find((j) => j.id === a.jobId);
      j.status = "unknown";
      j.completedAt = now;
      j.reason = "插入执行或设备状态未知，父任务一并隔离";
    }
    delete d.workflowAttemptId;
  }
  for (const c of (s.commands || []).filter((c) => c.status === "running")) {
    const a = s.attempts.find((a) => a.id === c.attemptId);
    if (a && a.status === "unknown") {
      c.status = "unknown";
      c.completedAt = now;
    }
  }
}
export function rackScenario(s, now, key) {
  const prior = s.jobs.find((j) => j.mode === "sim" && j.runId === key);
  if (prior) return { runId: key, replayed: true };
  requireThat(
    !s.jobs.some(
      (j) => j.mode === "sim" && ["queued", "running"].includes(j.status),
    ),
    "请先完成当前模拟任务",
  );
  requireThat(
    !s.devices.some(
      (d) =>
        d.mode === "sim" && ["waiting", "held"].includes(d.session?.status),
    ),
    "请先释放模拟控制会话",
  );
  const slots = [];
  for (let slot = 1; slot <= 10; slot++) {
    let d = s.devices.find(
      (d) => d.mode === "sim" && d.rack === DEMO_RACK && d.slot === slot,
    );
    if (!d) {
      d = register(s, now, "sim", {
        name: `插槽 ${String(slot).padStart(2, "0")}`,
        rack: DEMO_RACK,
        host: "模拟十槽宿主机",
      });
      d.slot = slot;
    }
    requireThat(
      d.state === "idle" &&
        d.connected !== "offline" &&
        !policiesFor(s, d).some((p) => p.draining),
      "演示插槽隔离、离线或排空，请先处理",
    );
    requireThat(
      d.cooldownUntil <= now &&
        deviceApps(s, d).every((a) => a.cooldownUntil <= now),
      "演示插槽仍在冷却，请等待截止时间",
    );
    d.enabled = true;
    d.revision++;
    slots.push(d);
  }
  let policy = loopPolicyFor(s, slots[0]);
  if (!policy)
    policy = configureLoops(s, now, "sim", {
      rack: DEMO_RACK,
      revision: 0,
      ...DEFAULT_LOOP_POLICY,
    });
  const put = (i, code, slot, priority) =>
    addWorkflow(s, now, "sim", {
      key: `${key}:${i}`,
      runId: key,
      definitionId: `sim:${code}:1`,
      deviceId: slot ? slots[slot - 1].id : null,
      rack: DEMO_RACK,
      priority,
      keyword: `演示主题 ${i}`,
      target: `demo-note-${i}`,
    });
  // Five large sessions occupy five slots, five independent jobs demonstrate other slots.
  for (let i = 1; i <= 5; i++)
    put(i, i % 2 ? "xhs.search10" : "weibo.search_batch", i, 1);
  const types = [
    "weibo.list",
    "weibo.search",
    "weibo.like",
    "xhs.list",
    "xhs.detail",
    "xhs.ocr",
  ];
  for (let i = 6; i <= 10; i++) put(i, types[(i - 6) % types.length], i, 5);
  const targets = [1, 1, 1, 1, 2, 2, 3, 3, 4, 5];
  for (let i = 11; i <= 20; i++) {
    const j = put(i, types[(i - 11) % types.length], targets[i - 11], 3);
    j.notBefore = now + policy.commandDelayMs * 2;
  }
  event(
    s,
    now,
    "rack-demo",
    "10 插槽 / 20 任务入池：5 个大循环、15 个小任务；真实 I/O 禁止",
    { runId: key },
  );
  return { runId: key, rack: DEMO_RACK, slots: 10, jobs: 20 };
}
