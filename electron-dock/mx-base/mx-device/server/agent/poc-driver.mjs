// PocDriver (V2-6 P0): the Driver SPI (plan §7.4) over the XHS PoC that
// runs on each phone, at level L0 — the PoC is used as it is (plan §7.5):
//
// - preflight: the PoC must report ok and isBusy: false before a lease is
//   accepted; otherwise the lease is refused and the work goes back
//   (nothing was sent).
// - execute: one GET per command; then the answer is checked (search: type,
//   keyword, page, count, ids; note: the id of the requested link) and the
//   state is read again: if another caller's work replaced ours in between,
//   that is an external insertion. Any mismatch, a 504 or a timeout throws,
//   the center records unknown and quarantines; nothing is retried.
// - capabilities are declared honestly: XHS only, three commands, stop only
//   between commands, no abort, no fencing, no reset.
//
// The PoC origin of each phone lives in the Agent's config only; the center
// never calls a PoC. Origins are host-local (http://127.0.0.1:<port>).
import { COMMANDS } from "../workflow-catalog.mjs";

export const POC_LEVEL = "L0";
// Registry command -> PoC operation.
export const POC_COMMANDS = {
  "xhs.search": "search",
  "xhs.search.next": "next",
  "xhs.note.detail": "note",
};
// The PoC waits up to 25 s itself; leave room for the HTTP round trip.
export const POC_CALL_TIMEOUT_MS = 35000;
const STATE_TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;

const fail = (code, message, evidence) =>
  Object.assign(new Error(message), { code, evidence });
const NOTE_PREFIX =
  /^https:\/\/www\.xiaohongshu\.com\/(explore|discovery\/item)\/[0-9a-zA-Z]+/;
/** A note link for a target: links pass through, bare ids become links. */
export function noteInput(target) {
  if (typeof target === "string" && NOTE_PREFIX.test(target)) return target;
  if (typeof target === "string" && /^[0-9a-zA-Z]{1,64}$/.test(target))
    return `https://www.xiaohongshu.com/explore/${target}`;
  throw fail("input", "详情目标须为小红书笔记链接或笔记 ID");
}
const noteIdOf = (link) => new URL(link).pathname.split("/")[2];
const outputOf = (code) => COMMANDS.find((c) => c.code === code)?.outputSchema;
/** Keeps exactly the fields an output schema declares (receipts must match). */
function project(value, schema) {
  if (!schema || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => project(v, schema.items));
  return Object.fromEntries(
    Object.keys(schema.properties || {})
      .filter((k) => value[k] !== undefined)
      .map((k) => [k, project(value[k], schema.properties[k])]),
  );
}
const summary = (s) =>
  s && {
    type: s.type ?? null,
    keyword: s.keyword ?? null,
    page: s.page ?? null,
    count: s.count ?? null,
    isBusy: typeof s.isBusy === "boolean" ? s.isBusy : null,
    status: typeof s.status === "string" ? s.status.slice(0, 120) : null,
    detailId: s.detail?.id ?? null,
  };

