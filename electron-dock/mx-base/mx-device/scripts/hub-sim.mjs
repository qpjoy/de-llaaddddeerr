// A stand-in for Hub's backend, for local previews only (dev:sim --hub).
// It does what the real Hub would do on its side of the V2-5 contract:
// - reverse-proxies /ops/device-center/* and /customer/device-center/* to
//   mx-device's /embed/*, adding the caller key and the viewer's scope and
//   name on the server side (the browser holds no mx-device credential);
// - submits demo jobs through the Job API v1, asynchronously with a
//   callback and synchronously through the /wait long-poll;
// - receives callbacks, verifies their signature and dedupes delivery ids.
// Keys stay in this process' memory; nothing is printed or written.
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { verifySignature } from "../server/outbox.mjs";

const TEMPLATES = ["xhs.detail", "weibo.list", "xhs.list", "weibo.search"];
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export async function startHubSim({
  center,
  port,
  ops,
  customer,
  intervalMs = 6000,
}) {
  const callbacks = [],
    seen = new Set(),
    stats = { submitted: 0, rejected: 0, waited: 0, duplicates: 0, invalid: 0 };
  const personas = {
    ops: { key: ops.key, scope: "ops", user: "Hub 管理员" },
    customer: { key: customer.key, scope: "client", user: "客户 A · 王五" },
  };
  const proxy = (req, res, persona, rest) => {
    const upstream = new URL(`/embed/${rest}`, center);
    const headers = { ...req.headers };
    // Never forward what the browser claims about identity or scope.
    for (const name of Object.keys(headers))
      if (/^(authorization|cookie|host|x-mx-)/i.test(name))
        delete headers[name];
    Object.assign(headers, {
      authorization: `Bearer ${persona.key}`,
      "x-mx-embed-scope": persona.scope,
      "x-mx-embed-user": encodeURIComponent(persona.user),
    });
    const up = request(upstream, { method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.once("close", () => up.destroy());
    req.pipe(up);
  };
  const v1 = async (path, body) => {
    const res = await fetch(new URL(path, center), {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${customer.key}`,
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, value: await res.json() };
  };
  let n = 0;
  const submit = async () => {
    n++;
    const sync = n % 3 === 0;
    const r = await v1("/v1/jobs", {
      clientRequestId: `hub-demo-${Date.now()}-${n}`,
      template: TEMPLATES[n % TEMPLATES.length],
      params: { keyword: `Hub 主题 ${n}`, target: `note-${n}` },
      class: n % 5 === 0 ? "interactive" : n % 4 === 0 ? "batch" : "standard",
      ttlMs: 900000,
      ...(!sync && { callback: { url: `http://127.0.0.1:${port}/callbacks` } }),
    });
    if (r.status !== 202) {
      stats.rejected++;
      return;
    }
    stats.submitted++;
    // A synchronous Hub API wraps the long-poll.
    if (sync)
      for (let i = 0; i < 8; i++) {
        const w = await v1(`/v1/jobs/${r.value.jobId}/wait?timeout=25`);
        if (w.value.final) {
          stats.waited++;
          break;
        }
      }
  };
  const timer = setInterval(() => void submit().catch(() => {}), intervalMs);
  timer.unref();
  void submit().catch(() => {});

  const page =
    () => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>模拟 Hub · 设备中心接入</title>
<style>
body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;background:#f4f6fb;color:#172338}
header{background:#1c2b45;color:#fff;padding:14px 24px;font-weight:650}
main{max-width:980px;margin:0 auto;padding:20px 16px;display:grid;gap:16px}
section{background:#fff;border:1px solid #dce5ef;border-radius:10px;padding:16px 20px}
a{color:#087f79}table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid #eef2f6;padding:6px 8px;text-align:left}
code{font-size:12px}.ok{color:#1fa36b}.bad{color:#e5484d}
</style></head><body><header>模拟 Hub（仅本机预览）</header><main>
<section><h2>嵌入的设备中心</h2>
<p>浏览器只访问本 Hub；Hub 后端把 <code>/…/device-center/*</code> 转发到 mx-device 的 <code>/embed/*</code>，并在服务端加上调用方密钥和查看者作用域。</p>
<ul><li><a href="/ops/device-center/">Hub 管理员 · ops 作用域（只读工作台）</a></li>
<li><a href="/customer/device-center/">外部客户 · client 作用域（只看自己的任务）</a></li></ul></section>
<section><h2>Job API v1 调用</h2>
<p>每 ${Math.round(intervalMs / 1000)} 秒以「${escape(customer.name)}」提交一个模拟任务：三分之二异步（带回调），三分之一同步（<code>/wait</code> 长轮询）。</p>
<p>已提交 ${stats.submitted} · 被拒 ${stats.rejected} · 同步等到结果 ${stats.waited} · 收到回调 ${callbacks.length}（重复 ${stats.duplicates}，签名无效 ${stats.invalid}）</p></section>
<section><h2>最近回调</h2><table><tr><th>时间</th><th>投递 ID</th><th>任务</th><th>状态</th><th>签名</th></tr>
${callbacks
  .slice(-15)
  .reverse()
  .map(
    (c) =>
      `<tr><td>${new Date(c.at).toLocaleTimeString("zh-CN", { hour12: false })}</td><td><code>${escape(c.id.slice(0, 8))}…</code></td><td><code>${escape(c.request)}</code></td><td>${escape(c.status)} · ${escape(c.completion)}</td><td class="${c.valid ? "ok" : "bad"}">${c.valid ? "有效" : "无效"}</td></tr>`,
  )
  .join("")}</table></section></main></body></html>`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://hub.local");
    const prefix = url.pathname.match(
      /^\/(ops|customer)\/device-center(\/.*)?$/,
    );
    if (prefix) {
      if (!prefix[2]) {
        res.writeHead(308, { Location: `${url.pathname}/${url.search}` });
        return res.end();
      }
      return proxy(
        req,
        res,
        personas[prefix[1]],
        `${prefix[2].slice(1)}${url.search}`,
      );
    }
    if (url.pathname === "/callbacks" && req.method === "POST") {
      let body = "";
      for await (const part of req) body += part;
      const id = req.headers["x-mx-delivery-id"] || randomUUID();
      const valid = verifySignature(customer.callbackSecret, req.headers, body);
      if (!valid) stats.invalid++;
      if (seen.has(id)) stats.duplicates++;
      else if (valid) {
        seen.add(id);
        const payload = JSON.parse(body);
        callbacks.push({
          at: Date.now(),
          id,
          valid,
          request: payload.job.clientRequestId,
          status: payload.job.status,
          completion: payload.job.completion,
        });
        if (callbacks.length > 200) callbacks.shift();
      }
      res.writeHead(valid ? 204 : 401);
      return res.end();
    }
    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'",
      });
      return res.end(page());
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => {
      clearInterval(timer);
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}
