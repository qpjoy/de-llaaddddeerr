import { useEffect, useMemo, useState } from "react";
import { BookOpen, Copy, Download, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { request } from "./api";
import { curlExample, documentOperations, resolveSchema } from "./documentation-model";

export function Documentation({ tenant, session }: { tenant: string; session: any }) {
  const [schema, setSchema] = useState<any>(null), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [group, setGroup] = useState("all"), [selected, setSelected] = useState("");
  const [version, setVersion] = useState(0), [copyState, setCopyState] = useState("");
  useEffect(() => {
    let active = true; setSchema(null); setError(""); setSelected("");
    if (tenant) request(`/bff/v1/documentation?path=%2Fdocs%2Fopenapi.json&tenantId=${encodeURIComponent(tenant)}`).then(({ data }) => { if (active) setSchema(data.schema); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [tenant, version]);
  const operations = useMemo(() => documentOperations(schema), [schema]);
  const groups = [...new Set<string>(operations.flatMap(entry => entry.operation.tags || []))];
  const visible = operations.filter(entry => (group === "all" || entry.operation.tags?.includes(group)) && `${entry.path} ${entry.operation.summary} ${entry.operation.tags?.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const entry = visible.find(item => `${item.method} ${item.path}` === selected) || visible[0];
  const parameters = entry?.parameters.map((param: any) => resolveSchema(schema, param)) || [];
  const body = entry && resolveSchema(schema, entry.operation.requestBody)?.content?.["application/json"];
  const bodySchema = body && resolveSchema(schema, body.schema);
  const snippet = entry ? curlExample(schema, entry, location.origin) : "";
  const space = session.memberships?.find((m: any) => m.tenantId === tenant)?.tenantName || "当前空间";
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(schema, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `dataport-openapi-${tenant}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <><div className="page-heading"><div><h1>接口文档</h1><p>{space} · 已授权的数据产品与通用接口</p></div><div className="harbor-actions"><Button variant="outline" aria-label="刷新接口文档" onClick={() => setVersion(v => v + 1)} disabled={!tenant || (!schema && !error)}><RefreshCw size={16} /></Button><Button variant="outline" disabled={!schema} onClick={download}><Download size={16} />OpenAPI JSON</Button></div></div>
    <div className="harbor-subscription-notice"><strong>使用当前空间的 API Key 接入</strong><p>此目录按空间授权筛选；实际调用还受所用 Key 的权限、状态、额度和订阅有效期约束。通用接口用于查询请求状态、历史结果、定价与用量。</p></div>
    {!tenant ? <p className="harbor-empty">请先加入或开通空间。</p> : error ? <p role="alert" className="harbor-empty">{error}</p> : !schema ? <p className="harbor-empty">正在读取接口文档…</p> : <>
      <div className="harbor-doc-search"><Search size={18} /><Input aria-label="搜索接口文档" placeholder="搜索接口名称、路径或数据产品" value={search} onChange={e => setSearch(e.target.value)} /><span>{visible.length} 个接口</span></div>
      <div className="harbor-doc-filters" aria-label="文档分类"><button aria-pressed={group === "all"} onClick={() => setGroup("all")}>全部</button>{groups.map(tag => <button key={tag} aria-pressed={group === tag} onClick={() => setGroup(tag)}>{tag}</button>)}</div>
      {!entry ? <p className="harbor-empty">{operations.length ? "没有匹配的接口。" : "当前空间暂无已授权的接口文档。"}</p> : <div className="harbor-doc-layout"><nav className="harbor-doc-nav" aria-label="接口目录">{visible.map(item => { const id = `${item.method} ${item.path}`; return <button key={id} aria-current={item === entry ? "page" : undefined} onClick={() => { setSelected(id); setCopyState(""); }}><span className="harbor-method" data-method={item.method}>{item.method.toUpperCase()}</span><strong>{item.operation.summary || item.path}</strong><code>{item.path}</code></button>; })}</nav>
        <Card className="harbor-doc-detail" key={`${entry.method}:${entry.path}`}><CardHeader><CardTitle><BookOpen size={20} />{entry.operation.summary || "接口说明"}</CardTitle><code className="harbor-doc-url">{entry.method.toUpperCase()} {location.origin}/api/v1{entry.path}</code></CardHeader><CardContent>
          {entry.operation.description && <p className="harbor-doc-description">{entry.operation.description}</p>}
          <h3>认证</h3><p>请求头 <code>Authorization: Bearer YOUR_API_KEY</code>。请在你的服务端保存 Key。</p>
          <h3>请求参数</h3>{!parameters.length ? <p className="harbor-hint">无需额外路径、查询或请求头参数。</p> : <Table><TableHeader><TableRow><TableHead>名称 / 位置</TableHead><TableHead>类型</TableHead><TableHead>必填</TableHead><TableHead>说明</TableHead></TableRow></TableHeader><TableBody>{parameters.map((param: any, i: number) => { const shape = resolveSchema(schema, param.schema); return <TableRow key={`${param.in}:${param.name}:${i}`}><TableCell><code>{param.name}</code><small>{param.in}</small></TableCell><TableCell>{shape.type || "object"}</TableCell><TableCell>{param.required ? "是" : "否"}</TableCell><TableCell>{param.description || "—"}{shape.enum && <p>可选值：{shape.enum.join("、")}</p>}</TableCell></TableRow>; })}</TableBody></Table>}
          {body && <><h3>JSON 请求体</h3><pre>{JSON.stringify(bodySchema, null, 2)}</pre></>}
          <div className="harbor-doc-section"><h3>请求示例</h3><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(snippet); setCopyState("已复制"); } catch { setCopyState("复制失败，请手动选择示例"); } }}><Copy size={14} />复制</Button></div><p className="harbor-hint">替换示例参数、路径占位符和 Key 后在服务端调用。新查询使用新 Idempotency-Key；重试同一请求保留原值。</p><pre>{snippet}</pre>{copyState && <p role="status">{copyState}</p>}
          <h3>响应结构</h3>{Object.entries(entry.operation.responses || {}).map(([status, response]: any) => { const value = resolveSchema(schema, response); const json = value.content?.["application/json"]; return <details className="harbor-response" key={status} open={status === "200"}><summary>{status} · {value.description || "响应"}</summary>{json?.schema && <pre>{JSON.stringify(resolveSchema(schema, json.schema), null, 2)}</pre>}{json?.example && <pre>{JSON.stringify(json.example, null, 2)}</pre>}</details>; })}
          {!!Object.keys(schema.components?.schemas || {}).length && <details className="harbor-response"><summary>当前空间可见的引用模型</summary><pre>{JSON.stringify(schema.components.schemas, null, 2)}</pre></details>}
        </CardContent></Card>
      </div>}
    </>}
  </>;
}
