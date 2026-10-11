import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  subscriptionState,
  type Subscription,
} from "./commerce-state";

type Product = {
  sku: string;
  revision: number;
  name: string;
  description: string;
  amountMinor: number;
  months: number;
  quota: number;
  status: string;
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
  const lock = useRef(false);
  const canRead = hasCapability(session, tenant, "billing.read");
  const canPay = hasCapability(session, tenant, "recharge.create");
  const canBuy = canPay && hasCapability(session, tenant, "apikey.write");
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
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenant, canRead]);
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
        /* Explicit refresh reports failures. */
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
      };
      const signature = JSON.stringify([tenant, body]);
      const intent = purchaseIntent(sessionStorage, signature);
      await post(`/commerce/tenants/${tenant}/orders`, body, intent.key);
      sessionStorage.removeItem(intent.name);
      setSelected(null);
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
  return (
    <div className="harbor-commerce">
      <div className="page-heading harbor-heading-actions">
        <div>
          <h1>{heading}</h1>
          <p>购买数据服务，按空间共享订阅与调用次数。</p>
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
        <p role="alert" className="harbor-error">
          {error}
        </p>
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
      ) : page === "market" ? (
        <>
          {catalog?.items
            .filter((item) => item.status === "published")
            .map((item) => (
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
                      / {item.months === 12 ? "年" : `${item.months} 个月`}
                    </span>
                  </div>
                  <p>
                    {item.quota.toLocaleString()} 次调用 · 有效期 {item.months}{" "}
                    个月
                  </p>
                  <div className="harbor-actions">
                    <Button
                      disabled={!canBuy || busy}
                      onClick={() => setSelected(item)}
                    >
                      立即订阅 <ArrowRight />
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
                        付款经服务端确认后自动开通；续订从原到期日顺延。成功查询（含有效无数据）计入次数，明确失败不计入，待核对请求保留次数。回看历史不增加调用。
                      </p>
                      <p>
                        到期或本期次数用尽后暂停新查询，不自动续费或扣钱包。
                      </p>
                    </div>
                  )}
                </div>
              </article>
            ))}
          {catalog && !catalog.items.length && (
            <p className="harbor-empty">暂时没有可购买的服务。</p>
          )}
        </>
      ) : !canRead ? (
        <p className="harbor-empty">请使用有当前空间账单查看权限的账号。</p>
      ) : (
        <>
          <div className="harbor-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => perform(refresh)}
            >
              刷新状态
            </Button>
            <Button variant="outline" onClick={() => go("market")}>
              选购 / 续订
            </Button>
          </div>
          {page === "services" ? (
            <div className="harbor-grid">
              {purchases.subscriptions.map((subscription) => {
                const state = subscriptionState(subscription);
                return (
                  <Card key={subscription.id}>
                    <CardHeader>
                      <CardTitle>IP 风险画像</CardTitle>
                      <span>
                        {
                          {
                            active: "使用中",
                            exhausted: "本期次数已用尽或处理中",
                            expired: "已到期",
                            future: "待生效",
                          }[state]
                        }
                      </span>
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
                      {subscription.held > 0 && (
                        <p>{subscription.held} 次请求处理中</p>
                      )}
                      <Button
                        disabled={state !== "active"}
                        onClick={() => go("intelligence")}
                      >
                        开始使用 <ArrowRight />
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
              {!purchases.subscriptions.length && (
                <div className="harbor-empty">
                  尚未开通服务，购买并完成付款后即可使用。
                </div>
              )}
            </div>
          ) : (
            <div className="harbor-orders">
              {purchases.orders.map((order) => (
                <Card key={order.id}>
                  <CardHeader>
                    <CardTitle>{order.product.name}</CardTitle>
                    <span>
                      {(
                        {
                          active: "已开通",
                          delivering: "付款已确认，正在开通",
                          pending: "待付款",
                          test_delivered: "测试订单（不含正式权益）",
                        } as Record<string, string>
                      )[order.status] || order.status}
                    </span>
                  </CardHeader>
                  <CardContent>
                    <p className="harbor-price">
                      {money(order.product.amountMinor)}
                    </p>
                    <p>创建时间：{dateTime(order.createdAt)}</p>
                    <p className="harbor-order-id">订单编号：{order.id}</p>
                    <div className="harbor-actions">
                      {!order.deliveredAt && canPay && (
                        <>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => action(order, "refresh")}
                          >
                            查询付款状态
                          </Button>
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
                              <Button
                                disabled={busy}
                                onClick={() => action(order, "checkout")}
                              >
                                继续付款
                              </Button>
                            ))}
                        </>
                      )}
                      {order.deliveredAt && order.environment === "live" && (
                        <Button onClick={() => go("services")}>查看订阅</Button>
                      )}
                    </div>
                    {!order.deliveredAt && links[order.id] && (
                      <p>付款后将返回数港，可在这里查询原订单状态。</p>
                    )}
                  </CardContent>
                </Card>
              ))}
              {!purchases.orders.length && (
                <p className="harbor-empty">暂无订单</p>
              )}
            </div>
          )}
        </>
      )}
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
              为当前空间购买，金额与权益由服务端确认。
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
                {selected.months} 个月 · {selected.quota.toLocaleString()}{" "}
                次调用 · 空间共享
              </p>
              <div className="harbor-price">{money(selected.amountMinor)}</div>
              <p>付款确认后开通，续订从原到期日顺延。不自动续费。</p>
              {!catalog?.purchaseAvailable && (
                <p role="status">付款服务尚未就绪，请稍后重试。</p>
              )}
              {error && (
                <p role="alert" className="harbor-error">
                  {error}
                </p>
              )}
              <Button
                disabled={busy || !catalog?.purchaseAvailable || !canBuy}
                onClick={purchase}
              >
                {busy ? "正在创建订单…" : "确认并创建订单"}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
