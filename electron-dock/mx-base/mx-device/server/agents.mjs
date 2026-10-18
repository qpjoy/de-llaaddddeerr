// Center side of the host Agent protocol (V2-3), as pure transaction
// functions over state. Transport (HTTP long-poll, batched reports) lives in
// http.mjs; the Agent itself in server/agent/.
//
// An Agent connects out with its own token. Its devices receive each session
// as a lease grant with a per-device fencing token. The Agent accepts the
// grant and asks for directives; every command is issued by the center
// (beginCommand) as a "run" directive under the lease token and a continuous
// seq, and its receipt is checked before the next one is issued. A
// partitioned Agent therefore finishes at most the command in hand and then
// waits at a safe point; the center always knows whether anything was issued.
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  Fault,
  requireThat,
  str,
  register,
  finish,
  returnLease,
  cancelSession,
} from "./model.mjs";
import {
  beginCommand,
  completeCommand,
  resumeOwnSession,
  cleanWorkflowFaults,
} from "./workflows.mjs";
import { findAccount, recordAccountSignal } from "./accounts.mjs";
import {
  AGENT_PROTOCOL,
  AGENT_LEASE_MS,
  AGENT_GRACE_MS,
  AGENT_HEARTBEAT_MS,
  agentOnline,
} from "./agent-lease.mjs";

export const AGENT_SIGNALS = [
  "captcha",
  "rate-limited",
  "logged-out",
  "risk-warning",
  "app-crash",
];
const SERIAL = /^[A-Za-z0-9._:-]{1,80}$/;
const hash = (token) => createHash("sha256").update(token).digest("hex");
const event = (s, mode, now, type, message, more = {}) =>
  s.events.push({ id: randomUUID(), mode, at: now, type, message, ...more });
const bump = (d) => {
  d.revision++;
};

/** The agent id is the token's prefix, so a transaction can load just that row. */
export const agentIdOf = (token) =>
  typeof token === "string" && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/.test(token)
    ? token.slice(0, 36)
    : null;
export function authenticate(s, token) {
  const id = agentIdOf(token),
    agent = id && (s.agents || []).find((a) => a.id === id);
  const expected = agent && Buffer.from(agent.tokenHash, "hex"),
    actual = Buffer.from(hash(String(token)), "hex");
  if (!agent || !timingSafeEqual(expected, actual))
    throw new Fault("Agent 凭证无效", 401);
  if (agent.status !== "active") throw new Fault("Agent 已停用", 403);
  return agent;
}
const newToken = (id) => `${id}.${randomBytes(32).toString("base64url")}`;

export function agentView(s, now, agent) {
  const devices = s.devices.filter((d) => d.agentId === agent.id);
  return {
    id: agent.id,
    mode: agent.mode,
    name: agent.name,
    host: agent.host,
    status: agent.status,
    revision: agent.revision,
    online: agentOnline(agent, now),
    lastSeenAt: agent.lastSeenAt || null,
    instanceId: agent.instanceId,
    version: agent.version,
    driver: agent.driver,
    capabilities: agent.capabilities || [],
    clockOffsetMs: agent.clockOffsetMs ?? null,
    buffered: agent.buffered || 0,
    pending: agent.pending || [],
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      serial: d.serial,
      rack: d.rack,
      state: d.state,
      connected: d.connected,
    })),
    leases: s.attempts.filter(
      (a) => a.agentId === agent.id && a.status === "running",
    ).length,
  };
}

// ---- Administration (session / admin token) ----

