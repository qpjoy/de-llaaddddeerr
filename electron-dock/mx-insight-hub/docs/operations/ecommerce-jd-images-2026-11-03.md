# 京东商品图片缺失（2026-11-03）

## 依据

排查结论 `Hub京东商品图片缺失排查结论_20261102.md`（2026-11-02，Arguseek dev 监控
`mon_e3f160176180bf4716021228c90cf881`）：

- 监控中 30 条京东商品图片数组全为空；天猫 73/73、闲鱼 10/10 有图。
- 抽查的 7 条京东商品，Delta `data_query_raw_record.images`、`raw_payload.images`、`media`、
  `cover_url` 与 Arguseek `common:product:images`、`media` 全空。是地址缺失，不是浏览器加载失败，
  与此前 alicdn 证书问题无关。
- Delta 的 `data_query_raw_record` 是它从 Hub 收到的标准化商品对象，不是供应商原始字节。
- 抽查样本：Hub Request ID `a9204dde-c3bf-4404-9338-f1ca6756f5fc`，京东商品 `100254062573`，
  查询“老爸评测 打假”第 2 页，`sourceMode=live`，上游返回时间 `2026-11-02T08:16:01.759Z`。

供应商官方 SDK 公开样例
[`getApiJdSearchItemListV1.json`](https://github.com/justoneapi-official/justoneapi-python/blob/main/docs/api-examples/getApiJdSearchItemListV1.json)
（样例内 `_fetchedAt` 2026-09-08；见[京东商品搜索 V1 文档](https://docs.justoneapi.com/zh/api/jdcom/product-search-v1)）：
48 条商品的 `imageUrl` 全是 `jfs/t1/...jpg|png` 相对路径，`images` 全是空数组，`longImageUrl` 全是空字符串。
本次在改动前的 HEAD 代码上离线回放，48 条全部输出 `images: []`；改动后 48 条都有图。

## 丢失位置

| 环节 | 结果 |
| --- | --- |
| 供应商响应 `data.products[].imageUrl` | `jfs/t1/...` 相对路径（官方样例 48/48） |
| `normalizeJustOneProductItem` → `imageUrls` → `safeUrl` | `new URL()` 只接受完整 HTTP/HTTPS 地址，相对路径被丢弃；`images` 本身为空 |
| 公共返回 `data.items[].images` | `[]` |
| 归档 `normalizedItem`、交付快照、幂等回执、Canonical `media.images` | 均继承 `[]` |
| 归档 `rawItem` / 受限响应字节 | 保留原相对路径，未改写 |

在官方样例上，图片只在投影这一步丢失：供应商给了路径，下游只是收到了空数组。线上请求是否同样如此，见下文“仍未闭环的证据”。

## 修复

- 只针对 `jd`，只处理匹配
  `^jfs/t<1–8 位数字>/<1–16 级目录>/<文件名>.(jpg|jpeg|png|webp)$` 的字符串（目录与文件名只允许
  `A-Za-z0-9_-`），补成 `https://img10.360buyimg.com/n0/<原路径>`。
  `images[]` 里的同形状字符串同样补全，和 `imageUrl` 相同的只保留一个。
- `n0` 是原图。2026-11-03 对样例首图实测：`n0` 800×800，`n1` 350×350，`n7` 220×220；
  `img10`/`img14`/`img30`/`m.360buyimg.com` 同一路径都返回 200，不带尺寸段返回 404。
- 用补全后的 48 个地址逐条 GET：全部 200（39 个 `image/jpeg`、9 个 `image/png`），最大 461,587 字节，
  在 Hub 图片中转的 JPEG/PNG/WebP、4 MiB、4096 px 限制内。图片中转与 alicdn 处理均未修改。
- 已是完整 HTTP/HTTPS 的地址原样保留。其他形状（如 `jfs/example/...`、前导 `/` 或 `//`、带查询参数、
  `.gif`、`..`），以及其他平台的相对字符串，仍旧丢弃，不套用京东域名。
- 端点合同 `justone.product-search.v1` 不变（参照 10-11 链接修复，不借升版本解除隔离）；
  公共合同 `mx-insight-hub.ecommerce-products.v1` 不变（`images` 字段原本就有，只是现在有值）；
  Canonical parser 标记升为 `mxih-justone-product-search.v5`。
- 只读诊断 `server/ops/diagnose-ecommerce-product-links.mjs` 新增 `imageProductCount`
  （投影后有图的商品数）与 `missingImageCount`，仍只输出计数，不输出地址。
- 不改 Launcher/MX-H2I 登录与联网，没有新增环境变量、迁移、价格或权限。

## 仍未闭环的证据

1. 线上请求 `a9204dde-…` 的精确供应商归档还没读；它是否也是 `jfs/t…` 形状，以部署后诊断为准。
2. 线上 Hub 运行版本没有核对。
3. 30 条是否全是同一原因，需要按各自 Request ID 跑诊断。
4. CDN 规则是在官方样例 48 条上验证的，线上归档里的路径还没逐条验证可访问性。

## 部署与验证

需要重新部署 Hub Public/Admin（既有流程 `bash scripts/manage.sh deploy`，显式
`MX_INSIGHT_SYNC_LAUNCHER=0`）。没有迁移，不需要部署 Launcher。

部署后执行下面的只读命令：在 Pod 内用当前投影重放原归档，不调用供应商、不写任何记录、
不输出商品内容或地址：

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node server/ops/diagnose-ecommerce-product-links.mjs a9204dde-c3bf-4404-9338-f1ca6756f5fc
```

预期 `state=projected`，`imageProductCount` 等于 `productCount`、`missingImageCount=0`，说明该归档就是已确认的路径形状、
部署代码已经能补出图片。`missingImageCount>0` 说明存在另一种形状，先核对再决定是否扩展规则，
不要用付费重采集代替归档证据。`archive_integrity_failed` 等状态不算通过。
旧版诊断没有这两个字段；输出里缺字段就说明 Pod 还没有新代码。

## 历史回执、缓存与下游

- 已提交的响应体、同一 Idempotency-Key 的重放、交付快照都不改写，仍然是 `images: []`。
  新鲜缓存默认 60 秒；过期快照默认最长 7 天，可能在 `cache_only` 或上游失败兜底（`stored_fallback`）时返回旧的空数组。
  使用新幂等键的 `refresh` / `live_only` 采集才会拿到图片。
- 已入库的 Canonical revision 不回写；同一商品之后再次采集时，按既有规则写入带图的新内容。
- Admin 百宝箱的图片中转只读已提交结果里的 `images`，旧结果仍显示中性图标。
- Delta 与 Arguseek 里已存的 30 条空数组不会因为 Hub 部署自动恢复。回填需另行确认方案（优先从已保存归档
  重新投影再同步下游），本次没有回填，也没有发起任何付费请求。
