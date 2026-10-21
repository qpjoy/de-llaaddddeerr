// V2-6 P0: the PoC driver at level L0 against the PoC simulator (same HTTP
// contract as the documented PoC). The conformance suite, the L0 checks
// (identity, page, external insertion, busy, 504, timeout) and the whole path
// center -> Agent -> PocDriver -> PoC on a PoC-driven slot.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { Engine } from "../server/engine.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { validateData } from "../server/command-registry.mjs";
import { COMMANDS } from "../server/workflow-catalog.mjs";
import { HostAgent } from "../server/agent/host-agent.mjs";
import { PocDriver, noteInput } from "../server/agent/poc-driver.mjs";
import { PocSimulator, noteLinkOf } from "../server/agent/poc-sim.mjs";
import { driverContract, sampleCommand } from "./agent-contract.mjs";

const ORIGIN = "http://127.0.0.1:18081";
// The realm comes from the center's hello; these drive a PoC simulator.
const pocDriver = (faults = {}, delayMs = 20) => {
  const sim = new PocSimulator({ delayMs, faults });
  const driver = new PocDriver({
    origins: { "poc-1": ORIGIN },
    fetch: sim.fetch,
  });
  return Object.assign(driver, { sim, realm: "sim" });
};
const search = (overrides = {}) =>
  sampleCommand({
    appId: "xhs",
    code: "xhs.search",
    page: 1,
    params: { keyword: "露营装备" },
    ...overrides,
  });
const ctx = { serial: "poc-1", seq: 1, token: 7 };

driverContract(
  "PocDriver (L0)",
  (faults) => pocDriver(faults),
  { serial: "poc-1" },
  {
    sample: { appId: "xhs", code: "xhs.search", params: { keyword: "契约" } },
  },
);

test("PoC L0: search then next, receipts match the output schema", async () => {
  const d = pocDriver();
  const first = await d.execute(search(), ctx);
  const next = await d.execute(
    search({ id: "c2", code: "xhs.search.next", page: 2, seq: 2 }),
    { ...ctx, seq: 2 },
  );
  const schema = COMMANDS.find((c) => c.code === "xhs.search").outputSchema;
  for (const r of [first, next]) {
    assert.equal(r.source, "poc");
    assert.equal(r.stopped, true);
    assert.equal(r.evidence.level, "L0");
    assert(
      validateData(r.result, schema),
      "fields beyond the schema are dropped",
    );
  }
  assert.deepEqual([first.result.page, next.result.page], [1, 2]);
  assert.equal(next.result.keyword, "露营装备");
  assert.equal(next.evidence.hasMore, true);
  assert.deepEqual(d.sim.calls, [
    "/api/search",
    "/api/state",
    "/api/next",
    "/api/state",
  ]);
});

test("PoC L0: another caller's search right after ours is an external insertion", async () => {
  const d = pocDriver({ external: (op) => op === "search" });
  await assert.rejects(d.execute(search(), ctx), (e) => {
    assert.equal(e.code, "mismatch");
    assert.match(e.message, /外部插入/);
    assert.equal(e.evidence.after.keyword, "外部调用方的关键词");
    return true;
  });
});

test("PoC L0: a wrong page, a 504 and a hang are never successes", async () => {
  await assert.rejects(
    pocDriver({ wrongPage: () => true }).execute(search(), ctx),
    (e) => e.code === "mismatch",
  );
  await assert.rejects(
    pocDriver({ timeout: () => true }).execute(search(), ctx),
    (e) => e.code === "timeout",
  );
  const hung = pocDriver({ hang: () => true });
  hung.callTimeoutMs = 80;
  await assert.rejects(
    hung.execute(search(), ctx),
    (e) => e.code === "timeout",
  );
  // The PoC is still busy with it: the next lease's preflight refuses.
  const ready = await hung.preflight({ serial: "poc-1" });
  assert.equal(ready.idle, false);
});

test("PoC L0: preflight needs a reachable PoC that reports itself idle", async () => {
  assert.equal((await pocDriver().preflight({ serial: "poc-1" })).idle, true);
  const stuck = await pocDriver({ stuckBusy: true }).preflight({
    serial: "poc-1",
  });
  assert.deepEqual(stuck, { idle: false, reason: "PoC 报告忙或状态未知" });
  const missing = await new PocDriver({ origins: {} }).preflight({
    serial: "x",
  });
  assert.equal(missing.idle, false);
  assert.equal(missing.reason, "PoC 不可达");
  const caps = pocDriver().capabilities({ serial: "poc-1" });
  assert.deepEqual(caps.apps, ["xhs"]);
  assert.deepEqual(caps.commands, [
    "xhs.search",
    "xhs.search.next",
    "xhs.note.detail",
  ]);
  assert.deepEqual(
    [caps.canCancel, caps.canAbort, caps.canFence, caps.canReset],
    [true, false, false, false],
  );
});

