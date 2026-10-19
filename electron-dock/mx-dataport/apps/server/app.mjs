import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { createApplicationSso } from "@qpjoy/mx-common/identity/sso";
import { PostgresSsoStore } from "@qpjoy/mx-common/identity/postgres";
import { SsoError, equal, readSsoJson } from "@qpjoy/mx-common/identity/http";
import { createLocalAuth, localToken, localOrigin } from "./local-auth.mjs";
const reads = new Set([
  "/session",
  "/me/usage",
  "/documentation",
  "/commerce/products",
  "/payments/return-order",
]);
export function permittedCustomerRoute(method, path) {
  const enterprise = /^\/enterprises\/[0-9a-f-]{36}\/(.*)$/.exec(path);
  if (enterprise)
    return method === "GET"
      ? /^(roles|members|tickets|audit|history|keys|subscriptions|billing|query-access|tickets\/[0-9a-f-]{36})$/.test(
          enterprise[1],
        )
      : method === "POST" &&
          /^(profile|roles|members|tickets|query|keys|subscription-selection|orders|members\/[0-9a-f-]{36}(?:\/(?:initial-password|reset-password))?|keys\/[0-9a-f-]{36}\/revoke|orders\/[0-9a-f-]{36}\/(?:checkout|refresh))$/.test(
            enterprise[1],
          );
  if (/^\/joins\/[A-Za-z0-9_-]{43}$/.test(path))
    return ["GET", "POST"].includes(method);
  return (
    (method === "GET" &&
      (reads.has(path) ||
        /^\/commerce\/tenants\/[0-9a-f-]{36}\/messages$/.test(path))) ||
    (method === "POST" &&
      /^\/commerce\/tenants\/[0-9a-f-]{36}\/messages\/(?:[1-9][0-9]{0,17}\/read|read-all)$/.test(
        path,
      ))
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
  const localAuth = createLocalAuth(fetcher);
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
        navigation: { mounts: ["/"], applicationForm: true },
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
      if (!config.preview && await localAuth.handle(req,res,url,resolveDependencies(),json)) return;
      if (
        req.method === "GET" &&
        url.pathname === "/bff/v1/catalog" &&
        !url.search
      ) {
        const integration = resolveDependencies();
        if (!integration.upstream || !integration.gatewayToken)
          throw new SsoError(
            503,
            "catalog_unavailable",
            "套餐信息暂不可用，请稍后重试。",
          );
        const upstream = await fetcher(
          `${integration.upstream}/internal/v1/portal/catalog`,
          {
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: {
              "x-mx-harbor-gateway": integration.gatewayToken,
              "x-request-id": id,
            },
          },
        );
        if (!upstream.ok)
          throw new SsoError(
            503,
            "catalog_unavailable",
            "套餐信息暂不可用，请稍后重试。",
          );
        return json(200, await upstream.json());
      }
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
        const integration = resolveDependencies();
        const token = localToken(req);
        const sso = token ? null : ssoFor(integration);
        if (!sso && !token)
          throw new SsoError(503, "service_unavailable", "客户服务尚未配置。");
        const localSession = token ? await localAuth.session(integration,req) : null;
        const session = localSession ? { csrf:localSession.csrf,subject:`dataport:${localSession.account}` } : await sso.sessionFor(req);
        if (!session) throw new SsoError(401, "login_required", "请先登录。");
        if (!token) await sso.verifySession(session, true);
        let body;
        if (req.method === "POST") {
          if (token) localOrigin(req,integration); else sso.checkOrigin(req);
          if (!session.csrf || !equal(session.csrf, req.headers["x-mx-csrf"]))
            throw new SsoError(
              403,
              "sso_csrf",
              "页面会话已变化，请刷新后重试。",
            );
          if (
            !/^application\/json(?:\s*;|$)/i.test(
              req.headers["content-type"] || "",
            )
          )
            throw new SsoError(
              415,
              "invalid_content_type",
              "请使用 JSON 请求。",
            );
          body = JSON.stringify(
            await readSsoJson(req, path.endsWith("/tickets") ? 32768 : 8192),
          );
        }
        if (!integration.upstream || !integration.gatewayToken)
          throw new SsoError(
            503,
            "customer_service_unavailable",
            "客户服务尚未接入，请稍后重试。",
          );
        const upstream = await fetcher(
          `${integration.upstream}/internal/v1/portal${path}${url.search}`,
          {
            method: req.method,
            body,
            redirect: "error",
            signal: AbortSignal.timeout(
              path.endsWith("/query") ? 120000 : 15000,
            ),
            headers: {
              ...(token ? {"x-mx-dataport-local-session":token,"x-mx-csrf":session.csrf} : {authorization:`Bearer ${session.accessToken}`,"x-mx-harbor-subject":session.subject}),
              "x-mx-harbor-gateway": integration.gatewayToken,
              "x-mx-dataport-session": createHmac(
                "sha256",
                integration.gatewayToken,
              )
                .update(`${session.subject}:${session.csrf}`)
                .digest("hex"),
              "x-request-id": id,
              ...(body ? { "content-type": "application/json" } : {}),
              ...(req.headers["idempotency-key"]
                ? { "idempotency-key": String(req.headers["idempotency-key"]) }
                : {}),
            },
          },
        );
        // A missing fixed session route means the Portal is not deployed (or
        // points at the wrong listener), not that the browser is anonymous.
        if (path === "/session" && upstream.status === 404)
          return json(503, {
            code: "customer_session_unavailable",
            message: "客户空间服务尚未就绪，请联系管理员完成服务接入。",
            requestId: id,
          });
        let payload;
        try {
          payload = await upstream.json();
        } catch {
          throw new SsoError(
            503,
            "customer_service_invalid_response",
            "客户服务响应异常，请稍后重试。",
          );
        }
        if (!upstream.ok) {
          const code =
            payload.error?.code || payload.code || "customer_service_error";
          // Fixed, public-safe diagnostics. Never forward arbitrary 5xx bodies.
          const accountMessages = {
            dataport_accounts_not_configured:
              "员工账号服务尚未就绪，请联系管理员完成配置。",
            dataport_accounts_invalid_config:
              "托管子账号凭据配置无效，请联系管理员检查。",
            dataport_accounts_unconfirmed:
              "账号操作结果尚未确认，请保留当前表单，核对员工列表后重试原操作。",
            dataport_accounts_unavailable:
              "员工账号服务暂不可用，请联系管理员检查。",
          };
          const accountMessage =
            upstream.status >= 500 &&
            typeof code === "string" &&
            Object.hasOwn(accountMessages, code)
              ? accountMessages[code]
              : undefined;
          return json(upstream.status, {
            code,
            message: accountMessage
              ? `${accountMessage}（请求编号：${id}）`
              : upstream.status >= 500
                ? "客户服务暂不可用，请稍后重试。"
                : payload.error?.message ||
                  payload.message ||
                  "无权访问此服务。",
            requestId: id,
          });
        }
        if (path === "/documentation" && payload.data?.schema) {
          payload.data.schema = {
            ...payload.data.schema,
            info: { ...payload.data.schema.info, title: "DataPort API" },
            servers: [{ url: integration.sso.origin + "/api/v1" }],
          };
          payload.data.html = null;
        }
        return json(upstream.status, payload);
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
        [
          "/pricing",
          "/payment/return",
          "/privacy",
          "/terms",
          "/cookies",
          "/join",
        ].includes(url.pathname)
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
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
