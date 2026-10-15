import { PlanCards } from "./plan-cards";
import { usePublicAccess } from "./public-access";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { request } from "./api";

type Offer = {
  sku: string;
  name: string;
  description: string;
  amountMinor: number;
  months: number;
  quota: number;
  dailyLimit: number | null;
  activationMode: string;
  kind?: string;
  trialDays?: number;
};
export function PublicPricing() {
  const [items, setItems] = useState<Offer[] | null>(null),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setError("");
    request<{ data: { items: Offer[] } }>("/bff/v1/catalog", {
      signal: controller.signal,
    })
      .then((value) =>
        setItems(
          value.data.items.sort((a, b) => a.amountMinor - b.amountMinor),
        ),
      )
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [version]);
  const { enter } = usePublicAccess();
  return error ? (
    <section className="ip-pricing-section public-container" role="alert">
      <h1>套餐暂不可用</h1>
      <p>{error}</p>
      <Button variant="outline" onClick={() => setVersion((v) => v + 1)}>
        重新加载套餐
      </Button>
    </section>
  ) : !items ? (
    <p className="public-container" role="status">
      正在读取套餐…
    </p>
  ) : !items.length ? (
    <p className="public-container">套餐正在准备中，请稍后查看。</p>
  ) : (
    <PlanCards items={items} onSelect={() => enter("market")} />
  );
}
