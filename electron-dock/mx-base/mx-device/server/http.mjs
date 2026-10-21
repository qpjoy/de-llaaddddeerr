import {
  definitions,
  saveDefinition,
  archiveDefinition,
  rackScenario,
  testAdapterCommand,
} from "./workflows.mjs";
import {
  commandDefinitions,
  saveCommand,
  archiveCommand,
} from "./command-registry.mjs";
import { configureLoops } from "./loop-policy.mjs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { StateHub } from "./state-hub.mjs";
import { JobWaiter } from "./job-waiter.mjs";
import { opsPayload, clientPayload } from "./scopes.mjs";
import {
  authenticateClient,
  cancelClientJob,
  changeClient,
  clientIdOf,
  clientsOverview,
  createClient,
  jobView,
  keyHashOf,
  predictJob,
  requestKey,
  submitJob,
} from "./clients.mjs";
import { resultItems, templateView } from "./job-result.mjs";
import { definitions as templateDefinitions } from "./workflows.mjs";
import {
  agentIdOf,
  agentView,
  agentHello,
  agentHeartbeat,
  agentInbox,
  agentProbed,
  agentReport,
  agentSignal,
  createAgent,
  changeAgent,
  adoptDevice,
  requestStop,
} from "./agents.mjs";
import { agentOnline } from "./agent-lease.mjs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import {
  Fault,
  realm,
  uuid,
  str,
  register,
  control,
  addJob,
  cancel,
  scenario,
  publicDevice,
  configureObserver,
  requestCapture,
  sessionAction,
  requestInspection,
  setPoCChannel,
} from "./model.mjs";
import { configurePacing } from "./pacing.mjs";
import { controlResource, updatePlacement } from "./resources.mjs";
import { schedulingSnapshot, placingSlots } from "./scheduling.mjs";
import {
  ACCOUNT_SIGNALS,
  ACCOUNT_STATUSES,
  accountView,
  recordAccountSignal,
  setAccountStatus,
} from "./accounts.mjs";
import { configureAutoProfile, shadowStrategy } from "./strategy-auto.mjs";
import { Worker } from "node:worker_threads";
import { POOL_SCENARIOS, simulationOptions } from "./pool-simulator.mjs";
import { DEFAULT_POOL_POLICY } from "./pool-policy.mjs";
import {
  listRules,
  listStrategies,
  saveRule,
  saveStrategy,
  archiveRule,
  archiveStrategy,
  applyStrategy,
} from "./strategy-registry.mjs";
import {
  assignQueuedJob,
  cancelQueuedJob,
  configureSimDevice,
  launchWorkstationDemo,
} from "./workstation.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  // Large state payloads compress about tenfold.
  const gzip =
    text.length > 65536 &&
    /\bgzip\b/.test(res.req?.headers["accept-encoding"] || "");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(gzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
    ...headers,
  });
  res.end(gzip ? gzipSync(text) : text);
};
async function body(req, limit = 32768) {
  let text = "";
  for await (const part of req) {
    text += part;
    if (Buffer.byteLength(text) > limit) throw new Fault("请求过大", 413);
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Fault("无效 JSON", 400);
  }
}
// Accounts are served by /api/accounts; device pacing summaries are in scheduling.
// Agents appear without their token hashes.
// Callers appear by name only (no key hashes, secrets or fairness state).
const summarize = ({ accounts, agents, clients, ...s }) => ({
  ...s,
  agents: (agents || []).map((a) => agentView(s, s.now, a)),
  clients: (clients || []).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    weight: c.weight,
  })),
  devices: s.devices.map(publicDevice),
  jobs: s.jobs.map(({ result, ...j }) => slimJob(j)),
  attempts: s.attempts.map(({ result, lateEvidence, checkpoints, ...a }) => a),
  commands: (s.commands || []).map(({ receipt, lateEvidence, ...c }) => ({
    ...c,
    definition: c.definition && {
      name: c.definition.name,
      action: c.definition.action,
    },
  })),
});
// The live queue carries the first LIVE_QUEUE entries in scheduling order
// (the central queue shows 12) plus totals; soft plans only within the
// timeline's horizon. Any job's full explanation is fetched on demand.
const LIVE_QUEUE = 300,
  PLAN_HORIZON_MS = 180000;
