// V2-6 P1: host Agents in the real realm, end to end over the HTTP API with
// the PoC driver and the PoC simulator — no phone, PoC, ADB or VPN. Approval,
// adoption that starts paused, enable through an Agent probe and the exclusive
// acknowledgement, confirmed real templates, grants from the single active
// scheduler only, realm isolation both ways, and the legacy direct-PoC path
// beside it (one phone is one or the other).
//
// A PoC simulator says what it is (/api/state: simulator: true). Standing in
// for a real PoC here, realLike() removes that flag from its answers; the
// product has no such switch.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { Engine } from "../server/engine.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { simulatedResult } from "../server/transport.mjs";
import { HostAgent } from "../server/agent/host-agent.mjs";
import { PocDriver } from "../server/agent/poc-driver.mjs";
import { PocSimulator, noteLinkOf } from "../server/agent/poc-sim.mjs";
import { REAL_DEFINITIONS } from "../server/workflow-catalog.mjs";

const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
const ORIGIN = "http://127.0.0.1:18081";
async function until(fn, ms = 15000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}
/** The simulator without its self-identification, for the first `limit`
 * state reads (default: all). */
function realLike(sim, limit = Infinity) {
  let reads = 0;
  return async (url, init) => {
    const response = await sim.fetch(url, init);
    if (new URL(url).pathname !== "/api/state" || reads++ >= limit)
      return response;
    const { simulator, ...body } = await response.json();
    return new Response(JSON.stringify(body), { status: response.status });
  };
}
const standby = {
  check: async () => null,
  on() {},
  lost() {},
  close: async () => {},
};

