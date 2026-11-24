import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, Globe, Search, ShieldCheck, ShoppingCart, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  supportedInterfacePlatforms,
  type InterfaceOperation,
  type InterfacePlatform,
} from "./interface-catalog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./dialog";
import { parseRequestObject, requestFields, requestSample } from "./interface-request";
import { responseFields } from "./interface-response";
import styles from "./data-directory.module.css";

const fieldRequirement = { true: "是", false: "否", conditional: "条件必填" };
const noResponseExample = "当前暂无响应示例";

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

export function PlatformLogo({ slug }: { slug: string }) {
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

function CatalogBadge() {
  return <span className={styles.status}>已收录</span>;
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

const platformPath = (slug: string) => `interfaces/${encodeURIComponent(slug)}`;

export function DataInterfaces({
  page, go, canSubscribe,
}: { page: string; go: (page: string) => void; canSubscribe?: boolean }) {
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef(page);
  const directoryScroll = useRef(0);
  const detail = page !== "interfaces";
  const platform = detail && supportedInterfacePlatforms.find(({ slug }) => platformPath(slug) === page);

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
  const visible = supportedInterfacePlatforms.filter(({ name, aliases, operations }) =>
    [name, ...(aliases ?? []), ...operations.map(({ title }) => title)]
      .some((value) => value.toLowerCase().includes(search)),
  );

  return (
    <section ref={root} data-interface-directory className={styles.directory} aria-labelledby="interfaces-title">
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
          <div className="page-heading harbor-heading-actions">
            <div>
              <h1 ref={heading} id="interfaces-title" tabIndex={-1}>数据接口</h1>
              <p className={styles.directoryIntro}>浏览平台数据服务，查看接口配置与接入状态。</p>
            </div>
            {canSubscribe && (
              <Button variant="outline" onClick={() => go("interface-subscriptions")}>
                <ShoppingCart data-icon="inline-start" /> 接口订阅
              </Button>
            )}
          </div>
          <div className={styles.toolbar}>
            <span className={styles.directoryCount}>全部接口 <span>{supportedInterfacePlatforms.length}</span></span>
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
              const destination = platformPath(item.slug);
              return (
                <article key={item.slug} className={`${styles.card} ${styles.interfaceCard}`}>
                  <header>
                    <PlatformLogo slug={item.slug} />
                    <h2>{item.name}</h2>
                    <CatalogBadge />
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
  const [selectedTab, setSelectedTab] = useState("0");
  const requestPath = platform.operations[Number(selectedTab)]?.path;

  return (
    <>
      <header className={styles.configHeader}>
        <div className={styles.configTitle}>
          <PlatformLogo slug={platform.slug} />
          <h1 id="interfaces-title" ref={heading} tabIndex={-1}>{platform.name}接口配置</h1>
          <CatalogBadge />
        </div>
        <p>当前企业可调用的接口以 API Key 权限为准。</p>
      </header>
      <section className={styles.configPanel} aria-labelledby="interface-overview-title">
        <h2 id="interface-overview-title">接入概况</h2>
        <dl className={styles.overviewFields}>
          <div><dt>请求地址</dt><dd>{requestPath ? <code>{requestPath}</code> : "待公布"}</dd></div>
          <div>
            <dt>鉴权方式</dt>
            <dd>{requestPath ? <code>Authorization: Bearer YOUR_API_KEY</code> : "待公布"}</dd>
          </div>
        </dl>
      </section>
      <Tabs value={selectedTab} onValueChange={setSelectedTab} className={styles.configTabs}>
        <TabsList aria-label={`${platform.name}接口`} variant="line" className={styles.endpointTabs}>
          {platform.operations.map(({ title }, index) => (
            <TabsTrigger key={index} value={String(index)}>{title}</TabsTrigger>
          ))}
        </TabsList>
        {platform.operations.map((operation, index) => (
          <TabsContent key={index} value={String(index)}>
            <InterfaceOperationDetail platform={platform} operation={operation} />
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

function InterfaceOperationDetail({ platform, operation }: { platform: InterfacePlatform; operation: InterfaceOperation }) {
  const { title, path, requestExample, responseExample } = operation;
  const sample = requestSample(requestExample);
  const fields = sample ? requestFields(operation, sample) : [];
  const returnedFields = responseFields(responseExample);

  return (
    <>
      <div className={styles.endpointHeader}>
        <div>
          <h2>{title}</h2>
          {path && <p><code>{path}</code></p>}
        </div>
        <InterfaceSandbox platform={platform} operation={operation} sample={sample} fields={fields} />
      </div>
      <div className={styles.endpointColumns}>
        <div>
          <section className={styles.configPanel}>
            <h3>请求字段</h3>
            {fields.length ? (
              <Table className={styles.fieldTable} aria-label="请求字段">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">字段</TableHead>
                    <TableHead scope="col">类型</TableHead>
                    <TableHead scope="col">必填</TableHead>
                    <TableHead scope="col">说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fields.map(({ name, type, required, description }) => (
                    <TableRow key={name}>
                      <TableCell><code>{name}</code></TableCell>
                      <TableCell><code>{type}</code></TableCell>
                      <TableCell>{required === undefined ? "待确认" : fieldRequirement[`${required}`]}</TableCell>
                      <TableCell>{description}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p>当前暂无请求字段</p>}
          </section>
          <section className={styles.configPanel}>
            <h3>返回字段</h3>
            {returnedFields.length ? (
              <>
                <p className={styles.fieldNote}>字段和类型根据响应示例整理。</p>
                <Table
                  className={`${styles.fieldTable} ${styles.responseFieldTable}`}
                  aria-label="返回字段"
                  containerProps={{
                    className: styles.responseFieldScroll,
                    role: "region",
                    "aria-label": "返回字段滚动区域",
                    tabIndex: 0,
                  }}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">字段</TableHead>
                      <TableHead scope="col">类型</TableHead>
                      <TableHead scope="col">说明</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {returnedFields.map(({ name, type, description }) => (
                      <TableRow key={name}>
                        <TableCell><code>{name}</code></TableCell>
                        <TableCell><code>{type}</code></TableCell>
                        <TableCell>{description}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : <p>当前暂无返回字段</p>}
          </section>
        </div>
        <div>
          <section className={styles.configPanel}>
            <h3>请求体示例</h3>
            {requestExample ? <pre>{requestExample}</pre> : <p>当前暂无请求示例</p>}
          </section>
          <section className={styles.configPanel}>
            <h3>响应示例</h3>
            {responseExample
              ? <pre className={styles.responseExample} tabIndex={0} aria-label="响应示例">{responseExample}</pre>
              : <p>{noResponseExample}</p>}
          </section>
        </div>
      </div>
    </>
  );
}

function InterfaceSandbox({ platform, operation, sample, fields }: {
  platform: InterfacePlatform;
  operation: InterfaceOperation;
  sample?: Record<string, unknown>;
  fields: ReturnType<typeof requestFields>;
}) {
  const example = sample ? JSON.stringify(sample, null, 2) : "";
  const [input, setInput] = useState(example);
  const [error, setError] = useState("");
  const [showResult, setShowResult] = useState(false);

  function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowResult(false);
    const parameters = sample ? parseRequestObject(input) : {};
    if (!parameters) {
      setError("请输入有效的 JSON 对象。");
      return;
    }
    const missing = fields.filter(({ name, required }) => {
      const value = parameters[name];
      return required === true && (!Object.hasOwn(parameters, name) || value === null
        || (typeof value === "string" && !value.trim()));
    });
    if (missing.length) {
      setError(`请填写必填字段 ${missing.map(({ name }) => name).join("、")}。`);
      return;
    }
    const platformField = ["platform", "marketplace"].find((name) => sample && Object.hasOwn(sample, name));
    if (platformField && parameters[platformField] !== sample?.[platformField]) {
      setError(`请保留当前平台的 ${platformField} 参数。`);
      return;
    }
    setError("");
    setShowResult(true);
  }

  return (
    <Dialog onOpenChange={(open) => {
      if (open) {
        setInput(example);
        setError("");
        setShowResult(false);
      }
    }}>
      <DialogTrigger asChild>
        <Button type="button" className={styles.debugButton}>
          <Terminal data-icon="inline-start" aria-hidden="true" /> 在线调试
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>在线调试</DialogTitle>
          <DialogDescription>使用{platform.name}当前接口的固定响应示例。调试在页面内运行，不计费、不消耗已购买次数。</DialogDescription>
        </DialogHeader>
        <p className={styles.sandboxEndpoint}><strong>{operation.title}</strong>{operation.path && <> <code>{operation.path}</code></>}</p>
        <form onSubmit={run}>
          {sample && <label className={styles.sandboxField}>
            请求参数（JSON）
            <textarea value={input} rows={7} spellCheck={false} onChange={(event) => {
              setInput(event.currentTarget.value);
              setError("");
              setShowResult(false);
            }} />
          </label>}
          {error && <p className={styles.sandboxError} role="alert">{error}</p>}
          <Button type="submit" className={styles.debugButton}>
            <Terminal data-icon="inline-start" aria-hidden="true" /> 运行沙箱测试
          </Button>
        </form>
        {showResult && <div className={styles.sandboxResult} role="status">
          <h3>样例结果</h3>
          {operation.responseExample
            ? <pre tabIndex={0} aria-label="样例结果">{operation.responseExample}</pre>
            : <p>{noResponseExample}</p>}
        </div>}
      </DialogContent>
    </Dialog>
  );
}
