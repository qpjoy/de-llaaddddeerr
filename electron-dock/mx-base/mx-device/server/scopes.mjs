// Scoped live state (V2-5, plan §10.1, §11.7). Both scopes derive from the
// realm's shared payload (one snapshot and plan per interval, however many
// viewers), so they show exactly what the mx-device workbench shows.
//
// ops:    everything the workbench shows, read-only; callers' callback URLs
//         and request fingerprints removed.
// client: one caller's own jobs (status, plan, blockers, progress) and an
//         aggregate of the pool; no devices, screens, accounts, events or
//         other callers' work.
import { jobView } from "./clients.mjs";

export function opsPayload(base) {
  return {
    ...base,
    scope: "ops",
    jobs: base.jobs.map((j) =>
      j.client
        ? {
            ...j,
            client: {
              id: j.client.id,
              name: j.client.name,
              class: j.client.class,
              template: j.client.template,
              requestId: j.client.requestId,
              deadlineAt: j.client.deadlineAt,
            },
          }
        : j,
    ),
  };
}

export function poolSummary(base) {
  const devices = base.devices || [];
  const count = (test) => devices.filter(test).length;
  return {
    devices: devices.length,
    running: count((d) => d.state === "running"),
    idle: count((d) => d.state === "idle" && d.enabled),
    paused: count((d) => !d.enabled && d.state !== "quarantined"),
    quarantined: count((d) => d.state === "quarantined"),
    offline: count((d) => d.connected === "offline"),
    racks: new Set(devices.map((d) => d.rack)).size,
    queued: base.scheduling?.queueSummary?.total ?? null,
  };
}

export function clientPayload(base, client) {
  const entries = new Map(
    (base.scheduling?.queue || []).map((q) => [q.jobId, q]),
  );
  const own = base.jobs.filter((j) => j.client?.id === client.id);
  return {
    scope: "client",
    now: base.now,
    at: base.scheduling?.at ?? base.now,
    client: { id: client.id, name: client.name },
    pool: poolSummary(base),
    mine: {
      queued: own.filter((j) => j.status === "queued").length,
      running: own.filter((j) => j.status === "running").length,
    },
    // Newest first; results are fetched per job.
    jobs: own
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({
        id: j.id,
        ...jobView(j, { entry: entries.get(j.id), at: base.scheduling?.at }),
        name: j.workflow?.name ?? null,
        result: null,
      })),
  };
}
