export function latestCatalog(rows = []) {
  const latest = new Map();
  for (const row of rows)
    if (!latest.has(row.code) || latest.get(row.code).version < row.version)
      latest.set(row.code, row);
  return [...latest.values()].filter((row) => !row.archived);
}
export function workstationView(state, rack = "") {
  const now = state.now ?? state.scheduling?.at ?? Date.now();
  const devicesById = new Map(state.devices.map((d) => [d.id, d]));
  const plans = new Map(
    (state.scheduling?.queue || []).map((q) => [q.jobId, q]),
  );
  const availability = new Map(
    (state.scheduling?.devices || []).map((d) => [d.deviceId, d]),
  );
  const queue = state.jobs
    .filter((j) => j.status === "queued")
    .map((job) => {
      const planned = plans.get(job.id),
        assignment = planned?.poolAssignment;
      return {
        job,
        planned,
        assignment,
        deviceId: job.deviceId || assignment?.deviceId || null,
        binding: job.deviceId ? "指定设备" : assignment ? "预计分配" : "待分配",
      };
    })
    .filter(
      ({ job, deviceId }) =>
        !rack ||
        (job.placement
          ? job.placement.rack === rack
          : deviceId
            ? devicesById.get(deviceId)?.rack === rack
            : true),
    )
    .sort(
      (a, b) =>
        (a.planned?.order ?? Infinity) - (b.planned?.order ?? Infinity) ||
        a.job.createdAt - b.job.createdAt,
    );
  const devices = state.devices
    .filter((d) => !rack || d.rack === rack)
    .map((device) => {
      const attempts = state.attempts.filter(
        (a) =>
          a.deviceId === device.id && ["running", "yielded"].includes(a.status),
      );
      const attempt =
        attempts.find((a) => a.status === "running") || attempts[0];
      const job = attempt && state.jobs.find((j) => j.id === attempt.jobId);
      const command = (state.commands || []).find(
        (c) => c.deviceId === device.id && c.status === "running",
      );
      // Capability edits preserve historical app rows. Display only the apps
      // that this device can currently run, including newly added empty rows.
      const appIds =
        device.mode === "sim"
          ? device.simApps || ["xhs", "weibo"]
          : device.adapter === "legacy-poc"
            ? ["xhs"]
            : [];
      const appRows = availability.get(device.id)?.apps || state.apps || [];
      const apps = appIds.map(
        (appId) =>
          appRows.find(
            (a) =>
              a.deviceId === device.id &&
              a.appId === appId &&
              a.mode === device.mode,
          ) || {
            deviceId: device.id,
            mode: device.mode,
            appId,
            cooldownUntil: 0,
          },
      );
      // nextAllowedAt also includes the whole-device interval; it must not
      // inflate the count of App-specific cooldowns.
      const coolingApps = apps.filter((a) => a.cooldownUntil > now);
      // Agent-hosted: a running lease past its deadline is suspect (grace
      // period before it is settled); an unreachable Agent means offline.
      const agent =
        device.agentId &&
        (state.agents || []).find((x) => x.id === device.agentId);
      const status =
        device.state === "quarantined"
          ? "quarantined"
          : attempt?.executor === "agent" &&
              attempt.status === "running" &&
              attempt.leaseUntil <= now
            ? "suspect"
            : device.connected === "offline" ||
                (agent &&
                  !attempt &&
                  (!agent.online || agent.status !== "active"))
              ? "offline"
              : attempt || device.state === "running"
                ? "running"
                : ["waiting", "held"].includes(device.session?.status)
                  ? "reserved"
                  : !device.enabled
                    ? "paused"
                    : device.cooldownUntil > now ||
                        (apps.length && coolingApps.length === apps.length)
                      ? "cooling"
                      : "idle";
      return {
        device,
        attempt,
        job,
        command,
        apps,
        coolingApps,
        status,
        availability: availability.get(device.id),
        queue: queue.filter((q) => q.deviceId === device.id),
      };
    })
    .sort((a, b) =>
      `${a.device.rack}/${a.device.host}/${a.device.name}`.localeCompare(
        `${b.device.rack}/${b.device.host}/${b.device.name}`,
        "zh-CN",
        { numeric: true },
      ),
    );
  return {
    now,
    devicesById,
    devices,
    queue,
    metrics: {
      total: devices.length,
      running: devices.filter((d) => d.status === "running").length,
      queued: queue.length,
      cooling: devices.reduce((n, d) => n + d.coolingApps.length, 0),
      quarantined: devices.filter((d) => d.status === "quarantined").length,
    },
  };
}
