import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { request } from "./api";
import {
  checkoutLocation,
  dateTime,
  hasCapability,
  money,
  purchaseIntent,
  productTerm,
  subscriptionState,
  subscriptionNotice,
  type Subscription,
} from "./commerce-state";

type Product = {
  sku: string;
  revision: number;
  name: string;
  description: string;
  amountMinor: number;
  months: number;
  kind?: string;
  trialDays?: number;
  quota: number;
  status: string;
  dailyLimit?: number | null;
  activationMode?: string;
};
export function Commerce({
  page,
  tenant,
  session,
  csrf,
  go,
  reloadSession,
}: {
  page: string;
  tenant: string;
  session: any;
  csrf: string;
  go: (page: string) => void;
  reloadSession: () => void;
}) {
  const [catalog, setCatalog] = useState<{
    items: Product[];
    purchaseAvailable: boolean;
  } | null>(null);
  const [purchases, setPurchases] = useState<{
    orders: any[];
    subscriptions: Subscription[];
  }>({ orders: [], subscriptions: [] });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Product | null>(null),
    [detail, setDetail] = useState<string | null>(null),
    [links, setLinks] = useState<Record<string, string>>({});
  const [upgradeFrom, setUpgradeFrom] = useState<Subscription | null>(null);
  const [orderDetail, setOrderDetail] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0),
    [loadFailed, setLoadFailed] = useState(false);
  const [productSearch, setProductSearch] = useState(""), [productSort, setProductSort] = useState("default");
  const products = (catalog?.items || []).filter(item => item.status === "published" && `${item.name} ${item.description}`.toLowerCase().includes(productSearch.toLowerCase())).sort((a,b) => productSort === "price" ? a.amountMinor - b.amountMinor : productSort === "quota" ? b.quota - a.quota : a.sku.localeCompare(b.sku));
  const lock = useRef(false);
  const canRead = hasCapability(session, tenant, "billing.read");
  const canPay = hasCapability(session, tenant, "recharge.create");
  const canBuy = canPay && hasCapability(session, tenant, "apikey.write");
  const notice = subscriptionNotice(purchases.subscriptions);
  const post = (path: string, body = {}, key?: string) =>
    request(`/bff/v1${path}`, {
      method: "POST",
      headers: {
        "x-mx-csrf": csrf,
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  async function refresh() {
    const result = await request(`/bff/v1/commerce/tenants/${tenant}`);
    setPurchases(result.data);
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    Promise.all([
      request("/bff/v1/commerce/products"),
      canRead
        ? request(`/bff/v1/commerce/tenants/${tenant}`)
        : Promise.resolve(null),
    ])
      .then(([products, records]) => {
        if (active) {
          setCatalog(products.data);
          if (records) setPurchases(records.data);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenant, canRead, loadVersion]);
  // Read existing orders only. Polling never prepares a payment or starts a query.
  useEffect(() => {
    if (!canRead || !purchases.orders.some((order) => !order.deliveredAt))
      return;
    let active = true,
      running = false;
    const timer = setInterval(async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const result = await request(`/bff/v1/commerce/tenants/${tenant}`);
        if (active) setPurchases(result.data);
      } catch {
        /* Retain the last confirmed state; order actions report failures. */
      } finally {
        running = false;
      }
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tenant, canRead, purchases.orders.some((order) => !order.deliveredAt)]);
  async function perform(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function purchase() {
    if (!selected || !canBuy) return;
    await perform(async () => {
      const body = {
        sku: selected.sku,
        revision: selected.revision,
        environment: "live",
        ...(upgradeFrom ? { upgradeFrom: upgradeFrom.id } : {}),
      };
      const signature = JSON.stringify([tenant, body]);
      const intent = purchaseIntent(sessionStorage, signature);
      await post(`/commerce/tenants/${tenant}/orders`, body, intent.key);
      sessionStorage.removeItem(intent.name);
      setSelected(null);
      await refresh();
      if (selected.kind === "trial") reloadSession();
      go("orders");
    });
  }
  async function action(order: any, action: "checkout" | "refresh") {
    await perform(async () => {
      const result = await post(
        `/commerce/tenants/${tenant}/orders/${order.id}/${action}`,
      );
      if (action === "checkout")
        setLinks((value) => ({
          ...value,
          [order.id]: checkoutLocation(
            result.data.paymentUrl,
            order.environment,
            new URL("/payment/return", location.origin).href,
          ),
        }));
      await refresh();
    });
  }
  const heading =
    page === "market"
      ? "数据商城"
      : page === "orders"
        ? "支付订单"
        : "我的订阅";
  const detailOrder = purchases.orders.find(
    (order) => order.id === orderDetail,
  );
  const orderStatus = (order: any) =>
    (
      ({
        active: "已开通",
        delivering: "正在开通",
        pending: "待付款",
        test_delivered: "测试订单",
      }) as Record<string, string>
    )[order.status] || "待确认";
  const trialClaimed = purchases.orders.some(order => order.product.kind === "trial");
  const paymentActions = (order: any) => (
    <div className="harbor-actions">
      {!order.deliveredAt && canPay && (
        <>
          {order.paymentStatus !== "paid" &&
            (links[order.id] ? (
              <a
                className="harbor-payment-link"
                href={links[order.id]}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开支付宝收银台 ↗
              </a>
            ) : (
              <Button disabled={busy} onClick={() => action(order, "checkout")}>
                继续付款
              </Button>
            ))}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action(order, "refresh")}
          >
            查询付款状态
          </Button>
        </>
      )}
      {order.deliveredAt && order.environment === "live" && (
        <Button
          onClick={() => {
            setOrderDetail(null);
            go("services");
          }}
        >
          查看订阅
        </Button>
      )}
    </div>
  );
  return (
    <div className="harbor-commerce">
      <div className="page-heading harbor-heading-actions">
        <div>
          <h1>{heading}</h1>
          <p>
            {page === "market"
              ? "按需选择数据服务，与空间成员共享使用。"
              : page === "services"
                ? "查看已开通的服务、可用次数与有效期。"
                : "查看购买记录与开通状态。"}
          </p>
        </div>
        <div className="harbor-actions">
          <Button
            variant={page === "market" ? "secondary" : "ghost"}
            onClick={() => go("market")}
          >
            发现服务
          </Button>
          <Button
            variant={page === "services" ? "secondary" : "ghost"}
            onClick={() => go("services")}
          >
            我的订阅
          </Button>
          <Button
            variant={page === "orders" ? "secondary" : "ghost"}
            onClick={() => go("orders")}
          >
            支付订单
          </Button>
        </div>
      </div>
      {error && (
        <div role="alert" className="harbor-error harbor-inline-issue">
          {error}
          {loadFailed && (
            <Button
              variant="link"
              size="sm"
              disabled={loading}
              onClick={() => setLoadVersion((value) => value + 1)}
            >
              重新加载
            </Button>
          )}
        </div>
      )}
      {!tenant && (
        <Card>
          <CardHeader>
            <CardTitle>先开通使用空间</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              加入团队空间，或开通自己的个人空间后购买。开通空间不会自动购买服务。
            </p>
            {session.canOpenPersonalAccount && (
              <Button
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    await post("/payments/personal-account", {
                      acknowledge: true,
                    });
                    reloadSession();
                  })
                }
              >
                开通个人空间
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {loading ? (
        <p role="status">正在读取服务…</p>
      ) : loadFailed ? null : page === "market" ? (
        <>
          {notice.latestEnd && <div className="harbor-subscription-notice" role="status">
            <strong>{notice.current.length ? "你已在订阅期内" : "你已有待生效的订阅"}</strong>
            <p>已购有效期至 {dateTime(notice.latestEnd)}{notice.future.length ? `，其中 ${notice.future.length} 份续订待生效` : ""}。可以继续订阅，生效方式以所选套餐为准，各订阅独立计次。</p>
            <Button variant="link" onClick={() => go("services")}>查看我的订阅 <ArrowRight /></Button>
          </div>}
          <div className="harbor-market-toolbar"><Input aria-label="搜索数据服务" placeholder="搜索数据服务或套餐" value={productSearch} onChange={e => setProductSearch(e.target.value)} /><Select value={productSort} onValueChange={setProductSort}><SelectTrigger aria-label="商品排序"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">默认排序</SelectItem><SelectItem value="price">价格从低到高</SelectItem><SelectItem value="quota">调用次数从多到少</SelectItem></SelectContent></Select><span>{products.length} 款服务</span></div>
          <div className={`harbor-market-products ${(catalog?.items.length || 0) > 1 ? "has-multiple" : ""}`}>
          {products.map((item) => (
              <article className="harbor-offer" key={item.sku}>
                <div className="harbor-offer-art" aria-hidden="true">
                  <ShieldCheck />
                  <span>IP 风险画像</span>
                </div>
                <div className="harbor-offer-copy">
                  <h2>{item.name}</h2>
                  <p>{item.description}</p>
                  <ul className="harbor-benefits">
                    <li>
                      <Check />
                      风险线索识别
                    </li>
                    <li>
                      <Check />
                      空间共享调用
                    </li>
                    <li>
                      <Check />
                      网页与 API 接入
                    </li>
                  </ul>
                  <div className="harbor-price">
                    {money(item.amountMinor)}
                    <span>
                      {" "}
                      / {item.kind === "trial" ? "次领取" : item.months === 12 ? "年" : `${item.months} 个月`}
                    </span>
                  </div>
                  <p>
                    {item.quota.toLocaleString()} 次调用 · 有效期 {productTerm(item)}
                  </p>
                  <p>{item.dailyLimit ? `每日最多 ${item.dailyLimit.toLocaleString()} 次，北京时间 00:00 重置` : "不单设每日上限"}</p>
                  <div className="harbor-actions">
                    <Button
                      disabled={!canBuy || busy || (item.kind === "trial" && trialClaimed)}
                      onClick={() => { setUpgradeFrom(null); setSelected(item); }}
                    >
                      {item.kind === "trial" ? trialClaimed ? "已领取试用" : "免费领取" : notice.latestEnd ? "继续订阅" : "立即订阅"} <ArrowRight />
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setDetail(detail === item.sku ? null : item.sku)
                      }
                    >
                      订阅说明
                    </Button>
                  </div>
                  {!canBuy && tenant && (
                    <p>
                      购买需要当前空间的订单和 Key
                      管理权限，请联系空间所有者或管理员。
                    </p>
                  )}
                  {detail === item.sku && (
                    <div className="harbor-terms">
                      <p>
                        {item.kind === "trial" ? "每个空间限领一次，领取后立即生效。" : "付款经服务端确认后自动开通；"}{item.kind === "trial" ? "" : item.activationMode === "immediate" ? "每次购买立即生效，各订阅独立计时。" : "续订从已购期限结束后顺延。"}成功查询（含有效无数据）计入次数，明确失败不计入，待核对请求保留次数。回看历史不增加调用。
                      </p>
                      <p>
                        到期或本期次数用尽后暂停新查询，不自动续费或扣钱包。
                      </p>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          {catalog && !products.length && <p className="harbor-empty">{catalog.items.length ? "没有匹配的服务，请尝试其他关键词。" : "暂时没有可购买的服务。"}</p>}
        </>
      ) : !canRead ? (
        <p className="harbor-empty">请使用有当前空间账单查看权限的账号。</p>
      ) : (
        <>
          {page === "services" ? (
            <><div className="harbor-subscription-notice"><p>默认优先消费最早到期的可用订阅。可手动设置优先订阅；额度不足时自动选择其他可用订阅，处理中请求仍结算到原订阅。</p><Button variant="outline" disabled={busy || !hasCapability(session, tenant, "apikey.write")} onClick={() => perform(async () => { const result = await post(`/commerce/tenants/${tenant}/subscription-selection`, { subscriptionId: null }); setPurchases(result.data); })}>恢复自动选择</Button></div><div className="harbor-grid">
              {purchases.subscriptions.map((subscription) => {
                const state = subscriptionState(subscription);
                const expiring = notice.expiring.some(value => value.id === subscription.id);
                return (
                  <Card key={subscription.id}>
                    <CardHeader>
                      <CardTitle>{subscription.product?.name || "IP 风险画像"}</CardTitle>
                      <span>
                        {
                          {
                            active: subscription.selected ? "当前消费" : "可用",
                            daily_exhausted: "今日次数已用尽",
                            exhausted: "本期次数已用尽或处理中",
                            expired: "已到期",
                            future: "待生效",
                          }[state]
                        }
                      </span>
                      {expiring && <span className="harbor-expiry-warning">{Date.parse(subscription.endsAt) - Date.now() <= 86400_000 ? "24 小时内到期" : "7 天内到期"}</span>}
                    </CardHeader>
                    <CardContent>
                      <p className="harbor-price">
                        {subscription.used.toLocaleString()}
                        <span> / {subscription.quota.toLocaleString()} 次</span>
                      </p>
                      <progress
                        max={subscription.quota}
                        value={subscription.used + subscription.held}
                        aria-label="本期调用次数"
                      />
                      <p>
                        有效期：{dateTime(subscription.startsAt)} —{" "}
                        {dateTime(subscription.endsAt)}
                      </p>
                      <p>{subscription.dailyLimit ? `今日 ${subscription.dailyUsed || 0} / ${subscription.dailyLimit} 次，处理中 ${subscription.dailyHeld || 0} 次；北京时间 00:00 重置` : "不单设每日上限"}</p>
                      {subscription.held > 0 && (
                        <p>{subscription.held} 次请求处理中</p>
                      )}
                      {expiring && <p>当前订阅即将到期{notice.future.length ? "，已购续订将在约定时间生效。" : "，可提前续订保持服务连续。"}</p>}
                      <div className="harbor-actions">
                        <Button
                          disabled={state !== "active"}
                          onClick={() => go("intelligence")}
                        >
                          开始使用 <ArrowRight />
                        </Button>
                        {hasCapability(session, tenant, "apikey.write") && subscription.channel === "product" && <Button variant="outline" disabled={busy || state !== "active" || subscription.preferred} onClick={() => perform(async () => { const result = await post(`/commerce/tenants/${tenant}/subscription-selection`, { subscriptionId: subscription.id }); setPurchases(result.data); })}>{subscription.preferred ? "优先消费" : "设为优先"}</Button>}
                        {canBuy && (
                          <Button
                            variant="outline"
                            onClick={() => go("market")}
                          >
                            续订
                          </Button>
                        )}
                      </div>
                      {canBuy && subscription.channel === "product" && !["expired", "future"].includes(state) && <div className="harbor-actions">{products.filter(item => item.amountMinor > (subscription.product?.amountMinor ?? Infinity) && item.quota > subscription.quota && (subscription.product?.kind === "trial" || (item.months >= (subscription.product?.months || 0) && (item.dailyLimit == null || (subscription.dailyLimit != null && item.dailyLimit >= subscription.dailyLimit))))).map(item => <Button variant="outline" key={item.sku} disabled={busy} onClick={() => { setUpgradeFrom(subscription); setSelected(item); }}>升级至 {item.name}</Button>)}</div>}
                    </CardContent>
                  </Card>
                );
              })}
              {!purchases.subscriptions.length && (
                <div className="harbor-empty">
                  <p>尚未开通服务，购买并完成付款后即可使用。</p>
                  {canBuy && (
                    <Button onClick={() => go("market")}>选购数据服务</Button>
                  )}
                </div>
              )}
            </div></>
          ) : (
            <Card className="harbor-table-panel harbor-orders">
              <Table className="harbor-orders-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>订单 / 产品</TableHead>
                    <TableHead>金额</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchases.orders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell>
                        <strong>{order.product.name}</strong>
                        <small>
                          {productTerm(order.product)} ·{" "}
                          {order.product.quota.toLocaleString()} 次调用
                        </small>
                      </TableCell>
                      <TableCell className="harbor-order-amount">
                        {money(order.product.amountMinor)}
                      </TableCell>
                      <TableCell>
                        <time>{dateTime(order.createdAt)}</time>
                      </TableCell>
                      <TableCell>
                        <span
                          className="harbor-result-state"
                          data-state={
                            order.status === "active" ? "success" : "unknown"
                          }
                        >
                          {orderStatus(order)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => setOrderDetail(order.id)}
                        >
                          {!order.deliveredAt &&
                          order.paymentStatus !== "paid" &&
                          canPay
                            ? "去付款"
                            : "查看详情"}
                          <ArrowRight aria-hidden="true" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!purchases.orders.length && (
                <div className="harbor-empty">
                  <p>暂无订单</p>
                  <Button variant="link" onClick={() => go("market")}>
                    浏览数据服务
                  </Button>
                </div>
              )}
            </Card>
          )}
        </>
      )}
      <Dialog
        open={!!detailOrder}
        onOpenChange={(open) => {
          if (!open && !busy) setOrderDetail(null);
        }}
      >
        <DialogContent className="harbor-checkout">
          <DialogHeader>
            <DialogTitle>订单详情</DialogTitle>
            <DialogDescription>{detailOrder?.product.name}</DialogDescription>
          </DialogHeader>
          {detailOrder && (
            <>
              <div className="harbor-order-summary">
                <strong className="harbor-price">
                  {money(detailOrder.product.amountMinor)}
                </strong>
                <span
                  className="harbor-result-state"
                  data-state={
                    detailOrder.status === "active" ? "success" : "unknown"
                  }
                >
                  {orderStatus(detailOrder)}
                </span>
              </div>
              <dl className="harbor-order-facts">
                <div>
                  <dt>订阅权益</dt>
                  <dd>
                    {productTerm(detailOrder.product)} ·{" "}
                    {detailOrder.product.quota.toLocaleString()} 次调用
                  </dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd>{dateTime(detailOrder.createdAt)}</dd>
                </div>
                <div>
                  <dt>订单编号</dt>
                  <dd>{detailOrder.id}</dd>
                </div>
              </dl>
              {detailOrder.environment === "test" && (
                <p>测试订单，不包含正式查询权益。</p>
              )}
              {detailOrder.paymentStatus === "paid" &&
                !detailOrder.deliveredAt && (
                  <p role="status">付款已确认，正在为你的空间开通服务。</p>
                )}
              {error && (
                <p className="harbor-error" role="alert">
                  {error}
                </p>
              )}
              {paymentActions(detailOrder)}
              {!detailOrder.deliveredAt && links[detailOrder.id] && (
                <p>付款后将返回数港，订单状态会自动更新。</p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <DialogContent className="harbor-checkout">
          <DialogHeader>
            <DialogTitle>确认订阅</DialogTitle>
            <DialogDescription>
              为当前空间开通，成员共享订阅次数。
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <h3>{selected.name}</h3>
              <p>
                {session.memberships?.find((m: any) => m.tenantId === tenant)
                  ?.tenantName || tenant}
              </p>
              <p>
                {productTerm(selected)} · {selected.quota.toLocaleString()}{" "}
                次调用 · 空间共享
              </p>
              <div className="harbor-price">{money(selected.amountMinor)}</div>
              <p>{selected.kind === "trial" ? "免费领取后立即生效，每个空间限领一次，无需付款。不自动续费。" : upgradeFrom ? "升级按新套餐全价购买，付款后立即生效并设为优先；旧订阅保留原到期日与剩余次数，不折抵、不退款。" : selected.activationMode === "immediate" ? "付款确认后立即生效，各订阅独立计时。不自动续费。" : "付款确认后开通，续订从已购期限结束后顺延。不自动续费。"}</p><p>{selected.dailyLimit ? `每日最多 ${selected.dailyLimit} 次，北京时间 00:00 重置` : "不单设每日上限"}</p>
              {selected.kind !== "trial" && notice.latestEnd && <div className="harbor-subscription-notice" role="status">
                <strong>你已订阅此服务，仍可继续购买</strong>
                <p>已购有效期至 {dateTime(notice.latestEnd)}。当前剩余次数与原有效期不变；每份订阅次数独立，不结转。最终生效时间以付款交付时为准。</p>
              </div>}
              {purchases.orders.some(order => order.product.sku === selected.sku && !order.deliveredAt && order.paymentStatus !== "paid") && <div className="harbor-subscription-notice">
                <p>你已有此服务的未完成订单，可以先查看原订单，也可以另购一份。</p>
                <Button variant="link" disabled={busy} onClick={() => { setSelected(null); go("orders"); }}>查看原订单</Button>
              </div>}
              {selected.kind !== "trial" && !catalog?.purchaseAvailable && (
                <p role="status">付款服务尚未就绪，请稍后重试。</p>
              )}
              {error && (
                <p role="alert" className="harbor-error">
                  {error}
                </p>
              )}
              <Button
                disabled={busy || (selected.kind !== "trial" && !catalog?.purchaseAvailable) || !canBuy || (selected.kind === "trial" && trialClaimed)}
                onClick={purchase}
              >
                {busy ? "正在处理…" : selected.kind === "trial" ? "确认免费领取" : "确认并创建订单"}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