const liveScheduling = (scheduling) => {
  const queue = scheduling.queue.slice(0, LIVE_QUEUE);
  const shown = new Set(queue.map((q) => q.jobId));
  return {
    ...scheduling,
    queue: queue.map(({ waitMs, ...q }) => ({
      ...q,
      poolAssignment: q.poolAssignment && withoutDerived(q.poolAssignment),
    })),
    queueSummary: {
      total: scheduling.queue.length,
      planned: scheduling.queue.filter((q) => q.poolAssignment).length,
      shown: queue.length,
    },
    // Timeline plan blocks: each device's next PLAN_SLOTS sessions within
    // the horizon. Blocked jobs are summarized by reason.
    poolPlans: scheduling.poolPlans.map(
      ({ assignments, blocked, policy, ...p }) => ({
        ...p,
        assignments: assignments
          .filter(
            (a) =>
              a.queuePosition <= PLAN_SLOTS &&
              a.startAt <= scheduling.at + PLAN_HORIZON_MS,
          )
          .map(planBlock),
        total: assignments.length,
        blockedByCode: blocked.reduce(
          (counts, b) => ({ ...counts, [b.code]: (counts[b.code] || 0) + 1 }),
          {},
        ),
      }),
    ),
  };
};
const PLAN_SLOTS = 5;
const planBlock = (a) => ({
  jobId: a.jobId,
  deviceId: a.deviceId,
  appId: a.appId,
  startAt: a.startAt,
  finishAt: a.finishAt,
  switchMs: a.switchMs,
  queuePosition: a.queuePosition,
  moves: a.moves,
  reason: a.reason,
});
// Explanation-only fields are served by /api/explain for one job at a time.
const withoutDerived = ({
  waitMs,
  costMs,
  idlePercent,
  alternatives,
  sticky,
  candidates,
  ...a
}) => a;
// Live views need plan length and step codes, not each step's frozen command
// definition (about two thirds of a job; full jobs come from /api/jobs/:id).
// Receipts and the frozen strategy snapshot stay in the job document too.
// Plan pointers and history change with every re-plan of a queued job; they
// are served per job by /api/explain instead.
const slimJob = ({ poolPlan, planHistory, fingerprint, ...j }) => {
  if (!j.workflow) return j;
  const { receipts, policySnapshot, ...workflow } = j.workflow;
  return {
    ...j,
    workflow: {
      ...workflow,
      plan: workflow.plan.map(({ definition, ...step }) => ({
        ...step,
        name: definition?.name,
      })),
      policySnapshot: policySnapshot && {
        maxInsertions: policySnapshot.maxInsertions,
        maxDetourMs: policySnapshot.maxDetourMs,
      },
    },
  };
};

