import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { interfacePlatforms } from "../apps/web/interface-catalog.ts";
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

test("one card represents a workbook platform and its detail lists the platform's distinct operations", () => {
  const html = render(DataInterfaces, { page: "interfaces" });
  assert.equal((html.match(/查看小红书接口配置/g) ?? []).length, 1);
  assert.match(html, /查看Telegram接口配置/);
  assert.doesNotMatch(html, /查看IP 风险画像接口配置/);
  assert.equal((html.match(/data-platform-page=/g) ?? []).length, interfacePlatforms.length);
  const detail = render(DataInterfaces, { page: "interfaces/xiaohongshu" });
  assert.match(detail, /返回数据接口/);
  assert.match(detail, /内容关键词搜索/);
  assert.match(detail, /获取某条内容下面的评论（笔记专用）/);
  assert.match(detail, /商品关键词搜索/);
  assert.match(detail, /\/api\/v1\/data\/search/);
  assert.match(detail, /当前暂无响应示例/);
});

test("encode and reopen a non-ASCII platform from the directory", () => {
  const detail = render(DataInterfaces, { page: `interfaces/${encodeURIComponent("信用中国")}` });
  assert.match(detail, /信用中国接口配置/);
  assert.match(detail, /待公布/);
  assert.match(detail, /当前暂无响应示例/);
  assert.match(render(DataInterfaces, { page: "interfaces/unknown" }), /未找到该接口/);
});

test("data directory and deep links keep existing direct-query and documentation permissions tenant-scoped", () => {
  const session = { memberships: [
    { tenantId: "lookup-only", dataport: { permissions: ["history.read"] } },
    { tenantId: "docs-only", dataport: { permissions: ["docs.read"] } },
  ] };
  for (const page of ["lookup", "intelligence"]) {
    assert.equal(canOpenPage(session, "lookup-only", page), true);
    assert.equal(canOpenPage(session, "docs-only", page), false);
  }
  for (const page of ["interfaces", "interfaces/xiaohongshu", "docs-ip"]) {
    assert.equal(canOpenPage(session, "docs-only", page), true);
    assert.equal(canOpenPage(session, "lookup-only", page), false);
    assert.equal(canOpenPage(session, "unrelated", page), false);
  }
});
