import test from "node:test";
import assert from "node:assert/strict";
import { loadAccountForm, navigateAfterLogin } from "../apps/web/api.ts";

test("successful login reloads the session even when the target is the current hash route", () => {
  for (const route of ["/#/intelligence", "/#/orders", "/"]) {
    const events = [];
    navigateAfterLogin("/#/intelligence", {
      href: `https://dataport.example.test${route}`,
      assign: () => assert.fail("same-document assignment would leave the anonymous session mounted"),
      reload: () => events.push("reload"),
    }, {
      replaceState: (state, title, url) => events.push(url),
    });
    assert.deepEqual(events, ["https://dataport.example.test/#/intelligence", "reload"]);
  }
});

test("login redirects that load another document retain the full authentication destination", () => {
  for (const redirect of ["/?account=ready#/intelligence", "https://auth.example.test/authorize?flow=fixture", "/auth/sso/callback?code=fixture"]) {
    let assigned;
    navigateAfterLogin(redirect, {
      href: "https://dataport.example.test/#/intelligence",
      assign: url => { assigned = url; },
      reload: () => assert.fail("must navigate to the authentication destination"),
    }, { replaceState: () => assert.fail("must preserve cross-document navigation") });
    assert.equal(assigned, new URL(redirect, "https://dataport.example.test").href);
  }
});

const failure = (status, code) =>
  Object.assign(Error("fixture failure"), { status, code });

for (const code of ["account_flow_expired", "account_request_failed"]) {
  test(`reconnect replaces an expired transaction from ${code}`, async () => {
    let starts = 0;
    const result = await loadAccountForm({
      register: true,
      canRestart: true,
      read: async () => {
        throw failure(410, code);
      },
      start: async (register) => {
        assert.equal(register, true);
        starts++;
        return { redirect: "https://auth.example.test/new-flow" };
      },
    });
    assert.equal(starts, 1);
    assert.equal(result.redirect, "https://auth.example.test/new-flow");
  });
}

test("a failed callback never redirects in a loop; closed dialogs do not create a flow", async () => {
  for (const guard of [
    { canRestart: false },
    { canRestart: true, current: () => false },
  ]) {
    await assert.rejects(
      loadAccountForm({
        ...guard,
        read: async () => {
          throw failure(410, "account_request_failed");
        },
        start: async () => assert.fail("must not create another flow"),
      }),
      { status: 410 },
    );
  }
});

test("connection failures are retried as reads; credentials and policy failures never trigger sign-in", async () => {
  for (const status of [401, 403, 409, 429, 503]) {
    await assert.rejects(
      loadAccountForm({
        canRestart: true,
        read: async () => {
          throw failure(status, "fixture_error");
        },
        start: async () => assert.fail("must not bypass the response"),
      }),
      { status },
    );
  }
  const options = {
    csrf: "new-csrf",
    formId: "new-form",
    policy: { mode: "invite_code", version: 2 },
  };
  assert.deepEqual(await loadAccountForm({ read: async () => options }), {
    options,
  });
});

test("a failing restart is reported without replay or further automatic attempts", async () => {
  let starts = 0;
  await assert.rejects(
    loadAccountForm({
      canRestart: true,
      read: async () => {
        throw failure(410, "account_request_failed");
      },
      start: async () => {
        starts++;
        throw failure(503, "account_unavailable");
      },
    }),
    { status: 503 },
  );
  assert.equal(starts, 1);
});
