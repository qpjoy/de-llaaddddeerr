// A stand-in for the XHS PoC on one phone (V2-6 P0), following the HTTP
// contract documented for it (tests/poc-contract.test.mjs, docs §7.5):
//   GET /api/state                  current state, never side effects
//   GET /api/search?keyword=        new global search context, page 1
//   GET /api/next                   next page of the global context
//   GET /api/note?input=<note link> one note's detail
// Synchronous GETs with side effects, one request in flight, up to 25 s,
// 504 {ok:false,error:"timeout"} when the phone does not finish. A request
// cut by its client still completes on the "phone" (as a real one would).
//
// Faults for tests and drills (each a function of the operation, or a flag):
//   hang(op)      never answers; the PoC stays busy
//   timeout(op)   answers 504 after the work finished anyway
//   external(op)  another caller runs its own search right after this one
//   wrongPage(op) reports a page other than the one requested
//   stuckBusy     /api/state keeps reporting isBusy: true
// Synthetic content only; nothing here talks to a phone.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { hash, simDetailText, simTitle } from "../sim-content.mjs";

const PAGE_SIZE = 10;
const MAX_PAGES = 5;
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
export const noteLinkOf = (id) =>
  `https://www.xiaohongshu.com/explore/${id}?xsec_token=${hash(`token|${id}`).toString(36)}&xsec_source=app_search_result`;

export class PocSimulator {
  constructor({ delayMs = 600, faults = {}, name = "poc-sim" } = {}) {
    Object.assign(this, { delayMs, faults, name });
    this.state = {
      type: null,
      keyword: null,
      page: null,
      count: 0,
      hasMore: false,
      status: "空闲",
      items: [],
      detail: null,
    };
    this.inflight = null;
    this.calls = []; // audit: every request path, for tests
    this.fetch = this.fetch.bind(this);
  }
  #page(keyword, page) {
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => {
      const id = hash(`${this.name}|${keyword}|${page}|${i}`)
        .toString(16)
        .padStart(8, "0")
        .repeat(3);
      return {
        id,
        title: simTitle("xhs", keyword, page, i + 1),
        authorName: `作者${(hash(id) % 900) + 100}`,
        detailInput: noteLinkOf(id),
      };
    });
    return {
      type: "search",
      keyword,
      page,
      count: items.length,
      hasMore: page < MAX_PAGES,
      items,
      detail: null,
    };
  }
  /** The phone's work for one operation; updates the global context. */
  #work(op, url) {
    if (op === "search") {
      const keyword = url.searchParams.get("keyword") || "";
      return { ...this.#page(keyword, 1), status: `第 1 页完成` };
    }
    if (op === "next") {
      if (this.state.type !== "search" || !this.state.keyword)
        return { error: "no search context" };
      const page = this.state.page + 1;
      return {
        ...this.#page(this.state.keyword, page),
        status: `第 ${page} 页完成`,
      };
    }
    const link = url.searchParams.get("input") || "";
    let id;
    try {
      id = new URL(link).pathname.split("/")[2];
    } catch {
      return { error: "invalid input" };
    }
    return {
      ...this.state,
      type: "note",
      detail: {
        id,
        title: simTitle("xhs", this.state.keyword, 1, 0),
        content: simDetailText("xhs", id, this.state.keyword),
      },
      status: "详情完成",
    };
  }
  async #run(op, url) {
    const f = this.faults;
    this.state = {
      ...this.state,
      status: op === "note" ? "正在加载详情…" : "正在加载…",
    };
    if (f.hang?.(op)) await new Promise(() => {}); // the phone never finishes
    await sleep(this.delayMs);
    const next = this.#work(op, url);
    if (next.error)
      return { status: 400, body: { ok: false, error: next.error } };
    if (f.wrongPage?.(op) && next.page) next.page += 1;
    this.state = next;
    if (f.timeout?.(op))
      return {
        status: 504,
        body: { ok: false, error: "timeout", message: "25 seconds elapsed" },
      };
    const body = { ok: true, isBusy: false, ...next };
    // Someone else's search lands right after ours answered (an L0 PoC
    // cannot refuse it): our answer is intact, the global state is not.
    if (f.external?.(op))
      this.state = {
        ...this.#page("外部调用方的关键词", 1),
        status: "第 1 页完成",
      };
    return { status: 200, body };
  }
  async fetch(input, init = {}) {
    const url = new URL(input);
    const op = url.pathname.replace(/^\/api\//, "");
    this.calls.push(url.pathname);
    if (init.signal?.aborted) throw init.signal.reason;
    if (op === "state")
      return json(200, {
        ok: true,
        // Says what it is: a simulation-realm Agent only talks to this.
        simulator: true,
        isBusy: this.faults.stuckBusy ? true : !!this.inflight,
        ...this.state,
      });
    if (!["search", "next", "note"].includes(op))
      return json(404, { ok: false, error: "not found" });
    if (this.inflight)
      return json(409, { ok: false, isBusy: true, error: "busy" });
    const work = this.#run(op, url).finally(() => {
      this.inflight = null;
    });
    this.inflight = work;
    // The client may give up; the phone does not.
    const answer = await (init.signal
      ? Promise.race([
          work,
          new Promise((_, reject) =>
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              {
                once: true,
              },
            ),
          ),
        ])
      : work);
    return json(answer.status, answer.body);
  }
  /** Serves the same contract over HTTP (dev previews, agent:poc). */
  listen(port = 0, host = "127.0.0.1") {
    const server = createServer(async (req, res) => {
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      try {
        const answer = await this.fetch(`http://${host}${req.url}`, {
          signal: abort.signal,
        });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(await answer.text());
      } catch {
        if (!res.headersSent) res.writeHead(499).end();
      }
    });
    return new Promise((resolve) =>
      server.listen(port, host, () => resolve(server)),
    );
  }
}
