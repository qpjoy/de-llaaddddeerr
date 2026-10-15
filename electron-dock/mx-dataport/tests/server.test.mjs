import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createHarborApp,
  permittedCustomerRoute,
} from "../apps/server/app.mjs";
import { workload } from "../deploy/k8s/render.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readConfig,
  readDependencies,
  DEFAULT_HUB_ORIGIN,
} from "../apps/server/config.mjs";
import { readApplicationSsoProfile } from "@qpjoy/mx-common/identity/profile";
const fixture = async (t, options) => {
  const server = createServer(createHarborApp(options));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
};
test("BFF fails closed without identity and does not expose administration", async (t) => {
  let calls = 0;
  const base = await fixture(t, {
    config: { preview: true },
    fetch: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  assert.equal((await fetch(base + "/bff/v1/session")).status, 503);
  for (const path of [
    "/internal/v1/admin/session",
    "/bff/v1/runtime",
    "/bff/v1/commerce/delivery",
    "/api/v1/private",
    "/%2e%2e/%2e%2e/etc/passwd",
  ])
    assert.equal((await fetch(base + path)).status, 404, path);
  assert.equal(
    (
      await fetch(base + "/bff/v1/commerce/products", {
        method: "POST",
        body: "{}",
      })
    ).status,
    404,
  );
  assert.equal(calls, 0);
  assert.equal((await fetch(base + "/ready")).status, 503);
  assert.equal(
    (await (await fetch(base + "/auth/sso/session")).json()).active,
    false,
  );
});
test("customer writes require a fresh session, exact origin and CSRF and preserve purchase identity", async (t) => {
  const tenant = "11111111-1111-4111-8111-111111111111",
    origin = "https://harbor.example.test";
  const calls = [];
  let active = true,
    verified = 0;
  const base = await fixture(t, {
    config: {
      upstream: "http://hub.internal:18151",
      gatewayToken: "server-only",
      sso: { origin },
    },
    sso: {
      sessionFor: async () =>
        active
          ? {
              csrf: "csrf-fixture",
              accessToken: "server-token",
              subject: "member",
            }
          : null,
      verifySession: async () => {
        verified++;
      },
      checkOrigin: (req) => {
        if (
          req.headers.origin !== origin ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          throw Object.assign(Error("origin"), { status: 403 });
      },
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: { id: "existing-order" } }), {
        status: 201,
      });
    },
  });
  const headers = {
    origin,
    "content-type": "application/json",
    "x-mx-csrf": "csrf-fixture",
    "idempotency-key": "original-intent",
  };
  const path = `/bff/v1/enterprises/${tenant}/orders`;
  const body = JSON.stringify({
    sku: "annual",
    revision: 1,
    environment: "live",
  });
  for (const override of [
    { origin: "https://other.test" },
    { "x-mx-csrf": "" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      (
        await fetch(base + path, {
          method: "POST",
          headers: { ...headers, ...override },
          body,
        })
      ).status,
      403,
    );
  assert.equal(calls.length, 0);
  assert.equal(
    (await fetch(base + path, { method: "POST", headers, body: "[]" })).status,
    400,
  );
  const response = await fetch(base + path, { method: "POST", headers, body });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body, body);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["idempotency-key"], "original-intent");
  assert.equal(calls[0].options.headers.authorization, "Bearer server-token");
  assert.equal(calls[0].options.headers["x-mx-csrf"], undefined);
  assert.match(calls[0].options.headers["x-mx-dataport-session"], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(await response.text(), /server-token|server-only/);
  const messagePath = `/bff/v1/commerce/tenants/${tenant}/messages/1/read`;
  assert.equal((await fetch(base + messagePath, {method: "POST", headers: {...headers, "x-mx-csrf": ""}, body: "{}"})).status, 403);
  assert.equal((await fetch(base + messagePath, {method: "POST", headers, body: "{}"})).status, 201);
  assert.equal(calls[1].url, `http://hub.internal:18151/internal/v1/portal/commerce/tenants/${tenant}/messages/1/read`);
  const ticketBody=JSON.stringify({content:"问题".repeat(2500),category:"technical"});
  assert.equal((await fetch(base+`/bff/v1/enterprises/${tenant}/tickets`,{method:"POST",headers,body:ticketBody})).status,201);
  assert.equal(calls[2].options.body,ticketBody);
  active = false;
  assert.equal(
    (await fetch(base + path, { method: "POST", headers, body })).status,
    401,
  );
  assert.equal(calls.length, 3);
  assert.equal(verified, 8);
  for (const forbidden of [
    "/commerce/delivery",
    `/commerce/tenants/${tenant}/acceptance-orders`,
    "/payments/integration/live/activate",
    "/api-keys/anything/reveal",
    "/notifications",
    `/commerce/tenants/${tenant}/messages`,
    `/commerce/tenants/${tenant}/messages/1/delete`,
  ])
    assert.equal(permittedCustomerRoute("POST", forbidden), false);
});
test("BFF fresh verification, fixed upstream credential, no browser secret and branded OpenAPI", async (t) => {
  let verified = 0,
    requests = [],
    active = true,
    revoked = false;
  const config = {
    sso: { origin: "https://harbor.example.test" },
    upstream: "http://hub.internal:18151",
    gatewayToken: "server-only-gateway",
  };
  const sso = {
    sessionFor: async () =>
      active ? { subject: "user-a", accessToken: "server-only-access" } : null,
    verifySession: async (_session, fresh) => {
      assert.equal(fresh, true);
      verified++;
      if (revoked) throw Object.assign(Error(), { status: 401 });
    },
    handle: async () => false,
  };
  const base = await fixture(t, {
    config,
    sso,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          data: {
            schema: {
              info: { title: "MX Insight Hub API" },
              servers: [{ url: "https://hub.invalid/api/v1" }],
              paths: { "/data/ip/risk/service": {} },
            },
            html: "private docs",
          },
        }),
      );
    },
  });
  const response = await fetch(
      base + "/bff/v1/documentation?path=%2Fdocs%2Fopenapi.json&tenantId=11111111-1111-4111-8111-111111111111",
      {
        headers: {
          "x-mx-harbor-subject": "attacker",
          "x-mx-harbor-gateway": "attacker",
          authorization: "Bearer attacker",
        },
      },
    ),
    body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(verified, 1);
  assert.equal(requests[0].options.headers["x-mx-harbor-subject"], "user-a");
  assert.equal(
    requests[0].options.headers.authorization,
    "Bearer server-only-access",
  );
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(new URL(requests[0].url).origin, config.upstream);
  assert.equal(new URL(requests[0].url).searchParams.get("tenantId"), "11111111-1111-4111-8111-111111111111");
  assert.doesNotMatch(body, /server-only|hub.invalid|MX Insight Hub/);
  assert.deepEqual(JSON.parse(body).data.schema.servers, [
    { url: "https://harbor.example.test/api/v1" },
  ]);
  assert.equal(JSON.parse(body).data.html, null);
  const listPath = "/bff/v1/enterprises/11111111-1111-4111-8111-111111111111/billing?page=6&pageSize=20";
  assert.equal((await fetch(base + listPath)).status, 200);
  assert.equal(requests[1].url, config.upstream + listPath.replace("/bff/v1/", "/internal/v1/portal/"));
  assert.equal(verified, 2);
  active = false;
  assert.equal((await fetch(base + "/bff/v1/session")).status, 401);
  assert.equal(requests.length, 2);
  active = true;
  revoked = true;
  assert.equal((await fetch(base + "/bff/v1/session")).status, 401);
  assert.equal(requests.length, 2);
});
test("migration job has only database credentials, immutable image and no service links or token mount", () => {
  const job = workload({
      node: "test-node",
      image: "mx-harbor:unique",
      job: "mx-harbor-migrate-test",
    }),
    pod = job.spec.template.spec;
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers[0].env.length, 1);
  assert.equal(pod.containers[0].env[0].name, "MX_HARBOR_DATABASE_URL");
  assert.equal(pod.containers[0].envFrom, undefined);
  assert.equal(pod.volumes, undefined);
  const deploy = workload({ node: "test-node", image: "mx-harbor:unique" });
  assert.equal(deploy.spec.strategy.type, "Recreate");
  assert.equal(
    deploy.spec.template.spec.containers[0].ports[0].hostIP,
    "127.0.0.1",
  );
  assert.equal(
    deploy.spec.template.spec.containers[0].imagePullPolicy,
    "Never",
  );
  const web = deploy.spec.template.spec;
  assert.equal(web.volumes[0].secret.optional, true);
  assert.ok(
    web.volumes[0].secret.items.some((item) => item.path === "gateway-token"),
  );
  assert.ok(
    !web.containers[0].env.some(
      (item) => item.name === "MX_HARBOR_GATEWAY_TOKEN",
    ),
  );
  assert.ok(!web.containers[0].volumeMounts[0].subPath);
  for (const method of ["POST", "DELETE", "PUT"])
    assert.equal(permittedCustomerRoute(method, "/session"), false);
});

