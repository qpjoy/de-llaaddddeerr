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
test("BFF fails closed without identity and does not expose administration or payment mutations", async (t) => {
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
      base + "/bff/v1/documentation?path=%2Fdocs%2Fopenapi.json",
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
  assert.doesNotMatch(body, /server-only|hub.invalid|MX Insight Hub/);
  assert.deepEqual(JSON.parse(body).data.schema.servers, [
    { url: "https://harbor.example.test/api/v1" },
  ]);
  assert.equal(JSON.parse(body).data.html, null);
  active = false;
  assert.equal((await fetch(base + "/bff/v1/session")).status, 401);
  assert.equal(requests.length, 1);
  active = true;
  revoked = true;
  assert.equal((await fetch(base + "/bff/v1/session")).status, 401);
  assert.equal(requests.length, 1);
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
  writeFileSync(join(root, "index.html"), "<h1>Data Harbor</h1>");
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
  assert.equal((await fetch(base + "/")).status, 200);
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

test("Hub network failure is retried on the next authorized request without restarting Harbor", async (t) => {
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

test("invalid core configuration still prevents startup", () => {
  for (const env of [
    {},
    { MX_HARBOR_DATABASE_URL: "postgres://localhost/mx_insight_hub" },
    {
      MX_HARBOR_DATABASE_URL: "postgres://localhost/mx_harbor",
      MX_HARBOR_PORT: "bad",
    },
  ])
    assert.throws(() => readConfig(env), /Invalid Harbor database/);
});
