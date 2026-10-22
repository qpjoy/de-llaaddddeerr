export const PRODUCT_CAPABILITY = "ip.risk.subscription.query";
export function orderStatusLabel(order: { status?: string }) {
  return (
    ({
      active: "已开通",
      delivering: "正在开通",
      pending: "待付款",
      test_delivered: "测试订单",
      payment_timeout: "支付超时",
    }) as Record<string, string>
  )[order.status || ""] || "待确认";
}
export function canCheckoutOrder(order: {
  deliveredAt?: unknown;
  paymentStatus?: string;
  status?: string;
  checkoutAvailable?: boolean;
}) {
  return !order.deliveredAt && order.paymentStatus !== "paid" &&
    order.status !== "payment_timeout" && order.checkoutAvailable !== false;
}
export function commerceErrorMessage(error: { code?: string; message?: string }) {
  return error.code === "payment_checkout_expired"
    ? "支付超时，请查询原订单的付款状态。"
    : error.message || "订单操作暂不可用，请稍后重试。";
}
export type Subscription = {
  id: string;
  channel: string;
  startsAt: string;
  endsAt: string;
  quota: number;
  used: number;
  held: number;
  dailyLimit?: number | null;
  dailyUsed?: number;
  dailyHeld?: number;
  preferred?: boolean;
  selected?: boolean;
  available?: boolean;
  product?: { name: string; sku: string; amountMinor: number; months: number; kind?: string; trialDays?: number };
};
export function subscriptionState(value: Subscription, now = Date.now()) {
  if (Date.parse(value.startsAt) > now) return "future";
  if (!(Date.parse(value.endsAt) > now)) return "expired";
  if (value.quota - value.used - value.held <= 0) return "exhausted";
  if (value.dailyLimit != null && (value.dailyUsed || 0) + (value.dailyHeld || 0) >= value.dailyLimit) return "daily_exhausted";
  return "active";
}
export function currentSubscription(values: Subscription[], now = Date.now()) {
  const current = values.filter(
    (value) =>
      value.channel === "product" &&
      Date.parse(value.startsAt) <= now &&
      Date.parse(value.endsAt) > now,
  );
  return current.find(value => value.selected) ||
    current.filter(value => subscriptionState(value, now) === "active")
      .sort((a,b) => Number(!!b.preferred) - Number(!!a.preferred) || Date.parse(a.endsAt) - Date.parse(b.endsAt) || Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id))[0] || current[0];
}
export function subscriptionNotice(values: Subscription[], now = Date.now()) {
  const valid = values.filter(value => value.channel === "product" && Date.parse(value.endsAt) > now);
  const current = valid.filter(value => Date.parse(value.startsAt) <= now);
  const future = valid.filter(value => Date.parse(value.startsAt) > now);
  const latestEnd = valid.reduce<string | undefined>((end, value) =>
    !end || Date.parse(value.endsAt) > Date.parse(end) ? value.endsAt : end, undefined);
  const expiring = current.filter(value => Date.parse(value.endsAt) - now <= 7 * 86400_000);
  return { current, future, latestEnd, expiring };
}
export function hasCapability(
  session: any,
  tenant: string,
  capability: string,
) {
  return !!session?.memberships?.some(
    (member: any) =>
      member.tenantId === tenant && member.capabilities?.includes(capability),
  );
}
export const money = (amount: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 2,
  }).format(amount / 100);
export const dateTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : "—";
export function purchaseIntent(
  storage: Pick<Storage, "getItem" | "setItem">,
  signature: string,
) {
  return storedIntent(storage, `harbor:purchase:${signature}`);
}
export function queryIntent(
  storage: Pick<Storage, "getItem" | "setItem">,
  signature: string,
) {
  return storedIntent(storage, `harbor:query:${signature}`);
}
function storedIntent(
  storage: Pick<Storage, "getItem" | "setItem">,
  name: string,
) {
  let key = storage.getItem(name);
  if (!key || !/^[0-9a-f-]{36}$/.test(key)) {
    key = crypto.randomUUID();
    storage.setItem(name, key);
  }
  return { key, name };
}
export function portraitState(result: any) {
  const state = result?.response?.data?.status;
  if (["success", "partial", "no_data"].includes(state)) return state;
  const code = result?.error?.code || result?.response?.error?.code || result?.code || "";
  return result?.status === 409 ||
    /unknown|pending|in_progress|ip_response_(unusable|too_large)/.test(code)
    ? "unknown"
    : "error";
}
// Presentation reasons are separate from outcome certainty. A protected
// duplicate must never become a retryable failure just because it has a label.
export function queryStatus(result: any) {
  const state = portraitState(result);
  const code = result?.error?.code || result?.response?.error?.code || result?.code;
  if (!["success", "partial", "no_data"].includes(state)) {
    if (["ip_channel_busy", "ip_channel_cooling", "ip_channel_daily_limit",
      "ip_channel_rate_limited", "ip_query_rate_limited"].includes(code))
      return { kind: "rate_limited", label: "渠道限流",
        description: code === "ip_channel_daily_limit"
          ? "查询渠道今日调用次数已达上限，请在渠道额度恢复后再试。"
          : "查询渠道触发频率限制或正在冷却，请稍后再试。系统不会自动重试。" };
    if (["ip_query_in_progress_or_unknown", "request_pending", "request_in_progress", "request_unknown"].includes(code))
      return { kind: "duplicate_protected", label: "防重复保护",
        description: "相同查询正在处理或上次结果尚未确认，本次未再次调用渠道。请先查看原查询记录。" };
  }
  const label = ({ success: "成功", partial: "部分数据", no_data: "暂无数据",
    unknown: "待确认", error: "失败" } as Record<string, string>)[state];
  return { kind: state, label, description: state === "unknown"
    ? "尚未取得可确认的查询回执，暂时无法判断是否完成。请保留查询记录编号，稍后刷新历史核对，避免重复提交。"
    : state === "error" ? "本次未取得可用画像，请查看查询详情。" : "" };
}
export function paymentReturnTrade(search: string) {
  const query = new URLSearchParams(search);
  const trade = query.get("out_trade_no");
  return query.get("method") === "alipay.trade.page.pay.return" &&
    query.getAll("out_trade_no").length === 1 &&
    /^MXP[0-9a-f]{32}$/i.test(trade || "")
    ? trade
    : null;
}
// Same fixed checkout destinations as Hub; a service response is not an arbitrary link.
export function checkoutLocation(
  value: string,
  environment: string,
  returnUrl?: string,
) {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    /* Rejected below. */
  }
  const host = (
    {
      live: "openapi.alipay.com",
      test: "openapi-sandbox.dl.alipaydev.com",
    } as Record<string, string>
  )[environment];
  if (
    !url ||
    !host ||
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/gateway.do" ||
    url.hash ||
    (returnUrl !== undefined &&
      (url.searchParams.getAll("return_url").length !== 1 ||
        url.searchParams.get("return_url") !== returnUrl))
  )
    throw Error(
      "收银台或数港返回地址不匹配，原订单已保留，请联系管理员检查支付接入。",
    );
  return url.href;
}

export function productTerm(product: { months: number; kind?: string; trialDays?: number | null }) {
  return product.kind === "trial" ? `${product.trialDays} 天` : `${product.months} 个月`;
}