test("production readiness depends on the migrated database, not external enrollment", async (t) => {
  let failed = false;
  const root = mkdtempSync(join(tmpdir(), "harbor-static-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "index.html"), "<h1>Data DataPort</h1>");
  const base = await fixture(t, {
    config: readConfig({
      MX_HARBOR_DATABASE_URL: "postgres://test:test@localhost/mx_harbor_test",
    }),
    resolveDependencies: () => readDependencies({}, readApplicationSsoProfile),
    pool: {
      query: async (sql) => {
        assert.match(sql, /app_auth.browser_sso_records/);
        if (failed) throw Error("database unavailable");
      },
    },
    staticRoot: root,
  });
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /img-src 'self' data: https:\/\/tile\.openstreetmap\.org;/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self';/);
  assert.match(csp, /frame-src 'none';/);
  assert.equal((await fetch(base + "/ready")).status, 200);
  for (const route of [
    "/auth/sso/login",
    "/auth/sso/form",
    "/auth/sso/session",
    "/bff/v1/session",
  ])
    assert.equal((await fetch(base + route)).status, 503, route);
  const status = await (await fetch(base + "/status")).json();
  assert.deepEqual(status.dependencies, { auth: "pending", hub: "pending" });
  assert.doesNotMatch(JSON.stringify(status), /postgres|svc.cluster|secret/);
  failed = true;
  assert.equal((await fetch(base + "/ready")).status, 503);
  assert.equal((await fetch(base + "/health")).status, 200);
});

test("running application discovers newly projected SSO and gateway files, and fails closed on removal or invalid config", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "harbor-enrollment-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    MX_HARBOR_SSO_PROFILE: join(root, "profile.json"),
    MX_HARBOR_GATEWAY_TOKEN_FILE: join(root, "gateway-token"),
  };
  const base = await fixture(t, {
    config: { preview: false },
    pool: {},
    resolveDependencies: () => readDependencies(env, readApplicationSsoProfile),
  });
  assert.equal((await fetch(base + "/auth/sso/session")).status, 503);
  writeFileSync(
    env.MX_HARBOR_SSO_PROFILE,
    JSON.stringify({
      appId: "mx-harbor",
      origin: "https://harbor.example.test",
      issuer: "https://auth.example.test/identity",
      clientId: "harbor",
      clientSecret: "s".repeat(43),
      audience: "mx-harbor",
      sessionKey: "k".repeat(43),
    }),
    { mode: 0o600 },
  );
  writeFileSync(env.MX_HARBOR_GATEWAY_TOKEN_FILE, "g".repeat(43), {
    mode: 0o600,
  });
  const session = await fetch(base + "/auth/sso/session");
  assert.equal(session.status, 200);
  assert.equal((await session.json()).active, false);
  assert.equal((await fetch(base + "/bff/v1/session")).status, 401);
  assert.deepEqual(
    (await (await fetch(base + "/status")).json()).dependencies,
    { auth: "configured", hub: "configured" },
  );
  writeFileSync(
    env.MX_HARBOR_SSO_PROFILE,
    '{"clientSecret":"sensitive-malformed',
  );
  assert.equal((await fetch(base + "/auth/sso/session")).status, 503);
  const invalid = await (await fetch(base + "/status")).text();
  assert.doesNotMatch(invalid, /sensitive|clientSecret/);
  assert.equal(JSON.parse(invalid).dependencies.auth, "invalid");
  rmSync(env.MX_HARBOR_SSO_PROFILE);
  rmSync(env.MX_HARBOR_GATEWAY_TOKEN_FILE);
  assert.equal((await fetch(base + "/auth/sso/session")).status, 503);
  assert.deepEqual(
    (await (await fetch(base + "/status")).json()).dependencies,
    { auth: "pending", hub: "pending" },
  );
});

