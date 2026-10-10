import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createApplicationSso } from "@qpjoy/mx-common/identity/sso";
import { PostgresSsoStore } from "@qpjoy/mx-common/identity/postgres";
import { SsoError } from "@qpjoy/mx-common/identity/http";
const reads = new Set([
  "/session",
  "/me/overview",
  "/api-keys",
  "/tenants",
  "/consumers",
  "/usage",
  "/documentation",
  "/commerce/products",
]);
export function permittedCustomerRoute(method, path) {
  return (
    method === "GET" &&
    (reads.has(path) || /^\/commerce\/tenants\/[0-9a-f-]{36}$/.test(path))
  );
}
export function createHarborApp({
  config,
  pool,
  sso: injectedSso,
  resolveDependencies = () => config,
  fetch: fetcher = fetch,
  staticRoot = resolve("dist/web"),
}) {
  let cachedSso, cachedProfile;
  function ssoFor(integration) {
    if (config.preview) return null;
    if (injectedSso) return injectedSso;
    if (!integration.sso) return null;
    const profile = JSON.stringify(integration.sso);
    if (profile !== cachedProfile) {
      cachedSso = createApplicationSso({
        settings: integration.sso,
        store: new PostgresSsoStore(pool, integration.sso.sessionKey),
        applicationName: "数港",
        navigation: { mounts: ["/"] },
      });
      cachedProfile = profile;
    }
    return cachedSso;
  }
  return async (req, res) => {
    const id = randomUUID();
    res.setHeader("x-request-id", id);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    const json = (status, value) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/health" && req.method === "GET")
        return json(200, {
          service: "mx-harbor",
          mode: config.preview ? "preview" : "production",
        });
      if (url.pathname === "/ready" && req.method === "GET") {
        if (!config.preview)
          await pool.query(
            "SELECT 1 FROM app_auth.browser_sso_records LIMIT 0",
          );
        return json(config.preview ? 503 : 200, { ready: !config.preview });
      }
      if (url.pathname === "/status" && req.method === "GET")
        return json(200, {
          service: "mx-harbor",
          dependencies: resolveDependencies().dependencies,
        });
      if (config.preview && url.pathname === "/auth/sso/session")
        return json(200, { active: false, preview: true });
      if (url.pathname.startsWith("/auth/sso/")) {
        const sso = ssoFor(resolveDependencies());
        if (!sso)
          throw new SsoError(503, "auth_unavailable", "账号服务尚未配置。");
        if (await sso.handle(req, res, url)) return;
        throw new SsoError(404, "not_found", "接口不存在。");
      }
      if (url.pathname.startsWith("/bff/v1/")) {
        const path = url.pathname.slice("/bff/v1".length);
        if (!permittedCustomerRoute(req.method, path))
          throw new SsoError(404, "not_found", "此客户功能尚未开放。");
        const integration = resolveDependencies(),
          sso = ssoFor(integration);
        if (!sso)
          throw new SsoError(503, "service_unavailable", "客户服务尚未配置。");
        const session = await sso.sessionFor(req);
        if (!session) throw new SsoError(401, "login_required", "请先登录。");
        await sso.verifySession(session, true);
        if (!integration.upstream || !integration.gatewayToken)
          throw new SsoError(
            503,
            "customer_service_unavailable",
            "客户服务尚未接入，请稍后重试。",
          );
        const upstream = await fetcher(
          `${integration.upstream}/internal/v1/portal${path}${url.search}`,
          {
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: {
              authorization: `Bearer ${session.accessToken}`,
              "x-mx-harbor-subject": session.subject,
              "x-mx-harbor-gateway": integration.gatewayToken,
              "x-request-id": id,
            },
          },
        );
        const payload = await upstream.json();
        if (!upstream.ok)
          return json(upstream.status, {
            code: payload.error?.code || "customer_service_error",
            message:
              upstream.status >= 500
                ? "客户服务暂不可用，请稍后重试。"
                : payload.error?.message ||
                  payload.message ||
                  "无权访问此服务。",
          });
        if (path === "/documentation" && payload.data?.schema) {
          payload.data.schema = {
            ...payload.data.schema,
            info: { ...payload.data.schema.info, title: "Data Harbor API" },
            servers: [{ url: integration.sso.origin + "/api/v1" }],
          };
          payload.data.html = null;
        }
        return json(200, payload);
      }
      // API forwarding is enabled only by the dedicated nginx compatibility route; never proxy Admin paths here.
      if (
        req.method !== "GET" ||
        url.pathname.startsWith("/internal/") ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/bff/")
      )
        throw new SsoError(404, "not_found", "接口不存在。");
      const asset =
        url.pathname === "/" ||
        ["/pricing", "/payment/return"].includes(url.pathname)
          ? "index.html"
          : decodeURIComponent(url.pathname).slice(1);
      const file = resolve(staticRoot, asset);
      if (!file.startsWith(resolve(staticRoot) + sep))
        throw new SsoError(404, "not_found", "页面不存在。");
      if (asset.startsWith("demos/") && !config.preview)
        throw new SsoError(404, "not_found", "页面不存在。");
      const content = await readFile(file),
        mime =
          {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".webp": "image/webp",
            ".woff2": "font/woff2",
          }[extname(file)] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": mime,
        "cache-control": asset.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      res.end(content);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(error.code === "ENOENT" ? 404 : error.status || 503, {
        code:
          error.code === "ENOENT"
            ? "not_found"
            : error.code || "service_unavailable",
        message:
          error instanceof SsoError
            ? error.message
            : error.code === "ENOENT"
              ? "页面不存在。"
              : "服务暂不可用，请稍后重试。",
        requestId: id,
      });
    }
  };
}
