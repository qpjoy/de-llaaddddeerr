// Use existing authenticated job APIs. No browser ever calls the phone endpoint.
export async function submitJob(send, mode, body) {
  const { followup, ...spec } = body;
  if (
    followup &&
    (mode !== "real" ||
      spec.operation !== "search" ||
      Number(spec.pages) !== 1 ||
      spec.confirmed !== true)
  )
    throw new Error("真机演示仅支持已确认的一页搜索与详情");
  const job = await send("jobs", mode, spec);
  if (!followup) return job;
  try {
    const detail = await send("jobs", mode, {
      key: `${spec.key}:detail`,
      operation: "note",
      deviceId: spec.deviceId,
      sourceJobId: job.id,
      priority: spec.priority,
      confirmed: true,
    });
    return { search: job, detail };
  } catch {
    // Two durable API writes, not an atomic batch. Keep the form/key for safe replay.
    throw new Error(
      `搜索任务 ${job.id} 已入池，但详情提交未确认。请保留弹窗，以相同参数重试；不要另建重复搜索。`,
    );
  }
}
