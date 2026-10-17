import { DataportSupport } from "./dataport-support.mjs";
import { AppError } from "../core/errors.mjs";
import {
  requireDataportAccess,
  legacyPermissions,
} from "./dataport-policy.mjs";
import { DataportAccountsClient } from "./dataport-accounts.mjs";
import { paging, uuid } from "./dataport-store.mjs";
import { IP_PRODUCT_CAPABILITY } from "../contracts/ip-risk-product.mjs";
import { commerceOrderView } from "../commerce/service.mjs";

const endpoints = {
  GET: [
    "roles",
    "members",
    "tickets",
    "audit",
    "history",
    "keys",
    "subscriptions",
    "billing",
    "query-access",
  ],
  POST: [
    "challenge",
    "profile",
    "roles",
    "members",
    "tickets",
    "query",
    "keys",
    "subscription-selection",
    "orders",
  ],
};
export function dataportRouteAllowed(method, path) {
  if (method === "GET" && path === "/payments/return-order") return true;
  if (/^\/joins\/[A-Za-z0-9_-]{43}$/.test(path))
    return ["GET", "POST"].includes(method);
  const match = /^\/enterprises\/([0-9a-f-]{36})\/(.+)$/.exec(path);
  if (!match || !uuid(match[1])) return false;
  if (
    method === "GET" &&
    /^tickets\/[0-9a-f-]{36}$/.test(match[2]) &&
    uuid(match[2].split("/")[1])
  )
    return true;
  return (
    endpoints[method]?.includes(match[2]) ||
    (method === "POST" &&
      uuid(match[2].split("/")[1]) &&
      /^(?:members\/[0-9a-f-]{36}(?:\/(?:initial-password|reset-password))?|keys\/[0-9a-f-]{36}\/revoke|orders\/[0-9a-f-]{36}\/(?:checkout|refresh))$/.test(
        match[2],
      ))
  );
}
export async function dataportRoute({
  request,
  response,
  path,
  searchParams,
  principal,
  dataport,
  store,
  commerce,
  service,
  product,
  readJson,
  sendJson,
  requestId,
  audience,
}) {
  if (!dataportRouteAllowed(request.method, path)) return false;
  const originalReadJson = readJson;
  readJson = async (...args) => {
    const body = await originalReadJson(...args);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AppError(400, "invalid_request", "请使用 JSON 对象请求。");
    return body;
  };
  dataport.available();
  const reply = (data, status = 200) => {
    sendJson(
      response,
      status,
      { data, requestId },
      { "cache-control": "private, no-store" },
    );
    return true;
  };
  if (request.method === "POST" && searchParams.size)
    throw new AppError(400, "invalid_query", "此操作不接受查询参数。");
  const accounts = new DataportAccountsClient();
  if (path === "/payments/return-order") {
    const trade = searchParams.get("trade");
    if (
      searchParams.size !== 1 ||
      searchParams.getAll("trade").length !== 1 ||
      !/^MXP[0-9a-f]{32}$/i.test(trade || "")
    )
      throw new AppError(
        400,
        "invalid_payment_query",
        "支付返回订单编号不正确。",
      );
    const eligible = [],
      billing = [];
    for (const m of principal.memberships) {
      if (m.dataport?.ownerChallengeRequired) continue;
      const permissions = m.dataport?.permissions || legacyPermissions(m);
      if (permissions.includes("billing.read")) billing.push(m.tenantId);
      if (
        permissions.includes("billing.read") ||
        permissions.includes("subscriptions.buy")
      )
        eligible.push(m.tenantId);
    }
    if (!eligible.length)
      throw new AppError(
        403,
        "insufficient_permission",
        "无权查看该购买记录。",
      );
    const rows = (
      await dataport.pool.query(
        `SELECT id,tenant_id AS "tenantId" FROM hub_commerce.orders WHERE payment #>> '{checkout,outTradeNo}'=$1 AND tenant_id=ANY($2::uuid[]) AND (tenant_id=ANY($3::uuid[]) OR intent->>'createdBy'=$4) LIMIT 2`,
        [trade, eligible, billing, principal.memberId],
      )
    ).rows;
    if (rows.length !== 1)
      throw new AppError(
        404,
        "payment_not_found",
        "未找到当前账号可查看的数港购买订单。",
      );
    return reply({ ...rows[0], businessType: "purchase" });
  }
  if (path.startsWith("/joins/")) {
    if (request.method === "POST") {
      const body = await readJson(request, 1024);
      if (body.confirm !== true || Object.keys(body).length !== 1)
        throw new AppError(
          400,
          "join_confirmation_required",
          "请先确认加入企业。",
        );
    }
    return reply(
      await dataport.join(
        principal,
        path.split("/")[2],
        request.method === "POST",
        audience,
      ),
    );
  }
  const [, tenantId, resource] = /^\/enterprises\/([^/]+)\/(.+)$/.exec(path);
  if (resource === "challenge")
    return reply(
      await dataport.ownerChallenge(
        principal,
        tenantId,
        (await readJson(request, 1024)).code,
      ),
    );
  requireDataportAccess(principal, tenantId);
  if (resource === "query-access") {
    requireDataportAccess(principal, tenantId, "usage.read");
    const data = await commerce.list(tenantId, { pageSize: 100 });
    return reply({
      subscriptions: data.subscriptions
        .filter((s) => s.channel === "product")
        .map((s) => ({
          id: s.id,
          channel: s.channel,
          product: s.product
            ? { name: s.product.name, kind: s.product.kind }
            : null,
          preferred: s.preferred,
          quota: s.quota,
          used: s.used,
          held: s.held,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          selected: s.selected,
          dailyLimit: s.dailyLimit,
          dailyUsed: s.dailyUsed,
          dailyHeld: s.dailyHeld,
        })),
    });
  }
  if (resource === "roles")
    return reply(
      await (request.method === "GET"
        ? dataport.roles(principal, tenantId)
        : dataport.saveRole(
            principal,
            tenantId,
            await readJson(request, 8192),
          )),
    );
  if (resource === "profile")
    return reply(
      await dataport.renameEnterprise(
        principal,
        tenantId,
        await readJson(request, 1024),
      ),
    );
  if (/^tickets\//.test(resource))
    return reply(
      await new DataportSupport(dataport).detail(
        principal,
        tenantId,
        resource.split("/")[1],
      ),
    );
  if (resource === "members")
    return reply(
      await (request.method === "GET"
        ? dataport.members(principal, tenantId, searchParams)
        : dataport.memberCommand(
            principal,
            tenantId,
            await readJson(request, 2048),
            accounts,
            audience,
          )),
    );
  if (resource.startsWith("members/")) {
    const [, memberId, action] = resource.split("/");
    return reply(
      action === "reset-password"
        ? await dataport.resetPassword(
            principal,
            tenantId,
            memberId,
            await readJson(request, 1024),
            accounts,
          )
        : action
          ? await dataport.initialPassword(
              principal,
              tenantId,
              memberId,
              accounts,
            )
          : await dataport.updateMember(
              principal,
              tenantId,
              memberId,
              await readJson(request, 2048),
            ),
    );
  }
  if (resource === "tickets")
    return reply(
      await (request.method === "GET"
        ? dataport.tickets(principal, tenantId, searchParams)
        : dataport.createTicket(
            principal,
            tenantId,
            await readJson(request, 32768),
          )),
    );
  if (resource === "audit") {
    if (searchParams.get("export") === "1")
      requireDataportAccess(principal, tenantId, "audit.export");
    return reply(await dataport.audit(principal, tenantId, searchParams));
  }
  if (resource === "history")
    return reply(await dataport.history(principal, tenantId, searchParams));
  if (resource === "query") {
    const body = await readJson(request, 1024);
    return reply(
      await dataport.query(
        principal,
        tenantId,
        body,
        request.headers["idempotency-key"],
        async (idempotencyKey) => {
          if (!product)
            throw new AppError(503, "query_unavailable", "查询服务尚未配置。");
          const access = await commerce.prepareAccess(tenantId, service);
          const context = await store.findApiKeyById(access.keyId);
          if (!context || context.tenant.id !== tenantId)
            throw new AppError(
              403,
              "query_access_unavailable",
              "当前企业查询身份不可用。",
            );
          return product.query(context, {
            body: { ip: body.ip },
            idempotencyKey,
            path: "/api/v1/data/ip/risk/service",
          });
        },
      ),
    );
  }
  if (resource === "keys") {
    requireDataportAccess(
      principal,
      tenantId,
      request.method === "GET" ? "keys.read" : "keys.create",
    );
    const consumers = await store.listConsumers(tenantId);
    if (request.method === "GET") {
      const items = (
        await Promise.all(
          consumers
            .filter((c) => c.tenantId === tenantId)
            .map((c) => service.listApiKeys(c.id)),
        )
      ).flat();
      return reply({ items: items.map(({ secret, ...item }) => item) });
    }
    const body = await readJson(request, 1024);
    if (
      Object.keys(body).some(
        (k) => !["name", "expiresInDays", "replaceFrom"].includes(k),
      )
    )
      throw new AppError(400, "invalid_key_request", "Key 参数无效。");
    const consumer = consumers.find(
      (c) =>
        c.tenantId === tenantId &&
        c.businessId === `commerce:ip-risk:${tenantId}` &&
        c.status === "active",
    );
    if (!consumer)
      throw new AppError(409, "subscription_required", "请先开通企业订阅。");
    const previous = body.replaceFrom
      ? (await service.listApiKeys(consumer.id)).find(
          (k) => k.id === body.replaceFrom,
        )
      : null;
    if (
      body.replaceFrom &&
      (!previous ||
        previous.status !== "active" ||
        new Date(previous.expiresAt) <= new Date() ||
        !Array.isArray(previous.platforms) ||
        !Array.isArray(previous.capabilities))
    )
      throw new AppError(
        409,
        "replacement_key_unavailable",
        "原 Key 已失效或不属于当前企业产品，请刷新后重试。",
      );
    const key = await service.createApiKey({
      consumerId: consumer.id,
      ...(previous
        ? {
            environment: previous.environment,
            webSearchOrder: previous.webSearchOrder || [],
          }
        : {}),
      name: body.name,
      expiresInDays: body.expiresInDays,
      platforms: previous?.platforms || ["ip_risk"],
      capabilities: previous?.capabilities || [IP_PRODUCT_CAPABILITY],
    });
    await dataport.event(tenantId, principal.memberId, "key.created", key.id);
    return reply(key, 201);
  }
  if (resource.startsWith("keys/")) {
    requireDataportAccess(principal, tenantId, "keys.revoke");
    const keyId = resource.split("/")[1],
      context = await store.findApiKeyById(keyId);
    if (!context || context.tenant.id !== tenantId)
      throw new AppError(404, "key_not_found", "Key 不存在或已撤销。");
    await service.revokeApiKey(keyId);
    await dataport.event(tenantId, principal.memberId, "key.revoked", keyId);
    return reply({ revoked: true });
  }
  if (resource === "subscriptions" || resource === "billing") {
    requireDataportAccess(
      principal,
      tenantId,
      resource === "subscriptions" ? "subscriptions.read" : "billing.read",
    );
    if (searchParams.get("export") === "1")
      requireDataportAccess(principal, tenantId, "billing.export");
    const { page, pageSize } = paging(searchParams);
    if (resource === "billing") {
      const q = (searchParams.get("q") || "").trim().slice(0, 128),
        status = searchParams.get("status") || "",
        from = searchParams.get("from") || null,
        to = searchParams.get("to") || null;
      if (
        !["", "paid", "pending", "delivered"].includes(status) ||
        [from, to].some(
          (v) =>
            v &&
            (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v))),
        )
      )
        throw new AppError(400, "invalid_billing_filter", "账单筛选条件无效。");
      const args = [tenantId, q, status, from, to],
        where = `tenant_id=$1 AND ($2='' OR position(lower($2) in lower(id::text||' '||(intent->'product'->>'name')))>0)
        AND ($3='' OR ($3='paid' AND payment->>'status'='paid') OR ($3='pending' AND delivered_at IS NULL AND coalesce(payment->>'status','pending')<>'paid') OR ($3='delivered' AND delivered_at IS NOT NULL))
        AND ($4::date IS NULL OR created_at >= $4::date) AND ($5::date IS NULL OR created_at < $5::date+interval '1 day')`;
      const total = (
        await dataport.pool.query(
          `SELECT count(*)::int AS total FROM hub_commerce.orders WHERE ${where}`,
          args,
        )
      ).rows[0].total;
      const rows = (
        await dataport.pool.query(
          `SELECT * FROM hub_commerce.orders WHERE ${where} ORDER BY created_at DESC,id LIMIT $6 OFFSET $7`,
          [...args, pageSize, (page - 1) * pageSize],
        )
      ).rows;
      return reply({
        orders: rows.map(commerceOrderView),
        summary: { orderCount: total },
        pagination: { orders: { page, pageSize, total } },
      });
    }
    const listing = await commerce.list(tenantId, {
      ordersPage: page,
      subscriptionsPage: page,
      pageSize,
    });
    const permissions =
      requireDataportAccess(principal, tenantId).dataport?.permissions || [];
    const ownPending =
      permissions.includes("subscriptions.buy") &&
      !permissions.includes("billing.read")
        ? (
            await dataport.pool.query(
              "SELECT * FROM hub_commerce.orders WHERE tenant_id=$1 AND intent->>'createdBy'=$2 AND delivered_at IS NULL ORDER BY created_at DESC,id LIMIT 20",
              [tenantId, principal.memberId],
            )
          ).rows.map(commerceOrderView)
        : [];
    if (resource === "subscriptions")
      return reply({
        subscriptions: listing.subscriptions,
        orders: ownPending,
        summary: {
          subscriptionCount: listing.summary.subscriptionCount,
          activeSubscriptionCount: listing.summary.activeSubscriptionCount,
          currentCount: listing.summary.currentCount,
          futureCount: listing.summary.futureCount,
          latestEnd: listing.summary.latestEnd,
          trialClaimed: listing.summary.trialClaimed,
          ...(requireDataportAccess(
            principal,
            tenantId,
          ).dataport?.permissions?.includes("subscriptions.buy")
            ? { pendingSkus: listing.summary.pendingSkus }
            : {}),
        },
        pagination: { subscriptions: listing.pagination.subscriptions },
      });
  }
  if (resource === "subscription-selection") {
    requireDataportAccess(principal, tenantId, "query.execute");
    return reply(
      await commerce.selectSubscription(
        tenantId,
        await readJson(request, 1024),
        principal.memberId,
      ),
    );
  }
  if (resource === "orders" || resource.startsWith("orders/")) {
    requireDataportAccess(principal, tenantId, "subscriptions.buy");
    const body = await readJson(request, 4096);
    if (resource === "orders")
      return reply(
        await commerce.create(
          tenantId,
          body,
          request.headers["idempotency-key"],
          principal.memberId,
          {
            harbor: true,
            purchaseActorOnly: !requireDataportAccess(
              principal,
              tenantId,
            ).dataport?.permissions?.includes("billing.read"),
          },
        ),
        201,
      );
    const [, id, action] = resource.split("/");
    const permissions =
      requireDataportAccess(principal, tenantId).dataport?.permissions || [];
    if (
      !permissions.includes("billing.read") &&
      !(
        await dataport.pool.query(
          "SELECT 1 FROM hub_commerce.orders WHERE tenant_id=$1 AND id=$2 AND intent->>'createdBy'=$3",
          [tenantId, id, principal.memberId],
        )
      ).rowCount
    )
      throw new AppError(404, "order_not_found", "无权处理该购买订单。");
    if (Object.keys(body).length)
      throw new AppError(400, "invalid_order_request", "订单参数不正确。");
    const value = await commerce.action(
      tenantId,
      id,
      action,
      action === "checkout"
        ? { returnUrl: new URL("/payment/return", principal.portalOrigin).href }
        : undefined,
    );
    await dataport.event(tenantId, principal.memberId, `order.${action}`, id);
    return reply(value);
  }
  return false;
}

