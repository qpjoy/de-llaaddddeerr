// Job result v1 (V2-5, plan §10): one envelope for every template, derived
// from the validated command receipts, and a JSON Schema per template version
// built from its commands' output schemas.
//
// completion: succeeded — every step validated; exhausted — succeeded, but
// the last list step returned nothing (the source ran out); partial — the job
// ended early with some validated read steps; none — nothing was collected.
import { expandDefinition } from "./workflow-input.mjs";

export const RESULT_SCHEMA = "mx-device.result.v1";
// Larger results are served page by page from /v1/jobs/:id/result.
export const INLINE_ITEMS = 200;
const FINAL = new Set([
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
  "expired",
  "blocked",
  "skipped",
]);
const NAVIGATION = new Set(["open", "home", "back", "restore"]);
const listsItems = (definition) =>
  !!definition?.outputSchema?.properties?.items;

/** Validated steps of a job: from its success result, else from the
 * succeeded commands (receipts) of its sessions. */
function validatedSteps(job, commands = []) {
  if (job.result?.steps)
    return job.result.steps.map((s) => ({
      ...s,
      completedAt:
        job.workflow?.receipts?.find((r) => r.stepIndex === s.stepIndex)
          ?.completedAt ?? null,
    }));
  return commands
    .filter(
      (c) =>
        c.jobId === job.id &&
        c.status === "succeeded" &&
        !c.restoring &&
        c.receipt?.result,
    )
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((c) => ({
      stepIndex: c.stepIndex,
      code: c.code,
      commandVersion: c.commandVersion,
      result: c.receipt.result,
      completedAt: c.completedAt ?? null,
    }));
}
const stepDefinition = (job, index) => job.workflow?.plan?.[index]?.definition;

/** succeeded | exhausted | partial | none. Works from the job alone (its
 * receipts) so a transaction can compute it without loading commands. */
export function resultCompletion(job, steps) {
  if (job.status === "succeeded") {
    const lists = (steps || validatedSteps(job)).filter((s) =>
      listsItems(stepDefinition(job, s.stepIndex)),
    );
    const last = lists.at(-1);
    return last &&
      Array.isArray(last.result?.items) &&
      !last.result.items.length
      ? "exhausted"
      : "succeeded";
  }
  const read = (job.workflow?.receipts || []).some(
    (r) => stepDefinition(job, r.stepIndex)?.effect === "read",
  );
  return read ? "partial" : "none";
}

/** The v1 result of a finished job; null while it is still live. */
export function jobResult(job, { commands = [], attempts = [] } = {}) {
  if (!FINAL.has(job.status)) return null;
  const steps = validatedSteps(job, commands);
  const items = [],
    records = [],
    pages = new Set();
  for (const step of steps) {
    const definition = stepDefinition(job, step.stepIndex);
    const r = step.result || {};
    if (Array.isArray(r.items)) {
      if (r.page != null) pages.add(r.page);
      for (const item of r.items)
        items.push({ ...item, page: r.page ?? null, step: step.stepIndex + 1 });
    } else if (!NAVIGATION.has(definition?.action))
      records.push({ step: step.stepIndex + 1, code: step.code, ...r });
  }
  const attempt = attempts
    .filter((a) => a.jobId === job.id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1);
  const plan = job.workflow?.plan || [];
  const times = steps.map((s) => s.completedAt).filter((t) => t != null);
  const inline = items.length <= INLINE_ITEMS;
  return {
    schema: RESULT_SCHEMA,
    realm: job.mode,
    jobId: job.id,
    attemptId: attempt?.id ?? null,
    template:
      job.client?.template ??
      `${job.workflow?.definitionId?.split(":")[1] ?? job.operation}@${job.workflow?.version ?? 1}`,
    collectedAt: job.completedAt ?? null,
    completion: resultCompletion(job, steps),
    counts: {
      steps: plan.length,
      completedSteps: steps.length,
      items: items.length,
      records: records.length,
      pages: pages.size,
    },
    items: inline ? items : items.slice(0, INLINE_ITEMS),
    resultRef: inline ? null : `/v1/jobs/${job.id}/result`,
    records,
    evidenceSummary: {
      source: job.mode === "sim" ? "simulator" : "device",
      validatedReceipts: steps.length,
      // Every command reported a verified stop before the next one began.
      allStopped:
        job.status === "succeeded" ? job.result?.stopped === true : null,
      commandCodes: [...new Set(steps.map((s) => s.code))],
      firstAt: times.length ? Math.min(...times) : null,
      lastAt: times.length ? Math.max(...times) : null,
    },
  };
}
/** All items of a large result, a page at a time. */
export function resultItems(
  job,
  { commands = [] } = {},
  offset = 0,
  limit = 200,
) {
  if (!FINAL.has(job.status)) return null;
  const all = [];
  for (const step of validatedSteps(job, commands)) {
    const r = step.result || {};
    if (Array.isArray(r.items))
      for (const item of r.items)
        all.push({ ...item, page: r.page ?? null, step: step.stepIndex + 1 });
  }
  return {
    total: all.length,
    offset,
    items: all.slice(offset, offset + limit),
  };
}

