import { randomUUID, createHash } from "node:crypto";

export class Fault extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
export const requireThat = (yes, message, status) => {
  if (!yes) throw new Fault(message, status);
};
export const str = (v, name, max = 120) => {
  requireThat(
    typeof v === "string" && v.trim() && v.length <= max,
    `${name}必填，最多 ${max} 字符`,
    400,
  );
  return v.trim();
};
export const realm = (v) => {
  requireThat(["sim", "real"].includes(v), "无效的运行模式", 400);
  return v;
};
export const uuid = (v) => {
  requireThat(
    typeof v === "string" &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v),
    "无效 ID",
    400,
  );
  return v;
};
export function origin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Fault("服务地址无效", 400);
  }
  requireThat(
    u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      Number(u.port) >= 18081 &&
      Number(u.port) <= 18180 &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "兼容适配器仅允许执行器宿主机 http://127.0.0.1:18081–18180；不接受路径、凭证或重定向",
    400,
  );
  return u.origin;
}
export function mobileOrigin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Fault("Mobile-Agent 地址无效", 400);
  }
  requireThat(
    u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      Number(u.port) >= 8787 &&
      Number(u.port) <= 8797 &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "观察接口仅允许执行器宿主机 http://127.0.0.1:8787–8797，不接受路径或凭证",
    400,
  );
  return u.origin;
}
export function serialNumber(value) {
  const serial = str(value, "ADB 序列号");
  requireThat(/^[a-zA-Z0-9._:-]+$/.test(serial), "序列号格式无效", 400);
  return serial;
}
export function publicDevice(d) {
  if (!d) return d;
  const { tokenHash, ...session } = d.session || {};
  return { ...d, session: d.session ? session : null };
}
export function noteLink(value) {
  const text = str(value, "详情链接", 8192);
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Fault("详情链接无效", 400);
  }
  requireThat(
    u.protocol === "https:" &&
      u.hostname === "www.xiaohongshu.com" &&
      /^\/explore\/[a-zA-Z0-9]+\/?$/.test(u.pathname) &&
      !u.username &&
      !u.password &&
      !u.hash,
    "请使用搜索结果中的小红书 HTTPS explore 链接",
    400,
  );
  return text;
}
const event = (s, mode, at, type, message, more = {}) =>
  s.events.push({ id: randomUUID(), mode, at, type, message, ...more });