async function realLab(
  t,
  { fetch: pocFetch, serials = ["phone-1"], engine = true } = {},
) {
  const store = new MemoryStore();
  const server = createApp({ store, cfg });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body, mode = "real") => {
    const r = await fetch(
      `${base}/api/${path}${path.includes("?") ? "&" : "?"}mode=${mode}`,
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
  const sim = new PocSimulator({ delayMs: 30 });
  const created = await api("agents", {
    name: "测试宿主机 Agent",
    host: "测试宿主机",
    approved: true,
  });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const host = new HostAgent({
    center: base,
    token: created.value.token,
    devices: serials.map((serial) => ({ serial })),
    driver: new PocDriver({
      origins: Object.fromEntries(serials.map((x) => [x, ORIGIN])),
      fetch: pocFetch?.(sim) ?? realLike(sim),
    }),
    pollWaitMs: 300,
    retryMs: 40,
  });
  await host.start();
  const engines = [];
  const startEngine = (options = {}) => {
    const e = new Engine(store, { workerId: "host-a", ...options });
    e.start();
    engines.push(e);
    return e;
  };
  if (engine) startEngine();
  t.after(async () => {
    for (const e of engines) await e.close();
    await host.stop();
    await new Promise((r) => server.close(r));
  });
  const adopt = (body) =>
    api(`agents/${created.value.agent.id}/adopt`, {
      rack: "测试机架",
      approved: true,
      ...body,
    });
  const device = (id) => store.state.devices.find((d) => d.id === id);
  /** Probe through the Agent, then enable with the exclusive acknowledgement. */
  const enable = async (id) => {
    const asked = await api(`devices/${id}/probe`, {
      revision: device(id).revision,
    });
    assert.equal(asked.status, 202, JSON.stringify(asked.value));
    await until(() => device(id).probe?.source === "agent", 5000, "probe");
    return api(`devices/${id}/control`, {
      action: "enable",
      revision: device(id).revision,
      confirmedExclusive: true,
    });
  };
  // No pacing gaps between the tasks of a test.
  const fast = (id) =>
    store.atomic((s) => {
      s.devices.find((d) => d.id === id).taskIntervalMs = 0;
    });
  return {
    store,
    sim,
    host,
    api,
    adopt,
    device,
    enable,
    fast,
    startEngine,
    agent: created.value.agent,
  };
}
const nonState = (sim) => sim.calls.filter((p) => p !== "/api/state");

test("real Agent: approved host, paused adoption, enable via Agent probe and exclusivity, confirmed PoC templates end to end", async (t) => {
  const L = await realLab(t);
  // Registration needs an approval and a named host.
  assert.equal((await L.api("agents", { name: "x", host: "y" })).status, 400);
  assert.equal(
    (await L.api("agents", { name: "x", approved: true })).status,
    400,
  );
  assert.equal(L.host.driver.realm, "real", "the center told the Agent");
  const listed = (await L.api("agents")).value.agents[0];
  assert.deepEqual(listed.pending, ["phone-1"]);
  assert.deepEqual(listed.conflicts, []);

  // Adoption: the account it uses and an approval, like every real device.
  assert.equal((await L.adopt({ serial: "phone-1" })).status, 400);
  assert.equal(
    (await L.adopt({ serial: "phone-1", accountKey: "xhs-1", approved: false }))
      .status,
    400,
  );
  const adopted = await L.adopt({ serial: "phone-1", accountKey: "xhs-1" });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.value));
  const id = adopted.value.id;
  const d = L.device(id);
  assert.equal(d.mode, "real");
  assert.equal(d.adapter, "agent");
  assert.equal(d.driver, "poc");
  assert.equal(d.enabled, false, "a real phone starts paused");
  assert.equal(d.origin, null, "the center never calls this PoC");
  assert.equal(d.workerId, `agent:${L.agent.id}`);
  assert.deepEqual(d.agentApps, ["xhs"]);
  assert.deepEqual(d.agentCommands, [
    "xhs.search",
    "xhs.search.next",
    "xhs.note.detail",
  ]);
  await L.fast(id);

  // Nothing is taken over: no work for a paused phone, no enable without
  // fresh idle evidence or without the exclusive acknowledgement.
  const job = {
    key: "real-search-1",
    definitionId: "real:xhs.poc.search3:1",
    deviceId: id,
    keyword: "露营装备",
    confirmed: true,
  };
  assert.equal((await L.api("jobs", job)).status, 409);
  const early = await L.api(`devices/${id}/control`, {
    action: "enable",
    revision: d.revision,
    confirmedExclusive: true,
  });
  assert.equal(early.status, 409);
  assert.match(early.value.error, /空闲证据/);
  const asked = await L.api(`devices/${id}/probe`, { revision: d.revision });
  assert.equal(asked.status, 202);
  await until(() => L.device(id).probe?.source === "agent", 5000, "probe");
  assert.equal(L.device(id).probe.idle, true);
  assert.equal(L.device(id).probe.simulator, false);
  assert.deepEqual(L.sim.calls, ["/api/state"], "a probe is one state read");
  const blind = await L.api(`devices/${id}/control`, {
    action: "enable",
    revision: L.device(id).revision,
  });
  assert.equal(blind.status, 409);
  assert.match(blind.value.error, /独占/);
  const on = await L.api(`devices/${id}/control`, {
    action: "enable",
    revision: L.device(id).revision,
    confirmedExclusive: true,
  });
  assert.equal(on.status, 200, JSON.stringify(on.value));
  assert.equal(L.device(id).enabled, true);

  // Real templates: confirmed, on a named phone, with what was asked only.
  const { confirmed, ...unconfirmed } = job;
  assert.match((await L.api("jobs", unconfirmed)).value.error, /显式确认/);
  const { deviceId, ...floating } = job;
  assert.equal((await L.api("jobs", floating)).status, 400);
  const { keyword, ...blank } = job;
  assert.match((await L.api("jobs", blank)).value.error, /关键词/);
  assert.equal(
    (await L.api("jobs", { ...job, definitionId: "sim:xhs.poc.search3:1" }))
      .status,
    403,
  );
  const queued = await L.api("jobs", job);
  assert.equal(queued.status, 202, JSON.stringify(queued.value));
  const done = await until(
    () => {
      const j = L.store.state.jobs.find((x) => x.id === queued.value.id);
      return !["queued", "running"].includes(j.status) && j;
    },
    15000,
    "real search",
  );
  assert.equal(done.status, "succeeded", done.reason);
  assert.equal(done.mode, "real");
  const commands = L.store.state.commands.filter((c) => c.jobId === done.id);
  assert(commands.every((c) => c.mode === "real" && c.seq >= 1));
  assert(commands.every((c) => c.receipt.source === "poc"));
  assert.deepEqual(
    commands.map((c) => c.receipt.result.page),
    [1, 2, 3],
  );
  assert.deepEqual(nonState(L.sim), ["/api/search", "/api/next", "/api/next"]);
  const attempt = L.store.state.attempts.find((a) => a.jobId === done.id);
  assert.equal(attempt.executor, "agent");
  assert(
    L.store.state.events.some(
      (e) => e.jobId === done.id && e.type === "queued" && e.mode === "real",
    ),
    "real template events stay in the real realm",
  );

  // Detail needs the full note link (with xsec_token), never a demo note.
  const detail = {
    key: "real-detail-1",
    definitionId: "real:xhs.poc.detail:1",
    deviceId: id,
    confirmed: true,
  };
  assert.equal((await L.api("jobs", detail)).status, 400);
  assert.equal(
    (await L.api("jobs", { ...detail, target: "abc123" })).status,
    400,
  );
  const link = noteLinkOf(commands[0].receipt.result.items[0].id);
  const opened = await L.api("jobs", { ...detail, target: link });
  assert.equal(opened.status, 202, JSON.stringify(opened.value));
  await until(
    () =>
      L.store.state.jobs.find((x) => x.id === opened.value.id).status ===
      "succeeded",
    15000,
    "real detail",
  );
  assert.equal(nonState(L.sim).at(-1), "/api/note");
  // Only the seeded templates exist in the real realm.
  assert.deepEqual(
    (await L.api("task-definitions")).value.definitions.map((x) => x.id),
    REAL_DEFINITIONS.map((x) => x.id),
  );
});

