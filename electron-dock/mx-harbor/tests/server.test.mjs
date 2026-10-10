import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createHarborApp,
  permittedCustomerRoute,
} from "../apps/server/app.mjs";
import { workload } from "../deploy/k8s/render.mjs";
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
  for (const method of ["POST", "DELETE", "PUT"])
    assert.equal(permittedCustomerRoute(method, "/session"), false);
});
