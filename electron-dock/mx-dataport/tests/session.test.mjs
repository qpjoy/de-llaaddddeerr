import test from "node:test";
import assert from "node:assert/strict";
import { loadHarborSession } from "../apps/web/session.ts";
import { request } from "../apps/web/api.ts";

test("identity and permissions share a bounded refresh; timeouts preserve the right authentication state and retry diagnostics", async () => {
  const signals = [];
  const timeout = () => { throw new DOMException("fixture timeout", "TimeoutError"); };
  const failedIdentity = await loadHarborSession(async (path, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    timeout();
  });
  assert.equal(failedIdentity.active, null);
  assert.equal(failedIdentity.issue.code, "session_timeout");
  assert.match(failedIdentity.issue.message, /重试连接/);
  const failedPermissions = await loadHarborSession(async (path, options) => {
    signals.push(options.signal);
    if (path === "/auth/sso/session") return { active: true, csrf: "fresh-csrf" };
    timeout();
  });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(failedPermissions.active, true);
  assert.equal(failedPermissions.csrf, "fresh-csrf");
  assert.equal(failedPermissions.customer, null);
  assert.equal(failedPermissions.issue.code, "session_timeout");
});

test("a registered SSO identity stays signed in when the customer session route is missing", async () => {
  const calls = [];
  const state = await loadHarborSession(async (path) => {
    calls.push(path);
    if (path === "/auth/sso/session")
      return { active: true, csrf: "fixture-csrf" };
    throw Object.assign(Error("Route not found"), {
      status: 404,
      code: "not_found",
      requestId: "fixture-request",
    });
  });
  assert.deepEqual(calls, ["/auth/sso/session", "/bff/v1/session"]);
  assert.equal(state.active, true);
  assert.equal(state.csrf, "fixture-csrf");
  assert.equal(
    state.customer,
    null,
    "failed permissions never become an empty or privileged customer",
  );
  assert.equal(state.issue.requestId, "fixture-request");
});

test("authentication unavailable, anonymous and explicitly revoked sessions remain distinct", async () => {
  const unavailable = await loadHarborSession(async () => {
    throw Error("identity offline");
  });
  assert.equal(unavailable.active, null);
  assert.equal(unavailable.customer, null);
  assert.ok(unavailable.issue);
  const anonymous = await loadHarborSession(async (path) => {
    assert.equal(
      path,
      "/auth/sso/session",
      "anonymous visitors never call the customer API",
    );
    return { active: false };
  });
  assert.equal(anonymous.active, false);
  assert.equal(anonymous.issue, null);
  const revoked = await loadHarborSession(async (path) => {
    if (path === "/auth/sso/session") return { active: true, csrf: "old-csrf" };
    throw Object.assign(Error("session revoked"), {
      status: 401,
      code: "sso_session_invalid",
    });
  });
  assert.equal(revoked.active, false);
  assert.equal(revoked.customer, null);
  assert.equal(revoked.csrf, "");
});

test("customer gateway errors do not expire authentication and retry reads the actual shared permissions", async () => {
  let available = false;
  const customer = {
    memberId: "member-fixture",
    displayName: "邀请用户",
    tenantIds: ["space-fixture"],
    memberships: [{
      tenantId: "space-fixture", role: "viewer",
      dataport: { permissions: ["history.read"], ownerChallengeRequired: false },
    }],
    platformAdmin: false,
  };
  const read = async (path) => {
    if (path === "/auth/sso/session")
      return { active: true, csrf: "fixture-csrf" };
    if (!available)
      throw Object.assign(Error("gateway unavailable"), {
        status: 401,
        code: "portal_auth_required",
      });
    return { data: customer };
  };
  const failed = await loadHarborSession(read);
  assert.equal(failed.active, true);
  assert.equal(failed.customer, null);
  available = true;
  const recovered = await loadHarborSession(read);
  assert.equal(recovered.active, true);
  assert.deepEqual(recovered.customer, customer);
  assert.equal(recovered.issue, null);
});

