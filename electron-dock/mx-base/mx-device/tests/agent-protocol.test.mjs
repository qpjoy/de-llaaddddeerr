// Host Agent protocol end to end (V2-3): the real HTTP API, the in-process
// scheduler (leader) and a SimAgent connected over HTTP. Semantics under
// crash, partition, stop, signals and rejection.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { Engine } from "../server/engine.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { findAccount } from "../server/accounts.mjs";
import { HostAgent } from "../server/agent/host-agent.mjs";
import { SimDriver } from "../server/agent/sim-driver.mjs";

const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
async function until(fn, ms = 15000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}
let keys = 0;
async function lab(
  t,
  {
    devices = 2,
    apps = ["xhs", "weibo"],
    agentApps = apps,
    speed = 0.2,
    faults = {},
    clock,
  } = {},
) {
  const offset = { ms: 0 };
  const store = new MemoryStore(clock || (() => Date.now() + offset.ms));
  const server = createApp({ store, cfg });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  // A switchable network between the Agent and the center.
  const net = { down: false };
  const agentFetch = async (url, init) => {
    if (net.down)
      throw Object.assign(new Error("network down"), { code: "ECONNREFUSED" });
    const response = await fetch(url, init);
    // Lose one answer after the center has processed the request.
    if (net.loseAnswer?.(url, init)) {
      net.loseAnswer = null;
      throw Object.assign(new Error("connection reset"), {
        code: "ECONNRESET",
      });
    }
    return response;
  };
  const api = async (path, body) => {
    const r = await fetch(
      `${base}/api/${path}${path.includes("?") ? "&" : "?"}mode=sim`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${cfg.adminToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return { status: r.status, value: await r.json() };
  };
  const { value: created } = await api("agents", { name: "宿主机 A" });
  const serials = Array.from({ length: devices }, (_, i) => `sim-${i + 1}`);
  const agents = [];
  const startAgent = async (extra = {}) => {
    const host = new HostAgent({
      center: base,
      token: created.token,
      devices: serials.map((serial) => ({ serial, apps: agentApps })),
      driver: new SimDriver({ speed, faults }),
      fetch: agentFetch,
      pollWaitMs: 500,
      retryMs: 40,
      ...extra,
    });
    agents.push(host);
    await host.start();
    return host;
  };
  const host = await startAgent();
  for (const serial of serials) {
    const adopted = await api(`agents/${created.agent.id}/adopt`, {
      serial,
      rack: "agent-rack",
      simApps: apps,
    });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.value));
  }
  await store.atomic((s, n) => {
    for (const d of s.devices) d.taskIntervalMs = 0;
    configureLoops(s, n, "sim", {
      rack: "agent-rack",
      revision: 0,
      commandDelayMs: 200,
      cooldownMinMs: 0,
      cooldownMaxMs: 0,
    });
  });
  const engine = new Engine(store, { workerId: "leader" });
  t.after(async () => {
    await engine.close();
    for (const a of agents) a.killed ? null : await a.stop();
    await new Promise((r) => server.close(r));
  });
  const submit = (count, definitionId = "sim:weibo.list:1") =>
    store.atomic((s, n) =>
      Array.from(
        { length: count },
        () =>
          addWorkflow(s, n, "sim", {
            key: `agent-${keys++}`,
            definitionId,
            rack: "agent-rack",
            keyword: "k",
            target: "t",
          }).id,
      ),
    );
  const jobs = (ids) => store.state.jobs.filter((j) => ids.includes(j.id));
  return {
    store,
    base,
    api,
    host,
    startAgent,
    engine,
    submit,
    jobs,
    net,
    offset,
    agentId: created.agent.id,
    token: created.token,
  };
}