// ---- Template catalog (GET /v1/templates) ----

export const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    keyword: { type: "string", minLength: 1, maxLength: 200 },
    target: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
};
const withFields = (schema, fields) => ({
  ...schema,
  properties: { ...fields, ...(schema.properties || {}) },
  required: [...new Set([...Object.keys(fields), ...(schema.required || [])])],
});
const union = (schemas) => {
  const unique = [
    ...new Map(schemas.map((s) => [JSON.stringify(s), s])).values(),
  ];
  return unique.length === 1
    ? unique[0]
    : unique.length
      ? { anyOf: unique }
      : false;
};
/** The JSON Schema of one template version's v1 result. */
export function resultSchema(code, version, plan) {
  const itemSchemas = [],
    recordSchemas = [];
  for (const step of plan) {
    const d = step.definition;
    if (listsItems(d))
      itemSchemas.push(
        withFields(d.outputSchema.properties.items.items, {
          page: { type: ["integer", "null"], minimum: 1 },
          step: { type: "integer", minimum: 1 },
        }),
      );
    else if (!NAVIGATION.has(d.action))
      recordSchemas.push(
        withFields(d.outputSchema, {
          step: { type: "integer", minimum: 1 },
          code: { const: d.code },
        }),
      );
  }
  const nullable = (type) => ({ type: [type, "null"] });
  return {
    $id: `${RESULT_SCHEMA}/${code}@${version}`,
    type: "object",
    required: [
      "schema",
      "realm",
      "jobId",
      "attemptId",
      "template",
      "collectedAt",
      "completion",
      "counts",
      "items",
      "resultRef",
      "records",
      "evidenceSummary",
    ],
    properties: {
      schema: { const: RESULT_SCHEMA },
      realm: { enum: ["sim", "real"] },
      jobId: { type: "string", format: "uuid" },
      attemptId: { ...nullable("string"), format: "uuid" },
      template: { const: `${code}@${version}` },
      collectedAt: nullable("integer"),
      completion: { enum: ["succeeded", "exhausted", "partial", "none"] },
      counts: {
        type: "object",
        properties: Object.fromEntries(
          ["steps", "completedSteps", "items", "records", "pages"].map((k) => [
            k,
            { type: "integer", minimum: 0 },
          ]),
        ),
      },
      items: {
        type: "array",
        maxItems: INLINE_ITEMS,
        items: union(itemSchemas),
      },
      resultRef: nullable("string"),
      records: { type: "array", items: union(recordSchemas) },
      evidenceSummary: {
        type: "object",
        properties: {
          source: { enum: ["simulator", "device"] },
          validatedReceipts: { type: "integer", minimum: 0 },
          allStopped: { type: ["boolean", "null"] },
          commandCodes: { type: "array", items: { type: "string" } },
          firstAt: nullable("integer"),
          lastAt: nullable("integer"),
        },
      },
    },
  };
}
export function templateView(state, definition) {
  const plan = expandDefinition(state, definition);
  return {
    template: definition.code,
    version: definition.version,
    name: definition.name,
    appId: definition.appId,
    loop: definition.loop,
    steps: plan.length,
    estimateMs: plan.reduce((n, s) => n + (s.definition.estimateMs || 0), 0),
    params: PARAMS_SCHEMA,
    resultSchema: resultSchema(definition.code, definition.version, plan),
  };
}
