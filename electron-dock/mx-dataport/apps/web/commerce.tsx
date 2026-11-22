import { PlanCards } from "./plan-cards";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { hasPermission, enterpriseUrl } from "./permissions";
import { downloadExcel } from "./download";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Database, Info } from "lucide-react";
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
} from "./dialog";
import { request } from "./api";
import { Pagination, type PageInfo } from "./pagination";
import {
  checkoutLocation,
  canCheckoutOrder,
  commerceErrorMessage,
  orderStatusLabel,
  dateTime,
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
  page: routePage,
  tenant,
  session,
  csrf,
  go: navigate,
  reloadSession,
}: {
  page: string;
  tenant: string;
  session: any;
  csrf: string;
  go: (page: string) => void;
  reloadSession: () => void;
}) {
  const [invoiceTab, setInvoiceTab] = useState("orders");
  const [catalogOpen, setCatalogOpen] = useState(routePage === "market");
  const page = routePage === "services" && catalogOpen ? "market" : routePage;
  const go = (next: string) => {
    if (next === "market") {
      setCatalogOpen(true);
      if (routePage !== "services" && routePage !== "market")
        navigate("market");
    } else if (next === "services") {
      setCatalogOpen(false);
      navigate("services");
    } else navigate(next);
  };
  const [billQ, setBillQ] = useState(""),
    [billStatus, setBillStatus] = useState(""),
    [billFrom, setBillFrom] = useState(""),
    [billTo, setBillTo] = useState(""),
    [exporting, setExporting] = useState(false);
  const [catalog, setCatalog] = useState<{
    items: Product[];
    purchaseAvailable: boolean;
  } | null>(null);
  const [purchases, setPurchases] = useState<{
    orders: any[];
    subscriptions: Subscription[];
    pagination?: { orders: PageInfo; subscriptions: PageInfo };
    summary?: {
      trialClaimed: boolean;
      currentCount: number;
      futureCount: number;
      latestEnd?: string;
      pendingSkus: string[];
    };
  }>({ orders: [], subscriptions: [] });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Product | null>(null),
    [links, setLinks] = useState<Record<string, string>>({});
  const [upgradeFrom, setUpgradeFrom] = useState<Subscription | null>(null);
  const [orderDetail, setOrderDetail] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0),
    [loadFailed, setLoadFailed] = useState(false);
  const products = (catalog?.items || [])
    .filter((item) => item.status === "published")
    .sort((a, b) => a.amountMinor - b.amountMinor);
  const [ordersPage, setOrdersPage] = useState(1),
    [subscriptionsPage, setSubscriptionsPage] = useState(1);
  const listUrl = enterpriseUrl(
    tenant,
    page === "orders"
      ? `billing?page=${ordersPage}&pageSize=20&q=${encodeURIComponent(billQ)}&status=${billStatus}&from=${billFrom}&to=${billTo}`
      : `subscriptions?page=${subscriptionsPage}&pageSize=6`,
  );
  const lock = useRef(false);
  const canRead = hasPermission(
    session,
    tenant,
    page === "orders" ? "billing.read" : "subscriptions.read",
  );
  const canPay = hasPermission(session, tenant, "subscriptions.buy");
  const canBuy = canPay;
  const notice = subscriptionNotice(purchases.subscriptions);
  const latestEnd = purchases.summary?.latestEnd ?? notice.latestEnd;
  const currentCount = purchases.summary?.currentCount ?? notice.current.length;
  const futureCount = purchases.summary?.futureCount ?? notice.future.length;
  const post = (path: string, body = {}, key?: string) =>
    request(
      `/bff/v1${path.replace(`/commerce/tenants/${tenant}`, `/enterprises/${tenant}`)}`,
      {
        method: "POST",
        headers: {
          "x-mx-csrf": csrf,
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify(body),
      },
    );
  async function refresh() {
    const result = await request(listUrl);
    setPurchases({ orders: [], subscriptions: [], ...result.data });
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    Promise.all([
      request("/bff/v1/commerce/products"),
      canRead ? request(listUrl) : Promise.resolve(null),
    ])
      .then(([products, records]) => {
        if (active) {
          setCatalog(products.data);
          if (records)
            setPurchases({ orders: [], subscriptions: [], ...records.data });
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
  }, [listUrl, canRead, loadVersion]);
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
        const result = await request(listUrl);
        if (active)
          setPurchases({ orders: [], subscriptions: [], ...result.data });
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
  }, [listUrl, canRead, purchases.orders.some((order) => !order.deliveredAt)]);
  async function perform(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(commerceErrorMessage(e as Error));
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
      const signature = JSON.stringify([
        tenant,
        body,
        ...(hasPermission(session, tenant, "billing.read")
          ? []
          : [session.memberId]),
      ]);
      const intent = purchaseIntent(sessionStorage, signature);
      await post(`/commerce/tenants/${tenant}/orders`, body, intent.key);
      sessionStorage.removeItem(intent.name);
      setSelected(null);
      await refresh();
      if (selected.kind === "trial") reloadSession();
      if (hasPermission(session, tenant, "billing.read")) go("orders");
      else go("services");
    });
  }
  async function action(order: any, action: "checkout" | "refresh") {
    await perform(async () => {
      let result;
      try {
        result = await post(
          `/commerce/tenants/${tenant}/orders/${order.id}/${action}`,
        );
      } catch (e) {
        if ((e as { code?: string }).code === "payment_checkout_expired") {
          // A checkout can close between the last read and this click. Retain
          // the order and remove stale links without asserting payment failure.
          setPurchases((current) => ({
            ...current,
            orders: current.orders.map((value) =>
              value.id === order.id
                ? { ...value, status: "payment_timeout", checkoutAvailable: false }
                : value,
            ),
          }));
          setLinks((current) => {
            const next = { ...current };
            delete next[order.id];
            return next;
          });
        }
        throw e;
      }
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
      ? "我的订阅"
      : page === "orders"
        ? "账单与发票"
        : "我的订阅";
  const detailOrder = purchases.orders.find(
    (order) => order.id === orderDetail,
  );
  const orderStatus = orderStatusLabel;
  const trialClaimed =
    purchases.summary?.trialClaimed ??
    purchases.orders.some((order) => order.product.kind === "trial");
  const paymentActions = (order: any) => (
    <div className="harbor-actions">
      {!order.deliveredAt && canPay && (
        <>
          {canCheckoutOrder(order) &&
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
    <div
      className={`harbor-commerce parity-commerce ${page === "orders" ? "parity-orders" : "parity-subscriptions"}`}
    >
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
      </div>
      {page === "orders" && (
        <Tabs
          value={invoiceTab}
          onValueChange={setInvoiceTab}
          className="parity-order-tabs"
        >
          <TabsList variant="line">
            <TabsTrigger value="orders">订单记录</TabsTrigger>
            <TabsTrigger value="invoices">开票申请</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {!hasPermission(session, tenant, "billing.read") &&
        canBuy &&
        purchases.orders.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>我的待处理购买</CardTitle>
              <p>最近 20 笔由你创建的购买订单</p>
            </CardHeader>
            <CardContent>
              {purchases.orders.map((order) => (
                <div className="harbor-subscription-notice" key={order.id}>
                  <strong>
                    {order.product.name} · {money(order.product.amountMinor)}
                  </strong>
                  <p>
                    {dateTime(order.createdAt)} · {orderStatus(order)}
                  </p>
                  {paymentActions(order)}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
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
      {!loading && !loadFailed && page === "services" && (
        <PlanCards
          items={products}
          embedded
          trialClaimed={trialClaimed}
          disabled={!canBuy || busy}
          onSelect={(item) => {
            setUpgradeFrom(null);
            setSelected(item as Product);
          }}
        />
      )}
      {page === "orders" && invoiceTab === "invoices" && (
        <>
          <div className="notice">
            <Info size={16} aria-hidden="true" />
            仅已确认付款的订单可申请发票。开票服务尚未接入，暂不接收公司信息。
          </div>
          <div className="parity-invoices">
            <section className="panel">
              <h3>公司开票信息</h3>
              <FieldGroup className="mt-6">
                <Field data-disabled>
                  <FieldLabel htmlFor="invoice-company">公司抬头</FieldLabel>
                  <Input
                    id="invoice-company"
                    disabled
                    placeholder="填写公司完整名称"
                  />
                </Field>
                <Field data-disabled>
                  <FieldLabel htmlFor="invoice-tax">纳税人识别号</FieldLabel>
                  <Input
                    id="invoice-tax"
                    disabled
                    placeholder="15–20 位大写字母或数字"
                  />
                </Field>
                <Field data-disabled>
                  <FieldLabel htmlFor="invoice-email">收票邮箱</FieldLabel>
                  <Input
                    id="invoice-email"
                    type="email"
                    disabled
                    placeholder="finance@example.com"
                  />
                </Field>
                <Button disabled>提交开票申请</Button>
              </FieldGroup>
            </section>
            <section className="panel">
              <h3>申请记录</h3>
              <div className="empty-state">
                <Database aria-hidden="true" />
                <h3>暂无开票申请</h3>
                <p>开票服务启用后，可查看申请进度和处理结果。</p>
              </div>
            </section>
          </div>
        </>
      )}
      <div
        className="commerce-records"
        hidden={page === "orders" && invoiceTab === "invoices"}
      >
        {loading && page !== "orders" ? (
          <p role="status">正在读取服务…</p>
        ) : loadFailed && page !== "orders" ? null : page === "market" ? (
          <>
            {latestEnd && (
              <div className="harbor-subscription-notice" role="status">
                <strong>
                  {currentCount ? "你已在订阅期内" : "你已有待生效的订阅"}
                </strong>
                <p>
                  已购有效期至 {dateTime(latestEnd)}
                  {futureCount ? `，其中 ${futureCount} 份续订待生效` : ""}
                  。可以继续订阅，生效方式以所选套餐为准，各订阅独立计次。
                </p>
                <Button variant="link" onClick={() => go("services")}>
                  查看我的订阅 <ArrowRight />
                </Button>
              </div>
            )}
            <PlanCards
              items={products}
              embedded
              trialClaimed={trialClaimed}
              disabled={!canBuy || busy}
              onSelect={(item) => {
                setUpgradeFrom(null);
                setSelected(item as Product);
              }}
            />
            {catalog && !products.length && (
              <p className="harbor-empty">
                {catalog.items.length
                  ? "没有匹配的服务，请尝试其他关键词。"
                  : "暂时没有可购买的服务。"}
              </p>
            )}
          </>
        ) : !canRead ? (
          <p className="harbor-empty">请使用有当前空间账单查看权限的账号。</p>
        ) : (
          <>
            {page === "services" ? (
              <>
                {purchases.subscriptions.length > 0 && (
                  <div className="harbor-subscription-notice">
                    <p>
                      默认优先消费最早到期的可用订阅。可手动设置优先订阅；额度不足时自动选择其他可用订阅，处理中请求仍结算到原订阅。
                    </p>
                    <Button
                      variant="outline"
                      disabled={
                        busy || !hasPermission(session, tenant, "query.execute")
                      }
                      onClick={() =>
                        perform(async () => {
                          await post(
                            `/commerce/tenants/${tenant}/subscription-selection`,
                            { subscriptionId: null },
                          );
                          await refresh();
                        })
                      }
                    >
                      恢复自动选择
                    </Button>
                  </div>
                )}
                <div className="harbor-grid">
                  {purchases.subscriptions.map((subscription) => {
                    const state = subscriptionState(subscription);
                    const expiring = notice.expiring.some(
                      (value) => value.id === subscription.id,
                    );
                    return (
                      <Card key={subscription.id}>
                        <CardHeader>
                          <CardTitle>
                            {subscription.product?.name || "IP 风险画像"}
                          </CardTitle>
                          <span>
                            {
                              {
                                active: subscription.selected
                                  ? "当前消费"
                                  : "可用",
                                daily_exhausted: "今日次数已用尽",
                                exhausted: "本期次数已用尽或处理中",
                                expired: "已到期",
                                future: "待生效",
                              }[state]
                            }
                          </span>
                          {expiring && (
                            <span className="harbor-expiry-warning">
                              {Date.parse(subscription.endsAt) - Date.now() <=
                              86400_000
                                ? "24 小时内到期"
                                : "7 天内到期"}
                            </span>
                          )}
                        </CardHeader>
                        <CardContent>
                          <p className="harbor-price">
                            {subscription.used.toLocaleString()}
                            <span>
                              {" "}
                              / {subscription.quota.toLocaleString()} 次
                            </span>
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
                          <p>
                            {subscription.dailyLimit
                              ? `今日 ${subscription.dailyUsed || 0} / ${subscription.dailyLimit} 次，处理中 ${subscription.dailyHeld || 0} 次；北京时间 00:00 重置`
                              : "不单设每日上限"}
                          </p>
                          {subscription.held > 0 && (
                            <p>{subscription.held} 次请求处理中</p>
                          )}
                          {expiring && (
                            <p>
                              当前订阅即将到期
                              {futureCount
                                ? "，已购续订将在约定时间生效。"
                                : "，可提前续订保持服务连续。"}
                            </p>
                          )}
                          <div className="harbor-actions">
                            <Button
                              disabled={state !== "active"}
                              onClick={() => go("intelligence")}
                            >
                              开始使用 <ArrowRight />
                            </Button>
                            {hasPermission(session, tenant, "query.execute") &&
                              subscription.channel === "product" && (
                                <Button
                                  variant="outline"
                                  disabled={
                                    busy ||
                                    state !== "active" ||
                                    subscription.preferred
                                  }
                                  onClick={() =>
                                    perform(async () => {
                                      await post(
                                        `/commerce/tenants/${tenant}/subscription-selection`,
                                        { subscriptionId: subscription.id },
                                      );
                                      await refresh();
                                    })
                                  }
                                >
                                  {subscription.preferred
                                    ? "优先消费"
                                    : "设为优先"}
                                </Button>
                              )}
                            {canBuy && (
                              <Button
                                variant="outline"
                                onClick={() => go("market")}
                              >
                                续订
                              </Button>
                            )}
                          </div>
                          {canBuy &&
                            subscription.channel === "product" &&
                            !["expired", "future"].includes(state) && (
                              <div className="harbor-actions">
                                {products
                                  .filter(
                                    (item) =>
                                      item.amountMinor >
                                        (subscription.product?.amountMinor ??
                                          Infinity) &&
                                      item.quota > subscription.quota &&
                                      (subscription.product?.kind === "trial" ||
                                        (item.months >=
                                          (subscription.product?.months || 0) &&
                                          (item.dailyLimit == null ||
                                            (subscription.dailyLimit != null &&
                                              item.dailyLimit >=
                                                subscription.dailyLimit)))),
                                  )
                                  .map((item) => (
                                    <Button
                                      variant="outline"
                                      key={item.sku}
                                      disabled={busy}
                                      onClick={() => {
                                        setUpgradeFrom(subscription);
                                        setSelected(item);
                                      }}
                                    >
                                      升级至 {item.name}
                                    </Button>
                                  ))}
                              </div>
                            )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
                {purchases.pagination && (
                  <Pagination
                    label="订阅"
                    {...purchases.pagination.subscriptions}
                    busy={busy || loading}
                    onChange={setSubscriptionsPage}
                  />
                )}
              </>
            ) : (
              <Card className="harbor-table-panel harbor-orders">
                <Tabs
                  value={billStatus}
                  onValueChange={(value) => {
                    setBillStatus(value);
                    setOrdersPage(1);
                  }}
                  className="parity-order-status"
                >
                  <TabsList variant="line">
                    <TabsTrigger value="">全部订单</TabsTrigger>
                    <TabsTrigger value="pending">待付款</TabsTrigger>
                    <TabsTrigger value="payment_timeout">支付超时</TabsTrigger>
                    <TabsTrigger value="paid">已支付</TabsTrigger>
                    <TabsTrigger value="delivered">已开通</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="dp-toolbar">
                  <Input
                    aria-label="搜索账单"
                    placeholder="搜索订单号或产品"
                    value={billQ}
                    onChange={(e) => {
                      setBillQ(e.target.value);
                      setOrdersPage(1);
                    }}
                  />
                  <input
                    type="date"
                    aria-label="开始日期"
                    title="按北京时间（UTC+8）筛选"
                    value={billFrom}
                    onChange={(e) => {
                      setBillFrom(e.target.value);
                      setOrdersPage(1);
                    }}
                  />
                  <input
                    type="date"
                    aria-label="结束日期"
                    title="按北京时间（UTC+8）筛选"
                    value={billTo}
                    onChange={(e) => {
                      setBillTo(e.target.value);
                      setOrdersPage(1);
                    }}
                  />
                  {hasPermission(session, tenant, "billing.export") && (
                    <Button
                      variant="outline"
                      disabled={exporting || loading || loadFailed}
                      onClick={async () => {
                        setExporting(true);
                        try {
                          let rows: any[] = [];
                          for (let n = 1; ; n++) {
                            const { data } = await request(
                              listUrl.replace(/page=\d+/, `page=${n}`) +
                                "&export=1",
                            );
                            rows.push(...data.orders);
                            if (rows.length >= data.pagination.orders.total)
                              break;
                          }
                          await downloadExcel(
                            "数港账单",
                            [
                              "订单号",
                              "产品",
                              "金额（元）",
                              "创建时间",
                              "支付状态",
                            ],
                            rows.map((r) => [
                              r.id,
                              r.product.name,
                              r.product.amountMinor / 100,
                              dateTime(r.createdAt),
                              orderStatus(r),
                            ]),
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setExporting(false);
                        }
                      }}
                    >
                      导出账单
                    </Button>
                  )}
                </div>

                {loading ? (
                  <p className="harbor-empty" role="status">
                    正在读取订单…
                  </p>
                ) : loadFailed ? null : (
                  <>
                    <Table className="harbor-orders-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead>订单 / 产品</TableHead>
                          <TableHead>结算金额</TableHead>
                          <TableHead>支付方式</TableHead>
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
                              <small title={order.id}>
                                {order.id.slice(0, 16)} ·{" "}
                                {dateTime(order.createdAt)}
                              </small>
                            </TableCell>
                            <TableCell className="harbor-order-amount">
                              <strong>
                                {money(order.product.amountMinor)}
                              </strong>
                              <small>
                                {productTerm(order.product)} ·{" "}
                                {order.product.quota.toLocaleString()} 次调用
                              </small>
                            </TableCell>
                            <TableCell>
                              {order.paymentStatus === "not_required"
                                ? "无需付款"
                                : order.paymentMethod === "alipay"
                                  ? "支付宝"
                                  : order.environment === "test"
                                    ? "测试支付"
                                    : "尚未确认"}
                            </TableCell>
                            <TableCell>
                              <span
                                className="harbor-result-state"
                                data-state={
                                  order.status === "active"
                                    ? "success"
                                    : order.status === "payment_timeout"
                                      ? "error"
                                      : "unknown"
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
                                {canCheckoutOrder(order) && canPay
                                  ? "去付款"
                                  : "查看详情"}
                                <ArrowRight aria-hidden="true" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {purchases.pagination && (
                      <Pagination
                        label="订单"
                        {...purchases.pagination.orders}
                        busy={busy || loading}
                        onChange={setOrdersPage}
                      />
                    )}
                    {!purchases.orders.length && (
                      <div className="harbor-empty">
                        <p>暂无订单</p>
                        <Button variant="link" onClick={() => go("market")}>
                          浏览数据服务
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </Card>
            )}
          </>
        )}
      </div>
      {page !== "orders" && (
        <section className="panel parity-subscription-rules">
          <h3>订阅规则</h3>
          <p>
            支持多份订阅，按各自额度与到期时间分别记录。企业成员共享已授权的订阅与查询历史，回看历史不消耗次数。
          </p>
          <p>
            续订和升级的生效方式以确认页及服务端订单为准；各份订阅独立计次，到期剩余额度失效。
          </p>
        </section>
      )}
      <Dialog
        open={!!detailOrder}
        onOpenChange={(open) => {
          if (!open && !busy) setOrderDetail(null);
        }}
      >
        <DialogContent className="harbor-checkout parity-order-dialog">
          <DialogHeader>
            <DialogTitle>订单详情</DialogTitle>
            <DialogDescription>{detailOrder?.id}</DialogDescription>
          </DialogHeader>
          {detailOrder && (
            <>
              <dl className="harbor-order-facts">
                <div>
                  <dt>产品</dt>
                  <dd>IP 风险画像</dd>
                </div>
                <div>
                  <dt>套餐</dt>
                  <dd>{detailOrder.product.name}</dd>
                </div>
                <div>
                  <dt>订阅额度</dt>
                  <dd>{detailOrder.product.quota.toLocaleString()} 次</dd>
                </div>
                <div>
                  <dt>每日额度</dt>
                  <dd>
                    {detailOrder.product.dailyLimit == null
                      ? "不另设每日上限"
                      : `${detailOrder.product.dailyLimit.toLocaleString()} 次`}
                  </dd>
                </div>
                <div>
                  <dt>有效期</dt>
                  <dd>{productTerm(detailOrder.product)}</dd>
                </div>
                <div>
                  <dt>申请时间</dt>
                  <dd>{dateTime(detailOrder.createdAt)}</dd>
                </div>
                <div>
                  <dt>人民币金额</dt>
                  <dd>{money(detailOrder.product.amountMinor)}</dd>
                </div>
                <div>
                  <dt>支付方式</dt>
                  <dd>
                    {detailOrder.paymentStatus === "not_required"
                      ? "无需付款"
                      : detailOrder.paymentMethod === "alipay"
                        ? "支付宝"
                        : detailOrder.environment === "test"
                          ? "测试支付"
                          : "尚未确认"}
                  </dd>
                </div>
                <div>
                  <dt>订单状态</dt>
                  <dd>{orderStatus(detailOrder)}</dd>
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
              {canCheckoutOrder(detailOrder) && links[detailOrder.id] && (
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
              <p>
                {selected.kind === "trial"
                  ? "免费领取后立即生效，每个空间限领一次，无需付款。不自动续费。"
                  : upgradeFrom
                    ? "升级按新套餐全价购买，付款后立即生效并设为优先；旧订阅保留原到期日与剩余次数，不折抵、不退款。"
                    : selected.activationMode === "immediate"
                      ? "付款确认后立即生效，各订阅独立计时。不自动续费。"
                      : "付款确认后开通，续订从已购期限结束后顺延。不自动续费。"}
              </p>
              <p>
                {selected.dailyLimit
                  ? `每日最多 ${selected.dailyLimit} 次，北京时间 00:00 重置`
                  : "不单设每日上限"}
              </p>
              {selected.kind !== "trial" && latestEnd && (
                <div className="harbor-subscription-notice" role="status">
                  <strong>你已订阅此服务，仍可继续购买</strong>
                  <p>
                    已购有效期至 {dateTime(latestEnd)}
                    。当前剩余次数与原有效期不变；每份订阅次数独立，不结转。最终生效时间以付款交付时为准。
                  </p>
                </div>
              )}
              {(purchases.summary?.pendingSkus?.includes(selected.sku) ??
                purchases.orders.some(
                  (order) =>
                    order.product.sku === selected.sku &&
                    canCheckoutOrder(order),
                )) && (
                <div className="harbor-subscription-notice">
                  <p>
                    你已有此服务的未完成订单，可以先查看原订单，也可以另购一份。
                  </p>
                  <Button
                    variant="link"
                    disabled={busy}
                    onClick={() => {
                      setSelected(null);
                      go("orders");
                    }}
                  >
                    查看原订单
                  </Button>
                </div>
              )}
              {selected.kind !== "trial" && !catalog?.purchaseAvailable && (
                <p role="status">付款服务尚未就绪，请稍后重试。</p>
              )}
              {error && (
                <p role="alert" className="harbor-error">
                  {error}
                </p>
              )}
              <Button
                disabled={
                  busy ||
                  (selected.kind !== "trial" && !catalog?.purchaseAvailable) ||
                  !canBuy ||
                  (selected.kind === "trial" && trialClaimed)
                }
                onClick={purchase}
              >
                {busy
                  ? "正在处理…"
                  : selected.kind === "trial"
                    ? "确认免费领取"
                    : "确认并创建订单"}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
