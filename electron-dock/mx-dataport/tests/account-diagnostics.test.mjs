import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHarborApp } from "../apps/server/app.mjs";

test("managed account failures retain safe diagnostics and never forward private upstream messages", async (t) => {
  let code = "dataport_accounts_not_configured";
  const server = createServer(
    createHarborApp({
      config: {
        upstream: "http://hub.internal:18151",
        gatewayToken: "server-only",
        sso: { origin: "https://dataport.example.test" },
      },
      sso: {
        sessionFor: async () => ({
          csrf: "fixture-csrf",
          subject: "fixture-member",
          accessToken: "private-token",
        }),
        verifySession: async () => {},
        checkOrigin: () => {},
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code,
              message:
                "private upstream path /run/secrets and credential details",
            },
          }),
          { status: 503 },
        ),
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  for (const [value, message] of [
    ["dataport_accounts_not_configured", /完成配置/],
    ["dataport_accounts_invalid_config", /凭据配置无效/],
    ["dataport_accounts_unconfirmed", /重试原操作/],
    ["unknown_private_failure", /客户服务暂不可用/],
  ]) {
    code = value;
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/bff/v1/enterprises/11111111-1111-4111-8111-111111111111/members`,
      {
        method: "POST",
        headers: {
          "x-mx-csrf": "fixture-csrf",
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: "create" }),
      },
    );
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.code, code);
    assert.match(payload.message, message);
    assert.equal(payload.requestId, response.headers.get("x-request-id"));
    assert.doesNotMatch(
      payload.message,
      /private|\/run|credential details|token/,
    );
    if (code !== "unknown_private_failure")
      assert.ok(payload.message.includes(payload.requestId));
  }
});
