import { randomUUID } from "node:crypto";
import { requireThat, str, publicDevice } from "./model.mjs";
import { resourceKey, inResource, resourcePolicy } from "./scheduling.mjs";

// These are logical center groups. They do not assert physical host identity.
export function controlResource(s, now, mode, body) {
  requireThat(["rack", "host"].includes(body.scope), "无效的资源层级", 400);
  requireThat(
    ["drain", "release", "limit"].includes(body.action),
    "无效的资源操作",
    400,
  );
  const rack = str(body.rack, "机架"),
    host = body.scope === "host" ? str(body.host, "宿主机") : null;
  const selector = { mode, scope: body.scope, rack, host };
  const members = s.devices.filter((d) => inResource(d, selector));
  requireThat(members.length, "资源分组不存在，请刷新", 404);
  let policy = resourcePolicy(s, mode, body.scope, rack, host);
  requireThat(
    body.revision === (policy?.revision || 0),
    "资源策略已更新，请刷新后重试",
  );
  let maxConcurrent = policy?.maxConcurrent ?? null;
  if (body.action === "limit") {
    maxConcurrent = body.maxConcurrent;
    requireThat(
      maxConcurrent === null ||
        (Number.isInteger(maxConcurrent) &&
          maxConcurrent >= 1 &&
          maxConcurrent <= 64),
      "并发上限必须为 1–64，或 null 表示不另设上限",
      400,
    );
  }
  if (!policy) {
    s.resources ||= [];
    requireThat(
      s.resources.filter((r) => r.mode === mode).length < 512,
      "资源策略数量已达上限",
      429,
    );
    policy = {
      id: randomUUID(),
      ...selector,
      resourceKey: resourceKey(selector),
      revision: 0,
      draining: false,
    };
    s.resources.push(policy);
  }
  policy.maxConcurrent = maxConcurrent;
  if (body.action === "drain") {
    policy.draining = true;
    for (const d of members) {
      d.enabled = false;
      d.revision++;
    }
  }
  if (body.action === "release") policy.draining = false;
  policy.revision++;
  policy.updatedAt = now;
  const label = body.scope === "rack" ? `机架「${rack}」` : `宿主机「${host}」`;
  s.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: `resource-${body.action}`,
    resourceKey: policy.resourceKey,
    message:
      body.action === "drain"
        ? `${label}排空：停止新领取，在途任务继续；设备保持暂停`
        : body.action === "release"
          ? `${label}解除排空；设备仍需逐台启用`
          : `${label}并发上限：${maxConcurrent ?? "不另设上限"}；在途任务不抢占`,
  });
  return policy;
}

export function updatePlacement(s, now, mode, id, body) {
  const d = s.devices.find((x) => x.id === id && x.mode === mode);
  requireThat(d, "设备不存在", 404);
  requireThat(d.revision === body.revision, "设备状态已更新，请刷新后重试");
  requireThat(
    !d.enabled &&
      d.state === "idle" &&
      !s.attempts.some((a) => a.deviceId === id && a.status === "running") &&
      !["waiting", "held"].includes(d.session?.status),
    "先暂停设备并等待执行/预留结束，再修改归属",
  );
  requireThat(
    !d.slot || (body.rack === d.rack && body.host === d.host),
    "演示插槽归属固定，不能通过归属编辑移动插槽",
    400,
  );
  const before = `${d.rack} / ${d.host}`;
  d.name = str(body.name, "设备名称", 80);
  d.rack = str(body.rack, "机架");
  d.host = str(body.host, "宿主机");
  d.revision++;
  // Keep identity, endpoint, worker, queued jobs and device id unchanged.
  s.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: "placement",
    deviceId: id,
    message: `${d.name} 的中心归属：${before} → ${d.rack} / ${d.host}；仍暂停`,
  });
  return publicDevice(d);
}
