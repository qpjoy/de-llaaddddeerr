import { ArrowRight, Check } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { productTerm } from "./commerce-state";
export type PlanOffer = {
  sku: string;
  name: string;
  description: string;
  amountMinor: number;
  quota: number;
  months: number;
  dailyLimit?: number | null;
  kind?: string;
  trialDays?: number;
  activationMode?: string;
};
export function PlanCards({
  items,
  embedded = false,
  trialClaimed = false,
  disabled = false,
  onSelect,
}: {
  items: PlanOffer[];
  embedded?: boolean;
  trialClaimed?: boolean;
  disabled?: boolean;
  onSelect: (item: PlanOffer) => void;
}) {
  return (
    <section
      id="pricing"
      className={`ip-pricing-section${embedded ? " console-pricing" : ""}`}
      aria-labelledby="pricing-title"
    >
      <div className="public-container">
        <div className="ip-pricing-heading">
          <h1 id="pricing-title">
            {embedded ? "选择套餐" : "按需选择，服务更清晰"}
          </h1>
          <p>免费试用与服务套餐，匹配不同业务用量。</p>
        </div>
        <div className="ip-pricing-grid" data-offers={items.length}>
          {items.map((item) => (
            <Card className="ip-pricing-card" key={item.sku}>
              <CardHeader>
                <CardTitle>
                  <h2>{item.name}</h2>
                </CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="ip-pricing-amount">
                  <span>¥</span>
                  <strong>
                    {(item.amountMinor / 100).toLocaleString("zh-CN", {
                      maximumFractionDigits: 2,
                    })}
                  </strong>
                  <span>
                    /{" "}
                    {item.kind === "trial"
                      ? "试用期"
                      : item.months === 12
                        ? "年"
                        : `${item.months} 个月`}
                  </span>
                </div>
                <ul>
                  <li>
                    <Check aria-hidden="true" />
                    <span>
                      {item.kind === "trial" ? (
                        item.quota.toLocaleString("zh-CN")
                      ) : (
                        <strong>{item.quota.toLocaleString("zh-CN")}</strong>
                      )}{" "}
                      次
                      {item.kind === "trial"
                        ? "试用"
                        : item.months === 12
                          ? "年度"
                          : "服务期"}
                      查询
                    </span>
                  </li>
                  <li>
                    <Check aria-hidden="true" />
                    <span>
                      {item.dailyLimit
                        ? `每天最多 ${item.dailyLimit.toLocaleString("zh-CN")} 次`
                        : "不单设每日上限"}
                    </span>
                  </li>
                  <li>
                    <Check aria-hidden="true" />
                    <span>
                      {item.kind === "trial" ? "领取即生效，" : "生效后 "}
                      {productTerm(item)}有效
                    </span>
                  </li>
                </ul>
              </CardContent>
              <CardFooter>
                <Button
                  variant="outline"
                  disabled={disabled || (item.kind === "trial" && trialClaimed)}
                  onClick={() => onSelect(item)}
                >
                  {item.kind === "trial"
                    ? trialClaimed
                      ? "已领取试用"
                      : "免费领取"
                    : "选择套餐"}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
        <p className="ip-pricing-note">
          总额度与每日上限同时适用，到期剩余额度失效。网页与 API
          共享企业订阅次数。
        </p>
      </div>
    </section>
  );
}
