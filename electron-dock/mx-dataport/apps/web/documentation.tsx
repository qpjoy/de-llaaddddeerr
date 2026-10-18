import { useEffect, useMemo, useState } from "react";
import { Copy, Download, RefreshCw, Search, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { request } from "./api";
import {
  requestExample,
  localResponseExample,
  documentOperations,
  resolveSchema,
} from "./documentation-model";

export function Documentation({ tenant }: { tenant: string; session: any }) {
  const [schema, setSchema] = useState<any>(null),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [group, setGroup] = useState("all"),
    [selected, setSelected] = useState("");
  const [version, setVersion] = useState(0),
    [copyState, setCopyState] = useState(""),
    [language, setLanguage] = useState("curl"),
    [demo, setDemo] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setSchema(null);
    setError("");
    setSelected("");
    if (tenant)
      request(
        `/bff/v1/documentation?path=%2Fdocs%2Fopenapi.json&tenantId=${encodeURIComponent(tenant)}`,
        { signal: controller.signal },
      )
        .then(({ data }) => {
          if (!controller.signal.aborted) setSchema(data.schema);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    return () => controller.abort();
  }, [tenant, version]);
  const operations = useMemo(() => documentOperations(schema), [schema]);
  const groups = [
    ...new Set<string>(
      operations.flatMap((entry) => entry.operation.tags || []),
    ),
  ];
  const visible = operations.filter(
    (entry) =>
      (group === "all" || entry.operation.tags?.includes(group)) &&
      `${entry.path} ${entry.operation.summary} ${entry.operation.tags?.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const entry =
    visible.find((item) => `${item.method} ${item.path}` === selected) ||
    visible[0];
  const parameters =
    entry?.parameters.map((param: any) => resolveSchema(schema, param)) || [];
  const body =
    entry &&
    resolveSchema(schema, entry.operation.requestBody)?.content?.[
      "application/json"
    ];
  const snippet = entry
    ? requestExample(schema, entry, location.origin, language)
    : "";
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(schema, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `dataport-openapi-${tenant}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <div className="page-heading">
        <h1>接口文档</h1>
        <div className="harbor-actions">
          <Button
            variant="outline"
            aria-label="刷新接口文档"
            onClick={() => setVersion((v) => v + 1)}
            disabled={!tenant || (!schema && !error)}
          >
            <RefreshCw size={16} />
          </Button>
          <Button variant="outline" disabled={!schema} onClick={download}>
            <Download size={16} />
            OpenAPI JSON
          </Button>
        </div>
      </div>
      {!tenant ? (
        <p className="harbor-empty">请先加入或开通空间。</p>
      ) : error ? (
        <p role="alert" className="harbor-empty">
          {error}
        </p>
      ) : !schema ? (
        <p className="harbor-empty">正在读取接口文档…</p>
      ) : (
        <>
          <Tabs className="parity-doc-groups" value={group} onValueChange={setGroup}>
            <TabsList variant="line">
              <TabsTrigger value="all">全部接口</TabsTrigger>
              {groups.map((tag) => (
                <TabsTrigger key={tag} value={tag}>
                  {tag}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="docs-grid parity-docs">
            <div>
              <section className="panel">
                <div className="section-title">
                  <h3>接口列表</h3>
                  <div className="parity-doc-search">
                    <Search size={15} />
                    <Input
                      aria-label="搜索接口文档"
                      placeholder="搜索接口名称或路径"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>接口名称 / 路径</TableHead>
                      <TableHead>方法</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((item) => {
                      const id = `${item.method} ${item.path}`;
                      return (
                        <TableRow key={id} data-selected={item === entry}>
                          <TableCell>
                            <strong>
                              {item.operation.summary || item.path}
                            </strong>
                            <small className="table-sub">{item.path}</small>
                          </TableCell>
                          <TableCell>
                            <span
                              className="harbor-method"
                              data-method={item.method}
                            >
                              {item.method.toUpperCase()}
                            </span>
                          </TableCell>
                          <TableCell>
                            <button
                              className="text-link"
                              aria-label={`查看 ${item.operation.summary || item.path}`}
                              onClick={() => {
                                setSelected(id);
                                setCopyState("");
                              }}
                            >
                              查看
                            </button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {!visible.length && (
                  <div className="empty-state">
                    <h3>
                      {operations.length
                        ? "没有匹配的接口"
                        : "当前空间暂无已授权的接口文档"}
                    </h3>
                  </div>
                )}
              </section>
              {entry && (
                <section
                  className="panel parity-doc-detail"
                  key={`${entry.method}:${entry.path}`}
                >
                  <div className="section-title">
                    <h3>
                      <Terminal size={17} />
                      接口说明
                    </h3>
                    <span className="tag tag-blue">只读文档</span>
                  </div>
                  <label className="field">
                    <span>当前接口</span>
                    <select
                      aria-label="当前接口"
                      value={`${entry.method} ${entry.path}`}
                      onChange={(e) => {
                        setSelected(e.target.value);
                        setCopyState("");
                      }}
                    >
                      {visible.map((item) => (
                        <option
                          key={`${item.method} ${item.path}`}
                          value={`${item.method} ${item.path}`}
                        >
                          {item.operation.summary || item.path}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="parity-doc-description">
                    {entry.operation.description ||
                      "请按以下参数接入当前接口。"}
                  </p>
                  <div className="notice">
                    此页展示接口定义与调用示例，不发送查询请求。实际调用受 API
                    Key 权限、订阅、额度和服务状态约束。
                  </div>
                  <div className="local-example-actions">
                    <Button
                      variant="outline"
                      onClick={() => setDemo((v) => !v)}
                      aria-expanded={demo}
                    >
                      本地示例演示
                    </Button>
                    <small>不发送请求，不消耗额度</small>
                  </div>
                  {demo && (
                    <pre aria-label="本地合成响应示例">
                      {JSON.stringify(
                        localResponseExample(schema, entry),
                        null,
                        2,
                      )}
                    </pre>
                  )}
                  <h3>请求参数</h3>
                  {!parameters.length ? (
                    <p className="harbor-hint">
                      无需额外路径、查询或请求头参数。
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>名称 / 位置</TableHead>
                          <TableHead>类型</TableHead>
                          <TableHead>必填</TableHead>
                          <TableHead>说明</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parameters.map((param: any, i: number) => {
                          const shape = resolveSchema(schema, param.schema);
                          return (
                            <TableRow key={`${param.in}:${param.name}:${i}`}>
                              <TableCell>
                                <code>{param.name}</code>
                                <small className="table-sub">{param.in}</small>
                              </TableCell>
                              <TableCell>{shape.type || "object"}</TableCell>
                              <TableCell>
                                {param.required ? "是" : "否"}
                              </TableCell>
                              <TableCell>
                                {param.description || "—"}
                                {shape.enum && (
                                  <p>可选值：{shape.enum.join("、")}</p>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                  {body && (
                    <details className="harbor-response">
                      <summary>JSON 请求体</summary>
                      <pre>
                        {JSON.stringify(
                          resolveSchema(schema, body.schema),
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  )}
                  <h3>响应结构</h3>
                  {Object.entries(entry.operation.responses || {}).map(
                    ([status, response]: any) => {
                      const value = resolveSchema(schema, response),
                        json = value.content?.["application/json"];
                      return (
                        <details className="harbor-response" key={status}>
                          <summary>
                            {status} · {value.description || "响应"}
                          </summary>
                          {json?.schema && (
                            <pre>
                              {JSON.stringify(
                                resolveSchema(schema, json.schema),
                                null,
                                2,
                              )}
                            </pre>
                          )}
                          {json?.example && (
                            <pre>{JSON.stringify(json.example, null, 2)}</pre>
                          )}
                        </details>
                      );
                    },
                  )}
                  {!!Object.keys(schema.components?.schemas || {}).length && (
                    <details className="harbor-response">
                      <summary>当前空间可见的引用模型</summary>
                      <pre>
                        {JSON.stringify(schema.components.schemas, null, 2)}
                      </pre>
                    </details>
                  )}
                </section>
              )}
            </div>
            <div>
              <section className="code-panel">
                <div className="code-heading">
                  <h3>请求示例</h3>
                  <Button
                    variant="ghost"
                    aria-label="复制代码"
                    disabled={!snippet}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(snippet);
                        setCopyState("已复制");
                      } catch {
                        setCopyState("复制失败，请手动选择示例");
                      }
                    }}
                  >
                    <Copy size={15} />
                  </Button>
                </div>
                <Tabs
                  value={language}
                  onValueChange={(v) => {
                    setLanguage(v);
                    setCopyState("");
                  }}
                >
                  <TabsList>
                    <TabsTrigger value="curl">cURL</TabsTrigger>
                    <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                    <TabsTrigger value="python">Python</TabsTrigger>
                  </TabsList>
                </Tabs>
                <pre>{snippet || "请选择一个已授权接口。"}</pre>
                {copyState && <p role="status">{copyState}</p>}
              </section>
              <section className="panel docs-help">
                <h3>接入须知</h3>
                <ol>
                  <li>在「API Keys」签发当前企业的调用凭证。</li>
                  <li>
                    通过 Authorization: Bearer 传递密钥，仅在服务端保存 Key。
                  </li>
                  <li>替换示例参数与路径占位符，按接口定义发起请求。</li>
                  <li>
                    新查询使用新的 Idempotency-Key；重试同一请求保留原值。
                  </li>
                  <li>
                    此目录按当前企业授权筛选，目录可见不等于所用 Key
                    一定可调用。
                  </li>
                </ol>
                <h3>状态码</h3>
                <dl>
                  <dt>200</dt>
                  <dd>请求已处理，具体结果以响应字段为准</dd>
                  <dt>400</dt>
                  <dd>参数错误，检查请求输入</dd>
                  <dt>401 / 403</dt>
                  <dd>身份无效或没有相应权限</dd>
                  <dt>429</dt>
                  <dd>请求频率或可用额度受限</dd>
                  <dt>5xx</dt>
                  <dd>服务异常；先核对原请求状态，避免重复提交</dd>
                </dl>
              </section>
            </div>
          </div>
        </>
      )}
    </>
  );
}