test("real Agent: a PoC simulator is never idle evidence, never driven, and never a receipt", async (t) => {
  // An honest simulator behind a real Agent.
  const L = await realLab(t, { fetch: (sim) => sim.fetch });
  const { value } = await L.adopt({ serial: "phone-1", accountKey: "xhs-1" });
  const refused = await L.enable(value.id);
  assert.equal(refused.status, 409, "no idle evidence from a simulator");
  const probe = L.device(value.id).probe;
  assert.equal(probe.idle, false);
  assert.equal(probe.simulator, true);
  assert.match(probe.error, /PoC 模拟器/);
  // Even if the phone were enabled anyway, the driver refuses the lease
  // before anything is sent; the work stays queued, the phone is paused.
  await L.fast(value.id);
  const id = await L.store.atomic((s, n) => {
    s.devices[0].enabled = true;
    return addWorkflow(s, n, "real", {
      key: "forced",
      definitionId: "real:xhs.poc.search3:1",
      deviceId: value.id,
      keyword: "露营装备",
      confirmed: true,
    }).id;
  });
  await until(() => !L.device(value.id).enabled, 5000, "lease refused");
  assert.equal(L.store.state.jobs.find((j) => j.id === id).status, "queued");
  assert.deepEqual(nonState(L.sim), [], "no PoC request was sent");
  assert.match(
    (await L.host.driver.preflight({ serial: "phone-1" })).reason,
    /不得连接 PoC 模拟器/,
  );
});

test("real Agent: a receipt that turns out to come from a PoC simulator is void and quarantines", async (t) => {
  // Looks real for the probe and the preflight, then the state read after
  // the first command shows a simulator.
  const L = await realLab(t, { fetch: (sim) => realLike(sim, 2) });
  const { value } = await L.adopt({ serial: "phone-1", accountKey: "xhs-1" });
  assert.equal((await L.enable(value.id)).status, 200);
  await L.fast(value.id);
  const queued = await L.api("jobs", {
    key: "crossed",
    definitionId: "real:xhs.poc.search3:1",
    deviceId: value.id,
    keyword: "露营装备",
    confirmed: true,
  });
  const job = await until(
    () => {
      const j = L.store.state.jobs.find((x) => x.id === queued.value.id);
      return !["queued", "running"].includes(j.status) && j;
    },
    15000,
    "voided receipt",
  );
  assert.equal(job.status, "unknown");
  assert.match(job.reason, /PoC 模拟器/);
  assert.equal(L.device(value.id).state, "quarantined");
  assert.deepEqual(nonState(L.sim), ["/api/search"], "nothing retried");
});

