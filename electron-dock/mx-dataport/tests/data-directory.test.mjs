import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { interfacePlatforms, supportedInterfacePlatforms } from "../apps/web/interface-catalog.ts";
import { parseRequestObject, requestFields, requestSample } from "../apps/web/interface-request.ts";
import { responseFields } from "../apps/web/interface-response.ts";
import { canOpenPage } from "../apps/web/permissions.ts";

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["apps/web/data-directory.tsx"],
  bundle: true,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  packages: "external",
  write: false,
  plugins: [{
    name: "directory-styles",
    setup(builder) {
      builder.onResolve({ filter: /\.module\.css$/ }, ({ path }) => ({ path, namespace: "styles" }));
      builder.onLoad({ filter: /.*/, namespace: "styles" }, () => ({
        contents: "export default new Proxy({}, { get: (_, name) => String(name) });",
      }));
    },
  }],
});
const component = { exports: {} };
new Function("module", "exports", "require", outputFiles[0].text)(component, component.exports, require);
const { DataInterfaces, DirectQueryDirectory } = component.exports;
const render = (Component, props = {}) => renderToStaticMarkup(createElement(Component, { ...props, go() {} }));

test("the direct-query entry opens the existing IP page and lists no platform interfaces", () => {
  const html = render(DirectQueryDirectory);
  assert.match(html, /数据直查/);
  assert.match(html, /进入 IP 风险画像查询/);
  assert.doesNotMatch(html, /查看小红书接口配置/);
});

test("directory cards and detail tabs list only supported interfaces", () => {
  const html = render(DataInterfaces, { page: "interfaces" });
  assert.equal((html.match(/查看小红书接口配置/g) ?? []).length, 1);
  assert.match(html, /查看Telegram接口配置/);
  assert.doesNotMatch(html, /查看IP 风险画像接口配置/);
  assert.match(html, /已收录<\/span>/);
  assert.doesNotMatch(html, /Hub 已支持|筹备中|待确认|查看信用中国接口配置/);
  assert.equal((html.match(/data-platform-page=/g) ?? []).length, supportedInterfacePlatforms.length);
  assert.deepEqual(
    supportedInterfacePlatforms.flatMap(({ operations }) => operations),
    interfacePlatforms.flatMap(({ operations }) => operations.filter(({ status }) => status === "supported")),
  );
  const kuaishou = render(DataInterfaces, { page: "interfaces/kuaishou" });
  assert.doesNotMatch(kuaishou, /获取某条内容下面的评论|商品关键词搜索/);
  const detail = render(DataInterfaces, { page: "interfaces/xiaohongshu" });
  assert.match(detail, /返回数据接口/);
  assert.match(detail, /已收录<\/span>/);
  assert.doesNotMatch(detail, /支持状态|Hub 已支持/);
  assert.match(detail, /内容关键词搜索/);
  assert.match(detail, /获取某条内容下面的评论（笔记专用）/);
  assert.match(detail, /商品关键词搜索/);
  assert.doesNotMatch(detail, /小红书搜索建议\/热词/);
  assert.match(detail, /<dt>请求地址<\/dt><dd><code>\/api\/v1\/data\/search<\/code><\/dd>/);
  assert.match(detail, /<dt>鉴权方式<\/dt><dd><code>Authorization: Bearer YOUR_API_KEY<\/code><\/dd>/);
  assert.ok(detail.indexOf("接入概况") < detail.indexOf('role="tablist"'));
  assert.match(detail, /<table[^>]*aria-label="请求字段"/);
  assert.match(detail, /<code>platform<\/code>[\s\S]*?<code>string<\/code>[\s\S]*?>是<\/td>/);
  assert.match(detail, /在线调试/);
  assert.ok(detail.indexOf("请求字段") < detail.indexOf("返回字段"));
  assert.ok(detail.indexOf("返回字段") < detail.indexOf("请求体示例"));
  assert.match(detail, /<table[^>]*aria-label="返回字段"/);
  assert.match(detail, /<code>data\.items\[\]\.author/);
  assert.doesNotMatch(detail, /当前暂无返回字段/);
  assert.match(detail, /请求体示例/);
  assert.match(detail, /<pre[^>]*aria-label="响应示例"/);
  assert.match(detail, /night-all\.data-search\.v1/);
  assert.doesNotMatch(detail, /当前暂无响应示例/);
});

test("workbook responses belong to the matching platform and operation", () => {
  const find = (slug) => interfacePlatforms.find((platform) => platform.slug === slug).operations;
  const [standard, native, comments] = find("tiktok");
  assert.equal(JSON.parse(standard.responseExample).data.platform, "tiktok");
  assert.equal(native.responseExample, undefined);
  assert.equal(JSON.parse(comments.responseExample).data.platform, "tiktok");
  assert.equal(JSON.parse(comments.responseExample).contractVersion, "mx-insight-hub.post-comments.v1");

  const telegram = find("telegram");
  assert.equal(telegram[0].responseExample, undefined);
  assert.equal(JSON.parse(telegram.find(({ title }) => title === "关键词命中").responseExample).data.platform, "telegram");
  assert.equal(find("xiaohongshu").find(({ title }) => title === "商品关键词搜索").responseExample, undefined);
});