/** Old customer endpoints remain narrowly scoped and cannot bypass the new
 * role model. Global administrative listings have no DataPort counterpart. */
export function authorizeLegacyPortal(principal, method, path, search) {
  if (path === "/session" || path === "/commerce/products") return principal;
  const match = /^\/commerce\/tenants\/([0-9a-f-]{36})(.*)$/.exec(path);
  const tenantId = match?.[1] || search.get("tenantId");
  let permission;
  if (["/me/usage", "/me/overview", "/usage"].includes(path))
    permission = "usage.read";
  else if (path === "/documentation") permission = "docs.read";
  else if (match) {
    if (!/^\/messages(?:\/(?:[1-9][0-9]*\/read|read-all))?$/.test(match[2]))
      throw new AppError(
        404,
        "portal_route_unavailable",
        "请使用数港企业订阅和账单接口。",
      );
    // Messages are personal delivery receipts; the existing service filters by
    // member ID. They carry no tenant ledger or query payload.
    permission = undefined;
  } else if (path === "/payments/return-order") {
    // The existing return lookup includes this exact tenant allowlist in SQL.
    const memberships = principal.memberships
      .filter((m) => {
        try {
          requireDataportAccess(principal, m.tenantId, "billing.read");
          return true;
        } catch {
          return false;
        }
      })
      .map((m) => ({ ...m, capabilities: ["billing.read"] }));
    if (!memberships.length)
      throw new AppError(
        403,
        "insufficient_permission",
        "当前账号没有可读取的账单空间。",
      );
    return {
      ...principal,
      memberships,
      tenantIds: memberships.map((m) => m.tenantId),
      capabilities: ["billing.read"],
    };
  } else
    throw new AppError(404, "portal_route_unavailable", "请使用数港企业接口。");
  const membership = requireDataportAccess(principal, tenantId, permission);
  // Only the selected read/commerce handler receives this compatibility view.
  // It is never reused for an unrestricted administrative route.
  return {
    ...principal,
    tenantIds: [tenantId],
    memberships: [
      {
        ...membership,
        capabilities: [
          "tenant.read",
          "consumer.read",
          "usage.read",
          "billing.read",
          "apikey.write",
          "recharge.create",
        ],
      },
    ],
    capabilities: [
      "tenant.read",
      "consumer.read",
      "usage.read",
      "billing.read",
      "apikey.write",
      "recharge.create",
    ],
  };
}
