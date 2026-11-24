
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CreditCard,
  Info,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { supportedInterfacePlatforms } from "./interface-catalog";
import { PlatformLogo } from "./data-directory";
import { checkoutLocation, canCheckoutOrder, commerceErrorMessage, money, orderStatusLabel, purchaseIntent } from "./commerce-state";
import { enterpriseUrl, hasPermission } from "./permissions";
import { request } from "./api";
import styles from "./interface-payment.module.css";

const steps = [
  { id: "select", label: "选择接口" },
  { id: "configure", label: "配置用量" },
  { id: "review", label: "确认订单" },
  { id: "receipt", label: "查看结果" },
] as const;

type Step = (typeof steps)[number]["id"];
type PaymentMethod = "alipay" | "bank";
type Offer = {
  sku: string;
  platform: string;
  name: string;
  unitPriceMinor: number;
  revision: number;
  minCalls: number;
  maxCalls: number;
};
type Offers = { items: Offer[]; alipayAvailable: boolean };
type Receipt = {
  id: string;
  status: string;
  environment: string;
  paymentMethod: PaymentMethod;
  paymentStatus: string;
  checkoutAvailable: boolean;
  deliveredAt?: string;
  company?: string;
  product: { name: string; amountMinor: number; callCount: number; unitPriceMinor: number };
};

const methodNames: Record<PaymentMethod, string> = {
  alipay: "支付宝",
  bank: "对公转账",
};
const callPresets = [1_000, 10_000, 100_000];

const countLabel = (count: number) => count.toLocaleString("zh-CN");

