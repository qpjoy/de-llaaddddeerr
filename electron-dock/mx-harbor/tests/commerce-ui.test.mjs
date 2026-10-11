import test from "node:test";
import assert from "node:assert/strict";
import {
  checkoutLocation,
  currentSubscription,
  subscriptionState,
  hasCapability,
  purchaseIntent,
  paymentReturnTrade,
  queryIntent,
  portraitState,
} from "../apps/web/commerce-state.ts";

test("only current paid product subscriptions unlock; held calls consume availability", () => {
  const now = Date.parse("2026-10-11T00:00:00Z");
  const base = {
    id: "paid",
    channel: "product",
    startsAt: "2026-10-01",
    endsAt: "2027-10-01",
    quota: 100,
    used: 90,
    held: 10,
  };
  assert.equal(subscriptionState(base, now), "exhausted");
  assert.equal(subscriptionState({ ...base, held: 9 }, now), "active");
  assert.equal(
    subscriptionState({ ...base, endsAt: "2026-10-11" }, now),
    "expired",
  );
  assert.equal(
    subscriptionState({ ...base, startsAt: "2026-11-01" }, now),
    "future",
  );
  assert.equal(currentSubscription([], now), undefined);
  assert.equal(
    currentSubscription(
      [
        { ...base, channel: "baidu-v2" },
        { ...base, startsAt: "2026-11-01" },
      ],
      now,
    ),
    undefined,
  );
  assert.equal(currentSubscription([base], now).id, "paid");
});
test("query retries retain identity across reloads, and uncertain outcomes never mean a clear failure", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  const a = queryIntent(storage, "tenant:key:203.0.113.1");
  assert.equal(queryIntent(storage, "tenant:key:203.0.113.1").key, a.key);
  assert.notEqual(queryIntent(storage, "other:key:203.0.113.1").key, a.key);
  assert.notEqual(queryIntent(storage, "tenant:key:203.0.113.2").key, a.key);
  values.delete(a.name);
  assert.notEqual(queryIntent(storage, "tenant:key:203.0.113.1").key, a.key);
  assert.equal(portraitState({ status: 409 }), "unknown");
  assert.equal(
    portraitState({ error: { code: "ip_query_outcome_unknown" } }),
    "unknown",
  );
  assert.equal(
    portraitState({ response: { data: { status: "no_data" } } }),
    "no_data",
  );
  assert.equal(
    portraitState({ response: { error: { code: "invalid_ip" } } }),
    "error",
  );
});
test("purchase authority is evaluated for the selected space, never another membership or admin hint", () => {
  const session = {
    platformAdmin: true,
    memberships: [
      { tenantId: "a", capabilities: ["billing.read"] },
      { tenantId: "b", capabilities: ["apikey.write", "recharge.create"] },
    ],
  };
  assert.equal(hasCapability(session, "a", "apikey.write"), false);
  assert.equal(hasCapability(session, "b", "apikey.write"), true);
  assert.equal(hasCapability(session, "c", "recharge.create"), false);
});
test("uncertain purchase retries keep one identity across page reloads and separate tenants/products", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  const a = purchaseIntent(storage, "a:product:1");
  assert.equal(purchaseIntent(storage, "a:product:1").key, a.key);
  assert.notEqual(purchaseIntent(storage, "b:product:1").key, a.key);
  assert.notEqual(purchaseIntent(storage, "a:product:2").key, a.key);
  values.delete(a.name);
  assert.notEqual(purchaseIntent(storage, "a:product:1").key, a.key);
});
test("payment links stay on the environment's exact HTTPS checkout; returns are locators only", () => {
  assert.equal(
    checkoutLocation("https://openapi.alipay.com/gateway.do?fixture=1", "live"),
    "https://openapi.alipay.com/gateway.do?fixture=1",
  );
  for (const value of [
    "javascript:alert(1)",
    "http://openapi.alipay.com/gateway.do",
    "https://openapi.alipay.com.evil.test/gateway.do",
    "https://u:p@openapi.alipay.com/gateway.do",
    "https://openapi.alipay.com:444/gateway.do",
    "https://openapi.alipay.com/gateway.do#bad",
    "https://openapi.alipay.com/elsewhere",
    "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
  ])
    assert.throws(() => checkoutLocation(value, "live"));
  const trade = "MXP" + "a".repeat(32);
  assert.equal(
    paymentReturnTrade(
      `?method=alipay.trade.page.pay.return&out_trade_no=${trade}&status=paid&amount=1`,
    ),
    trade,
  );
  assert.equal(paymentReturnTrade(`?out_trade_no=${trade}&status=paid`), null);
  assert.equal(
    paymentReturnTrade(
      `?method=alipay.trade.page.pay.return&out_trade_no=${trade}&out_trade_no=${trade}`,
    ),
    null,
  );
});