test("response fields merge observed array item keys and keep empty or null values", () => {
  const fields = responseFields(JSON.stringify({
    items: [{ id: "first", metric: null }, { id: "second", metric: 1.5, extra: true }],
    nested: [[], [{ id: 2 }]],
    warnings: [],
    "literal.dot": 0,
  }));
  const types = Object.fromEntries(fields.map(({ name, type }) => [name, type]));
  assert.deepEqual(types, {
    items: "object[]",
    "items[].id": "string",
    "items[].metric": "null | number",
    "items[].extra": "boolean",
    nested: "object[][]",
    "nested[][].id": "integer",
    warnings: "array",
    '["literal.dot"]': "integer",
  });
  assert.deepEqual(responseFields(), []);
  assert.deepEqual(responseFields("invalid JSON"), []);
  for (const { operations } of interfacePlatforms) {
    for (const { responseExample } of operations) {
      const result = responseFields(responseExample);
      assert.equal(result.length > 0, Boolean(responseExample));
      assert.equal(new Set(result.map(({ name }) => name)).size, result.length);
    }
  }
});

test("supported non-ASCII platform links work and unsupported platform links have no detail", () => {
  const phoenix = render(DataInterfaces, { page: `interfaces/${encodeURIComponent("凤凰号/凤凰新闻")}` });
  assert.match(phoenix, /凤凰号\/凤凰新闻接口配置/);
  const hidden = render(DataInterfaces, { page: `interfaces/${encodeURIComponent("信用中国")}` });
  assert.match(hidden, /未找到该接口/);
  assert.doesNotMatch(hidden, /信用中国接口配置|在线调试/);
  assert.match(render(DataInterfaces, { page: "interfaces/unknown" }), /未找到该接口/);
});

test("supported interfaces without examples show empty documentation and retain the debug entry", () => {
  const detail = render(DataInterfaces, { page: "interfaces/qixin" });
  assert.match(detail, /<dt>请求地址<\/dt><dd>待公布<\/dd>/);
  assert.match(detail, /<dt>鉴权方式<\/dt><dd>待公布<\/dd>/);
  assert.match(detail, /当前暂无请求字段/);
  assert.match(detail, /当前暂无返回字段/);
  assert.match(detail, /当前暂无响应示例/);
  assert.match(detail, /在线调试/);
});

test("request fields and sandbox input follow structured catalog examples without interpreting cURL", () => {
  const operation = interfacePlatforms.find(({ slug }) => slug === "x").operations[3];
  assert.deepEqual(requestSample(operation.requestExample), { mode: "email", query: "name@example.com" });
  const taobao = interfacePlatforms.find(({ slug }) => slug === "taobao").operations[0];
  assert.equal(requestSample(taobao.requestExample).query, "耳机");
  const wechat = interfacePlatforms.find(({ slug }) => slug === "wechat-channels").operations[0];
  const fields = requestFields(wechat, requestSample(wechat.requestExample));
  assert.ok(fields.some(({ name, type }) => name === "params.raw" && type === "boolean"));
  assert.equal(parseRequestObject("[]"), undefined);
  assert.equal(parseRequestObject('{"query":'), undefined);
  assert.deepEqual(parseRequestObject('{"query":"城市"}'), { query: "城市" });
});

test("data directory and deep links keep existing direct-query and documentation permissions tenant-scoped", () => {
  const session = { memberships: [
    { tenantId: "lookup-only", dataport: { permissions: ["history.read"] } },
    { tenantId: "docs-only", dataport: { permissions: ["docs.read"] } },
    { tenantId: "paid", dataport: { permissions: ["docs.read"], interfaceSubscriptionActive: true } },
    { tenantId: "paid-without-docs", dataport: { permissions: [], interfaceSubscriptionActive: true } },
    { tenantId: "buyer", dataport: { permissions: ["subscriptions.read", "subscriptions.buy"] } },
  ] };
  for (const page of ["lookup", "intelligence"]) {
    assert.equal(canOpenPage(session, "lookup-only", page), true);
    assert.equal(canOpenPage(session, "docs-only", page), false);
  }
  for (const page of ["interfaces", "interfaces/xiaohongshu"]) {
    assert.equal(canOpenPage(session, "paid", page), true);
    assert.equal(canOpenPage(session, "docs-only", page), false);
    assert.equal(canOpenPage(session, "paid-without-docs", page), false);
    assert.equal(canOpenPage(session, "buyer", page), false);
    assert.equal(canOpenPage(session, "lookup-only", page), false);
    assert.equal(canOpenPage(session, "unrelated", page), false);
  }
  assert.equal(canOpenPage(session, "docs-only", "docs-ip"), true);
  assert.equal(canOpenPage(session, "lookup-only", "docs-ip"), false);
  assert.equal(canOpenPage(session, "buyer", "services"), true);
  assert.equal(canOpenPage(session, "buyer", "interface-subscriptions"), true);
});