function InterfaceSelection({
  offers, select, openOrders,
}: { offers: Offer[]; select: (offer: Offer) => void; openOrders?: () => void }) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();
  const platforms = supportedInterfacePlatforms.filter(({ name, aliases }) =>
    [name, ...(aliases ?? [])].some((value) => value.toLowerCase().includes(search)),
  );
  return (
    <section className={styles.selection} aria-label="接口付费目录">
      <div className={styles.selectionToolbar}>
        <h2>全部接口 <span>{supportedInterfacePlatforms.length}</span></h2>
        <div className={styles.selectionActions}>
          <Input type="search" aria-label="搜索平台接口" placeholder="搜索平台名称"
            value={query} onChange={(event) => setQuery(event.target.value)} />
          {openOrders && <Button type="button" variant="outline" onClick={openOrders}>查看订单记录</Button>}
        </div>
      </div>
      {platforms.length ? (
        <div className={styles.selectionGrid}>
          {platforms.map(({ slug, name }) => {
            const offer = offers.find((value) => value.platform === slug);
            return (
              <article key={slug} className={styles.selectionCard} data-orderable={!!offer}>
                <header>
                  <PlatformLogo slug={slug} />
                  <h3>{offer?.name ?? name}</h3>
                  <Badge variant="secondary" className={styles.catalogStatus} data-preview={!!offer}>
                    {offer ? "可订阅" : "暂未开放"}
                  </Badge>
                </header>
                <div className={styles.selectionPrice}>
                  <p>{offer ? <><span>预存参考单价</span><strong>{money(offer.unitPriceMinor)}</strong> / 次</>
                    : <span>待公布</span>}</p>
                  {offer && <Button type="button" size="sm" onClick={() => select(offer)}>
                    订阅 <ArrowRight data-icon="inline-end" />
                  </Button>}
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className={styles.selectionEmpty} role="status">未找到匹配的接口</p>}
    </section>
  );
}

function OrderSummary({
  amount,
  calls,
  charge,
  name,
  method,
  company,
  orderId,
}: {
  amount: number | null;
  calls: number | null;
  charge: number;
  name: string;
  method: PaymentMethod;
  company: string;
  orderId?: string;
}) {
  return (
    <dl className={styles.summary}>
      {orderId && (
        <div>
          <dt>订单编号</dt>
          <dd>
            <code>{orderId}</code>
          </dd>
        </div>
      )}
      <div>
        <dt>数据接口</dt>
        <dd>{name}</dd>
      </div>
      <div>
        <dt>预存参考单价</dt>
        <dd>{money(charge)} / 次</dd>
      </div>
      <div>
        <dt>预计成功调用次数</dt>
        <dd>{calls === null ? "—" : `${countLabel(calls)} 次`}</dd>
      </div>
      <div>
        <dt>付款方式</dt>
        <dd>{methodNames[method]}</dd>
      </div>
      {method === "bank" && company && (
        <div>
          <dt>付款单位</dt>
          <dd>{company}</dd>
        </div>
      )}
      <div className={styles.total}>
        <dt>申请金额</dt>
        <dd>{amount === null ? "—" : money(amount)}</dd>
      </div>
    </dl>
  );
}

export function InterfacePayment({
  tenant, session, csrf, navigate, reloadSession,
}: { tenant: string; session: any; csrf: string; navigate: (page: string) => void; reloadSession: () => void }) {
  const [step, setStep] = useState<Step>("select");
  const [offers, setOffers] = useState<Offers | null>(null);
  const [selected, setSelected] = useState<Offer | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [count, setCount] = useState("1000");
  const [method, setMethod] = useState<PaymentMethod>("alipay");
  const [company, setCompany] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [paymentLink, setPaymentLink] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const countInput = useRef<HTMLInputElement>(null);
  const companyInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const live = useRef(false);
  const canReadBilling = hasPermission(session, tenant, "billing.read");
  const subscriptionHome = hasPermission(session, tenant, "subscriptions.read") ? "services" : "account";

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<{ data: Offers }>(enterpriseUrl(tenant, "interface-offers"), { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setOffers(data); })
      .catch((e) => { if (!controller.signal.aborted) setError(commerceErrorMessage(e)); });
    return () => controller.abort();
  }, [tenant, attempt]);
  useEffect(() => {
    heading.current?.closest("main")?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  const calls = Number(count);
  const validCount = selected !== null && /^\d+$/.test(count) &&
    Number.isSafeInteger(calls) && calls >= selected.minCalls && calls <= selected.maxCalls;
  const bankCompany = method === "bank" ? company.trim() : "";
  const validCompany = method !== "bank" || bankCompany.length >= 2 && bankCompany.length <= 100 && !/[\u0000-\u001f\u007f]/.test(bankCompany);
  const validMethod = method === "bank" || offers?.alipayAvailable === true;
  const amount = validCount && selected ? calls * selected.unitPriceMinor : null;
  const hasCountError = checked && !validCount;
  const hasCompanyError = checked && !validCompany;
  const stepIndex = steps.findIndex(({ id }) => id === step);

  function choose(offer: Offer) {
    setSelected(offer);
    setCount(String(Math.min(offer.maxCalls, Math.max(1000, offer.minCalls))));
    setMethod(offers?.alipayAvailable ? "alipay" : "bank");
    setChecked(false);
    setStep("configure");
  }
  function goBack() {
    setError("");
    if (step === "review") setStep("configure");
    else if (step === "configure") setStep("select");
    else navigate(subscriptionHome);
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecked(true);
    if (!validCount) return countInput.current?.focus();
    if (!validCompany) return companyInput.current?.focus();
    if (!validMethod) return;
    setAgreed(false);
    setError("");
    setStep("review");
  }
  const post = (path: string, body: unknown, key?: string) =>
    request<{ data: Receipt & { paymentUrl?: string } }>(enterpriseUrl(tenant, path), {
      method: "POST",
      headers: { "x-mx-csrf": csrf, ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(body),
    });
  async function perform(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (live.current) setError(commerceErrorMessage(e as Error));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function orderAction(order: Receipt, action: "checkout" | "refresh") {
    try {
      const { data } = await post(`orders/${order.id}/${action}`, {});
      if (!live.current) return;
      setReceipt(data);
      if (data.status === "credited") reloadSession();
      if (action === "checkout")
        setPaymentLink(checkoutLocation(data.paymentUrl ?? "", order.environment, new URL("/payment/return", location.origin).href));
      else if (!canCheckoutOrder(data)) setPaymentLink("");
    } catch (e) {
      if (live.current && (e as { code?: string }).code === "payment_checkout_expired") {
        setReceipt({ ...order, status: "payment_timeout", checkoutAvailable: false });
        setPaymentLink("");
      }
      throw e;
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agreed || !validCount || !validCompany || !validMethod || !selected) return;
    await perform(async () => {
      const body = {
        sku: selected.sku, revision: selected.revision, callCount: calls, method, agreed,
        ...(method === "bank" ? { company: bankCompany } : {}),
      };
      const digest = await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(JSON.stringify([tenant, session.memberId, body])));
      const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const intent = purchaseIntent(sessionStorage, signature);
      const { data } = await post("interface-orders", body, intent.key);
      if (!live.current) return;
      setReceipt(data);
      setStep("receipt");
      sessionStorage.removeItem(intent.name);
      if (data.status === "credited") reloadSession();
      if (data.paymentMethod === "alipay" && canCheckoutOrder(data)) await orderAction(data, "checkout");
    });
  }

  return (
    <div className={styles.page}>
      <Button
        className={styles.back}
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={goBack}
      >
        <ArrowLeft data-icon="inline-start" />
        {step === "review"
          ? "返回配置"
          : step === "configure"
            ? "返回接口选择"
            : subscriptionHome === "services" ? "返回我的订阅" : "返回数据接口"}
      </Button>
      <header className={styles.heading}>
        <h1 ref={heading} tabIndex={-1}>
          {step === "receipt" ? "订单结果" : "数据接口付费"}
        </h1>
        {step === "select" && (
          <p>预存金额用于企业已开通的接口，实际扣费以企业计费配置为准。</p>
        )}
      </header>
      <ol className={styles.steps} aria-label="接口付费流程">
        {steps.map(({ id, label }, index) => (
          <li
            key={id}
            aria-current={id === step ? "step" : undefined}
            data-complete={index < stepIndex}
          >
            {index < stepIndex ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <span>{index + 1}</span>
            )}
            {label}
          </li>
        ))}
      </ol>

      {error && <div role="alert" className="harbor-error">{error}
        {!offers && <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>重新加载</Button>}
      </div>}
      {step === "select" && (offers
        ? <InterfaceSelection offers={offers.items} select={choose}
            openOrders={canReadBilling ? () => navigate("orders") : undefined} />
        : !error && <p role="status">正在读取接口订阅配置…</p>)}

      {step === "configure" && selected && (
        <form className={styles.checkout} onSubmit={review} noValidate>
          <div className={styles.stack}>
            <Card className={styles.surface}>
              <CardHeader>
                <CardTitle>配置用量</CardTitle>
              </CardHeader>
              <CardContent className={styles.controls}>
                <Field data-invalid={hasCountError}>
                  <FieldLabel htmlFor="api-order-calls">
                    成功调用次数
                  </FieldLabel>
                  <Input
                    ref={countInput}
                    id="api-order-calls"
                    type="number"
                    inputMode="numeric"
                    min={selected.minCalls}
                    max={selected.maxCalls}
                    step={1}
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                    aria-invalid={hasCountError}
                    aria-describedby={
                      hasCountError
                        ? "api-order-call-range api-order-call-error"
                        : "api-order-call-range"
                    }
                  />
                  <p className={styles.hint} id="api-order-call-range">
                    按预计用量申请预存金额，支持{" "}
                    {countLabel(selected.minCalls)}–
                    {countLabel(selected.maxCalls)} 次。
                  </p>
                  {hasCountError && (
                    <FieldError id="api-order-call-error">
                      请填写范围内的整数次数。
                    </FieldError>
                  )}
                </Field>
                <div
                  className={styles.presets}
                  role="group"
                  aria-label="常用调用次数"
                >
                  {callPresets.filter((value) => value >= selected.minCalls && value <= selected.maxCalls).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-pressed={validCount && calls === value}
                      onClick={() => setCount(String(value))}
                    >
                      {countLabel(value)} 次
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className={styles.surface}>
              <CardHeader>
                <CardTitle>付款方式</CardTitle>
              </CardHeader>
              <CardContent className={styles.controls}>
                <div className={styles.methods} role="group" aria-label="付款方式">
                  <label data-selected={method === "alipay"}>
                    <input type="radio" name="interface-payment-method" value="alipay"
                      checked={method === "alipay"} disabled={!offers?.alipayAvailable} onChange={() => setMethod("alipay")} />
                    <span className="alipay-mark" aria-hidden="true">支</span>
                    支付宝{!offers?.alipayAvailable && "（暂不可用）"}
                  </label>
                  <label data-selected={method === "bank"}>
                    <input type="radio" name="interface-payment-method" value="bank"
                      checked={method === "bank"} onChange={() => setMethod("bank")} />
                    <CreditCard size={18} aria-hidden="true" /> 对公转账
                  </label>
                </div>
                {method === "bank" && (
                  <Field data-invalid={hasCompanyError}>
                    <FieldLabel htmlFor="api-order-company">
                      付款单位名称
                    </FieldLabel>
                    <Input
                      ref={companyInput}
                      id="api-order-company"
                      value={company}
                      maxLength={100}
                      placeholder="填写企业全称"
                      onChange={(event) => setCompany(event.target.value)}
                      aria-invalid={hasCompanyError}
                      aria-describedby={
                        hasCompanyError ? "api-order-company-error" : undefined
                      }
                    />
                    {hasCompanyError && (
                      <FieldError id="api-order-company-error">
                        请填写完整的付款单位名称。
                      </FieldError>
                    )}
                  </Field>
                )}
              </CardContent>
            </Card>
          </div>
          <Card className={styles.surface}>
            <CardHeader>
              <CardTitle>费用明细</CardTitle>
            </CardHeader>
            <CardContent className={styles.controls}>
              <OrderSummary
                name={selected.name}
                charge={selected.unitPriceMinor}
                amount={amount}
                calls={validCount ? calls : null}
                method={method}
                company={bankCompany}
              />
              <Button type="submit">
                核对订单 <ArrowRight data-icon="inline-end" />
              </Button>
            </CardContent>
          </Card>
        </form>
      )}

      {step === "review" && selected && (
        <Card className={`${styles.surface} ${styles.single}`}>
          <CardHeader>
            <CardTitle>确认订单</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className={styles.controls}
              onSubmit={submit}
              aria-busy={busy}
            >
              <OrderSummary
                name={selected.name}
                charge={selected.unitPriceMinor}
                amount={amount}
                calls={calls}
                method={method}
                company={bankCompany}
              />
              <Alert className={styles.notice}>
                <Info />
                <AlertDescription>
                  {method === "alipay"
                    ? "请通过支付宝收银台付款。确认到账后，预存金额会记入企业余额。"
                    : "对公收款尚未开放，申请将保存为待收款配置，收款信息以确认结果为准。"}
                </AlertDescription>
              </Alert>
              <Field orientation="horizontal">
                <Checkbox
                  id="api-order-agreed"
                  checked={agreed}
                  onCheckedChange={(value) => setAgreed(value === true)}
                  disabled={busy}
                />
                <FieldLabel htmlFor="api-order-agreed">
                  我已核对订单金额和付款方式。
                </FieldLabel>
              </Field>
              <Button type="submit" disabled={busy || !agreed}>
                {busy && <Spinner />}
                {method === "alipay" ? "确认订单" : "提交付款申请"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step === "receipt" && receipt && (
        <Card className={`${styles.surface} ${styles.single}`}>
          <CardHeader>
            <CardTitle>订单结果</CardTitle>
          </CardHeader>
          <CardContent className={styles.controls}>
            <Alert className={styles.notice}>
              <Info />
              <AlertDescription>
                {receipt.paymentMethod === "bank"
                  ? "待收款配置。申请已保存，收款信息以客服确认为准。"
                  : receipt.status === "credited"
                    ? "付款已确认，预存金额已到账。"
                    : paymentLink ? "请打开支付宝收银台完成付款。" : orderStatusLabel(receipt)}
              </AlertDescription>
            </Alert>
            <OrderSummary
              orderId={receipt.id}
              name={receipt.product.name}
              amount={receipt.product.amountMinor}
              calls={receipt.product.callCount}
              charge={receipt.product.unitPriceMinor}
              method={receipt.paymentMethod}
              company={receipt.company ?? ""}
            />
            <div className={styles.receiptActions}>
              {receipt.paymentMethod === "alipay" && !receipt.deliveredAt && (
                <>
                  {canCheckoutOrder(receipt) && (paymentLink
                    ? <a className="harbor-payment-link" href={paymentLink} target="_blank" rel="noopener noreferrer">打开支付宝收银台 ↗</a>
                    : <Button disabled={busy} onClick={() => perform(() => orderAction(receipt, "checkout"))}>继续付款</Button>)}
                  <Button variant="outline" disabled={busy} onClick={() => perform(() => orderAction(receipt, "refresh"))}>查询付款状态</Button>
                </>
              )}
              {canReadBilling && <Button variant="outline" onClick={() => navigate("orders")}>
                查看订单记录 <ArrowRight data-icon="inline-end" />
              </Button>}
              {receipt.paymentMethod === "bank" && hasPermission(session, tenant, "support.create") && (
                <Button variant="outline" onClick={() => navigate("support")}>联系客服</Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