export class PocDriver {
  /** origins: { [serial]: "http://127.0.0.1:18081" }. */
  constructor({
    origins = {},
    fetch = globalThis.fetch,
    callTimeoutMs = POC_CALL_TIMEOUT_MS,
    clock = Date.now,
  } = {}) {
    this.kind = "poc";
    this.level = POC_LEVEL;
    // Set from the center's hello answer. Realms never mix: the simulation
    // realm drives only a PoC simulator, the real realm never one. Before
    // the center has said which, nothing is driven.
    this.realm = null;
    Object.assign(this, { origins, fetchImpl: fetch, callTimeoutMs, clock });
    this.busy = new Set();
  }
  capabilities(device) {
    return {
      apps: ["xhs"],
      commands: Object.keys(POC_COMMANDS),
      canCancel: true, // between commands (safe points)
      canAbort: false, // a PoC request in flight cannot be stopped
      canFence: false, // L0: other callers cannot be refused
      canReset: false, // no home/back endpoint
      level: this.level,
      origin: this.origins[device.serial] ? "configured" : "missing",
    };
  }
  timeoutMs() {
    return this.callTimeoutMs;
  }
  async #get(serial, path, { timeoutMs, signal } = {}) {
    const origin = this.origins[serial];
    if (!origin) throw fail("device-fault", "未配置该手机的 PoC 地址");
    // A plain timer (AbortSignal.timeout would not keep a process alive).
    const limit = new AbortController();
    const timer = setTimeout(
      () =>
        limit.abort(
          Object.assign(new Error("timeout"), { name: "TimeoutError" }),
        ),
      timeoutMs,
    );
    let res, text;
    try {
      res = await this.fetchImpl(new URL(path, origin), {
        signal: signal ? AbortSignal.any([signal, limit.signal]) : limit.signal,
        redirect: "error",
        headers: { accept: "application/json" },
      });
      // The body is read under the same deadline.
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    if (text.length > MAX_BYTES) throw fail("mismatch", "PoC 响应过大");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw fail("mismatch", "PoC 响应不是 JSON");
    }
    return { status: res.status, body };
  }
  async #state(serial) {
    const { status, body } = await this.#get(serial, "/api/state", {
      timeoutMs: STATE_TIMEOUT_MS,
    });
    return status === 200 && body?.ok === true ? body : null;
  }
  /** Read-only health: reachable, idle as the PoC reports it. */
  async probe(device) {
    try {
      const s = await this.#state(device.serial);
      return {
        reachable: !!s,
        idle: s?.isBusy === false,
        simulator: s?.simulator === true,
        foreground: null,
        poc: summary(s),
      };
    } catch {
      return { reachable: false, idle: false, foreground: null };
    }
  }
  /** Before a lease: the PoC must be reachable and report itself idle, and
   * be what the realm allows (sim: a PoC simulator; real: never one). */
  async preflight(device) {
    const health = await this.probe(device);
    if (health.reachable && this.realm === "sim" && !health.simulator)
      return {
        idle: false,
        reason: "模拟域只能连接 PoC 模拟器；真实 PoC 须在真实域接入",
      };
    if (health.reachable && this.realm === "real" && health.simulator)
      return {
        idle: false,
        reason: "真实设备不得连接 PoC 模拟器；模拟器只能在模拟域使用",
      };
    if (health.reachable && !["sim", "real"].includes(this.realm))
      return { idle: false, reason: "尚未从设备中心得知所属域，不执行" };
    return {
      idle: health.reachable && health.idle && !this.busy.has(device.serial),
      reason: !health.reachable
        ? "PoC 不可达"
        : !health.idle
          ? "PoC 报告忙或状态未知"
          : this.busy.has(device.serial)
            ? "本 Agent 正在执行"
            : null,
    };
  }
  async execute(cmd, { serial, seq, token, signal }) {
    if (this.busy.has(serial)) throw fail("busy", "设备忙");
    const op = POC_COMMANDS[cmd.code];
    if (!op) throw fail("capability", `PoC 不支持指令 ${cmd.code}`);
    this.busy.add(serial);
    const startedAt = this.clock();
    try {
      const expectedPage =
        op === "search" ? 1 : op === "next" ? cmd.page : null;
      let path;
      if (op === "search")
        path = `/api/search?keyword=${encodeURIComponent(cmd.params.keyword)}`;
      else if (op === "next") path = "/api/next";
      else
        path = `/api/note?input=${encodeURIComponent(noteInput(cmd.params.target))}`;
      let answer;
      try {
        answer = await this.#get(serial, path, {
          timeoutMs: this.callTimeoutMs,
          signal,
        });
      } catch (error) {
        // Sent but not answered: the phone may have done it.
        throw fail(
          "timeout",
          error.code === "device-fault" ? error.message : "PoC 未在时限内答复",
        );
      }
      const { status, body } = answer;
      if (status !== 200 || body?.ok !== true || body.isBusy === true)
        throw fail(
          status === 504 ? "timeout" : "mismatch",
          `PoC 未确认完成（HTTP ${status}${body?.error ? ` ${body.error}` : ""}）`,
          { status, error: body?.error ?? null },
        );
      let result;
      if (op === "note") {
        const id = noteIdOf(noteInput(cmd.params.target));
        if (body.detail?.id !== id)
          throw fail("mismatch", "详情 ID 与请求的笔记不一致", summary(body));
        result = {
          target: cmd.params.target,
          fullText: String(body.detail.content || ""),
          complete: !!body.detail.content,
        };
      } else {
        if (
          body.type !== "search" ||
          body.keyword !==
            (op === "search" ? cmd.params.keyword : body.keyword) ||
          body.page !== expectedPage ||
          !Array.isArray(body.items) ||
          body.count !== body.items.length ||
          !body.items.every((i) => typeof i?.id === "string" && i.id)
        )
          throw fail(
            "mismatch",
            "搜索结果的关键词、页码或条数与请求不一致",
            summary(body),
          );
        if (
          op === "next" &&
          cmd.params.keyword &&
          body.keyword !== cmd.params.keyword
        )
          throw fail("mismatch", "翻页结果属于另一个搜索", summary(body));
        result = { keyword: body.keyword, page: body.page, items: body.items };
      }
      // L0: nothing tells calls apart, so check that ours is still the
      // PoC's latest work. Anything else means another caller came in.
      const after = await this.#state(serial).catch(() => null);
      const ours =
        after &&
        (op === "note"
          ? after.detail?.id === body.detail.id
          : after.keyword === body.keyword && after.page === body.page);
      if (!ours)
        throw fail(
          "mismatch",
          "执行后 PoC 状态已被其他调用改变（疑似外部插入）",
          {
            answer: summary(body),
            after: summary(after),
          },
        );
      return {
        commandId: cmd.id,
        jobId: cmd.jobId,
        attemptId: cmd.attemptId,
        deviceId: cmd.deviceId,
        appId: cmd.appId,
        code: cmd.code,
        stepIndex: cmd.stepIndex,
        ...(cmd.commandVersion === undefined
          ? {}
          : { commandVersion: cmd.commandVersion }),
        seq,
        token,
        stopped: true,
        source: "poc",
        result: project(
          result,
          cmd.definition?.outputSchema || outputOf(cmd.code),
        ),
        evidence: {
          level: this.level,
          op,
          // What /api/state said after the call; the center voids a real
          // phone's receipt that came from a PoC simulator.
          simulator: after.simulator === true,
          startedAt,
          finishedAt: this.clock(),
          answer: summary(body),
          after: summary(after),
          hasMore: typeof body.hasMore === "boolean" ? body.hasMore : null,
        },
      };
    } finally {
      this.busy.delete(serial);
    }
  }
  /** Stop at a safe point: nothing in flight between commands. */
  async stop({ serial }) {
    return { safePoint: !this.busy.has(serial), at: this.clock() };
  }
}
