// Simulated phone screens (V2-6): what each platform shows for each command
// in flight or confirmed, and for each device state; platform-like synthetic
// receipts that still pass validation.
import test from "node:test";
import assert from "node:assert/strict";
import { screenModel, IDLE_LOCK_MS } from "../src/phone/screen-model.mjs";
import { enrich, feed } from "../src/phone/synth.mjs";
import { simulateCommand, validReceipt } from "../server/workflows.mjs";
import { COMMANDS } from "../server/workflow-catalog.mjs";
import { simTitle, demoKeyword } from "../server/sim-content.mjs";

const NOW = 1_800_000_000_000;
const device = {
  id: "d1",
  mode: "sim",
  simApps: ["xhs", "weibo", "xianyu", "pdd"],
};
const command = (code, extra = {}) => {
  const def = COMMANDS.find((c) => c.code === code);
  return {
    id: "c1",
    code,
    appId: def.appId || "xhs",
    definition: { name: def.name, action: def.action },
    params: { keyword: "露营装备", target: "note-1" },
    page: null,
    createdAt: NOW - 500,
    estimatedDurationMs: def.estimateMs,
    ...extra,
  };
};
const model = (extra) =>
  screenModel({ device, now: NOW, status: "running", ...extra });

test("idle phones lock after a while; home stays home", () => {
  assert.equal(
    screenModel({ device, now: NOW, status: "idle" }).surface,
    "lock",
  );
  const recent = {
    appId: "pdd",
    commandAction: "search",
    items: [],
    progressAt: NOW - 1000,
    observedAt: NOW - 1000,
    keyword: "充电宝",
  };
  assert.equal(
    screenModel({ device, now: NOW, status: "idle", projection: recent })
      .surface,
    "app",
  );
  const old = { ...recent, progressAt: NOW - IDLE_LOCK_MS - 1 };
  assert.equal(
    screenModel({ device, now: NOW, status: "idle", projection: old }).surface,
    "lock",
  );
  const home = {
    appId: "xhs",
    commandCode: "session.home",
    progressAt: NOW - IDLE_LOCK_MS - 1,
  };
  assert.equal(
    screenModel({ device, now: NOW, status: "idle", projection: home }).surface,
    "home",
  );
});

test("each command in flight has its own screen on every platform", () => {
  const job = { appId: "pdd", input: { keyword: "充电宝" } };
  assert.equal(model({ job, command: command("pdd.open") }).surface, "splash");
  const s = model({
    job,
    command: command("pdd.search", { params: { keyword: "充电宝" } }),
  });
  assert.deepEqual([s.surface, s.view, s.keyword], ["app", "search", "充电宝"]);
  assert(s.items.length >= 4, "suggestions on the search page");
  const next = model({ job, command: command("pdd.next", { page: 3 }) });
  assert.deepEqual([next.view, next.loadingPage], ["results", 3]);
  assert.equal(model({ job, command: command("pdd.scroll") }).scrolling, true);
  assert.equal(
    model({ job, command: command("pdd.refresh") }).refreshing,
    true,
  );
  const detail = model({ job, command: command("pdd.detail") });
  assert.deepEqual([detail.view, detail.loading], ["detail", true]);
  const ocr = model({ job, command: command("pdd.ocr") });
  assert.deepEqual([ocr.view, ocr.scanning], ["ocr", true]);
  assert.equal(model({ job, command: command("pdd.home") }).surface, "home");
  const like = model({
    job: { appId: "weibo" },
    command: command("weibo.like"),
  });
  assert.deepEqual([like.view, like.liking, !!like.hero], ["post", true, true]);
  assert.equal(
    model({ job: { appId: "xianyu" }, command: command("xianyu.refresh") })
      .appId,
    "xianyu",
  );
  // An in-flight command is labelled on screen.
  assert.equal(s.pending.action, "search");
});

