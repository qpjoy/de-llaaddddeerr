// Hard per-client limits at claim time (V2-5). Pure; no imports from the model.

/** Running jobs per client id. */
export function clientRunning(state) {
  const counts = new Map();
  for (const j of state.jobs)
    if (j.client && j.status === "running")
      counts.set(j.client.id, (counts.get(j.client.id) || 0) + 1);
  return counts;
}
/** Why a client's queued job may not start now. counts: clientRunning(state),
 * computed once for read-only passes over an unchanged state. */
export function clientBlockers(state, job, counts) {
  if (!job.client) return [];
  const client = (state.clients || []).find((c) => c.id === job.client.id);
  if (!client) return [];
  const max = client.quotas?.maxInflight;
  if (max == null) return [];
  let running = counts?.get(client.id);
  if (running === undefined) {
    running = 0;
    for (const j of state.jobs)
      if (j.client?.id === client.id && j.status === "running") running++;
  }
  return running >= max
    ? [
        {
          code: "client-inflight",
          message: `调用方「${client.name}」并发已达上限（${running}/${max}）`,
        },
      ]
    : [];
}
