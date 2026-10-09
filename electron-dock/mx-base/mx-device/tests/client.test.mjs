import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { requestId } from "../src/request-id.mjs";
import { submitJob } from "../src/submit-job.mjs";

test("request ID supports HTTP without randomUUID and retains UUID v4 entropy", () => {
  const httpCrypto = {
    getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
  };
  const ids = new Set(
    Array.from({ length: 1000 }, () => requestId(httpCrypto)),
  );
  assert.equal(ids.size, 1000);
  for (const id of ids)
    assert.match(
      id,
      /^[a-f0-9]{8}-(?:[a-f0-9]{4})-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  assert.equal(
    requestId({ getRandomValues: (bytes) => bytes.fill(0) }),
    "00000000-0000-4000-8000-000000000000",
  );
});
test("request ID preserves native Crypto binding and refuses insecure Math.random fallback", () => {
  const native = {
    randomUUID() {
      assert.equal(this, native);
      return "native-id";
    },
  };
  assert.equal(requestId(native), "native-id");
  assert.throws(() => requestId({}), /安全随机数/);
  assert.throws(() => requestId(null), /安全随机数/);
});
const demo = {
  key: "stable",
  operation: "search",
  keyword: "美食",
  pages: "1",
  deviceId: "selected-device",
  priority: "5",
  confirmed: true,
  followup: true,
};
test("real demo creates search then a same-device dependency; retains keys across partial failure", async () => {
  const records = new Map(),
    calls = [];
  let fail = true;
  const send = async (path, mode, body) => {
    assert.equal(path, "jobs");
    assert.equal(mode, "real");
    calls.push(body);
    if (body.operation === "note" && fail) {
      fail = false;
      throw Error("response lost");
    }
    if (!records.has(body.key))
      records.set(body.key, { ...body, id: `${body.key}-id` });
    return records.get(body.key);
  };
  await assert.rejects(
    submitJob(send, "real", demo),
    /搜索任务 stable-id 已入池/,
  );
  const result = await submitJob(send, "real", demo);
  assert.equal(records.size, 2);
  assert.equal(result.detail.sourceJobId, result.search.id);
  assert.equal(result.detail.deviceId, result.search.deviceId);
  assert.equal(result.detail.key, "stable:detail");
  assert.equal(result.detail.confirmed, true);
  assert.deepEqual(calls[0], calls[2]);
  assert.deepEqual(calls[1], calls[3]);
  assert(!("followup" in calls[0]));
});
test("real demo requires confirmation and one page before any request; normal jobs unchanged", async () => {
  let count = 0;
  const send = async () => {
    count++;
    return { id: "job" };
  };
  for (const body of [
    { ...demo, confirmed: false },
    { ...demo, pages: 2 },
    { ...demo, operation: "note" },
  ])
    await assert.rejects(submitJob(send, "real", body), /已确认的一页搜索/);
  await assert.rejects(submitJob(send, "sim", demo));
  assert.equal(count, 0);
  await submitJob(send, "sim", { key: "normal", operation: "search" });
  assert.equal(count, 1);
});
