import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import {
  register,
  recordProbe,
  control,
  addJob,
  claim,
} from "../server/model.mjs";
import { callPoC, observation } from "../server/transport.mjs";
import { submitJob } from "../src/submit-job.mjs";

// Local HTTP fixture for the supplied XHS PoC contract. Never reaches port 18081 or a phone.
const link =
  "https://www.xiaohongshu.com/explore/abc123?xsec_token=a%2Fb%2Bc&xsec_source=app_search_result";
for (const scenario of ["success", "empty", "timeout"]) {
  test(`documented PoC HTTP contract: ${scenario}, durable dependency, no unsafe retries`, async (t) => {
    const paths = [];
    const fixture = createServer((req, res) => {
      assert.equal(req.method, "GET");
      const url = new URL(req.url, "http://fixture.invalid");
      paths.push(url.pathname);
      let body;
      if (url.pathname === "/api/state")
        body = {
          ok: true,
          type: "search",
          isBusy: false,
          page: 1,
          hasMore: false,
          count: 0,
          items: [],
        };
      else if (url.pathname === "/api/search" || url.pathname === "/api/next") {
        if (url.pathname === "/api/search")
          assert.equal(url.searchParams.get("keyword"), "杭州 美食");
        body = {
          ok: true,
          type: "search",
          keyword: "杭州 美食",
          page: url.pathname === "/api/next" ? 2 : 1,
          hasMore: true,
          count: scenario === "empty" ? 0 : 1,
          items:
            scenario === "empty"
              ? []
              : [{ id: "abc123", title: "契约测试数据", detailInput: link }],
        };
        if (scenario === "timeout") {
          res.statusCode = 504;
          body = { ok: false, error: "timeout", message: "25 seconds elapsed" };
        }
      } else if (url.pathname === "/api/note") {
        assert.equal(url.searchParams.get("input"), link);
        body = {
          ok: true,
          type: "note",
          detail: {
            id: "abc123",
            title: "契约测试详情",
            content: "合成响应，并非真机采集",
          },
        };
      } else {
        res.statusCode = 404;
        body = { ok: false, error: "not_found" };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    t.after(() => new Promise((r) => fixture.close(r)));
    const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
    const call = (device, op, input) =>
      callPoC(device, op, input, (url, options) => {
        assert.equal(url.origin, "http://127.0.0.1:18081");
        return fetch(
          new URL(url.pathname + url.search, fixtureOrigin),
          options,
        );
      });
    let now = Date.now();
    const store = new MemoryStore(() => now);
    const d = await store.atomic((s, n) =>
      register(s, n, "real", {
        name: "contract-only",
        workerId: "contract-worker",
        origin: "http://127.0.0.1:18081",
        accountKey: "contract-only",
        approved: true,
      }),
    );
    assert.equal(d.enabled, false);
    assert.deepEqual(paths, []);
    const obs = observation(await call(d, "state"));
    await store.atomic((s, n) => {
      recordProbe(s, n, "real", d.id, d.revision, obs);
      control(s, n, "real", d.id, {
        action: "enable",
        revision: 2,
        confirmedExclusive: true,
      });
    });
    const send = (path, mode, body) =>
      store.atomic((s, n) => addJob(s, n, mode, body));
    const body = {
      key: "contract-demo",
      operation: "search",
      keyword: "杭州 美食",
      pages: 1,
      deviceId: d.id,
      priority: 5,
      confirmed: true,
      followup: true,
    };
    const jobs = await submitJob(send, "real", body);
    await submitJob(send, "real", body);
    assert.equal(store.state.jobs.length, 2);
    assert.equal(store.state.attempts.length, 0);
    const engine = new Engine(store, {
      workerId: "contract-worker",
      call,
      realDelay: 0,
    });
    t.after(() => engine.close());
    const first = await store.atomic((s, n) =>
      claim(s, n, "real", "contract-worker"),
    );
    assert.equal(first.job.id, jobs.search.id);
    assert.equal(
      await store.atomic((s, n) => claim(s, n, "real", "contract-worker")),
      null,
    );
    await engine.execute(first);
    now += 2100;
    const second = await store.atomic((s, n) =>
      claim(s, n, "real", "contract-worker"),
    );
    if (scenario === "success") {
      assert.equal(second.job.id, jobs.detail.id);
      await engine.execute(second);
      assert.equal(store.state.jobs[1].status, "succeeded");
      assert.equal(store.state.jobs[1].result.detail.id, "abc123");
      assert.deepEqual(paths, [
        "/api/state",
        "/api/state",
        "/api/search",
        "/api/state",
        "/api/note",
      ]);
      // The standalone bounded-search flow still uses /api/next and checks page identity.
      now += 2100;
      await send("jobs", "real", {
        ...body,
        key: "two-pages",
        pages: 2,
        followup: false,
      });
      await engine.execute(
        await store.atomic((s, n) => claim(s, n, "real", "contract-worker")),
      );
      assert.deepEqual(paths.slice(-3), [
        "/api/state",
        "/api/search",
        "/api/next",
      ]);
      assert.equal(store.state.jobs[2].result.pages.length, 2);
    } else {
      assert.equal(second, null);
      assert.equal(
        store.state.jobs[1].status,
        scenario === "empty" ? "skipped" : "blocked",
      );
      if (scenario === "timeout") {
        assert.equal(store.state.jobs[0].status, "unknown");
        assert.equal(store.state.devices[0].state, "quarantined");
      }
      assert.deepEqual(paths, ["/api/state", "/api/state", "/api/search"]);
    }
  });
}