export function createAgent(s, now, mode, body) {
  requireThat(
    mode === "sim",
    "宿主机 Agent 目前只接入模拟设备；真实设备在 V2-6 接入",
    403,
  );
  s.agents ||= [];
  requireThat(
    s.agents.filter((a) => a.mode === mode).length < 50,
    "最多登记 50 个 Agent",
  );
  const id = randomUUID(),
    token = newToken(id);
  const agent = {
    id,
    mode,
    name: str(body?.name, "Agent 名称", 80),
    host: str(body?.host || "模拟宿主机", "宿主机", 80),
    status: "active",
    tokenHash: hash(token),
    revision: 1,
    createdAt: now,
    lastSeenAt: 0,
    instanceId: null,
    version: null,
    driver: null,
    capabilities: [],
    serials: [],
    pending: [],
  };
  s.agents.push(agent);
  event(s, mode, now, "agent", `登记宿主机 Agent「${agent.name}」`);
  // The token is shown once; only its hash is stored.
  return { agent: agentView(s, now, agent), token };
}
const findAgent = (s, mode, id) => {
  const agent = (s.agents || []).find((a) => a.id === id && a.mode === mode);
  requireThat(agent, "Agent 不存在", 404);
  return agent;
};
export function changeAgent(s, now, mode, id, body) {
  const agent = findAgent(s, mode, id);
  requireThat(body?.revision === agent.revision, "Agent 已被修改，请刷新", 409);
  requireThat(
    ["disable", "enable", "rotate"].includes(body.action),
    "未知操作",
    400,
  );
  let token = null;
  if (body.action === "disable") agent.status = "disabled";
  if (body.action === "enable") agent.status = "active";
  if (body.action === "rotate") {
    token = newToken(agent.id);
    agent.tokenHash = hash(token);
  }
  agent.revision++;
  event(
    s,
    mode,
    now,
    "agent",
    `Agent「${agent.name}」${{ disable: "已停用：不再签发新租约，在途租约照常结束", enable: "已启用", rotate: "已更换凭证，旧凭证立即失效" }[body.action]}`,
  );
  return { agent: agentView(s, now, agent), token };
}
/** Registers a serial the Agent reported as a new simulated device it hosts. */
export function adoptDevice(s, now, mode, id, body) {
  const agent = findAgent(s, mode, id);
  const serial = str(body?.serial, "设备序列号", 80);
  requireThat(SERIAL.test(serial), "序列号格式无效", 400);
  requireThat(
    (agent.pending || []).includes(serial),
    "该序列号不在 Agent 的待登记清单中",
    409,
  );
  const d = register(s, now, mode, {
    name: body.name || serial,
    rack: body.rack,
    host: body.host || agent.host,
    simApps: body.simApps,
  });
  Object.assign(d, { agentId: agent.id, serial, leaseToken: 0 });
  agent.pending = agent.pending.filter((x) => x !== serial);
  event(
    s,
    mode,
    now,
    "agent",
    `${d.name} 由 Agent「${agent.name}」托管（${serial}）`,
    { deviceId: d.id },
  );
  return d;
}
/** Asks the Agent to stop a running session at its next safe point. A
 * session parked at a checkpoint has nothing in flight and is cancelled here. */
export function requestStop(s, now, mode, attemptId, body) {
  const a = s.attempts.find((x) => x.id === attemptId && x.mode === mode);
  requireThat(a?.executor === "agent", "只能停止由 Agent 执行的会话", 404);
  const reason = str(body?.reason || "管理员停止", "原因", 200);
  if (a.status === "yielded") {
    cancelSession(s, now, a, `${reason}：会话停在检查点，没有在途指令`);
    return { attemptId, status: "cancelled" };
  }
  requireThat(a.status === "running", "会话已结束", 409);
  a.agentStop ??= { at: now, reason };
  event(
    s,
    mode,
    now,
    "agent-stop",
    `请求 Agent 在下一个安全点停止：${reason}`,
    {
      jobId: a.jobId,
      deviceId: a.deviceId,
      attemptId,
    },
  );
  return { attemptId, status: "stopping" };
}

// ---- Agent messages (Agent token) ----

/** hello: identity, devices and the leases the Agent still holds. Leases it
 * does not hold are settled now: requeued if nothing was issued under them,
 * otherwise unknown (no blind retry). */