test("Hub network failure is retried on the next authorized request without restarting DataPort", async (t) => {
  let available = false,
    enrolled = false,
    verified = 0,
    calls = 0;
  const base = await fixture(t, {
    config: { preview: false },
    resolveDependencies: () => ({
      upstream: DEFAULT_HUB_ORIGIN,
      gatewayToken: enrolled ? "g".repeat(43) : null,
    }),
    sso: {
      sessionFor: async () => ({
        subject: "test",
        accessToken: "private-access",
      }),
      verifySession: async () => {
        verified++;
      },
    },
    fetch: async (url) => {
      calls++;
      assert.equal(new URL(url).origin, DEFAULT_HUB_ORIGIN);
      if (!available) throw Error("DNS unavailable");
      return new Response(JSON.stringify({ data: { ok: true } }));
    },
  });
  assert.equal((await fetch(base + "/bff/v1/session")).status, 503);
  assert.equal(calls, 0);
  enrolled = true;
  assert.equal((await fetch(base + "/bff/v1/session")).status, 503);
  available = true;
  assert.equal((await fetch(base + "/bff/v1/session")).status, 200);
  assert.equal(verified, 3);
  assert.equal(calls, 2);
});

test("missing Portal session is a customer dependency failure and keeps diagnostics without leaking upstream content", async (t) => {
  let response = new Response("<h1>private-hub-host</h1>", { status: 404 });
  let verified = 0;
  const base = await fixture(t, {
    config: {
      upstream: "http://hub.internal:18151",
      gatewayToken: "fixture-gateway",
    },
    sso: {
      sessionFor: async () => ({
        subject: "registered-user",
        accessToken: "private-token",
      }),
      verifySession: async () => {
        verified++;
      },
    },
    fetch: async () => response,
  });
  const missing = await fetch(base + "/bff/v1/session");
  const payload = await missing.json();
  assert.equal(missing.status, 503);
  assert.equal(payload.code, "customer_session_unavailable");
  assert.equal(payload.requestId, missing.headers.get("x-request-id"));
  assert.doesNotMatch(JSON.stringify(payload), /private|hub\.internal|token/);
  response = new Response(
    JSON.stringify({
      error: { code: "member_suspended", message: "账号已停用" },
    }),
    { status: 403 },
  );
  const forbidden = await fetch(base + "/bff/v1/session");
  assert.equal(
    forbidden.status,
    403,
    "permission failures are not softened into successful customer sessions",
  );
  assert.equal((await forbidden.json()).code, "member_suspended");
  response = new Response("<h1>private-gateway-detail</h1>", { status: 502 });
  const invalid = await fetch(base + "/bff/v1/session");
  assert.equal(invalid.status, 503);
  assert.equal(
    (await invalid.json()).code,
    "customer_service_invalid_response",
  );
  response = new Response(
    JSON.stringify({ data: { memberId: "member-fixture" } }),
  );
  assert.equal(
    (await fetch(base + "/bff/v1/session")).status,
    200,
    "the next request recovers without a new login",
  );
  assert.equal(verified, 4);
});