test("PoC L0: a simulation-realm Agent refuses a PoC that is not a simulator", async () => {
  const real = new PocDriver({
    origins: { "poc-1": ORIGIN },
    fetch: async () =>
      new Response(JSON.stringify({ ok: true, isBusy: false, type: null })),
  });
  real.realm = "sim";
  const verdict = await real.preflight({ serial: "poc-1" });
  assert.equal(verdict.idle, false);
  assert.match(verdict.reason, /只能连接 PoC 模拟器/);
  const sim = pocDriver();
  sim.realm = "sim";
  assert.equal((await sim.preflight({ serial: "poc-1" })).idle, true);
});

test("PoC L0: a real-realm Agent refuses a PoC simulator; an unknown realm drives nothing", async () => {
  const honest = pocDriver();
  honest.realm = "real";
  const verdict = await honest.preflight({ serial: "poc-1" });
  assert.equal(verdict.idle, false);
  assert.match(verdict.reason, /不得连接 PoC 模拟器/);
  // A PoC that does not say it is a simulator (stands in for a real one).
  const sim = new PocSimulator({ delayMs: 20 });
  const real = new PocDriver({
    origins: { "poc-1": ORIGIN },
    fetch: async (url, init) => {
      const response = await sim.fetch(url, init);
      if (new URL(url).pathname !== "/api/state") return response;
      const { simulator, ...body } = await response.json();
      return new Response(JSON.stringify(body));
    },
  });
  assert.equal((await real.preflight({ serial: "poc-1" })).idle, false);
  assert.match(
    (await real.preflight({ serial: "poc-1" })).reason,
    /所属域/,
    "before the center's hello nothing is driven",
  );
  real.realm = "real";
  assert.equal((await real.preflight({ serial: "poc-1" })).idle, true);
  // Receipts say what the PoC reported after the call.
  const receipt = await real.execute(search(), ctx);
  assert.equal(receipt.evidence.simulator, false);
  assert.equal(
    (await pocDriver().execute(search(), ctx)).evidence.simulator,
    true,
  );
});

test("PoC L0: note details by link or id; the id must match", async () => {
  const d = pocDriver();
  const link = noteLinkOf("abc123");
  const byLink = await d.execute(
    search({ code: "xhs.note.detail", page: null, params: { target: link } }),
    ctx,
  );
  assert.equal(byLink.result.target, link);
  assert.equal(byLink.result.complete, true);
  assert(byLink.result.fullText.length > 10);
  assert.equal(
    noteInput("abc123"),
    "https://www.xiaohongshu.com/explore/abc123",
  );
  assert.throws(() => noteInput("javascript:alert(1)"), /笔记链接/);
  // A PoC answering with another note is rejected.
  const liar = new PocDriver({
    origins: { "poc-1": ORIGIN },
    fetch: async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/api/note")
            ? { ok: true, isBusy: false, detail: { id: "other", content: "x" } }
            : { ok: true, isBusy: false, detail: { id: "other" } },
        ),
      ),
  });
  await assert.rejects(
    liar.execute(
      search({ code: "xhs.note.detail", params: { target: "abc123" } }),
      ctx,
    ),
    (e) => e.code === "mismatch",
  );
  await assert.rejects(
    d.execute(search({ code: "weibo.search" }), ctx),
    (e) => e.code === "capability",
  );
});