export function agentHello(s, now, token, body) {
  const agent = authenticate(s, token);
  const instanceId = str(body?.instanceId, "实例 ID", 80);
  const devices = Array.isArray(body.devices) ? body.devices : [];
  requireThat(
    devices.length <= 200 &&
      devices.every(
        (d) => typeof d?.serial === "string" && SERIAL.test(d.serial),
      ),
    "设备清单无效",
    400,
  );
  const leases = Array.isArray(body.leases) ? body.leases.slice(0, 200) : [];
  const restarted = agent.instanceId !== instanceId;
  Object.assign(agent, {
    instanceId,
    protocol: Number(body.protocol) || AGENT_PROTOCOL,
    version: str(body.version || "unknown", "版本", 40),
    driver: str(body.driver || "sim", "驱动", 20),
    capabilities: (Array.isArray(body.capabilities) ? body.capabilities : [])
      .filter((x) => typeof x === "string")
      .slice(0, 50),
    lastSeenAt: now,
    serials: devices.map((d) => d.serial),
  });
  const bound = s.devices.filter((d) => d.agentId === agent.id);
  agent.pending = agent.serials.filter(
    (serial) => !bound.some((d) => d.serial === serial),
  );
  for (const d of bound) {
    const seen = agent.serials.includes(d.serial);
    if (seen && d.offlineBy === "agent") {
      d.connected = "online";
      delete d.offlineBy;
      bump(d);
    } else if (!seen && d.connected !== "offline") {
      d.connected = "offline";
      d.offlineBy = "agent";
      bump(d);
    }
  }
  const held = new Set(leases.map((l) => `${l.attemptId}:${l.token}`));
  for (const a of s.attempts.filter(
    (a) => a.agentId === agent.id && a.status === "running",
  ))
    if (!held.has(`${a.id}:${a.token}`))
      settleLostLease(
        s,
        now,
        a,
        restarted ? "Agent 重启后不再持有租约" : "Agent 未持有该租约",
      );
  cleanWorkflowFaults(s, now);
  event(
    s,
    agent.mode,
    now,
    "agent",
    `Agent「${agent.name}」${restarted ? "已连接（新实例）" : "已重连"}：${bound.length} 台已登记，${agent.pending.length} 台待登记`,
  );
  return {
    agentId: agent.id,
    protocol: AGENT_PROTOCOL,
    heartbeatMs: AGENT_HEARTBEAT_MS,
    leaseMs: AGENT_LEASE_MS,
    graceMs: AGENT_GRACE_MS,
    devices: bound.map((d) => ({
      deviceId: d.id,
      serial: d.serial,
      name: d.name,
      token: d.leaseToken || 0,
    })),
    pending: agent.pending,
    now,
  };
}
function settleLostLease(s, now, a, reason) {
  if (!a.leaseIssued) returnLease(s, now, a, reason);
  else
    finish(s, now, a, {
      error: `${reason}，已发出的指令结果未知；隔离设备，不自动重试`,
    });
}
/** heartbeat: liveness, clock offset and lease renewal. */
export function agentHeartbeat(s, now, token, body) {
  const agent = authenticate(s, token);
  if (body?.instanceId !== agent.instanceId)
    throw new Fault("Agent 实例已变化，请重新 hello", 409);
  agent.lastSeenAt = now;
  agent.clockOffsetMs = Number.isFinite(body.clockMs)
    ? Math.round(body.clockMs - now)
    : null;
  agent.buffered = Number.isInteger(body.buffered) ? body.buffered : 0;
  const leases = (Array.isArray(body.leases) ? body.leases : [])
    .slice(0, 200)
    .map(({ attemptId, token: t }) => {
      const a = s.attempts.find((x) => x.id === attemptId);
      if (!a || a.agentId !== agent.id || a.token !== t)
        return { attemptId, token: t, status: "revoked" };
      if (a.status !== "running")
        return { attemptId, token: t, status: a.status };
      if (a.leaseUntil + AGENT_GRACE_MS <= now)
        return { attemptId, token: t, status: "expired" };
      a.leaseUntil = now + AGENT_LEASE_MS;
      return {
        attemptId,
        token: t,
        status: "ok",
        leaseMs: AGENT_LEASE_MS,
        stop: !!a.agentStop,
      };
    });
  return { leases, now };
}
/** poll: grants not accepted yet and stop requests, read-only. */
export function agentInbox(s, now, token) {
  const agent = authenticate(s, token);
  const grants = [],
    controls = [];
  for (const a of s.attempts) {
    if (a.agentId !== agent.id || a.status !== "running") continue;
    const d = s.devices.find((d) => d.id === a.deviceId);
    if (a.agentState === "granted") grants.push(grantMessage(s, now, a, d));
    if (a.agentStop)
      controls.push({
        type: "attempt.stop",
        attemptId: a.id,
        deviceId: a.deviceId,
        token: a.token,
        reason: a.agentStop.reason,
      });
  }
  return { grants, controls, now };
}
function grantMessage(s, now, a, d) {
  const j = s.jobs.find((j) => j.id === a.jobId),
    w = j.workflow;
  return {
    type: "lease.grant",
    attemptId: a.id,
    deviceId: d.id,
    serial: d.serial,
    token: a.token,
    generation: a.executionGeneration,
    leaseMs: Math.max(0, a.leaseUntil - now),
    job: {
      id: j.id,
      appId: j.appId,
      name: w.name,
      loop: w.loop,
      steps: w.plan.length,
      startStep: w.nextStep,
      plan: w.plan.map((step) => ({
        code: step.code,
        version: step.definition?.version ?? null,
        effect: step.definition?.effect ?? null,
      })),
    },
  };
}
const commandMessage = (c) => ({
  id: c.id,
  seq: c.seq,
  token: c.token,
  jobId: c.jobId,
  attemptId: c.attemptId,
  deviceId: c.deviceId,
  appId: c.appId,
  code: c.code,
  stepIndex: c.stepIndex,
  page: c.page,
  params: c.params,
  definition: c.definition,
  commandVersion: c.commandVersion,
  estimateMs: c.estimatedDurationMs,
  simulationDurationMs: c.simulationDurationMs,
});
const resend = (row, c) => ({
  action: "run",
  generation: row.executionGeneration,
  command: commandMessage(c),
});
/** The next step for a lease: run (one command), wait, yield, stop or done. */
function nextDirective(s, now, row, agent) {
  if (row.agentStop && row.status === "running")
    return { action: "stop", reason: row.agentStop.reason };
  if (row.status === "yielded") {
    const resumed = resumeOwnSession(s, now, row, `agent:${agent.id}`);
    if (!resumed) {
      // The scheduler decides (a small task may be inserted); the lease ends.
      row.agentState = "yielded";
      return { action: "yield" };
    }
    if (resumed.waitUntil)
      return {
        action: "wait",
        waitMs: Math.min(5000, Math.max(50, resumed.waitUntil - now)),
      };
    row.leaseUntil = now + AGENT_LEASE_MS;
    row.workerId = `agent:${agent.id}`;
  }
  if (row.status !== "running") return { action: "done", status: row.status };
  const c = beginCommand(s, now, row);
  if (!c) return { action: "done", status: row.status };
  row.leaseIssued = (row.leaseIssued || 0) + 1;
  row.seq = (row.seq || 0) + 1;
  Object.assign(c, { seq: row.seq, token: row.token, agentId: agent.id });
  return {
    action: "run",
    generation: row.executionGeneration,
    command: commandMessage(c),
  };
}
/** One lease message from the Agent, in a transaction scoped to its attempt. */
export function agentReport(s, now, token, m) {
  const agent = authenticate(s, token);
  const row = s.attempts.find((a) => a.id === m?.attemptId);
  if (!row || row.agentId !== agent.id || row.token !== m.token)
    return { ok: false, error: "stale-token", directive: { action: "drop" } };
  const live = () =>
    row.status === "running" &&
    row.leaseUntil + AGENT_GRACE_MS > now &&
    row.executionGeneration === (m.generation ?? row.executionGeneration);
  const inflight = () =>
    s.commands.find(
      (c) =>
        c.attemptId === row.id &&
        c.status === "running" &&
        c.token === row.token,
    );
  switch (m.type) {
    case "lease.accept": {
      if (!live())
        return { ok: false, directive: { action: "done", status: row.status } };
      if (row.agentState === "granted") {
        row.agentState = "accepted";
        row.acceptedAt = now;
        row.leaseUntil = now + AGENT_LEASE_MS;
      }
      // A repeated accept (lost response) gets the command in flight again.
      const c = inflight();
      return {
        ok: true,
        directive: c ? resend(row, c) : nextDirective(s, now, row, agent),
      };
    }
    case "lease.reject": {
      if (row.status !== "running" || row.leaseIssued)
        return {
          ok: false,
          error: "already-started",
          directive: { action: "drop" },
        };
      const reason = ["busy", "capability", "device-fault"].includes(m.reason)
        ? m.reason
        : "device-fault";
      returnLease(
        s,
        now,
        row,
        `Agent 拒绝租约（${{ busy: "设备忙", capability: "能力不符", "device-fault": "设备异常" }[reason]}）；暂停设备待核查`,
        { pause: true },
      );
      return { ok: true, directive: { action: "drop" } };
    }
    case "command.finished": {
      const c = s.commands.find((x) => x.id === m.commandId);
      if (!c || c.attemptId !== row.id || c.token !== row.token)
        return {
          ok: false,
          error: "unknown-command",
          directive: { action: "drop" },
        };
      if (c.status !== "running") {
        // A repeat: the answer to the first delivery was lost. If that answer
        // issued the next command, the Agent never saw it; send it again.
        if (c.status === "unknown")
          c.lateEvidence ??= { at: now, receipt: m.receipt };
        const next = inflight();
        return {
          ok: c.status === "succeeded",
          duplicate: true,
          directive:
            c.status !== "succeeded" ||
            !["running", "yielded"].includes(row.status)
              ? { action: "done", status: row.status }
              : next
                ? resend(row, next)
                : nextDirective(s, now, row, agent),
        };
      }
      // Device Gate echo: the receipt must name this command, seq and token.
      const echo =
        m.seq === c.seq &&
        m.receipt?.commandId === c.id &&
        m.receipt?.seq === c.seq &&
        m.receipt?.token === c.token;
      const ok = completeCommand(s, now, row, c, echo ? m.receipt : null);
      if (!ok)
        return { ok: false, directive: { action: "done", status: row.status } };
      if (row.status === "succeeded")
        return { ok: true, directive: { action: "done", status: "succeeded" } };
      return { ok: true, directive: nextDirective(s, now, row, agent) };
    }
    case "lease.next": {
      // The Agent asks only with no command in hand: an issued command means
      // the answer carrying it was lost.
      const next = inflight();
      if (next)
        return { ok: true, duplicate: true, directive: resend(row, next) };
      if (row.status !== "yielded" && !live())
        return { ok: false, directive: { action: "done", status: row.status } };
      return { ok: true, directive: nextDirective(s, now, row, agent) };
    }
    case "attempt.stopped": {
      if (row.status !== "running" || !row.agentStop)
        return { ok: false, directive: { action: "done", status: row.status } };
      if (inflight()) {
        finish(s, now, row, {
          error: "停止时仍有未回执的指令，结果未知；隔离设备",
        });
        cleanWorkflowFaults(s, now);
      } else
        cancelSession(
          s,
          now,
          row,
          `${row.agentStop.reason}：Agent 已在安全点停止${m.evidence?.reset ? "并复位" : ""}`,
        );
      return { ok: true, directive: { action: "done", status: row.status } };
    }
    default:
      throw new Fault("未知的 Agent 消息", 400);
  }
}
/** signal: platform risk signals go to the account of that device App. */
export function agentSignal(s, now, token, m) {
  const agent = authenticate(s, token);
  const d = s.devices.find(
    (d) => d.id === m?.deviceId && d.agentId === agent.id,
  );
  requireThat(d, "设备不属于此 Agent", 404);
  requireThat(AGENT_SIGNALS.includes(m.kind), "未知的平台信号", 400);
  const detail =
    typeof m.detail === "string" ? m.detail.trim().slice(0, 200) : "";
  if (m.kind === "app-crash") {
    event(
      s,
      d.mode,
      now,
      "agent-signal",
      `${d.name}：App 崩溃${detail ? `（${detail}）` : ""}`,
      {
        deviceId: d.id,
      },
    );
    return { ok: true };
  }
  const account = findAccount(s, d, m.appId);
  requireThat(account, "设备上没有该 App 的账号", 404);
  recordAccountSignal(s, now, d.mode, account.id, {
    kind: m.kind,
    detail: `Agent 上报${detail ? `：${detail}` : ""}`,
  });
  return { ok: true, accountId: account.id };
}
