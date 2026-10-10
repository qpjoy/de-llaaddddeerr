import { Layers3 } from "lucide-react";
import { AccessButton } from "./public-access";

export function PublicHeader({
  current = "home",
  accountLabel,
  accountPending = false,
}: {
  current?: "home" | "pricing";
  accountLabel?: string;
  accountPending?: boolean;
}) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="public-header query-header">
        <div className="public-container public-nav">
          <a className="public-brand" href="/" aria-label="数港 DataPort 首页">
            <Layers3 aria-hidden="true" />
            <strong>
              数港 <span>DataPort</span>
            </strong>
          </a>
          <nav aria-label="网站导航">
            <a href="/" aria-current={current === "home" ? "page" : undefined}>
              首页
            </a>
            <a
              href="/pricing"
              aria-current={current === "pricing" ? "page" : undefined}
            >
              定价
            </a>
            <AccessButton destination="docs-ip" variant="ghost">
              接口文档
            </AccessButton>
            <AccessButton account disabled={accountPending}>
              {accountLabel}
            </AccessButton>
          </nav>
        </div>
      </header>
    </>
  );
}