// ---- center -> Agent -> PocDriver -> PoC ----

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
async function pocRack(t, faults = {}) {
  const store = new MemoryStore();
  const server = createApp({ store, cfg });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body) => {
    const r = await fetch(`${base}/api/${path}?mode=sim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  const { value: created } = await api("agents", { name: "PoC 宿主机" });
  const sim = new PocSimulator({ delayMs: 30, faults });
  const host = new HostAgent({
    center: base,
    token: created.token,
    devices: [{ serial: "poc-1" }],
    driver: new PocDriver({ origins: { "poc-1": ORIGIN }, fetch: sim.fetch }),
    pollWaitMs: 300,
    retryMs: 40,
  });
  await host.start();
  const adopted = await api(`agents/${created.agent.id}/adopt`, {
    serial: "poc-1",
    name: "PoC 插槽 1",
    rack: "PoC 机架",
    simApps: ["xhs", "weibo", "pdd"], // ignored: the driver's report wins
  });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.value));
  await store.atomic((s, n) => {
    for (const d of s.devices) d.taskIntervalMs = 0;
    configureLoops(s, n, "sim", {
      rack: "PoC 机架",
      revision: 0,
      commandDelayMs: 200,
      cooldownMinMs: 0,
      cooldownMaxMs: 0,
    });
  });
  const engine = new Engine(store, { workerId: "leader" });
  engine.start();
  t.after(async () => {
    await engine.close();
    await host.stop();
    await new Promise((r) => server.close(r));
  });
  return { store, sim, host, adopted: adopted.value };
}
const submit = (store, definitionId, extra = {}) =>
  store.atomic(
    (s, n) =>
      addWorkflow(s, n, "sim", {
        key: `poc-${Math.random()}`,
        definitionId,
        rack: "PoC 机架",
        keyword: "露营装备",
        ...extra,
      }).id,
  );

test("PoC slot: adoption takes the driver's capabilities; PoC templates run end to end", async (t) => {
  const L = await pocRack(t);
  assert.equal(
    L.host.driver.realm,
    "sim",
    "the center told the Agent its realm",
  );
  const d = L.store.state.devices[0];
  assert.equal(d.driver, "poc");
  assert.equal(d.pocLevel, "L0");
  assert.deepEqual(d.simApps, ["xhs"]);
  assert.deepEqual(d.simCommandCodes, [
    "xhs.search",
    "xhs.search.next",
    "xhs.note.detail",
  ]);
  // A template needing "open App" never reaches this phone.
  const blocked = await submit(L.store, "sim:xhs.detail:1", {
    target: "abc123",
  });
  const searched = await submit(L.store, "sim:xhs.poc.search3:1");
  const job = await until(
    () => {
      const j = L.store.state.jobs.find((x) => x.id === searched);
      return ["succeeded", "unknown", "failed"].includes(j.status) && j;
    },
    15000,
    "PoC search",
  );
  assert.equal(job.status, "succeeded", job.reason);
  const commands = L.store.state.commands.filter((c) => c.jobId === searched);
  assert.deepEqual(
    commands.map((c) => c.receipt.result.page),
    [1, 2, 3],
  );
  assert(commands.every((c) => c.receipt.source === "poc"));
  assert.deepEqual(
    L.sim.calls.filter((p) => p !== "/api/state"),
    ["/api/search", "/api/next", "/api/next"],
  );
  const link = noteLinkOf(commands[0].receipt.result.items[0].id);
  const detail = await submit(L.store, "sim:xhs.poc.detail:1", {
    target: link,
  });
  await until(
    () =>
      L.store.state.jobs.find((x) => x.id === detail).status === "succeeded",
    15000,
    "PoC detail",
  );
  assert.equal(
    L.store.state.jobs.find((x) => x.id === blocked).status,
    "queued",
  );
});

test("PoC slot: an external insertion quarantines; a busy PoC refuses the lease", async (t) => {
  const faults = { external: () => false, stuckBusy: false };
  const L = await pocRack(t, faults);
  faults.external = (op) => op === "next";
  const id = await submit(L.store, "sim:xhs.poc.search3:1");
  const job = await until(
    () => {
      const j = L.store.state.jobs.find((x) => x.id === id);
      return j.status !== "queued" && j.status !== "running" && j;
    },
    15000,
    "insertion detected",
  );
  assert.equal(job.status, "unknown");
  assert.equal(L.store.state.devices[0].state, "quarantined");
  // Nothing was retried: one search, one next, no third PoC call.
  assert.deepEqual(
    L.sim.calls.filter((p) => p !== "/api/state"),
    ["/api/search", "/api/next"],
  );
});

test("PoC slot: a PoC reporting busy gets no command; the work stays queued", async (t) => {
  const L = await pocRack(t, { stuckBusy: true });
  const id = await submit(L.store, "sim:xhs.poc.search3:1");
  await until(
    () => L.store.state.devices[0].enabled === false,
    15000,
    "lease refused, device paused",
  );
  assert.equal(L.store.state.jobs.find((x) => x.id === id).status, "queued");
  assert.deepEqual(
    L.sim.calls.filter((p) => p !== "/api/state"),
    [],
    "no PoC request was sent",
  );
});
