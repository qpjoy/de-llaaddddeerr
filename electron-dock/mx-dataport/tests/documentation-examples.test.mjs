import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  documentOperations,
  requestExample,
  localResponseExample,
} from "../apps/web/documentation-model.ts";
const operation = {
  parameters: [
    {
      in: "header",
      name: "Idempotency-Key",
      required: true,
      schema: { type: "string" },
    },
  ],
  requestBody: {
    content: {
      "application/json": {
        example: { flag: true, value: null, text: 'quote " and 中文' },
      },
    },
  },
  responses: {
    200: {
      description: "ok",
      content: {
        "application/json": {
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    },
  },
};
const schema = { paths: { "/data/example": { post: operation } } };
const entry = documentOperations(schema)[0];
test("language examples preserve JSON types and safe strings, share the real path and identity headers", () => {
  const js = requestExample(
    schema,
    entry,
    "https://dataport.example.test",
    "javascript",
  );
  assert.match(js, /\/api\/v1\/data\/example/);
  assert.match(js, /process.env.HARBOR_API_KEY/);
  assert.match(js, /Idempotency-Key/);
  assert.doesNotThrow(() => new Function(`return async()=>{${js}}`));
  const py = requestExample(
    schema,
    entry,
    "https://dataport.example.test",
    "python",
  );
  const parsed = spawnSync(
    "python3",
    ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { input: py, encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(py, /json.loads/);
  assert.match(py, /os.environ/);
  assert.match(
    requestExample(schema, entry, "https://dataport.example.test", "curl"),
    /--data/,
  );
});
test("local demonstration is explicitly synthetic and returns only schema examples without dispatch", () => {
  assert.match(localResponseExample(schema, entry).notice, /不发送请求/);
  assert.deepEqual(localResponseExample(schema, entry).example, { ok: false });
  assert.equal(
    localResponseExample({}, { ...entry, operation: { responses: {} } })
      .example,
    null,
  );
});
