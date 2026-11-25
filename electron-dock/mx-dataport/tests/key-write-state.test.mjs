import test from "node:test";
import assert from "node:assert/strict";
import { request } from "../apps/web/api.ts";
import { keyCreationFailure } from "../apps/web/key-write-state.ts";

async function readFailure(fetcher) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  let failure;
  try {
    await request("/test/keys", { method: "POST", body: '{"name":"fixture"}' });
  } catch (error) {
    failure = keyCreationFailure(error);
  } finally {
    globalThis.fetch = previous;
  }
  assert.ok(failure, "expected a rejected creation");
  return failure;
}

test("subscription rejection gives the next step without claiming a Key might have been created", async () => {
  let writes = 0;
  const failure = await readFailure(async () => {
    writes++;
    return new Response(JSON.stringify({ error: { code: "subscription_required", message: "subscription required" } }), { status: 409 });
  });
  assert.equal(writes, 1);
  assert.equal(failure.unconfirmed, false);
  assert.match(failure.message, /我的订阅.*IP 风险画像/);
  assert.doesNotMatch(failure.message, /上次创建结果|核对 Key/);
});

test("explicit validation, permission and rate-limit rejections retain their clear response", async () => {
  for (const status of [400, 401, 403, 409, 429]) {
    const failure = await readFailure(async () => new Response('{"message":"explicit rejection"}', { status }));
    assert.deepEqual(failure, { unconfirmed: false, message: "explicit rejection" });
  }
});

test("lost, timed-out, server-error and malformed successful responses still require verification, without replay", async () => {
  for (const response of [null, new Response('{"message":"timeout"}', { status: 408 }), new Response('{"message":"unavailable"}', { status: 503 }), new Response("not JSON", { status: 200 })]) {
    let writes = 0;
    const failure = await readFailure(async () => {
      writes++;
      if (!response) throw new TypeError("connection lost");
      return response;
    });
    assert.equal(writes, 1);
    assert.equal(failure.unconfirmed, true);
    assert.match(failure.message, /核对 Key 列表.*勿直接重复签发/);
  }
});