test("invalid core configuration still prevents startup", () => {
  for (const env of [
    {},
    { MX_HARBOR_DATABASE_URL: "postgres://localhost/mx_insight_hub" },
    {
      MX_HARBOR_DATABASE_URL: "postgres://localhost/mx_harbor",
      MX_HARBOR_PORT: "bad",
    },
  ])
    assert.throws(() => readConfig(env), /Invalid DataPort database/);
});


test("public catalog forwards only server credentials and cannot bypass customer authentication", async t => {
  const calls=[];
  const base=await fixture(t,{config:{upstream:"http://hub.internal:18151",gatewayToken:"server-only"},fetch:async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify({data:{items:[{sku:"basic",amountMinor:399900}]}}));
  }});
  const response=await fetch(base+"/bff/v1/catalog",{headers:{authorization:"Bearer attacker","x-mx-harbor-subject":"attacker","x-mx-harbor-gateway":"attacker"}});
  assert.equal(response.status,200);assert.equal((await response.json()).data.items.length,1);
  assert.equal(calls[0].url,"http://hub.internal:18151/internal/v1/portal/catalog");
  assert.equal(calls[0].options.headers["x-mx-harbor-gateway"],"server-only");
  assert.equal(calls[0].options.headers.authorization,undefined);assert.equal(calls[0].options.headers["x-mx-harbor-subject"],undefined);
  for(const path of ["/bff/v1/catalog?admin=1","/bff/v1/commerce/products","/bff/v1/session"])
    assert.notEqual((await fetch(base+path)).status,200);
  assert.notEqual((await fetch(base+"/bff/v1/catalog",{method:"POST"})).status,200);
  assert.equal(calls.length,1);
});
