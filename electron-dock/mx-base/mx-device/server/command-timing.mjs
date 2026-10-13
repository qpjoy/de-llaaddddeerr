import { commandByCode } from "./workflow-catalog.mjs";

// Only validated simulation receipts train this bounded, per-device estimator.
// A model version/command code key prevents mixing incompatible command versions.
export function recordCommandTiming(device, command, completedAt) {
  if (device.mode !== "sim" || command.restoring) return;
  const elapsed = completedAt - command.createdAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 180000) return;
  const key = `${command.definitionId}/${command.code}`;
  device.commandTimings ||= {};
  const previous = device.commandTimings[key];
  const samples = [...(previous?.samples || []), elapsed].slice(-32);
  const sorted = [...samples].sort((a, b) => a - b);
  device.commandTimings[key] = {
    count: (previous?.count || 0) + 1,
    samples,
    meanMs: Math.round(
      previous ? previous.meanMs * 0.8 + elapsed * 0.2 : elapsed,
    ),
    p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1],
    updatedAt: completedAt,
  };
  // Definitions are versioned, so old calibration keys must also be bounded.
  const keys = Object.keys(device.commandTimings);
  if (keys.length > 128) {
    keys.sort(
      (a, b) =>
        device.commandTimings[a].updatedAt - device.commandTimings[b].updatedAt,
    );
    for (const old of keys.slice(0, keys.length - 128))
      delete device.commandTimings[old];
  }
}

export function calibratedDuration(device, job) {
  if (!job.workflow) return job.estimatedDurationMs;
  return job.workflow.plan.reduce((total, step) => {
    const sample =
      device.commandTimings?.[`${job.workflow.definitionId}/${step.code}`];
    return (
      total +
      (sample?.count >= 3
        ? sample.p90Ms
        : commandByCode(step.code)?.estimateMs || 1000)
    );
  }, 0);
}