test("real grants come from the single active scheduler; legacy PoC phones stay with their host worker", async (t) => {
  const L = await realLab(t, { engine: false });
  const { value } = await L.adopt({ serial: "phone-1", accountKey: "xhs-1" });
  assert.equal((await L.enable(value.id)).status, 200);
  await L.fast(value.id);
  // A legacy direct-PoC phone on host worker "host-a", beside the Agent.
  const legacy = await L.api("devices", {
    name: "旧 PoC 手机",
    origin: "http://127.0.0.1:18082",
    workerId: "host-a",
    accountKey: "xhs-legacy",
    approved: true,
  });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.value));
  await L.store.atomic((s, n) => {
    const d = s.devices.find((x) => x.id === legacy.value.id);
    d.probe = { reachable: true, idle: true, at: n };
    d.revision++;
  });
  const on = await L.api(`devices/${legacy.value.id}/control`, {
    action: "enable",
    revision: L.device(legacy.value.id).revision,
    confirmedExclusive: true,
  });
  assert.equal(on.status, 200, JSON.stringify(on.value));
  const old = await L.api("jobs", {
    key: "legacy-1",
    operation: "search",
    keyword: "旧路径",
    pages: 2,
    deviceId: legacy.value.id,
    confirmed: true,
  });
  assert.equal(old.status, 202, JSON.stringify(old.value));
  const workflow = await L.api("jobs", {
    key: "agent-1",
    definitionId: "real:xhs.poc.detail:1",
    deviceId: value.id,
    target: noteLinkOf("abc123"),
    confirmed: true,
  });
  assert.equal(workflow.status, 202, JSON.stringify(workflow.value));
  // A standby worker on the legacy phone's host: it runs the legacy job
  // in-process through its own PoC call, and grants nothing to the Agent.
  const calls = [];
  L.startEngine({
    leadership: standby,
    realDelay: 0,
    call: async (device, op, input) => {
      calls.push([device.id, op]);
      return op === "state"
        ? { ok: true, isBusy: false }
        : simulatedResult(op, input, op === "next" ? 2 : 1);
    },
  });
  const status = (id) => L.store.state.jobs.find((j) => j.id === id).status;
  await until(() => status(old.value.id) === "succeeded", 10000, "legacy");
  assert.deepEqual(
    calls.map(([, op]) => op),
    ["state", "search", "next"],
  );
  assert(calls.every(([id]) => id === legacy.value.id));
  await sleep(600);
  assert.equal(status(workflow.value.id), "queued", "standby grants nothing");
  assert.equal(
    L.store.state.attempts.filter((a) => a.jobId === workflow.value.id).length,
    0,
  );
  // The active scheduler grants it; the Agent runs it.
  L.startEngine({ workerId: "scheduler", call: () => assert.fail("no call") });
  await until(() => status(workflow.value.id) === "succeeded", 10000, "grant");
  assert(
    calls.every(([id]) => id === legacy.value.id),
    "never the Agent's",
  );
  assert.deepEqual(nonState(L.sim), ["/api/note"]);
  // Old jobs are not handed to the Agent's phone, templates not to the old one.
  assert.equal(
    (
      await L.api("jobs", {
        key: "legacy-on-agent",
        operation: "search",
        keyword: "x",
        deviceId: value.id,
        confirmed: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await L.api("jobs", {
        key: "template-on-legacy",
        definitionId: "real:xhs.poc.search3:1",
        deviceId: legacy.value.id,
        keyword: "x",
        confirmed: true,
      })
    ).status,
    400,
  );
});

test("one phone is Agent-hosted or a legacy PoC registration, never both", async (t) => {
  const L = await realLab(t, { serials: ["phone-1", "phone-2"] });
  const legacy = await L.api("devices", {
    name: "旧 PoC 手机",
    origin: "http://127.0.0.1:18082",
    workerId: "host-a",
    serial: "phone-1",
    accountKey: "xhs-1",
    approved: true,
  });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.value));
  const listed = (await L.api("agents")).value.agents[0];
  assert.deepEqual(listed.conflicts, ["phone-1"]);
  const twice = await L.adopt({ serial: "phone-1", accountKey: "xhs-9" });
  assert.equal(twice.status, 409);
  assert.match(twice.value.error, /二选一/);
  // The same account under another serial is the same phone, too.
  const alias = await L.adopt({ serial: "phone-2", accountKey: "xhs-1" });
  assert.equal(alias.status, 409);
  const ok = await L.adopt({ serial: "phone-2", accountKey: "xhs-2" });
  assert.equal(ok.status, 200, JSON.stringify(ok.value));
  // And the other way round: no legacy registration of an Agent's phone.
  const back = await L.api("devices", {
    name: "别名",
    origin: "http://127.0.0.1:18083",
    workerId: "host-a",
    serial: "phone-2",
    accountKey: "xhs-3",
    approved: true,
  });
  assert.equal(back.status, 409);
  assert.match(back.value.error, /宿主机 Agent 托管/);
  assert.equal(
    L.store.state.devices.filter((d) => d.serial === "phone-2").length,
    1,
  );
});

test("real Agent: only the PoC driver, and simulation Agents stay in their realm", async (t) => {
  const L = await realLab(t, { engine: false });
  // A real Agent connecting with the simulation driver is refused and stops.
  const wrong = await fetch(`${L.host.center}/agent/v1/hello`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${L.host.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ instanceId: "other", driver: "sim", devices: [] }),
  });
  assert.equal(wrong.status, 403);
  assert.match((await wrong.json()).error, /PoC 驱动/);
  // Real Agents are listed only in the real realm and vice versa.
  assert.equal(
    (await L.api("agents", undefined, "sim")).value.agents.length,
    0,
  );
  assert.equal((await L.api("agents")).value.agents.length, 1);
  // A simulation Agent's adoption never creates a real device.
  const simAgent = await L.api("agents", { name: "模拟" }, "sim");
  assert.equal(simAgent.status, 201);
  assert.equal(simAgent.value.agent.mode, "sim");
  assert.equal(
    (
      await L.api(
        `agents/${L.agent.id}/adopt`,
        { serial: "phone-1", accountKey: "k", approved: true },
        "sim",
      )
    ).status,
    404,
    "a real Agent does not exist in the simulation realm",
  );
});
