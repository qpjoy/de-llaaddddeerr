export const PRODUCT_CAPABILITY = "ip.risk.subscription.query";
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
  product?: { name: string; sku: string; amountMinor: number; months: number };
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
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
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
  const code = result?.error?.code || result?.response?.error?.code || "";
  return result?.status === 409 ||
    /unknown|pending|in_progress|ip_response_(unusable|too_large)/.test(code)
    ? "unknown"
    : "error";
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
