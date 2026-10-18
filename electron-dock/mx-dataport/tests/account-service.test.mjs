import test from "node:test";
import assert from "node:assert/strict";
import { accountSecretPlan } from "../scripts/account-service.mjs";

const secret = (data) => ({
  data: Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      Buffer.from(v).toString("base64"),
    ]),
  ),
});
const token = "dedicated-fixture-token-never-an-admin-token";
const key = "ab".repeat(32);
const auth = () => secret({ "account-token": token, "credential-key": key });
test("account configuration requires both explicit initialization and proven empty storage", () => {
  for (const options of [
    {},
    { initialize: true },
    { emptyStoreVerified: true },
  ])
    assert.throws(() => accountSecretPlan(options), /First install/);
  const plan = accountSecretPlan({
    initialize: true,
    emptyStoreVerified: true,
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].data["account-token"], plan[1].data["account-token"]);
  assert.equal(
    Buffer.from(plan[0].data["credential-key"], "base64").toString().length,
    64,
  );
  assert.equal(
    plan[1].data["credential-key"],
    undefined,
    "Hub must never receive the password encryption key",
  );
});
test("interrupted setup retains the exact Auth key and only fills a missing Hub Secret", () => {
  const retained = auth(),
    before = JSON.stringify(retained);
  const [hub] = accountSecretPlan({ auth: retained, initialize: true });
  assert.equal(JSON.stringify(retained), before);
  assert.equal(hub.data["account-token"], retained.data["account-token"]);
  assert.deepEqual(accountSecretPlan({ auth: retained, hub }), []);
  const files = secret({
    "account-token": token + "\n",
    "credential-key": key + "\n",
  });
  const [copied] = accountSecretPlan({ auth: files });
  assert.equal(
    copied.data["account-token"],
    files.data["account-token"],
    "retain file newline exactly; both runtime readers trim it",
  );
  assert.deepEqual(accountSecretPlan({ auth: files, hub: copied }), []);
});
test("lost keys, damaged retained secrets and inconsistent bridges never cause regeneration", () => {
  const [hub] = accountSecretPlan({ auth: auth() });
  assert.throws(
    () =>
      accountSecretPlan({
        auth: auth(),
        hub: {
          ...hub,
          data: {
            ...hub.data,
            "credential-key": Buffer.from(key).toString("base64"),
          },
        },
      }),
    /must not receive/,
  );
  assert.throws(
    () =>
      accountSecretPlan({ hub, initialize: true, emptyStoreVerified: true }),
    /restore Auth/,
  );
  for (const bad of [
    secret({ "account-token": token }),
    secret({ "account-token": "short", "credential-key": key }),
    secret({ "account-token": token, "credential-key": key + "zz" }),
  ])
    assert.throws(
      () =>
        accountSecretPlan({
          auth: bad,
          initialize: true,
          emptyStoreVerified: true,
        }),
      /invalid|missing/,
    );
  for (const changed of [
    {
      ...hub,
      data: {
        ...hub.data,
        "account-token": Buffer.from(
          "different-credential-1234567890123456789",
        ).toString("base64"),
      },
    },
    {
      ...hub,
      data: {
        ...hub.data,
        "account-origin": Buffer.from("https://another.example.test").toString(
          "base64",
        ),
      },
    },
  ])
    assert.throws(
      () => accountSecretPlan({ auth: auth(), hub: changed }),
      /differs/,
    );
});
