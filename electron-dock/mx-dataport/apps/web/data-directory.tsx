import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Globe, Search, ShieldCheck, X } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  interfacePlatforms,
  type InterfacePlatform,
  type InterfaceStatus,
} from "./interface-catalog";
import styles from "./data-directory.module.css";

const logos: Record<string, [string, string]> = {
  "x": ["x", "#14171a"],
  facebook: ["facebook", "#0866ff"],
  instagram: ["instagram", "#dd2a7b"],
  threads: ["threads", "#151515"],
  tiktok: ["tiktok", "#171717"],
  youtube: ["youtube", "#ff0033"],
  reddit: ["reddit", "#ff4500"],
  douyin: ["tiktok", "#171717"],
  kuaishou: ["kuaishou", "#ff4906"],
  xiaohongshu: ["xiaohongshu", "#ff2442"],
  weibo: ["sinaweibo", "#e6162d"],
  bilibili: ["bilibili", "#00a1d6"],
  zhihu: ["zhihu", "#1772f6"],
  "wechat-search": ["wechat", "#07b75b"],
  "wechat-official-accounts": ["wechat", "#07b75b"],
  "wechat-channels": ["wechat", "#07b75b"],
};

function PlatformLogo({ slug }: { slug: string }) {
  const logo = Object.hasOwn(logos, slug) ? logos[slug] : undefined;
  return (
    <span className={styles.logo} aria-hidden="true">
      {logo ? (
        <span style={{
          backgroundColor: logo[1],
          maskImage: `url(/platforms/${logo[0]}.svg)`,
        }} />
      ) : slug === "ip" ? <ShieldCheck /> : <Globe />}
    </span>
  );
}

const statusLabels: Record<InterfaceStatus, string> = {
  supported: "Hub 已支持",
  planned: "筹备中",
  unknown: "待确认",
};

function platformStatus({ operations }: InterfacePlatform): InterfaceStatus {
  if (operations.some(({ status }) => status === "supported")) return "supported";
  return operations.some(({ status }) => status === "unknown") ? "unknown" : "planned";
}

function Status({ status }: { status: InterfaceStatus }) {
  return <span className={styles.status} data-supported={status === "supported"}>{statusLabels[status]}</span>;
}

export function DirectQueryDirectory({ go }: { go: (page: string) => void }) {
  return (
    <section className={styles.directory} aria-labelledby="lookup-title">
      <div className="page-heading">
        <h1 id="lookup-title">数据直查</h1>
      </div>
      <div className={styles.grid}>
        <article className={styles.card}>
          <header>
            <PlatformLogo slug="ip" />
            <h2>IP 风险画像</h2>
          </header>
          <p className={styles.lookupDescription}>
            查询 IPv4 地址的风险等级、代理特征与网络归属，支持 Excel 批量导入。
          </p>
          <button type="button" className={styles.cardLink} aria-label="进入 IP 风险画像查询" onClick={() => go("intelligence")} />
          <div className={styles.cardBottom} aria-hidden="true">
            <span>进入查询</span>
            <ChevronRight size={18} />
          </div>
        </article>
      </div>
    </section>
  );
}

export function DirectQueryBackLink() {
  return (
    <nav className={styles.breadcrumb} aria-label="数据直查导航">
      <a className={styles.backLink} href="#/lookup">
        <ArrowLeft size={16} aria-hidden="true" /> 返回数据直查
      </a>
    </nav>
  );
}

const filters = [
  { id: "all", label: "全部接口", count: interfacePlatforms.length },
  { id: "supported", label: "Hub 已支持", count: interfacePlatforms.filter((p) => platformStatus(p) === "supported").length },
  { id: "pending", label: "筹备中 / 待确认", count: interfacePlatforms.filter((p) => platformStatus(p) !== "supported").length },
] as const;

const platformPath = (slug: string) => `interfaces/${encodeURIComponent(slug)}`;

