import { createHash } from "node:crypto";
import { origin, noteLink } from "./model.mjs";
export async function callPoC(
  device,
  operation,
  input = {},
  fetchImpl = fetch,
) {
  if (device.mode !== "real") throw Error("Only real devices can invoke HTTP");
  if (!["state", "search", "next", "note"].includes(operation))
    throw Error("Operation not allowed");
  const url = new URL(`/api/${operation}`, origin(device.origin));
  if (operation === "search") url.searchParams.set("keyword", input.keyword);
  if (operation === "note")
    url.searchParams.set("input", noteLink(input.input));
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(),
      operation === "state" ? 5000 : 35000,
    );
  try {
    const r = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json" },
    });
    let size = 0;
    const chunks = [];
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        controller.abort();
        throw Error("Response too large");
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw Error("Invalid JSON");
    }
    if (r.status !== 200 || body?.ok !== true)
      throw Error(`Unverified response HTTP ${r.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}
export function observation(body) {
  const p = {
    type: body.type ?? null,
    status:
      typeof body.status === "string"
        ? body.status.slice(0, 300)
        : "状态字段缺失",
    keyword: body.keyword ?? null,
    page: body.page ?? null,
    count: body.count ?? null,
    isBusy: typeof body.isBusy === "boolean" ? body.isBusy : null,
    hasMore: body.hasMore ?? null,
    items: Array.isArray(body.items)
      ? body.items
          .slice(0, 50)
          .map((i) => ({ id: i.id, title: i.title, authorName: i.authorName }))
      : [],
    detail:
      body.detail && typeof body.detail === "object"
        ? {
            id: body.detail.id,
            title: body.detail.title,
            content: body.detail.content,
          }
        : null,
  };
  p.fingerprint = createHash("sha256").update(JSON.stringify(p)).digest("hex");
  return {
    reachable: true,
    idle: body.ok === true && body.isBusy === false,
    projection: p,
  };
}
export function validateResult(op, input, body, page) {
  if (body?.ok !== true || body.isBusy === true)
    throw Error("Device did not confirm completion");
  if (op === "note") {
    if (body.detail?.id !== new URL(input.input).pathname.split("/")[2])
      throw Error("Note identity mismatch");
    return body;
  }
  if (
    body.type !== "search" ||
    body.keyword !== input.keyword ||
    body.page !== page ||
    typeof body.hasMore !== "boolean" ||
    !Array.isArray(body.items) ||
    body.count !== body.items.length ||
    !body.items.every((i) => typeof i?.id === "string" && i.id)
  )
    throw Error("Search identity/page/count mismatch");
  return body;
}
export function simulatedResult(op, input, page = 1, appId = "xhs") {
  if (op === "note")
    return {
      ok: true,
      detail: {
        id: new URL(input.input).pathname.split("/")[2],
        title: appId === "weibo" ? "模拟微博正文" : "模拟笔记详情",
        content: "这是调度演练生成的合成数据，不来自真实手机。",
      },
    };
  return {
    ok: true,
    type: "search",
    keyword: input.keyword,
    page,
    hasMore: page < 3,
    isBusy: false,
    count: 3,
    status: `第 ${page} 页完成（模拟）`,
    items: [1, 2, 3].map((n) => ({
      id: `demo${page}${n}`,
      title: `${input.keyword} · 模拟结果 ${page}-${n}`,
      authorName: "演示账号",
      detailInput:
        appId === "weibo"
          ? `https://weibo.com/1000000000/demo${page}${n}`
          : `https://www.xiaohongshu.com/explore/demo${page}${n}`,
    })),
  };
}
