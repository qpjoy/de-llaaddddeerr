export const httpMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
export function resolveSchema(document: any, value: any): any {
  const visited = new Set();
  while (value?.$ref?.startsWith("#/")) {
    if (visited.has(value.$ref)) return {};
    visited.add(value.$ref);
    value = value.$ref
      .slice(2)
      .split("/")
      .reduce(
        (node: any, key: string) =>
          node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
        document,
      );
  }
  return value || {};
}
export function exampleValue(document: any, input: any, depth = 0): any {
  if (depth > 5) return null;
  const schema = resolveSchema(document, input);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf || schema.anyOf)
    return exampleValue(document, (schema.oneOf || schema.anyOf)[0], depth + 1);
  if (schema.type === "object" || schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties || {})
        .filter(
          ([key]) => !schema.required?.length || schema.required.includes(key),
        )
        .map(([key, value]) => [key, exampleValue(document, value, depth + 1)]),
    );
  if (schema.type === "array")
    return [exampleValue(document, schema.items, depth + 1)];
  if (["integer", "number"].includes(schema.type)) return schema.minimum ?? 1;
  if (schema.type === "boolean") return false;
  if (schema.format === "ipv4") return "203.0.113.1";
  return "YOUR_VALUE";
}
const commonTitles: Record<string, string> = {
  "/data/services/pricing": "查看当前 Key 的服务价格",
  "/data/ip/risk/history/{kind}/{id}": "回看单次或批次画像结果",
  "/requests/by-idempotency-key": "按幂等标识查找请求",
  "/requests/{requestId}": "读取请求处理结果",
  "/acquisitions/{requestId}": "回看已交付的原始结果",
  "/usage": "读取当前调用身份的用量",
};
const isCommon = (entry: { path: string; operation: any }) =>
  Number(
    entry.operation.tags.includes("通用接口") ||
      entry.path.startsWith("/requests/") ||
      entry.path.startsWith("/acquisitions/") ||
      ["/usage", "/data/services/pricing"].includes(entry.path),
  );
export function documentOperations(document: any) {
  return Object.entries(document?.paths || {})
    .flatMap(([path, item]: any) =>
      Object.entries(item)
        .filter(([method]) => httpMethods.has(method))
        .map(([method, operation]: any) => ({
          path,
          method,
          operation: {
            ...operation,
            summary: commonTitles[path] || operation.summary,
            tags: (operation.tags?.length ? operation.tags : ["通用接口"]).map(
              (tag: string) =>
                tag === "Evidence"
                  ? "请求与历史"
                  : tag === "Hub 服务定价"
                    ? "服务定价"
                    : tag,
            ),
          },
          parameters: [
            ...(item.parameters || []),
            ...(operation.parameters || []),
          ],
        })),
    )
    .sort((a, b) => isCommon(a) - isCommon(b));
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function curlExample(
  document: any,
  entry: ReturnType<typeof documentOperations>[number],
  origin: string,
) {
  const params = entry.parameters.map((param: any) =>
    resolveSchema(document, param),
  );
  const query = new URLSearchParams();
  for (const param of params.filter((p: any) => p.in === "query" && p.required))
    query.set(param.name, String(exampleValue(document, param.schema)));
  const url = `${origin}/api/v1${entry.path}${query.size ? `?${query}` : ""}`;
  const lines = [
    `curl -X ${entry.method.toUpperCase()} ${quote(url)}`,
    '  -H "Authorization: Bearer $HARBOR_API_KEY"',
  ];
  for (const param of params.filter(
    (p: any) =>
      p.in === "header" &&
      (p.required || p.name?.toLowerCase() === "idempotency-key"),
  ))
    lines.push(
      `  -H ${quote(`${param.name}: ${param.name.toLowerCase() === "idempotency-key" ? "YOUR_UNIQUE_REQUEST_ID" : exampleValue(document, param.schema)}`)}`,
    );
  const body = resolveSchema(document, entry.operation.requestBody)?.content?.[
    "application/json"
  ];
  if (body)
    lines.push(
      "  -H 'Content-Type: application/json'",
      `  --data ${quote(JSON.stringify(body.example ?? exampleValue(document, body.schema), null, 2))}`,
    );
  return lines.join(" \\\n");
}

export function requestExample(
  document: any,
  entry: ReturnType<typeof documentOperations>[number],
  origin: string,
  language: string,
) {
  if (language === "curl") return curlExample(document, entry, origin);
  const params = entry.parameters.map((p: any) => resolveSchema(document, p)),
    query = new URLSearchParams();
  for (const p of params.filter((p: any) => p.in === "query" && p.required))
    query.set(p.name, String(exampleValue(document, p.schema)));
  const url = `${origin}/api/v1${entry.path}${query.size ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: "Bearer YOUR_API_KEY",
  };
  for (const p of params.filter(
    (p: any) =>
      p.in === "header" &&
      (p.required || p.name?.toLowerCase() === "idempotency-key"),
  ))
    headers[p.name] =
      p.name.toLowerCase() === "idempotency-key"
        ? "YOUR_UNIQUE_REQUEST_ID"
        : String(exampleValue(document, p.schema));
  const body = resolveSchema(document, entry.operation.requestBody)?.content?.[
      "application/json"
    ],
    value = body
      ? (body.example ?? exampleValue(document, body.schema))
      : undefined;
  if (body) headers["Content-Type"] = "application/json";
  if (language === "javascript") {
    const headerCode = JSON.stringify(headers, null, 2).replace(
      '"Bearer YOUR_API_KEY"',
      "`Bearer ${process.env.HARBOR_API_KEY}`",
    );
    return `// Node.js 服务端示例；替换路径占位符和请求参数\nconst response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(entry.method.toUpperCase())},\n  headers: ${headerCode}${body ? `,\n  body: JSON.stringify(${JSON.stringify(value, null, 2)})` : ""}\n});\nif (!response.ok) throw new Error(\`HTTP \${response.status}\`);\nconsole.log(await response.json());`;
  }
  const headerCode = JSON.stringify(headers, null, 2).replace(
    '"Bearer YOUR_API_KEY"',
    '"Bearer " + os.environ["HARBOR_API_KEY"]',
  );
  return `import os, json\nfrom urllib.request import Request, urlopen\n\nurl = ${JSON.stringify(url)}  # 替换路径占位符和请求参数\nheaders = ${headerCode}\n${body ? `body = json.loads(${JSON.stringify(JSON.stringify(value))})\n` : ""}request = Request(url, headers=headers, method=${JSON.stringify(entry.method.toUpperCase())}${body ? ', data=json.dumps(body).encode("utf-8")' : ""})\nwith urlopen(request, timeout=30) as response:\n    print(json.load(response))`;
}
export function localResponseExample(
  document: any,
  entry: ReturnType<typeof documentOperations>[number],
) {
  const response = Object.entries(entry.operation.responses || {}).find(
    ([status]) => /^2\d\d$/.test(status),
  );
  const json = resolveSchema(document, response?.[1])?.content?.[
    "application/json"
  ];
  return {
    notice: "本地合成示例，不发送请求、不消耗额度，不代表真实查询结果。",
    example:
      json?.example ??
      (json?.schema ? exampleValue(document, json.schema) : null),
  };
}
