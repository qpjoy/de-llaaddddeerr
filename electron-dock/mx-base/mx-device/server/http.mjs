import { createServer } from "node:http";
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
} from "./model.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};
async function body(req) {
  let text = "";
  for await (const part of req) {
    text += part;
    if (Buffer.byteLength(text) > 32768) throw new Fault("请求过大", 413);
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Fault("无效 JSON", 400);
  }
}
const summarize = (s) => ({
  ...s,
  devices: s.devices.map(publicDevice),
  jobs: s.jobs.map(({ result, ...j }) => j),
  attempts: s.attempts.map(({ result, lateEvidence, checkpoints, ...a }) => a),
});

export function createApp({ store, cfg, staticRoot = resolve("dist") }) {
  const failures = new Map(),
    probeRequests = new Map();
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
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
      if (req.method === "POST") {
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
      if (path.startsWith("/api/")) {
        const who = role(req);
        if (!who) throw new Fault("请先登录设备中心", 401);
        if (path === "/api/session") return json(res, 200, { role: who });
        const mode = realm(url.searchParams.get("mode") || "sim");
        if (who === "test" && mode !== "sim")
          throw new Fault("测试凭证仅允许模拟模式", 403);
        if (path === "/api/state" && req.method === "GET")
          return json(res, 200, summarize(await store.snapshot(mode)));
        const peripheral = path.match(
          /^\/api\/devices\/([^/]+)\/(observer|capture|frame|session)$/,
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
            action === "capture" ? 202 : 200,
            await store.atomic(
              (s, n) =>
                action === "observer"
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
            await store.atomic((s, n) => scenario(s, n, b.kind, b.key), {
              mode,
              key: `${b.key}:1`,
            }),
          );
        }
        if (path === "/api/devices" && req.method === "POST") {
          const b = await body(req);
          return json(
            res,
            201,
            await store.atomic((s, n) => register(s, n, mode, b), { mode }),
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
          // Probe is durable work claimed by the HOST worker, not an API-server HTTP request.
          const d = (await store.snapshot(mode)).devices.find(
            (d) => d.id === id,
          );
          if (!d) throw new Fault("设备不存在", 404);
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
                if (row.revision !== b.revision)
                  throw new Fault("设备状态已变化");
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
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new Fault("不支持的方法", 405);
      const rel =
        path === "/"
          ? "index.html"
          : decodeURIComponent(path).replace(/^\//, "");
      const file = resolve(staticRoot, rel);
      if (!file.startsWith(staticRoot + "/"))
        throw new Fault("路径不可访问", 403);
      const bytes = await readFile(file).catch(() => null);
      if (!bytes) throw new Fault("页面不存在", 404);
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
    } catch (e) {
      json(res, e.status || 503, {
        error:
          e instanceof Fault ? e.message : "服务暂不可用；未自动重试设备操作",
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