test("malformed successful responses do not fabricate a login or customer permissions", async () => {
  assert.equal((await loadHarborSession(async () => ({}))).active, null);
  const result = await loadHarborSession(async (path) =>
    path === "/auth/sso/session" ? { active: true } : { data: {} },
  );
  assert.equal(result.active, true);
  assert.equal(result.customer, null);
  assert.ok(result.issue);
});

test("old Hub owner sessions are service failures, retain diagnostics and recover after Hub is updated", async () => {
  const owner = {
    tenantIds: ["space-fixture"],
    memberships: [{ tenantId: "space-fixture", role: "owner", capabilities: ["membership.write", "usage.read"] }],
  };
  const read = async path => path === "/auth/sso/session"
    ? { active: true, csrf: "same-csrf" }
    : { data: owner, requestId: "hub-request" };
  const old = await loadHarborSession(read);
  assert.equal(old.active, true);
  assert.equal(old.csrf, "same-csrf");
  assert.equal(old.customer, null);
  assert.equal(old.issue.code, "customer_permissions_unavailable");
  assert.equal(old.issue.requestId, "hub-request");
  owner.memberships[0].dataport = { permissions: [], ownerChallengeRequired: true };
  const pending = await loadHarborSession(read);
  assert.equal(pending.customer.memberships[0].dataport.ownerChallengeRequired, true);
  assert.equal(pending.issue, null);
  owner.memberships[0].dataport = { permissions: ["history.read", "members.read"], ownerChallengeRequired: false };
  const ready = await loadHarborSession(read);
  assert.deepEqual(ready.customer, owner);
  assert.equal(ready.issue, null);
});

test("incomplete permission contracts fail closed while real empty permissions and join-only sessions remain valid", async () => {
  for (const dataport of [null, {}, { permissions: [] }, { permissions: [null], ownerChallengeRequired: false }, { permissions: ["history.read"], ownerChallengeRequired: "false" }]) {
    const result = await loadHarborSession(async path => path === "/auth/sso/session"
      ? { active: true }
      : { data: { tenantIds: ["space"], memberships: [{ tenantId: "space", role: "owner", dataport }] } });
    assert.equal(result.active, true);
    assert.equal(result.customer, null);
    assert.equal(result.issue.code, "customer_permissions_unavailable");
  }
  const empty = { tenantIds: ["space"], memberships: [{ tenantId: "space", role: "viewer", dataport: { permissions: [], ownerChallengeRequired: false } }] };
  const joinOnly = { tenantIds: [], memberships: [] };
  for (const customer of [empty, joinOnly]) {
    const result = await loadHarborSession(async path => path === "/auth/sso/session" ? { active: true } : { data: customer });
    assert.deepEqual(result.customer, customer);
    assert.equal(result.issue, null);
  }
  const missing = await loadHarborSession(async path => path === "/auth/sso/session" ? { active: true } : { data: { tenantIds: ["space"], memberships: [] } });
  assert.equal(missing.customer, null);
  assert.equal(missing.issue.code, "customer_permissions_unavailable");
});

test("request errors retain only diagnostic identifiers and handle HTML gateway failures", async (t) => {
  let response = new Response(
    JSON.stringify({
      code: "customer_session_unavailable",
      message: "服务未就绪",
      requestId: "fixture-request",
    }),
    { status: 503 },
  );
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(request("/bff/v1/session"), {
    status: 503,
    code: "customer_session_unavailable",
    requestId: "fixture-request",
  });
  response = new Response("<h1>private-upstream-address</h1>", {
    status: 502,
    headers: { "x-request-id": "gateway-request" },
  });
  await assert.rejects(
    request("/bff/v1/session"),
    (error) =>
      error.status === 502 &&
      error.code === "invalid_response" &&
      error.requestId === "gateway-request" &&
      !error.message.includes("private-upstream"),
  );
});
