import { useEffect, useState } from "react";
import { Check, ArrowRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessButton } from "./public-access";
import { request } from "./api";
import { money } from "./commerce-state";

type Offer = { sku: string; name: string; description: string; amountMinor: number; months: number; quota: number; dailyLimit: number | null; activationMode: string };
export function PublicPricing() {
  const [items, setItems] = useState<Offer[] | null>(null), [error, setError] = useState(""), [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setItems(null); setError("");
    request<{ data: { items: Offer[] } }>("/bff/v1/catalog", { signal: controller.signal })
      .then(value => setItems(value.data.items.sort((a,b) => a.amountMinor - b.amountMinor)))
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [version]);
  return <section className="ip-pricing-section"><div className="public-container">
    <div className="ip-pricing-heading"><h1>按需选择，服务规则更清晰</h1><p>IP 风险画像套餐，匹配不同业务用量。</p></div>
    {error ? <div role="alert"><p>{error}</p><Button variant="outline" onClick={() => setVersion(v => v + 1)}>重新加载套餐</Button></div> : !items ? <p role="status">正在读取套餐…</p> : !items.length ? <p>套餐正在准备中，请稍后查看。</p> : <div className="ip-pricing-grid">{items.map(item => <Card className="ip-pricing-card" key={item.sku}>
      <CardHeader><CardTitle><h2>{item.name}</h2></CardTitle><CardDescription>{item.description}</CardDescription></CardHeader>
      <CardContent><div className="ip-pricing-amount"><strong>{money(item.amountMinor)}</strong><span>/ {item.months === 12 ? "年" : `${item.months} 个月`}</span></div><ul>
        <li><Check/><span><strong>{item.quota.toLocaleString()}</strong> 次服务期查询</span></li>
        <li><Check/><span>{item.dailyLimit ? `每天最多 ${item.dailyLimit.toLocaleString()} 次` : "不单设每日上限"}</span></li>
        <li><Check/><span>生效后 {item.months} 个月有效</span></li>
        <li><Check/><span>{item.activationMode === "immediate" ? "每次付款后立即生效" : "续订按已购期限顺延"}</span></li>
      </ul></CardContent><CardFooter><AccessButton destination="market" variant="outline">选择套餐 <ArrowRight data-icon="inline-end"/></AccessButton></CardFooter>
    </Card>)}</div>}
    <p className="ip-pricing-note">总额度与每日上限同时适用；每日按北京时间 00:00 重置，到期剩余额度失效。网页与 API 共享次数，不自动续费。</p>
  </div></section>;
}