test("sessions run on the Agent under fenced leases with continuous seq", async (t) => {
  const L = await lab(t);
  L.engine.start();
  const ids = await L.submit(4);
  await until(
    () => L.jobs(ids).every((j) => j.status === "succeeded"),
    20000,
    "jobs",
  );
  const s = L.store.state;
  const attempts = s.attempts.filter((a) => ids.includes(a.jobId));
  assert(
    attempts.every((a) => a.executor === "agent" && a.agentId === L.agentId),
  );
  // Tokens are per device and strictly increasing.
  for (const d of s.devices) {
    const tokens = attempts
      .filter((a) => a.deviceId === d.id)
      .map((a) => a.token);
    assert.deepEqual(
      tokens,
      [...tokens].sort((x, y) => x - y),
    );
    assert.equal(new Set(tokens).size, tokens.length);
    assert.equal(d.leaseToken, Math.max(0, ...tokens));
  }
  // Every command carries its lease token and a continuous seq from 1.
  for (const a of attempts) {
    const commands = s.commands
      .filter((c) => c.attemptId === a.id)
      .sort((x, y) => x.seq - y.seq);
    assert(commands.length > 0);
    assert.deepEqual(
      commands.map((c) => c.seq),
      commands.map((_, i) => i + 1),
    );
    assert(
      commands.every((c) => c.token === a.token && c.status === "succeeded"),
    );
  }
  assert.equal(
    L.host.stats.commands,
    s.commands.filter((c) => ids.includes(c.jobId)).length,
  );
  // Pacing and accounts are charged exactly as for in-process execution.
  const charged = s.devices.reduce(
    (n, d) => n + (findAccount(s, d, "weibo")?.totals.sessions || 0),
    0,
  );
  assert.equal(charged, 4);
  // The Agent is visible to operators, without its token hash.
  const { value } = await L.api("agents");
  assert.equal(value.agents[0].online, true);
  assert.equal(value.agents[0].devices.length, 2);
  assert.equal(JSON.stringify(value).includes("tokenHash"), false);
});