test("confirmed receipts fill the screen; another App's leftovers do not", () => {
  const p = {
    appId: "pdd",
    commandAction: "detail",
    detail: {
      id: "g1",
      title: "充电宝 大容量",
      content: "正文",
      priceCents: 4990,
    },
    items: [],
    observedAt: NOW,
    progressAt: NOW,
  };
  const d = model({ projection: p, job: { appId: "pdd" } });
  assert.deepEqual(
    [d.view, d.detail.title, d.hero.price],
    ["detail", "充电宝 大容量", "49.9"],
  );
  const ocr = model({
    projection: { ...p, commandAction: "ocr", blocks: ["¥49.90", "包邮"] },
    job: { appId: "pdd" },
  });
  assert.deepEqual(ocr.blocks, ["¥49.90", "包邮"]);
  // A new XHS session must not show the PDD page.
  const fresh = model({ projection: p, job: { appId: "xhs" } });
  assert.deepEqual([fresh.appId, fresh.surface], ["xhs", "splash"]);
  // Toasts last a few seconds.
  const back = {
    appId: "pdd",
    commandAction: "back",
    items: [],
    progressAt: NOW - 500,
  };
  assert.equal(
    model({ projection: back, job: { appId: "pdd" } }).toast,
    "已返回上一页",
  );
  assert.equal(
    model({
      projection: { ...back, progressAt: NOW - 60000 },
      job: { appId: "pdd" },
    }).toast,
    null,
  );
});

test("device states cover the screen; PoC phones are not labelled synthetic", () => {
  const cooling = screenModel({
    device,
    now: NOW,
    status: "cooling",
    cooldownUntil: NOW + 28000,
  });
  assert.deepEqual(
    [cooling.overlay.title, cooling.overlay.note],
    ["App 冷却中", "剩余 28 秒"],
  );
  assert.equal(
    screenModel({ device, now: NOW, status: "quarantined" }).overlay.tone,
    "danger",
  );
  assert.equal(
    screenModel({ device, now: NOW, status: "suspect" }).overlay.title,
    "失联待确认",
  );
  const parked = model({
    attempt: { status: "yielded" },
    job: { appId: "xhs" },
  });
  assert.equal(parked.parked, true);
  const poc = screenModel({ device: { ...device, driver: "poc" }, now: NOW });
  assert.deepEqual([poc.synthetic, poc.source], [false, "poc"]);
  assert.equal(screenModel({ device, now: NOW }).synthetic, true);
});

test("synthetic content is deterministic and platform-like", () => {
  assert.equal(
    simTitle("xhs", "露营装备", 1, 1),
    simTitle("xhs", "露营装备", 1, 1),
  );
  assert.notEqual(
    simTitle("pdd", "充电宝", 1, 1),
    simTitle("weibo", "充电宝", 1, 1),
  );
  assert.match(
    simTitle("pdd", "演示关键词", 1, 1),
    /家居好物/,
    "a feed topic replaces the placeholder",
  );
  assert.equal(demoKeyword("pdd", 0), "充电宝");
  const a = enrich("xhs", "露营", { id: "x1", title: "t" });
  assert.deepEqual(a, enrich("xhs", "露营", { id: "x1", title: "t" }));
  assert.equal(a.glyph, "Tent");
  assert.equal(feed("weibo", "seed").length, 6);
  // Receipts made from it still pass the receipt checks.
  for (const code of [
    "xhs.search",
    "pdd.search",
    "pdd.detail",
    "pdd.ocr",
    "weibo.like",
  ]) {
    const def = COMMANDS.find((c) => c.code === code);
    const c = {
      id: "cmd-1",
      jobId: "j",
      attemptId: "a",
      deviceId: "d",
      appId: def.appId,
      code,
      stepIndex: 1,
      page: def.action === "search" ? 1 : null,
      params: { keyword: "充电宝", target: "g1" },
      definition: def,
    };
    const r = simulateCommand(c);
    assert(validReceipt(c, r), code);
    if (code === "pdd.search") {
      assert.equal(r.result.items.length, 6);
      assert(
        r.result.items.every(
          (i) => i.priceCents > 0 && i.title.includes("充电宝"),
        ),
      );
    }
  }
});