const bump = (d) => {
  d.revision++;
};
const active = (j) => ["queued", "running"].includes(j.status);
const findDevice = (s, mode, id) => {
  const d = s.devices.find((d) => d.mode === mode && d.id === id);
  requireThat(d, "设备不存在", 404);
  return d;
};
export function register(s, now, mode, body) {
  requireThat(
    s.devices.filter((d) => d.mode === mode).length < 64,
    "首版每个模式最多 64 台设备",
  );
  const adapter = mode === "sim" ? "simulator" : body.adapter || "legacy-poc";
  requireThat(
    mode === "sim" || ["legacy-poc", "mobile-agent"].includes(adapter),
    "未知适配器",
    400,
  );
  const serial = body.serial ? serialNumber(body.serial) : null;
  if (adapter === "mobile-agent")
    requireThat(serial, "Mobile-Agent 必须指定真实 ADB 序列号", 400);
  const endpoint =
    mode === "real"
      ? adapter === "mobile-agent"
        ? mobileOrigin(body.origin)
        : origin(body.origin)
      : null;
  const workerId =
    mode === "real" ? str(body.workerId, "执行器") : "simulation";
  const resourceKey =
    mode === "real"
      ? `${workerId}:${endpoint}${adapter === "mobile-agent" ? `:${serial}` : ""}`
      : randomUUID();
  const accountKey =
    mode === "real" ? str(body.accountKey, "账号资源标识") : resourceKey;
  requireThat(
    !s.devices.some(
      (d) =>
        d.mode === mode &&
        (d.resourceKey === resourceKey || d.accountKey === accountKey),
    ),
    "该入口或账号资源已登记；不能给同一手机另起别名绕过互斥",
  );
  if (mode === "real" && body.serial)
    requireThat(
      !s.devices.some(
        (d) => d.mode === mode && d.serial === String(body.serial).trim(),
      ),
      "该序列号已登记，不能重复占用同一手机",
    );
  if (mode === "real")
    requireThat(body.approved === true, "必须批准此本机连接目标", 400);
  const d = {
    id: randomUUID(),
    mode,
    adapter,
    name: str(body.name, "设备名称", 80),
    rack: str(body.rack || "未分配机架", "机架"),
    host: str(body.host || "未命名宿主机", "宿主机"),
    workerId,
    origin: endpoint,
    resourceKey,
    accountKey,
    identity: mode === "real" ? "operator-declared-unverified" : "simulated",
    serial,
    observer:
      adapter === "mobile-agent"
        ? { origin: endpoint, serial, version: randomUUID() }
        : null,
    enabled: mode === "sim",
    state: "idle",
    connected: mode === "sim" ? "online" : "unknown",
    revision: 1,
    epoch: 1,
    cooldownUntil: 0,
    probe: null,
    projection: null,
    createdAt: now,
  };
  s.devices.push(d);
  event(
    s,
    mode,
    now,
    "registered",
    `${d.name} 已登记${mode === "real" ? "，默认暂停；物理身份待核验" : ""}`,
    { deviceId: d.id },
  );
  return d;
}
export function addJob(s, now, mode, body) {
  const key = str(body.key, "幂等键"),
    operation = body.operation;
  requireThat(
    ["search", "note"].includes(operation),
    "只支持有界搜索和详情任务",
    400,
  );
  const input =
    operation === "search"
      ? {
          keyword: str(body.keyword, "关键词", 200),
          pages: Number(body.pages ?? 1),
        }
      : { input: body.sourceJobId ? null : noteLink(body.input) };
  if (operation === "search")
    requireThat(
      Number.isInteger(input.pages) && input.pages >= 1 && input.pages <= 3,
      "每个搜索会话限定 1–3 页",
      400,
    );
  const sourceJobId = body.sourceJobId ? uuid(body.sourceJobId) : null;
  requireThat(
    !sourceJobId || operation === "note",
    "只有详情任务可以引用搜索结果",
    400,
  );
  const deviceId = body.deviceId ? uuid(body.deviceId) : null;
  const priority = Number(body.priority ?? 5);
  requireThat(
    Number.isInteger(priority) && priority >= 1 && priority <= 9,
    "优先级为 1–9，1 最高",
    400,
  );
  const spec = { operation, input, deviceId, sourceJobId, priority };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(spec))
    .digest("hex");
  const previous = s.jobs.find((j) => j.mode === mode && j.key === key);
  if (previous) {
    requireThat(
      previous.fingerprint === fingerprint,
      "同一幂等键不能用于不同任务",
    );
    return previous;
  }
  requireThat(
    s.jobs.filter((j) => j.mode === mode && active(j)).length < 200,
    "任务池已满（200）",
    429,
  );
  if (deviceId) {
    const d = findDevice(s, mode, deviceId);
    requireThat(
      d.adapter !== "mobile-agent",
      "此适配器目前仅观察，不支持搜索/详情派发",
      400,
    );
    requireThat(
      d.pocDisabled !== true,
      "旧 PoC 通道已停用，不派发采集任务",
      400,
    );
    requireThat(
      d.enabled && d.state !== "quarantined",
      "目标设备尚未启用或待核验",
    );
  }
  if (mode === "real")
    requireThat(deviceId, "兼容真机任务必须明确指定设备；不自动更换账号", 400);
  if (sourceJobId) {
    const src = s.jobs.find((j) => j.id === sourceJobId && j.mode === mode);
    requireThat(src?.operation === "search", "依赖的搜索任务不存在", 400);
    if (mode === "real")
      requireThat(src.deviceId === deviceId, "真实详情需沿用来源设备和账号");
  }
  const j = {
    id: randomUUID(),
    mode,
    key,
    fingerprint,
    ...spec,
    status: "queued",
    createdAt: now,
    notBefore: now,
    attemptCount: 0,
    reason: sourceJobId ? "等待来源搜索" : "等待兼容设备",
    lastDeviceId: null,
    runId: body.runId || null,
  };
  s.jobs.push(j);
  event(
    s,
    mode,
    now,
    "queued",
    `${operation === "search" ? `搜索「${input.keyword}」` : "详情任务"} 已进入任务池`,
    { jobId: j.id },
  );
  return j;
}
export function control(s, now, mode, id, body) {
  const d = findDevice(s, mode, id);
  requireThat(body.revision === d.revision, "设备状态已更新，请刷新后重试");
  const current = s.attempts.find(
    (a) => a.deviceId === id && a.status === "running",
  );
  if (body.action === "pause") d.enabled = false;
  else if (body.action === "enable") {
    requireThat(d.pocDisabled !== true, "旧 PoC 通道已停用", 403);
    requireThat(
      d.adapter !== "mobile-agent",
      "Mobile-Agent 观察适配器尚不允许真实控制",
      403,
    );
    requireThat(
      !["waiting", "held"].includes(d.session?.status),
      "请先释放本中心控制会话",
    );
    requireThat(!current && d.state === "idle", "设备执行中或待核验");
    if (mode === "real") {
      requireThat(
        d.probe?.idle === true &&
          now - d.probe.at < 60000 &&
          d.probe.at > (d.pocChangedAt || 0),
        "请先检查连接，并取得 60 秒内的空闲证据",
      );
      requireThat(
        body.confirmedExclusive === true,
        "请确认 Hub 旧调度和其他调用方已停止，手机由本中心独占",
      );
    }
    requireThat(d.connected !== "offline", "设备离线");
    d.enabled = true;
  } else if (body.action === "recover") {
    requireThat(
      d.state === "quarantined" && !current && now >= (d.recoveryAfter || 0),
      "尚不能恢复，须等待执行租约结束",
    );
    requireThat(
      body.confirmedStopped === true && str(body.reason, "核验说明", 500),
      "需确认旧执行器及手机操作已停止",
    );
    if (mode === "real")
      requireThat(
        d.probe?.idle &&
          now - d.probe.at < 60000 &&
          d.probe.at > (d.pocChangedAt || 0),
        "须重新取得空闲证据",
      );
    d.state = "idle";
    d.enabled = false;
    d.epoch++;
    d.cooldownUntil = now + 2000;
  } else if (body.action === "disconnect") {
    requireThat(mode === "sim", "断线注入只允许模拟设备", 400);
    d.connected = "offline";
    d.enabled = false;
    d.epoch++;
    if (current) {
      current.status = "interrupted";
      current.completedAt = now;
      const j = s.jobs.find((j) => j.id === current.jobId);
      j.status = "queued";
      j.notBefore = now + 6000;
      j.reason = "模拟中断：6 秒后由其他设备领取";
      j.lastDeviceId = id;
      d.state = "idle";
      event(
        s,
        mode,
        now,
        "sim-interrupted",
        `${d.name} 模拟中断，任务保留；旧尝试不能提交结果`,
        { jobId: j.id, deviceId: id },
      );
    }
  } else if (body.action === "reconnect") {
    requireThat(mode === "sim", "仅模拟模式可直接恢复连接", 400);
    requireThat(!current, "设备仍在执行");
    requireThat(
      !["waiting", "held"].includes(d.session?.status),
      "请先解除控制会话",
    );
    d.connected = "online";
    d.state = "idle";
    d.enabled = true;
    d.epoch++;
  } else throw new Fault("未知设备操作", 400);
  bump(d);
  event(s, mode, now, body.action, `${d.name}：${body.action}`, {
    deviceId: id,
  });
  return d;
}
export function recordProbe(s, now, mode, id, revision, observation) {
  const d = findDevice(s, mode, id);
  requireThat(d.revision === revision, "检查期间设备状态已变化，请重新检查");
  d.probe = { ...observation, at: now };
  d.connected = observation.reachable ? "online" : "unknown";
  if (!observation.idle) d.enabled = false;
  if (observation.projection)
    d.projection = {
      ...observation.projection,
      observedAt: now,
      source: "real",
      progressAt:
        d.projection?.fingerprint === observation.projection.fingerprint
          ? d.projection.progressAt
          : now,
    };
  bump(d);
  event(
    s,
    mode,
    now,
    "probe",
    `${d.name}：${observation.reachable ? "接口可达" : "接口不可达"} / ${observation.idle ? "报告空闲" : "不可判定为可调度"}`,
    { deviceId: id },
  );
  return d;
}
export function sweep(s, now, mode) {
  for (const a of s.attempts.filter(
    (a) => a.mode === mode && a.status === "running" && a.leaseUntil <= now,
  )) {
    const j = s.jobs.find((j) => j.id === a.jobId),
      d = findDevice(s, mode, a.deviceId);
    a.status = "unknown";
    a.completedAt = now;
    a.error = "执行租约过期，结果未知";
    if (j) {
      j.status = "unknown";
      j.reason = a.error;
      j.completedAt = now;
    }
    d.enabled = false;
    d.state = "quarantined";
    d.recoveryAfter = a.leaseUntil;
    bump(d);
    event(
      s,
      mode,
      now,
      "unknown",
      "租约过期：隔离设备；未派发任务仍在池中，不盲目重试",
      { jobId: a.jobId, deviceId: d.id },
    );
  }
  sweepSessions(s, now, mode);
}
export function claim(s, now, mode, workerId) {
  sweep(s, now, mode);
  const devices = s.devices.filter(
    (d) =>
      d.mode === mode &&
      d.enabled &&
      d.adapter !== "mobile-agent" &&
      d.pocDisabled !== true &&
      !["waiting", "held"].includes(d.session?.status) &&
      d.state === "idle" &&
      d.connected !== "offline" &&
      d.cooldownUntil <= now &&
      (mode === "sim" || d.workerId === workerId),
  );
  devices.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const pending = s.jobs.filter(
    (j) => j.mode === mode && j.status === "queued" && j.notBefore <= now,
  );
  const score = (j) =>
    Math.max(1, j.priority - Math.floor((now - j.createdAt) / 30000));
  pending.sort(
    (a, b) =>
      score(a) - score(b) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
  for (const j of pending) {
    if (j.sourceJobId) {
      const src = s.jobs.find((x) => x.id === j.sourceJobId);
      if (!src || active(src)) continue;
      if (src.status !== "succeeded") {
        j.status = "blocked";
        j.reason = "来源任务未成功，不重新采集";
        j.completedAt = now;
        continue;
      }
      const link = src.result?.pages?.[0]?.items?.[0]?.detailInput;
      if (!link) {
        j.status = "skipped";
        j.reason = "来源搜索没有可用详情链接";
        j.completedAt = now;
        continue;
      }
      try {
        j.input.input = noteLink(link);
      } catch {
        j.status = "blocked";
        j.reason = "来源详情链接未通过校验";
        j.completedAt = now;
        continue;
      }
    }
    const d = devices.find((d) => !j.deviceId || d.id === j.deviceId);
    if (!d) continue;
    const a = {
      id: randomUUID(),
      jobId: j.id,
      mode,
      deviceId: d.id,
      workerId,
      epoch: d.epoch,
      status: "running",
      createdAt: now,
      leaseUntil: now + 180000,
      dispatchedAt: null,
      checkpoints: [],
    };
    s.attempts.push(a);
    j.status = "running";
    j.attemptCount++;
    j.lastDeviceId = d.id;
    j.reason = `优先级 ${j.priority}，等待提升后 ${score(j)}；设备空闲且依赖满足`;
    j.startedAt = now;
    d.state = "running";
    bump(d);
    event(s, mode, now, "claimed", `${d.name} 领取任务；${j.reason}`, {
      jobId: j.id,
      deviceId: d.id,
      attemptId: a.id,
    });
    return { device: d, job: j, attempt: a };
  }
  return null;
}
export function owned(s, now, a) {
  const current = s.attempts.find((x) => x.id === a.id),
    d = s.devices.find((x) => x.id === a.deviceId);
  return (
    current?.status === "running" &&
    current.epoch === a.epoch &&
    current.leaseUntil > now &&
    d?.epoch === a.epoch
  );
}
export function markDispatch(s, now, a) {
  if (!owned(s, now, a)) return false;
  const row = s.attempts.find((x) => x.id === a.id);
  row.dispatchedAt ??= now;
  return true;
}
export function checkpoint(s, now, a, result) {
  if (!owned(s, now, a)) return false;
  s.attempts.find((x) => x.id === a.id).checkpoints.push(result);
  const d = s.devices.find((d) => d.id === a.deviceId);
  d.projection = {
    source: a.mode === "sim" ? "sim" : "real",
    observedAt: now,
    progressAt: now,
    type: result.detail ? "note" : "search",
    page: result.page || null,
    count: result.count ?? null,
    keyword: result.keyword || null,
    status: result.status || "步骤完成",
    items: (result.items || [])
      .map((i) => ({ id: i.id, title: i.title, authorName: i.authorName }))
      .slice(0, 50),
    detail: result.detail
      ? {
          id: result.detail.id,
          title: result.detail.title,
          content: result.detail.content,
        }
      : null,
    isBusy: false,
  };
  bump(d);
  event(
    s,
    a.mode,
    now,
    "checkpoint",
    result.detail
      ? "详情证据已保存"
      : `已确认第 ${result.page} 页，${result.count} 条`,
    { jobId: a.jobId, deviceId: a.deviceId, projection: d.projection },
  );
  return true;
}
export function finish(s, now, a, outcome) {
  const row = s.attempts.find((x) => x.id === a.id);
  if (!row) return;
  if (!owned(s, now, a)) {
    row.lateEvidence ??= { at: now, ...outcome };
    event(s, a.mode, now, "late", "迟到回执保留为证据，不覆盖当前任务", {
      jobId: a.jobId,
      attemptId: a.id,
    });
    return;
  }
  const j = s.jobs.find((j) => j.id === a.jobId),
    d = findDevice(s, a.mode, a.deviceId);
  row.completedAt = now;
  row.result = outcome.result;
  row.error = outcome.error;
  if (outcome.blockedBeforeDispatch && !row.dispatchedAt) {
    row.status = "blocked";
    j.status = "queued";
    j.reason = "手机未报告空闲，已暂停设备；任务保留";
    d.enabled = false;
    d.state = "idle";
  } else if (outcome.error) {
    row.status = "unknown";
    j.status = "unknown";
    j.reason = outcome.error;
    j.completedAt = now;
    d.state = "quarantined";
    d.enabled = false;
    d.recoveryAfter = row.leaseUntil;
  } else {
    row.status = "succeeded";
    j.status = "succeeded";
    j.result = outcome.result;
    j.completedAt = now;
    j.reason = "全部已确认步骤完成";
    d.state = "idle";
    d.cooldownUntil = now + (a.mode === "real" ? 2000 : 300);
  }
  bump(d);
  event(s, a.mode, now, row.status, `${d.name}：${j.reason}`, {
    jobId: j.id,
    deviceId: d.id,
    attemptId: a.id,
  });
}
export function cancel(s, now, mode, id) {
  const j = s.jobs.find((j) => j.mode === mode && j.id === id);
  requireThat(j?.status === "queued", "只能取消未派发任务");
  j.status = "cancelled";
  j.completedAt = now;
  j.reason = "管理员取消";
  event(s, mode, now, "cancelled", "取消未派发任务", { jobId: id });
  return j;
}
export function scenario(s, now, kind, key) {
  sweepSessions(s, now, "sim");
  requireThat(
    !s.devices.some(
      (d) =>
        d.mode === "sim" && ["waiting", "held"].includes(d.session?.status),
    ),
    "请先释放模拟控制会话",
  );
  requireThat(
    ["five", "failover", "priority"].includes(kind),
    "未知演示场景",
    400,
  );
  const prior = s.jobs.find((j) => j.mode === "sim" && j.runId === key);
  if (prior) return { runId: key, replayed: true };
  requireThat(
    !s.jobs.some((j) => j.mode === "sim" && active(j)),
    "请先完成当前演示，或取消未执行任务",
  );
  let devices = s.devices.filter((d) => d.mode === "sim");
  while (devices.length < 2) {
    register(s, now, "sim", {
      name: `模拟手机 ${devices.length ? "B" : "A"}`,
      rack: "演示机架",
      host: "模拟宿主机",
    });
    devices = s.devices.filter((d) => d.mode === "sim");
  }
  devices.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  for (const [i, d] of devices.entries()) {
    d.enabled = i === 0 || (kind === "failover" && i === 1);
    d.connected = "online";
    d.state = "idle";
    d.cooldownUntil = 0;
    d.epoch++;
    bump(d);
  }
  const put = (n, b) =>
    addJob(s, now + n, "sim", {
      key: `${key}:${n}`,
      runId: key,
      priority: 5,
      ...b,
    });
  const a = put(1, {
    operation: "search",
    keyword: "美食",
    pages: 2,
    priority: kind === "priority" ? 1 : 5,
  });
  if (kind === "priority") {
    const b = put(2, {
      operation: "search",
      keyword: "后台长任务",
      pages: 3,
      priority: 8,
    });
    b.notBefore = now + 1500;
    const c = put(3, {
      operation: "note",
      input: "https://www.xiaohongshu.com/explore/demo3",
      priority: 1,
    });
    c.notBefore = now + 3500;
  } else {
    put(2, {
      operation: "note",
      input: "https://www.xiaohongshu.com/explore/demo1",
    });
    put(3, { operation: "note", sourceJobId: a.id });
    put(4, { operation: "search", keyword: "杭州", pages: 1 });
    put(5, { operation: "search", keyword: "旅行", pages: 1, priority: 8 });
  }
  event(
    s,
    "sim",
    now,
    "scenario",
    kind === "failover"
      ? "双机演示已开始：可点击设备 A 的模拟断线，观察接管"
      : "演示任务已入池；全部为模拟，不连接真机",
    { runId: key },
  );
  return { runId: key };
}

// Observation is explicitly requested; snapshots and cached-frame reads never perform phone I/O.
export function configureObserver(s, now, id, body) {
  const d = findDevice(s, "real", id);
  requireThat(d.revision === body.revision, "设备状态已更新，请重试");
  requireThat(body.approved === true, "需批准只读观察连接", 400);
  const serial = serialNumber(body.serial),
    endpoint = mobileOrigin(body.origin);
  requireThat(
    !d.serial || d.serial === serial,
    "不能更换已登记手机的物理序列号",
  );
  requireThat(
    !s.devices.some(
      (x) => x.mode === "real" && x.id !== id && x.serial === serial,
    ),
    "该序列号已登记，请在原设备上配置画面",
  );
  requireThat(
    d.adapter !== "mobile-agent" || d.origin === endpoint,
    "观察设备的服务入口不能在此更换",
  );
  requireThat(
    !["queued", "running"].includes(d.capture?.status) ||
      d.capture.expiresAt <= now,
    "请等待当前截图请求结束",
  );
  d.serial = serial;
  d.observer = { origin: endpoint, serial, version: randomUUID() };
  d.capture = null;
  d.frame = null;
  d.inspection = null;
  d.mobileStatus = null;
  bump(d);
  event(
    s,
    "real",
    now,
    "observer-configured",
    `${d.name} 已配置只读画面；未连接手机`,
    { deviceId: id },
  );
  return publicDevice(d);
}

// Disabling the compatibility channel changes only mx-device policy, not the
// existing PoC/VPN process. Do not strand active or queued collection work.
export function setPoCChannel(s, now, id, body) {
  const d = findDevice(s, "real", id);
  requireThat(
    d.adapter !== "mobile-agent",
    "纯 Mobile-Agent 设备没有旧 PoC 通道",
    400,
  );
  requireThat(body.revision === d.revision, "设备状态已更新，请重试");
  requireThat(
    typeof body.enabled === "boolean" && body.confirmed === true,
    "需确认仅改变本中心兼容通道",
    400,
  );
  requireThat(
    !d.enabled && d.state === "idle",
    "请先暂停领取，等待在途任务完成并核验未知任务",
  );
  requireThat(
    !s.jobs.some((j) => j.mode === "real" && j.deviceId === id && active(j)),
    "请先完成或取消该设备的待处理采集任务",
  );
  requireThat(
    !s.attempts.some((a) => a.deviceId === id && a.status === "running"),
    "设备仍有在途操作",
  );
  requireThat(
    !d.probeRequestedAt ||
      d.probeRequestedAt <= (d.probe?.at || 0) ||
      now - d.probeRequestedAt > 30000,
    "请等待当前 PoC 检查结束",
  );
  d.pocDisabled = !body.enabled;
  d.pocChangedAt = now;
  d.probeRequestedAt = 0;
  d.probeTakenAt = 0;
  bump(d);
  event(
    s,
    "real",
    now,
    "poc-channel",
    `${d.name}：${body.enabled ? "恢复旧 PoC 兼容通道，仍暂停，须重新检查空闲" : "停用旧 PoC 调用，画面和历史保留；未停止手机 PoC/VPN"}`,
    { deviceId: id },
  );
  return publicDevice(d);
}

export function requestInspection(s, now, id) {
  const d = findDevice(s, "real", id);
  requireThat(d.observer, "请先配置 Mobile-Agent 连接", 400);
  if (
    ["queued", "running"].includes(d.inspection?.status) &&
    d.inspection.expiresAt > now
  )
    return d.inspection;
  if (d.inspection?.finishedAt > now - 5000) return d.inspection;
  d.inspection = {
    id: randomUUID(),
    version: d.observer.version,
    status: "queued",
    requestedAt: now,
    expiresAt: now + 20000,
  };
  return d.inspection;
}
export function claimInspection(s, now, workerId) {
  const devices = s.devices.filter(
    (d) => d.mode === "real" && d.workerId === workerId,
  );
  for (const d of devices) {
    if (
      ["queued", "running"].includes(d.inspection?.status) &&
      d.inspection.expiresAt <= now
    ) {
      d.inspection.status = "failed";
      d.inspection.error = "状态读取超时；请检查执行器心跳";
      d.inspection.finishedAt = now;
    }
  }
  const d = devices.find((d) => d.inspection?.status === "queued");
  if (!d) return null;
  d.inspection.status = "running";
  return d;
}
export function completeInspection(s, now, device, report) {
  const d = findDevice(s, "real", device.id);
  if (
    d.inspection?.id !== device.inspection.id ||
    d.observer?.version !== device.observer.version ||
    d.inspection.status !== "running" ||
    d.inspection.expiresAt <= now
  )
    return false;
  d.inspection.finishedAt = now;
  d.inspection.status = report ? "succeeded" : "failed";
  if (report) d.mobileStatus = { ...report, receivedAt: now };
  else d.inspection.error = "Mobile-Agent 状态读取失败；旧报告不可作为当前状态";
  return true;
}
export function requestCapture(s, now, id) {
  const d = findDevice(s, "real", id);
  requireThat(d.observer, "请先配置 Mobile-Agent 画面连接", 400);
  if (
    ["queued", "running"].includes(d.capture?.status) &&
    d.capture.expiresAt > now
  )
    return d.capture;
  if (d.capture?.finishedAt > now - 2000) return d.capture;
  d.capture = {
    id: randomUUID(),
    version: d.observer.version,
    status: "queued",
    requestedAt: now,
    expiresAt: now + 20000,
  };
  return d.capture;
}
export function claimCapture(s, now, workerId) {
  for (const d of s.devices.filter(
    (d) => d.mode === "real" && d.workerId === workerId,
  )) {
    if (
      ["queued", "running"].includes(d.capture?.status) &&
      d.capture.expiresAt <= now
    ) {
      d.capture.status = "failed";
      d.capture.error = "截图请求超时；请检查执行器心跳";
      d.capture.finishedAt = now;
    }
  }
  const d = s.devices.find(
    (d) =>
      d.mode === "real" &&
      d.workerId === workerId &&
      d.capture?.status === "queued",
  );
  if (!d) return null;
  d.capture.status = "running";
  return d;
}
export function completeCapture(s, now, device, frame, error) {
  const d = findDevice(s, "real", device.id);
  if (
    d.capture?.id !== device.capture.id ||
    d.observer?.version !== device.observer.version ||
    d.capture.status !== "running" ||
    d.capture.expiresAt <= now
  )
    return false;
  d.capture.status = error ? "failed" : "succeeded";
  d.capture.finishedAt = now;
  if (error) d.capture.error = "画面获取失败；旧画面不代表当前状态";
  else
    d.frame = {
      id: device.capture.id,
      version: d.observer.version,
      receivedAt: now,
      width: frame.width,
      height: frame.height,
    };
  return !error;
}

function sweepSessions(s, now, mode) {
  for (const d of s.devices.filter(
    (d) => d.mode === mode && ["waiting", "held"].includes(d.session?.status),
  )) {
    if (d.session.expiresAt <= now) {
      d.session.status = "expired";
      delete d.session.tokenHash;
      // Never infer physical idleness or restart old queues from a browser/lease timeout.
      d.enabled = false;
      bump(d);
      event(
        s,
        mode,
        now,
        "session-expired",
        `${d.name} 会话过期；保持停止领取`,
        { deviceId: d.id },
      );
    } else if (
      d.session.status === "waiting" &&
      !s.attempts.some((a) => a.deviceId === d.id && a.status === "running")
    ) {
      d.session.status = d.state === "quarantined" ? "blocked" : "held";
      if (d.session.status === "blocked") delete d.session.tokenHash;
      bump(d);
      event(
        s,
        mode,
        now,
        "session-ready",
        `${d.name}：${d.session.status === "held" ? "本中心执行槽已预留" : "结果不明，不能接管"}`,
        { deviceId: d.id },
      );
    }
  }
}
export function sessionAction(s, now, mode, id, body) {
  const d = findDevice(s, mode, id),
    action = body.action;
  requireThat(
    ["acquire", "renew", "release", "takeover", "reset"].includes(action),
    "未知会话操作",
    400,
  );
  if (["takeover", "reset"].includes(action))
    requireThat(
      mode === "sim",
      "旧执行端不能拒绝外部命令；真实抢占/复位禁止，仅可模拟演示",
      403,
    );
  if (["acquire", "takeover"].includes(action))
    requireThat(body.revision === d.revision, "设备状态已更新，请重试");
  sweepSessions(s, now, mode);
  const held = ["waiting", "held"].includes(d.session?.status);
  if (["acquire", "takeover"].includes(action)) {
    requireThat(
      d.state !== "quarantined" && d.connected !== "offline",
      "设备已隔离或离线，不能预留",
    );
    requireThat(!held || action === "takeover", "已被其他会话占用");
    requireThat(
      body.confirmed === true,
      "需确认只预留本中心执行槽，不阻止外部控制端",
      400,
    );
    if (action === "takeover") {
      const a = s.attempts.find(
        (a) => a.deviceId === id && a.status === "running",
      );
      if (a) {
        a.status = "interrupted";
        a.completedAt = now;
        const j = s.jobs.find((j) => j.id === a.jobId);
        j.status = "queued";
        j.notBefore = now + 6000;
        j.reason = "模拟抢占：任务保留，6 秒后可重新调度";
      }
      d.epoch++;
      d.state = "idle";
    }
    const token = randomUUID();
    d.session = {
      id: randomUUID(),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      status: s.attempts.some(
        (a) => a.deviceId === id && a.status === "running",
      )
        ? "waiting"
        : "held",
      scope: "center-only",
      createdAt: now,
      expiresAt: now + 60000,
    };
    d.enabled = false;
    bump(d);
    event(
      s,
      mode,
      now,
      `session-${action}`,
      `${d.name}：${mode === "sim" ? "模拟控制会话" : "仅预留本中心执行槽，未接管外部控制"}`,
      { deviceId: id },
    );
    return { device: publicDevice(d), token };
  }
  requireThat(
    held &&
      typeof body.token === "string" &&
      createHash("sha256").update(body.token).digest("hex") ===
        d.session.tokenHash,
    "会话已失效或属于其他控制端",
    403,
  );
  if (action === "renew") d.session.expiresAt = now + 60000;
  if (action === "release") {
    d.session.status = "released";
    delete d.session.tokenHash;
  }
  if (action === "reset") {
    requireThat(
      d.session.status === "held" && d.state === "idle",
      "请等待当前模拟任务结束",
    );
    d.projection = {
      source: "sim",
      observedAt: now,
      progressAt: now,
      status: "模拟恢复工作起点",
      items: [],
    };
  }
  if (action !== "renew") {
    bump(d);
    event(
      s,
      mode,
      now,
      `session-${action}`,
      `${d.name}：${action === "release" ? "会话已释放，仍暂停领取；任务池保留" : "模拟复位，不清任务历史"}`,
      { deviceId: id },
    );
  }
  return { device: publicDevice(d) };
}