test("stale tokens and broken echoes are refused by the center", async (t) => {
  const L = await lab(t, { devices: 1 });
  // Hold the Agent's network so the command stays issued but unanswered.
  L.engine.start();
  const [id] = await L.submit(1);
  const command = await until(
    () =>
      L.store.state.commands.find(
        (c) => c.jobId === id && c.status === "running",
      ),
    10000,
    "a running command",
  );
  L.net.down = true;
  const report = (m) =>
    fetch(`${L.base}/agent/v1/report`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${L.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: [m] }),
    }).then((r) => r.json());
  const stale = await report({
    type: "command.finished",
    attemptId: command.attemptId,
    token: command.token - 1,
    commandId: command.id,
    seq: command.seq,
  });
  assert.equal(stale.results[0].error, "stale-token");
  const forged = await report({
    type: "command.finished",
    attemptId: command.attemptId,
    token: command.token,
    commandId: command.id,
    seq: command.seq + 1,
    receipt: {
      commandId: command.id,
      seq: command.seq + 1,
      token: command.token,
    },
  });
  assert.equal(forged.results[0].ok, false);
  const job = L.store.state.jobs.find((j) => j.id === id);
  assert.equal(
    job.status,
    "unknown",
    "a receipt that does not echo seq is unknown",
  );
  assert.equal(
    L.store.state.devices[0].state,
    "quarantined",
    "and the device is quarantined, not retried",
  );
  const bad = await fetch(`${L.base}/agent/v1/poll`, {
    method: "POST",
    headers: {
      authorization: "Bearer nope",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(bad.status, 401);
});

test("crash: a lease that issued commands becomes unknown; an unaccepted grant returns to the queue", async (t) => {
  const L = await lab(t, { devices: 1, faults: { hang: () => true } });
  L.engine.start();
  const [first] = await L.submit(1);
  await until(
    () =>
      L.store.state.commands.some(
        (c) => c.jobId === first && c.status === "running",
      ),
    10000,
    "a command in flight",
  );
  L.host.kill();
  const restarted = await L.startAgent({
    driver: new SimDriver({ speed: 0.2 }),
  });
  await until(() => restarted.connected, 5000, "hello");
  let job = L.store.state.jobs.find((j) => j.id === first);
  assert.equal(job.status, "unknown");
  assert.equal(L.store.state.devices[0].state, "quarantined");
  assert.equal(job.attemptCount, 1, "never retried");

  // Second case: the Agent dies before it ever accepts the grant.
  const M = await lab(t, { devices: 1 });
  M.host.kill();
  M.engine.start();
  const [second] = await M.submit(1);
  await until(
    () =>
      M.store.state.attempts.some(
        (a) => a.jobId === second && a.agentState === "granted",
      ),
    10000,
    "a pending grant",
  );
  const fresh = await M.startAgent();
  await until(
    () => M.jobs([second])[0].status === "succeeded",
    15000,
    "the requeued job",
  );
  job = M.jobs([second])[0];
  assert.equal(
    job.attemptCount,
    2,
    "the unaccepted grant was returned, then granted again",
  );
  const returned = M.store.state.attempts.find(
    (a) => a.jobId === second && a.status === "expired",
  );
  assert.equal(returned.leaseIssued, 0);
  assert(fresh.stats.commands > 0);
});

test("partition: the Agent finishes the command in hand, starts nothing new, and resumes when healed", async (t) => {
  const L = await lab(t, { devices: 1, speed: 1 });
  L.engine.start();
  const [id] = await L.submit(1);
  await until(
    () =>
      L.store.state.commands.some(
        (c) => c.jobId === id && c.status === "running",
      ),
    10000,
    "a command in flight",
  );
  L.net.down = true;
  const before = L.host.stats.commands;
  await sleep(1200); // longer than one command
  assert.equal(
    L.host.stats.commands,
    before + 1,
    "only the command in hand ran",
  );
  const issued = L.store.state.commands.filter((c) => c.jobId === id).length;
  await sleep(600);
  assert.equal(
    L.store.state.commands.filter((c) => c.jobId === id).length,
    issued,
  );
  assert(L.host.outbox.length >= 1, "its receipt waits in the buffer");
  L.net.down = false;
  await until(() => L.jobs([id])[0].status === "succeeded", 15000, "resume");
  await until(() => L.host.outbox.length === 0, 5000, "the buffer drained");
});

test("partition past lease and grace: unknown, and the late receipt is kept as evidence", async (t) => {
  const L = await lab(t, { devices: 1, speed: 1 });
  L.engine.start();
  const [id] = await L.submit(1);
  const command = await until(
    () =>
      L.store.state.commands.find(
        (c) => c.jobId === id && c.status === "running",
      ),
    10000,
    "a command in flight",
  );
  L.net.down = true;
  await sleep(600);
  L.offset.ms += 40000; // center time passes beyond lease and grace
  await until(() => L.jobs([id])[0].status === "unknown", 5000, "sweep");
  assert.equal(L.store.state.devices[0].state, "quarantined");
  L.net.down = false;
  await until(
    () => L.store.state.commands.find((c) => c.id === command.id)?.lateEvidence,
    10000,
    "late evidence",
  );
  assert.equal(
    L.jobs([id])[0].status,
    "unknown",
    "late evidence never turns into success",
  );
});

test("stop: the Agent stops at the next safe point, resets and the job is cancelled", async (t) => {
  const L = await lab(t, { devices: 1, speed: 1 });
  L.engine.start();
  const [id] = await L.submit(1);
  const attempt = await until(
    () =>
      L.store.state.attempts.find(
        (a) => a.jobId === id && a.agentState === "accepted",
      ),
    10000,
    "an accepted lease",
  );
  const stop = await L.api(`attempts/${attempt.id}/stop`, {
    reason: "演练停止",
  });
  assert.equal(stop.value.status, "stopping");
  await until(() => L.jobs([id])[0].status === "cancelled", 10000, "stopped");
  const s = L.store.state;
  assert.equal(s.devices[0].state, "idle");
  assert(
    s.commands
      .filter((c) => c.jobId === id)
      .every((c) => c.status === "succeeded"),
  );
  assert.match(L.jobs([id])[0].reason, /安全点停止并复位/);
});

test("signals from the Agent put the account under review", async (t) => {
  const L = await lab(t, {
    devices: 1,
    faults: { signal: (cmd) => (cmd.stepIndex === 0 ? "captcha" : null) },
  });
  L.engine.start();
  await L.submit(1);
  await until(
    () => {
      const d = L.store.state.devices[0];
      return findAccount(L.store.state, d, "weibo")?.status === "review";
    },
    10000,
    "account review",
  );
  const account = findAccount(L.store.state, L.store.state.devices[0], "weibo");
  assert.match(account.statusReason, /Agent 上报/);
});

test("a grant the Agent cannot run is rejected: job back in the queue, device paused", async (t) => {
  const L = await lab(t, { devices: 1, agentApps: ["xhs"] });
  L.engine.start();
  const [id] = await L.submit(1); // a Weibo job; this Agent device has no Weibo
  await until(
    () => !L.store.state.devices[0].enabled,
    10000,
    "the device paused",
  );
  const job = L.jobs([id])[0];
  assert.equal(job.status, "queued");
  assert.match(job.reason, /能力不符/);
  assert.equal(L.store.state.commands.filter((c) => c.jobId === id).length, 0);
});

test("a lost answer is repaired: the command it carried is sent again, nothing runs twice", async (t) => {
  const L = await lab(t, { devices: 1 });
  L.net.loseAnswer = (url, init) =>
    url.endsWith("/report") && init.body.includes('"command.finished"');
  L.engine.start();
  const [id] = await L.submit(1);
  await until(() => L.jobs([id])[0].status === "succeeded", 15000, "job");
  assert.equal(L.net.loseAnswer, null, "an answer was lost on the way");
  const commands = L.store.state.commands.filter((c) => c.jobId === id);
  assert(commands.every((c) => c.status === "succeeded"));
  await until(() => L.host.outbox.length === 0, 5000, "the buffer drained");
  assert.equal(L.host.stats.commands, commands.length, "each command ran once");
});