export function DataInterfaces({ page, go }: { page: string; go: (page: string) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const searchInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef(page);
  const directoryScroll = useRef(0);
  const detail = page !== "interfaces";
  const platform = detail && interfacePlatforms.find(({ slug }) => platformPath(slug) === page);

  useEffect(() => {
    const content = root.current?.closest("main");
    if (detail) {
      content?.scrollTo(0, 0);
      heading.current?.focus({ preventScroll: true });
    } else if (previousPage.current !== "interfaces") {
      content?.scrollTo(0, directoryScroll.current);
      const previous = previousPage.current;
      const currentButton = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-platform-page]") ?? [])
        .find((button) => button.dataset.platformPage === previous);
      (currentButton ?? heading.current)?.focus({ preventScroll: true });
    }
    previousPage.current = page;
  }, [page, detail]);

  const search = query.trim().toLowerCase();
  const visible = interfacePlatforms.filter((item) => {
    const supported = platformStatus(item) === "supported";
    return (filter === "all" || supported === (filter === "supported"))
      && [item.name, ...(item.aliases ?? []), ...item.operations.map(({ title }) => title)]
        .some((value) => value.toLowerCase().includes(search));
  });

  return (
    <section ref={root} className={styles.directory} aria-labelledby="interfaces-title">
      {detail ? (
        <>
          <a className={styles.backLink} href="#/interfaces">
            <ArrowLeft size={16} aria-hidden="true" /> 返回数据接口
          </a>
          {platform ? (
            <InterfaceConfiguration key={platform.slug} platform={platform} heading={heading} />
          ) : (
            <div className="page-heading"><h1 ref={heading} id="interfaces-title" tabIndex={-1}>未找到该接口</h1></div>
          )}
        </>
      ) : (
        <>
          <div className="page-heading">
            <h1 ref={heading} id="interfaces-title" tabIndex={-1}>数据接口</h1>
            <p className={styles.directoryIntro}>浏览平台数据服务，查看接口配置与接入状态。</p>
          </div>
          <div className={styles.toolbar}>
            <div className={styles.filters} role="group" aria-label="接口状态筛选">
              {filters.map(({ id, label, count }) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  {label}<span>{count}</span>
                </button>
              ))}
            </div>
            <div className={styles.search}>
              <Search size={17} aria-hidden="true" />
              <input
                ref={searchInput}
                aria-label="搜索平台接口"
                placeholder="搜索平台名称"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              {query && (
                <button type="button" aria-label="清空平台搜索" onClick={() => {
                  setQuery("");
                  searchInput.current?.focus();
                }}>
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <div className={styles.grid}>
            {visible.map((item) => {
              const status = platformStatus(item);
              const destination = platformPath(item.slug);
              return (
                <article key={item.slug} className={styles.card} data-supported={status === "supported"}>
                  <header>
                    <PlatformLogo slug={item.slug} />
                    <h2>{item.name}</h2>
                    <Status status={status} />
                  </header>
                  <button
                    type="button"
                    className={styles.cardLink}
                    data-platform-page={destination}
                    aria-label={`查看${item.name}接口配置`}
                    onClick={() => {
                      directoryScroll.current = root.current?.closest("main")?.scrollTop ?? 0;
                      go(destination);
                    }}
                  />
                  <div className={styles.cardBottom} aria-hidden="true">
                    <span>接口配置</span>
                    <ChevronRight size={18} />
                  </div>
                </article>
              );
            })}
          </div>
          {!visible.length && <p className={styles.empty} role="status">未找到匹配的接口</p>}
        </>
      )}
    </section>
  );
}

function InterfaceConfiguration({
  platform,
  heading,
}: {
  platform: InterfacePlatform;
  heading: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <>
      <header className={styles.configHeader}>
        <div className={styles.configTitle}>
          <PlatformLogo slug={platform.slug} />
          <h1 id="interfaces-title" ref={heading} tabIndex={-1}>{platform.name}接口配置</h1>
          <Status status={platformStatus(platform)} />
        </div>
        <p>当前企业可调用的接口以 API Key 权限为准。</p>
      </header>
      <Tabs defaultValue="0" className={styles.configTabs}>
        <TabsList aria-label={`${platform.name}接口`} variant="line" className={styles.endpointTabs}>
          {platform.operations.map(({ title }, index) => (
            <TabsTrigger key={index} value={String(index)}>{title}</TabsTrigger>
          ))}
        </TabsList>
        {platform.operations.map(({ title, path, status, requestExample }, index) => (
          <TabsContent key={index} value={String(index)}>
            <section className={styles.configPanel}>
              <h2>{title}</h2>
              <dl className={styles.overviewFields}>
                <div><dt>支持状态</dt><dd>{statusLabels[status]}</dd></div>
                <div><dt>请求地址</dt><dd>{path ? <code>{path}</code> : "待公布"}</dd></div>
              </dl>
            </section>
            <div className={styles.endpointColumns}>
              <section className={styles.configPanel}>
                <h3>请求示例</h3>
                {requestExample ? <pre>{requestExample}</pre> : <p>当前暂无请求示例</p>}
              </section>
              <section className={styles.configPanel}>
                <h3>响应示例</h3>
                <p>当前暂无响应示例</p>
              </section>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