export function createApp({
  store,
  cfg,
  staticRoot = resolve("dist"),
  deliverer = null,
}) {
  const failures = new Map(),
    probeRequests = new Map();
  const waiter = new JobWaiter(store);
  // One shared producer per realm for /api/state and the SSE stream.
  // Plans and wait reasons are refreshed when asked (every few seconds or
  // after a write); rows every interval. Derived timings are left to the
  // client so unchanged plans do not resend every tick.
  const fullScheduling = new Map(); // mode -> last complete scheduling snapshot
  const hub = new StateHub(
    async (channel, previous, { planning }) => {
      // Scoped views derive from the realm's payload (V2-5).
      const [mode, scope] = channel.split("|");
      if (scope === "ops") return opsPayload(await hub.current(mode));
      if (scope?.startsWith("client:")) {
        const base = await hub.current(mode),
          id = scope.slice(7);
        return clientPayload(
          base,
          base.clients.find((c) => c.id === id) || { id, name: "" },
        );
      }
      const state = await store.snapshot(mode);
      if (planning || !previous)
        fullScheduling.set(mode, schedulingSnapshot(state, state.now, mode));
      return {
        ...summarize(state),
        scheduling:
          planning || !previous
            ? liveScheduling(fullScheduling.get(mode))
            : previous.scheduling,
      };
    },
    { intervalMs: cfg.streamIntervalMs ?? 1000 },
  );
  // Writes handled here make cached state stale and push an update at once.
  const touched = (res, mode) => {
    hub.invalidate(mode);
    res.once("finish", () => {
      hub.invalidate(mode);
      hub.poke(mode);
      waiter.nudge();
      deliverer?.poke();
    });
  };
  // ---- Job API v1 and embedding (V2-5): caller API keys ----
  async function caller(req) {
    const key = (req.headers.authorization || "").replace(/^Bearer /, "");
    const id = clientIdOf(key);
    if (!id) throw new Fault("调用方凭证无效", 401);
    const row = authenticateClient(await store.client(id), key);
    return { row, keyHash: keyHashOf(key) };
  }
  // The latest full plan's queue entry for a job (at most a few seconds old).
  async function planned(jobId) {
    const base = await hub.current("sim");
    const scheduling = fullScheduling.get("sim");
    return {
      base,
      at: scheduling?.at,
      entry: scheduling?.queue.find((q) => q.jobId === jobId) || null,
    };
  }
  async function callerJob(row, jobId) {
    const detail = await store.detail("sim", jobId);
    if (!detail || detail.job.client?.id !== row.id)
      throw new Fault("任务不存在", 404);
    return detail;
  }
  async function viewOf(detail) {
    const { base, at, entry } = await planned(detail.job.id);
    const predicted =
      detail.job.status === "queued" && !entry?.poolAssignment
        ? predictJob(base, base.now, detail.job)
        : null;
    return jobView(detail.job, { entry, predicted, detail, at });
  }
  const channelOf = (row, scope) => {
    if (scope === "ops") {
      if (row.embed !== "ops")
        throw new Fault("此调用方无权使用 ops 作用域", 403);
      return "sim|ops";
    }
    if (scope !== "client") throw new Fault("scope 为 client 或 ops", 400);
    return `sim|client:${row.id}`;
  };
  async function v1Route(req, res, url, path) {
    const { row, keyHash } = await caller(req);
    if (req.method !== "GET") touched(res, "sim");
    if (path === "/v1/templates" && req.method === "GET") {
      const state = await hub.current("sim");
      const latest = new Map();
      for (const d of templateDefinitions(state))
        if (
          d.mode === "sim" &&
          !d.archived &&
          (!row.scopes.apps.length || row.scopes.apps.includes(d.appId)) &&
          (!row.scopes.templates.length ||
            row.scopes.templates.includes(d.code)) &&
          (latest.get(d.code)?.version ?? 0) < d.version
        )
          latest.set(d.code, d);
      return json(res, 200, {
        classes: row.scopes.classes,
        templates: [...latest.values()]
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((d) => templateView(state, d)),
      });
    }
    if (path === "/v1/jobs" && req.method === "POST") {
      const b = await body(req);
      const out = await store.atomic(
        (s, n) => submitJob(s, n, "sim", row.id, keyHash, b),
        {
          mode: "sim",
          key:
            typeof b.clientRequestId === "string"
              ? requestKey(row.id, b.clientRequestId)
              : null,
        },
      );
      const { at, entry } = out.replayed
        ? await planned(out.job.id)
        : { at: null, entry: null };
      return json(res, out.replayed ? 200 : 202, {
        ...jobView(out.job, { entry, predicted: out.predicted, at }),
        replayed: out.replayed,
      });
    }
    if (path === "/v1/jobs" && req.method === "GET") {
      const limit = Math.min(
        200,
        Math.max(1, Number(url.searchParams.get("limit")) || 50),
      );
      const jobs = await store.clientJobs("sim", row.id, {
        limit,
        active: url.searchParams.get("status") === "active",
      });
      const { at } = await planned(null);
      const queue = new Map(
        (fullScheduling.get("sim")?.queue || []).map((q) => [q.jobId, q]),
      );
      return json(res, 200, {
        jobs: jobs.map((j) => ({
          ...jobView(j, { entry: queue.get(j.id), at }),
          result: undefined,
        })),
      });
    }
    const jobPath = path.match(
      /^\/v1\/jobs\/([0-9a-f-]{36})(\/wait|\/cancel|\/result)?$/,
    );
    if (jobPath) {
      const id = uuid(jobPath[1]),
        action = jobPath[2];
      if (!action && req.method === "GET")
        return json(res, 200, await viewOf(await callerJob(row, id)));
      if (action === "/wait" && req.method === "GET") {
        // Long-poll: answers when the job ends or after timeout seconds (≤ 25).
        const seconds = Math.min(
          25,
          Math.max(0, Number(url.searchParams.get("timeout") ?? 25) || 0),
        );
        const started = Date.now();
        let detail = await callerJob(row, id);
        if (!["queued", "running"].includes(detail.job.status) || !seconds)
          return json(res, 200, {
            ...(await viewOf(detail)),
            waitedMs: 0,
            timedOut:
              !seconds && ["queued", "running"].includes(detail.job.status),
          });
        const gone = new AbortController();
        res.once("close", () => gone.abort());
        const status = await waiter.wait(
          "sim",
          id,
          seconds * 1000,
          gone.signal,
        );
        if (gone.signal.aborted) return;
        detail = await callerJob(row, id);
        return json(res, 200, {
          ...(await viewOf(detail)),
          waitedMs: Date.now() - started,
          timedOut: status === null,
        });
      }
      if (action === "/result" && req.method === "GET") {
        const detail = await callerJob(row, id);
        const page = resultItems(
          detail.job,
          detail,
          Math.max(0, Number(url.searchParams.get("offset")) || 0),
          Math.min(
            500,
            Math.max(1, Number(url.searchParams.get("limit")) || 200),
          ),
        );
        if (!page) throw new Fault("任务尚未结束", 409);
        return json(res, 200, { jobId: id, ...page });
      }
      if (action === "/cancel" && req.method === "POST") {
        await body(req);
        const out = await store.atomic(
          (s, n) => cancelClientJob(s, n, "sim", row.id, keyHash, id),
          { mode: "sim", jobId: id },
        );
        return json(res, 200, { jobId: id, ...out });
      }
    }
    if (path === "/v1/stream" && req.method === "GET")
      return hub.subscribe(
        channelOf(row, url.searchParams.get("scope") || "client"),
        req,
        res,
      );
    if (path === "/v1/state" && req.method === "GET")
      return json(
        res,
        200,
        await hub.current(
          channelOf(row, url.searchParams.get("scope") || "client"),
        ),
      );
    throw new Fault("接口不存在", 404);
  }
  // Embedded workbench for a Hub reverse proxy (plan §10.1): Hub's backend
  // forwards /device-center/* here with the caller's key and the viewer's
  // scope and name; the browser only holds Hub's own session. Read-only.
  const EMBED_USER = /^[^\u0000-\u001f<>"'&]{1,80}$/;
  async function embedRoute(req, res, url, path) {
    if (!["GET", "HEAD"].includes(req.method))
      throw new Fault("嵌入工作台只读；写操作请在设备中心管理台进行", 405);
    const { row } = await caller(req);
    if (row.embed === "none") throw new Fault("此调用方未开放嵌入", 403);
    const scope = req.headers["x-mx-embed-scope"] || row.embed;
    const channel = channelOf(row, scope);
    // The viewer's display name, percent-encoded UTF-8 (headers are bytes).
    let user = "";
    try {
      user = decodeURIComponent(String(req.headers["x-mx-embed-user"] || ""));
    } catch {
      user = "";
    }
    const sub = path.slice("/embed".length) || "/";
    if (sub === "/api/session")
      return json(res, 200, {
        scope,
        mode: "sim",
        client: { id: row.id, name: row.name },
        user: EMBED_USER.test(user) ? user : null,
      });
    if (sub === "/api/state") return json(res, 200, await hub.current(channel));
    if (sub === "/api/stream") return hub.subscribe(channel, req, res);
    const jobPath = sub.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
    if (jobPath) {
      const detail = await store.detail("sim", uuid(jobPath[1]));
      if (!detail || (scope === "client" && detail.job.client?.id !== row.id))
        throw new Fault("任务不存在", 404);
      return json(res, 200, await viewOf(detail));
    }
    if (sub === "/api/explain" && scope === "ops")
      return json(
        res,
        200,
        await explain(uuid(url.searchParams.get("jobId")), "sim"),
      );
    if (sub.startsWith("/api/")) throw new Fault("接口不存在", 404);
    return serveStatic(req, res, sub, { embed: true });
  }
  async function explain(jobId, mode) {
    // One job's plan and wait reasons from the latest full plan.
    await hub.current(mode);
    const scheduling = fullScheduling.get(mode);
    const detail = await store.detail(mode, jobId);
    return {
      at: scheduling?.at ?? null,
      planHistory: detail?.job.planHistory || [],
      entry: scheduling?.queue.find((q) => q.jobId === jobId) || null,
      blocked:
        scheduling?.poolPlans
          .flatMap((p) => p.blocked)
          .find((b) => b.jobId === jobId) || null,
    };
  }
  async function serveStatic(req, res, path, { embed = false } = {}) {
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new Fault("不支持的方法", 405);
    const rel =
      path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\//, "");
    const file = resolve(staticRoot, rel);
    if (!file.startsWith(staticRoot + "/"))
      throw new Fault("路径不可访问", 403);
    let bytes = await readFile(file).catch(() => null);
    if (!bytes) throw new Fault("页面不存在", 404);
    // The embedded shell reads its scope from /embed/api/session.
    if (embed && rel === "index.html")
      bytes = Buffer.from(
        bytes
          .toString("utf8")
          .replace(
            "<head>",
            '<head>\n    <meta name="mx-embed" content="1" />',
          ),
      );
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }
  let simulationBusy = false;
  async function benchmark(options) {
    if (simulationBusy)
      throw new Fault("已有调度演练正在计算，请稍后重试", 429);
    simulationBusy = true;
    let worker;
    try {
      return await new Promise((resolve, reject) => {
        worker = new Worker(
          new URL("./pool-simulation-worker.mjs", import.meta.url),
          { workerData: options },
        );
        const timer = setTimeout(
          () => reject(new Fault("演练计算超时，请缩小规模或调整预算", 503)),
          6500,
        );
        const done = (fn, value) => {
          clearTimeout(timer);
          fn(value);
        };
        worker.once("message", (value) =>
          value.error
            ? done(reject, new Fault(value.error, value.status))
            : done(resolve, value.report),
        );
        worker.once("error", () =>
          done(reject, new Fault("演练计算失败", 500)),
        );
        worker.once("exit", (code) => {
          if (code) done(reject, new Fault("演练工作线程退出", 500));
        });
      });
    } finally {
      if (worker) await worker.terminate();
      simulationBusy = false;
    }
  }
  const sign = (payload) =>
    createHmac("sha256", cfg.adminToken).update(payload).digest("hex");
  function role(req) {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (token && equal(token, cfg.adminToken)) return "admin";
    if (token && equal(token, cfg.testToken)) return "test";
    const cookie = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("mx_device_session="))
      ?.split("=")[1];
    if (cookie) {
      const [exp, sig] = cookie.split(".");
      if (
        Number(exp) > Date.now() &&
        Number(exp) < Date.now() + 13 * 3600000 &&
        equal(sign(exp), sig)
      )
        return "admin";
    }
    return null;
  }
  // Host Agent protocol v1: HTTP long-poll plus batched, idempotent reports.
  // Agents connect out with their own token (V2-3). Each Agent works for the
  // realm it was registered in (V2-6 P1); every transaction loads only that
  // realm's rows, so its token is checked there and nowhere else.
  async function agentRoute(req, res, path) {
    if (req.method !== "POST") throw new Fault("仅支持 POST", 405);
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const agentId = agentIdOf(token);
    if (!agentId) throw new Fault("Agent 凭证无效", 401);
    const mode = await store.agentRealm(agentId);
    if (!["sim", "real"].includes(mode)) throw new Fault("Agent 凭证无效", 401);
    touched(res, mode);
    const b = await body(req, 1 << 20);
    const scoped = { mode, scope: "agent", agentId };
    if (path === "/agent/v1/hello")
      return json(
        res,
        200,
        await store.atomic((s, n) => agentHello(s, n, token, b), { mode }),
      );
    if (path === "/agent/v1/heartbeat")
      return json(
        res,
        200,
        await store.atomic((s, n) => agentHeartbeat(s, n, token, b), scoped),
      );
    if (path === "/agent/v1/poll") {
      const deadline =
        Date.now() + Math.min(25000, Math.max(0, Number(b.waitMs) || 0));
      let gone = false;
      res.once("close", () => {
        gone = true;
      });
      for (;;) {
        const inbox = await store.atomic(
          (s, n) => agentInbox(s, n, token),
          scoped,
        );
        if (
          inbox.grants.length ||
          inbox.controls.length ||
          gone ||
          Date.now() >= deadline
        )
          return json(res, 200, inbox);
        await sleep(250);
      }
    }
    if (path === "/agent/v1/report") {
      const messages = Array.isArray(b.messages)
        ? b.messages.slice(0, 100)
        : [];
      const results = [];
      for (const m of messages) {
        try {
          if (m?.type === "signal")
            results.push(
              await store.atomic((s, n) => agentSignal(s, n, token, m), {
                mode,
              }),
            );
          else if (m?.type === "device.probed")
            results.push(
              await store.atomic((s, n) => agentProbed(s, n, token, m), {
                mode,
                scope: "device",
                deviceId: uuid(m.deviceId),
                agentId,
              }),
            );
          else if (!/^[0-9a-f-]{36}$/.test(m?.attemptId || ""))
            results.push({
              ok: false,
              error: "stale-token",
              directive: { action: "drop" },
            });
          else
            results.push(
              await store.atomic((s, n) => agentReport(s, n, token, m), {
                mode,
                scope: "attempt",
                attemptId: m.attemptId,
                agentId,
              }),
            );
        } catch (error) {
          if (error.status === 401 || error.status === 403) throw error;
          results.push({
            ok: false,
            error:
              error instanceof Fault ? error.message : "处理失败，稍后重报",
            retry: !(error instanceof Fault),
          });
        }
      }
      return json(res, 200, { results });
    }
    throw new Fault("未知 Agent 接口", 404);
  }
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const embedded = /^\/embed(\/|$)/.test(req.url || "");
    res.setHeader(
      "Content-Security-Policy",
      // The embedded workbench may be framed by the proxying Hub page (same origin).
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${embedded ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'`,
    );
    try {
      const url = new URL(req.url, "http://localhost"),
        path = url.pathname;
      if (path === "/health/live")
        return json(res, 200, { ok: true, service: "mx-device" });
      if (path === "/health/ready") {
        await store.ready();
        return json(res, 200, { ok: true });
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        if (
          req.headers.origin &&
          new URL(req.headers.origin).host !== req.headers.host
        )
          throw new Fault("跨站写入被拒绝", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new Fault("需要 JSON 请求", 415);
      }
      if (path === "/api/login" && req.method === "POST") {
        const ip = req.socket.remoteAddress,
          now = Date.now(),
          prior = failures.get(ip);
        if (prior && now - prior.at < 60000 && prior.count >= 10)
          throw new Fault("尝试过多，请稍后再试", 429);
        const b = await body(req);
        if (!equal(b.token, cfg.adminToken)) {
          if (failures.size > 1000) failures.clear();
          failures.set(ip, {
            at: prior && now - prior.at < 60000 ? prior.at : now,
            count: prior && now - prior.at < 60000 ? prior.count + 1 : 1,
          });
          throw new Fault("管理凭证不正确", 401);
        }
        failures.delete(ip);
        const exp = String(now + 12 * 3600000);
        res.setHeader(
          "Set-Cookie",
          `mx_device_session=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${cfg.secureCookies ? "; Secure" : ""}`,
        );
        return json(res, 200, { ok: true });
      }
      if (path === "/api/logout" && req.method === "POST") {
        res.setHeader(
          "Set-Cookie",
          "mx_device_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return json(res, 200, { ok: true });
      }
      if (path.startsWith("/agent/v1/"))
        return await agentRoute(req, res, path);
      if (path.startsWith("/v1/")) return await v1Route(req, res, url, path);
      // The proxy redirects its bare prefix (/device-center → /device-center/):
      // only it knows the outside path, which relative asset URLs depend on.
      if (path.startsWith("/embed/"))
        return await embedRoute(req, res, url, path);
      if (path.startsWith("/api/")) {
        const who = role(req);
        if (!who) throw new Fault("请先登录设备中心", 401);
        if (path === "/api/session") return json(res, 200, { role: who });
        const mode = realm(url.searchParams.get("mode") || "sim");
        if (who === "test" && mode !== "sim")
          throw new Fault("测试凭证仅允许模拟模式", 403);
        if (req.method !== "GET") touched(res, mode);
        if (path === "/api/pool-scenarios" && req.method === "GET") {
          if (mode !== "sim") throw new Fault("调度池演练仅允许模拟模式", 403);
          return json(res, 200, {
            scenarios: POOL_SCENARIOS,
            defaults: DEFAULT_POOL_POLICY,
          });
        }
        if (path === "/api/pool-simulate" && req.method === "POST") {
          if (mode !== "sim") throw new Fault("调度池演练仅允许模拟模式", 403);
          const options = simulationOptions(await body(req));
          return json(res, 200, await benchmark(options));
        }
        if (path === "/api/accounts" && req.method === "GET") {
          const state = await store.snapshot(mode);
          const rank = { review: 0, limited: 1, active: 2, retired: 3 };
          return json(res, 200, {
            statuses: ACCOUNT_STATUSES,
            signals: ACCOUNT_SIGNALS,
            accounts: (state.accounts || [])
              .map((a) => accountView(state, state.now, a))
              .sort(
                (a, b) =>
                  rank[a.status] - rank[b.status] ||
                  a.appId.localeCompare(b.appId) ||
                  a.accountKey.localeCompare(b.accountKey),
              ),
          });
        }
        if (
          ["/api/account-status", "/api/account-signal"].includes(path) &&
          req.method === "POST"
        ) {
          const b = await body(req);
          const id = str(b.id, "账号", 300);
          const change =
            path === "/api/account-status"
              ? setAccountStatus
              : recordAccountSignal;
          return json(
            res,
            200,
            await store.atomic(
              (s, n) => accountView(s, n, change(s, n, mode, id, b)),
              { mode },
            ),
          );
        }
        if (path === "/api/agents" && req.method === "GET") {
          const state = await store.snapshot(mode);
          return json(res, 200, {
            agents: (state.agents || []).map((a) =>
              agentView(state, state.now, a),
            ),
          });
        }
        if (path === "/api/agents" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            201,
            await store.atomic((s, n) => createAgent(s, n, mode, b), { mode }),
          );
        }
        const agentPath = path.match(
          /^\/api\/agents\/([0-9a-f-]{36})(\/adopt)?$/,
        );
        if (agentPath && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            200,
            await store.atomic(
              (s, n) =>
                agentPath[2]
                  ? publicDevice(adoptDevice(s, n, mode, agentPath[1], b))
                  : changeAgent(s, n, mode, agentPath[1], b),
              { mode },
            ),
          );
        }
        const stopPath = path.match(/^\/api\/attempts\/([0-9a-f-]{36})\/stop$/);
        if (stopPath && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            200,
            await store.atomic(
              (s, n) => requestStop(s, n, mode, stopPath[1], b),
              {
                mode,
              },
            ),
          );
        }
        if (path === "/api/strategy-auto" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            200,
            await store.atomic((s, n) => configureAutoProfile(s, n, mode, b), {
              mode,
            }),
          );
        }
        if (path === "/api/strategy-shadow" && req.method === "POST") {
          const b = await body(req);
          const state = await store.snapshot(mode);
          return json(
            res,
            200,
            shadowStrategy(
              state,
              state.now,
              mode,
              b,
              placingSlots(state, state.now),
            ),
          );
        }
        if (path === "/api/state" && req.method === "GET")
          return json(res, 200, await hub.current(mode));
        if (path === "/api/stream" && req.method === "GET")
          return hub.subscribe(mode, req, res);
        if (path === "/api/explain" && req.method === "GET")
          return json(
            res,
            200,
            await explain(uuid(url.searchParams.get("jobId")), mode),
          );
        // Callers of the Job API v1 (V2-5): keys and secrets are shown once.
        if (path === "/api/clients" && req.method === "GET") {
          const state = await store.snapshot(mode);
          return json(
            res,
            200,
            clientsOverview(
              state,
              state.now,
              await store.clientJobCounts(mode),
            ),
          );
        }
        if (path === "/api/clients" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            201,
            await store.atomic((s, n) => createClient(s, n, mode, b), { mode }),
          );
        }
        const clientPath = path.match(
          /^\/api\/clients\/([0-9a-f-]{36})(\/deliveries)?$/,
        );
        if (clientPath && clientPath[2] && req.method === "GET")
          return json(res, 200, {
            deliveries: (
              await store.deliveries(mode, {
                clientId: uuid(clientPath[1]),
                limit: 30,
              })
            ).map(({ payload, ...d }) => ({
              ...d,
              jobStatus: payload?.job?.status ?? null,
              clientRequestId: payload?.job?.clientRequestId ?? null,
            })),
          });
        if (clientPath && !clientPath[2] && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            200,
            await store.atomic(
              (s, n) => changeClient(s, n, mode, uuid(clientPath[1]), b),
              { mode },
            ),
          );
        }
        const retry = path.match(/^\/api\/outbox\/([0-9a-f-]{36})\/retry$/);
        if (retry && req.method === "POST") {
          await body(req);
          const row = await store.retryDelivery(mode, uuid(retry[1]));
          if (!row) throw new Fault("投递不存在或已送达", 404);
          return json(res, 200, { id: row.id, status: row.status });
        }
        if (
          ["/api/strategy-definitions", "/api/rule-definitions"].includes(path)
        ) {
          const strategy = path === "/api/strategy-definitions";
          if (req.method === "GET") {
            const state = await store.snapshot(mode);
            const history = { history: true, includeArchived: true };
            return json(
              res,
              200,
              strategy
                ? {
                    strategies: mode === "sim" ? listStrategies(state) : [],
                    history:
                      mode === "sim" ? listStrategies(state, history) : [],
                    rules: mode === "sim" ? listRules(state) : [],
                    ruleHistory:
                      mode === "sim" ? listRules(state, history) : [],
                  }
                : {
                    rules: mode === "sim" ? listRules(state) : [],
                    history: mode === "sim" ? listRules(state, history) : [],
                  },
            );
          }
          if (req.method === "POST") {
            if (mode !== "sim")
              throw new Fault("策略与规则当前仅用于模拟调度", 403);
            const b = await body(req),
              save = strategy ? saveStrategy : saveRule;
            return json(
              res,
              201,
              await store.atomic((s, n) => save(s, n, mode, b), { mode }),
            );
          }
        }
        const strategyArchive = path.match(
          /^\/api\/(strategy|rule)-definitions\/([^/]+)$/,
        );
        if (strategyArchive && req.method === "DELETE") {
          if (mode !== "sim")
            throw new Fault("策略与规则当前仅用于模拟调度", 403);
          const b = await body(req);
          let id;
          try {
            id = decodeURIComponent(strategyArchive[2]);
          } catch {
            throw new Fault("目录 ID 无效", 400);
          }
          const archive =
            strategyArchive[1] === "strategy" ? archiveStrategy : archiveRule;
          return json(
            res,
            200,
            await store.atomic((s, n) => archive(s, n, mode, id, b), { mode }),
          );
        }
        if (path === "/api/strategy-apply" && req.method === "POST") {
          if (mode !== "sim") throw new Fault("策略当前仅应用于模拟机架", 403);
          const b = await body(req);
          return json(
            res,
            200,
            await store.atomic((s, n) => applyStrategy(s, n, mode, b), {
              mode,
            }),
          );
        }
        if (path === "/api/workstation-demo" && req.method === "POST") {
          if (mode !== "sim") throw new Fault("演示场景不能驱动真机", 403);
          const b = await body(req);
          return json(
            res,
            202,
            await store.atomic((s, n) => launchWorkstationDemo(s, n, mode, b), {
              mode,
            }),
          );
        }
        const assignment = path.match(
          /^\/api\/jobs\/([^/]+)\/(assignment|queue-cancel)$/,
        );
        if (assignment && req.method === "POST") {
          if (mode !== "sim")
            throw new Fault("此工作台任务管理仅用于模拟", 403);
          const id = uuid(assignment[1]),
            b = await body(req);
          const mutate =
            assignment[2] === "assignment" ? assignQueuedJob : cancelQueuedJob;
          return json(
            res,
            200,
            await store.atomic((s, n) => mutate(s, n, mode, id, b), {
              mode,
              jobId: id,
            }),
          );
        }
        const capabilities = path.match(
          /^\/api\/devices\/([^/]+)\/sim-capabilities$/,
        );
        if (capabilities && req.method === "POST") {
          if (mode !== "sim") throw new Fault("设备能力编辑仅用于模拟", 403);
          const id = uuid(capabilities[1]),
            b = await body(req);
          return json(
            res,
            200,
            await store.atomic(
              (s, n) => configureSimDevice(s, n, mode, id, b),
              { mode },
            ),
          );
        }
        if (path === "/api/command-definitions" && req.method === "GET") {
          const state = await store.snapshot(mode);
          return json(res, 200, {
            commands: mode === "sim" ? commandDefinitions(state) : [],
            history:
              mode === "sim"
                ? commandDefinitions(state, {
                    history: true,
                    includeArchived: true,
                  })
                : [],
          });
        }
        if (path === "/api/command-definitions" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            201,
            await store.atomic((s, n) => saveCommand(s, n, mode, b), { mode }),
          );
        }
        const catalogArchive = path.match(
          /^\/api\/(command|task)-definitions\/([^/]+)$/,
        );
        if (catalogArchive && req.method === "DELETE") {
          const b = await body(req);
          let id;
          try {
            id = decodeURIComponent(catalogArchive[2]);
          } catch {
            throw new Fault("目录 ID 无效", 400);
          }
          const archive =
            catalogArchive[1] === "command"
              ? archiveCommand
              : archiveDefinition;
          return json(
            res,
            200,
            await store.atomic((s, n) => archive(s, n, mode, id, b), { mode }),
          );
        }
        if (path === "/api/task-definitions" && req.method === "GET") {
          const state = await store.snapshot(mode);
          return json(res, 200, {
            definitions: definitions(state).filter((d) => d.mode === mode),
            commands: mode === "sim" ? commandDefinitions(state) : [],
          });
        }
        if (path === "/api/task-definitions" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            201,
            await store.atomic((s, n) => saveDefinition(s, n, mode, b), {
              mode,
            }),
          );
        }
        if (path === "/api/loop-policy" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            200,
            await store.atomic((s, n) => configureLoops(s, n, mode, b), {
              mode,
            }),
          );
        }
        if (path === "/api/resources/control" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            200,
            await store.atomic((s, n) => controlResource(s, n, mode, b), {
              mode,
            }),
          );
        }
        const adapterTest = path.match(
          /^\/api\/devices\/([^/]+)\/adapter-test$/,
        );
        if (adapterTest && req.method === "POST") {
          const id = uuid(adapterTest[1]),
            b = await body(req);
          b.key = str(b.key, "幂等键");
          return json(
            res,
            202,
            await store.atomic(
              (s, n) => testAdapterCommand(s, n, mode, id, b),
              { mode, key: b.key },
            ),
          );
        }
        const pacing = path.match(/^\/api\/devices\/([^/]+)\/pacing$/);
        if (pacing && req.method === "POST") {
          const id = uuid(pacing[1]),
            b = await body(req);
          return json(
            res,
            200,
            await store.atomic((s, n) => configurePacing(s, n, mode, id, b), {
              mode,
            }),
          );
        }
        const placement = path.match(/^\/api\/devices\/([^/]+)\/placement$/);
        if (placement && req.method === "POST") {
          const id = uuid(placement[1]),
            b = await body(req);
          return json(
            res,
            200,
            await store.atomic((s, n) => updatePlacement(s, n, mode, id, b), {
              mode,
            }),
          );
        }
        const peripheral = path.match(
          /^\/api\/devices\/([^/]+)\/(observer|capture|frame|session|mobile-status|poc-channel)$/,
        );
        if (peripheral) {
          const id = uuid(peripheral[1]),
            action = peripheral[2];
          if (action !== "session" && mode !== "real")
            throw new Fault("模拟设备不能连接真实画面", 403);
          if (action === "frame" && req.method === "GET") {
            const png = await store.frame(
              id,
              uuid(url.searchParams.get("captureId")),
            );
            if (!png) throw new Fault("画面不存在或已更新，请刷新记录", 404);
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": png.length,
              "Cache-Control": "no-store",
            });
            return res.end(png);
          }
          if (req.method !== "POST" || action === "frame")
            throw new Fault("不支持的方法", 405);
          const b = await body(req);
          return json(
            res,
            ["capture", "mobile-status"].includes(action) ? 202 : 200,
            await store.atomic(
              (s, n) =>
                action === "mobile-status"
                  ? requestInspection(s, n, id)
                  : action === "poc-channel"
                    ? setPoCChannel(s, n, id, b)
                    : action === "observer"
                      ? configureObserver(s, n, id, b)
                      : action === "capture"
                        ? requestCapture(s, n, id)
                        : sessionAction(s, n, mode, id, b),
              { mode },
            ),
          );
        }
        if (path.startsWith("/api/jobs/") && req.method === "GET") {
          const detail = await store.detail(mode, uuid(path.split("/")[3]));
          if (!detail) throw new Fault("任务不存在", 404);
          return json(res, 200, detail);
        }
        if (path === "/api/scenarios" && req.method === "POST") {
          if (mode !== "sim") throw new Fault("演示场景不能驱动真机", 403);
          const b = await body(req);
          str(b.key, "演示幂等键");
          return json(
            res,
            202,
            await store.atomic(
              (s, n) =>
                b.kind === "rack20"
                  ? rackScenario(s, n, b.key)
                  : scenario(s, n, b.kind, b.key),
              {
                mode,
                key: `${b.key}:1`,
              },
            ),
          );
        }
        if (path === "/api/devices" && req.method === "POST") {
          const b = await body(req);
          if (mode !== "sim" && b.defaultStrategyId !== undefined)
            throw new Fault("真实设备不能应用模拟默认策略", 403);
          return json(
            res,
            201,
            await store.atomic(
              (s, n) => {
                const device = register(s, n, mode, b);
                if (
                  b.defaultStrategyId !== undefined &&
                  !s.devices.some(
                    (d) =>
                      d.mode === mode &&
                      d.rack === device.rack &&
                      d.id !== device.id,
                  ) &&
                  !s.loopPolicies?.some(
                    (p) => p.mode === mode && p.rack === device.rack,
                  )
                ) {
                  applyStrategy(s, n, mode, {
                    rack: device.rack,
                    revision: 0,
                    strategyId: b.defaultStrategyId,
                  });
                }
                return device;
              },
              { mode },
            ),
          );
        }
        if (path === "/api/jobs" && req.method === "POST") {
          const b = await body(req);
          str(b.key, "幂等键");
          if (mode === "real" && b.confirmed !== true)
            throw new Fault("必须显式确认真实执行", 400);
          return json(
            res,
            202,
            await store.atomic((s, n) => addJob(s, n, mode, b), {
              mode,
              key: b.key,
              jobId: b.sourceJobId ? uuid(b.sourceJobId) : null,
            }),
          );
        }
        const deviceAction = path.match(
          /^\/api\/devices\/([^/]+)\/(control|probe)$/,
        );
        if (deviceAction && req.method === "POST") {
          const id = uuid(deviceAction[1]),
            b = await body(req);
          if (deviceAction[2] === "control")
            return json(
              res,
              200,
              await store.atomic(
                (s, n) => publicDevice(control(s, n, mode, id, b)),
                {
                  mode,
                },
              ),
            );
          if (mode !== "real")
            throw new Fault("模拟设备不调用手机状态接口", 400);
          // Probe is durable work claimed by the HOST worker (or the phone's
          // Agent), not an API-server HTTP request.
          const d = (await store.snapshot(mode)).devices.find(
            (d) => d.id === id,
          );
          if (!d) throw new Fault("设备不存在", 404);
          if (d.pocDisabled) throw new Fault("旧 PoC 通道已停用", 403);
          if (d.adapter === "mobile-agent")
            throw new Fault(
              "此设备通过开始观看检查画面，不调用 PoC 状态接口",
              400,
            );
          if (probeRequests.get(id) > Date.now() - 3000)
            throw new Fault("请等待当前检查完成", 429);
          probeRequests.set(id, Date.now());
          return json(
            res,
            202,
            await store.atomic(
              (s, n) => {
                const row = s.devices.find((x) => x.id === id);
                if (row.pocDisabled) throw new Fault("旧 PoC 通道已停用", 403);
                if (row.revision !== b.revision)
                  throw new Fault("设备状态已变化");
                // An Agent-hosted phone is probed by its Agent (inbox).
                if (
                  row.agentId &&
                  !agentOnline(
                    s.agents.find((a) => a.id === row.agentId),
                    n,
                  )
                )
                  throw new Fault("宿主机 Agent 离线或已停用，无法检查", 409);
                row.probeRequestedAt = n;
                row.revision++;
                return publicDevice(row);
              },
              { mode },
            ),
          );
        }
        const cancelled = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
        if (cancelled && req.method === "POST") {
          const id = uuid(cancelled[1]);
          return json(
            res,
            200,
            await store.atomic((s, n) => cancel(s, n, mode, id), {
              mode,
              jobId: id,
            }),
          );
        }
        throw new Fault("接口不存在", 404);
      }
      return await serveStatic(req, res, path);
    } catch (e) {
      if (res.headersSent) return res.end();
      json(
        res,
        e.status || 503,
        {
          error:
            e instanceof Fault ||
            (Number.isInteger(e.status) && e.status >= 400 && e.status < 500)
              ? e.message
              : "服务暂不可用；未自动重试设备操作",
          ...(e instanceof Fault ? e.body : {}),
        },
        e instanceof Fault ? e.headers : {},
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.hub = hub;
  // Open SSE streams would keep close() waiting; end them first.
  const close = server.close.bind(server);
  server.close = (callback) => {
    hub.close();
    waiter.close();
    return close(callback);
  };
  return server;
}
