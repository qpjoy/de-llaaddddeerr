import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import {
  register,
  recordProbe,
  control,
  addJob,
  claim,
} from "../server/model.mjs";
import {
  callPoC,
  simulatedResult,
  validateResult,
  observation,
} from "../server/transport.mjs";
async function realStore() {
  const s = new MemoryStore();
  const d = await s.atomic((s, n) =>
    register(s, n, "real", {
      name: "fake physical",
      origin: "http://127.0.0.1:18081",
      workerId: "w",
      accountKey: "test",
      approved: true,
    }),
  );
  await s.atomic((s, n) => {
    recordProbe(s, n, "real", d.id, d.revision, {
      idle: true,
      reachable: true,
    });
    control(s, n, "real", d.id, {
      action: "enable",
      revision: 2,
      confirmedExclusive: true,
    });
    addJob(s, n, "real", {
      key: "one",
      deviceId: d.id,
      operation: "search",
      keyword: "test",
      pages: 2,
    });
  });
  return s;
}
test("real adapter contract preserves GET URLs, tokens, no redirects or arbitrary operations", async () => {
  const device = { mode: "real", origin: "http://127.0.0.1:18081" },
    input =
      "https://www.xiaohongshu.com/explore/abc?xsec_token=x%2Fy&xsec_source=app_search_result";
  let calls = 0;
  await callPoC(device, "note", { input }, async (url, opts) => {
    calls++;
    assert.equal(url.pathname, "/api/note");
    assert.equal(url.searchParams.get("input"), input);
    assert.equal(opts.redirect, "error");
    return new Response(JSON.stringify({ ok: true, detail: { id: "abc" } }), {
      status: 200,
    });
  });
  assert.equal(calls, 1);
  await assert.rejects(callPoC({ ...device, mode: "sim" }, "search"));
  await assert.rejects(callPoC(device, "restart"));
});
test("non-JSON, timeout response, excessive body and mismatched results fail closed", async () => {
  const d = { mode: "real", origin: "http://127.0.0.1:18081" };
  for (const response of [
    new Response("html"),
    new Response('{"ok":false}', { status: 504 }),
    new Response("x".repeat(1024 * 1024 + 1)),
  ])
    await assert.rejects(callPoC(d, "state", {}, async () => response));
  assert.throws(() =>
    validateResult(
      "search",
      { keyword: "wanted" },
      simulatedResult("search", { keyword: "other" }),
      1,
    ),
  );
  assert.equal(observation({ ok: true }).idle, false);
  assert.equal(observation({ ok: true, isBusy: true }).idle, false);
});
test("busy preflight never submits phone commands and leaves task queued/paused", async () => {
  const store = await realStore(),
    calls = [],
    engine = new Engine(store, {
      workerId: "w",
      call: async (d, op) => {
        calls.push(op);
        return { ok: true, isBusy: true };
      },
    });
  const work = await store.atomic((s, n) => claim(s, n, "real", "w"));
  await engine.execute(work);
  assert.deepEqual(calls, ["state"]);
  assert.equal(store.state.jobs[0].status, "queued");
  assert(!store.state.devices[0].enabled);
});
test("ambiguous response is never automatically retried", async () => {
  const store = await realStore(),
    calls = [],
    engine = new Engine(store, {
      workerId: "w",
      call: async (d, op) => {
        calls.push(op);
        if (op === "state") return { ok: true, isBusy: false };
        throw Error("timeout");
      },
    });
  await engine.tick();
  await Promise.all([...engine.inflight.values()]);
  await engine.tick();
  assert.deepEqual(calls, ["state", "search"]);
  assert.equal(store.state.jobs[0].status, "unknown");
  assert.equal(store.state.devices[0].state, "quarantined");
  await engine.close();
});
test("real search holds session and issues exactly state/search/next; simulation never HTTP", async () => {
  const store = await realStore(),
    calls = [],
    engine = new Engine(store, {
      workerId: "w",
      realDelay: 0,
      call: async (d, op, input) => {
        calls.push(op);
        return op === "state"
          ? { ok: true, isBusy: false }
          : simulatedResult(op, input, op === "next" ? 2 : 1);
      },
    });
  await engine.execute(await store.atomic((s, n) => claim(s, n, "real", "w")));
  assert.deepEqual(calls, ["state", "search", "next"]);
  assert.equal(store.state.jobs[0].result.pages.length, 2);
  const sim = new MemoryStore();
  await sim.atomic((s, n) => {
    register(s, n, "sim", { name: "sim" });
    addJob(s, n, "sim", { key: "s", operation: "search", keyword: "s" });
  });
  const noHttp = new Engine(sim, {
    simDelay: 0,
    call: () => {
      throw Error("HTTP is forbidden");
    },
  });
  await noHttp.execute(await sim.atomic((s, n) => claim(s, n, "sim", "w")));
  assert.equal(sim.state.jobs[0].status, "succeeded");
});
test("read-only probe requests are consumed only by assigned worker", async () => {
  const store = await realStore();
  await store.atomic((s) => {
    s.jobs = [];
    s.devices[0].enabled = false;
    s.devices[0].probeRequestedAt = Date.now();
    s.devices[0].probe = null;
  });
  let calls = 0;
  const wrong = new Engine(store, {
    workerId: "different",
    call: () => {
      calls++;
      return { ok: true, isBusy: false };
    },
  });
  await wrong.tick();
  assert.equal(calls, 0);
  await wrong.close();
  const right = new Engine(store, {
    workerId: "w",
    call: async () => {
      calls++;
      return { ok: true, isBusy: false };
    },
  });
  await right.tick();
  await Promise.all([...right.inflight.values()]);
  await right.tick();
  assert.equal(calls, 1);
  assert(store.state.devices[0].probe.idle);
  await right.close();
});
